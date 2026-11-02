# 003 执行

> 当前状态：WS1 已实现领域与持久化侧（`src/core`、`src/app`）。真正的执行器（DSH 会话、工作区、权限预设）由 WS2 落地；本文只描述领域已经保证的生命周期、批准门与事务边界。

## 1. 任务生命周期

```text
classify(task)                 人批准                     执行器报告开始           执行器报告结束
     │                            │                            │                         │
     ▼                            ▼                            ▼                         ▼
awaiting-approval ──────────> approved ──────────────────> running ──────────────> succeeded / failed
     │                            │                            │
     │ reject                     │ cancel                     │ cancel
     ▼                            ▼                            ▼
 rejected                      cancelled                    cancelled
     │
     │ TTL 到期
     ▼
  expired
```

- 创建：`classify(decisionId, { intent: 'task', task, approvalTtlMs })` 在**同一事务**写入 Task、Approval 和 Decision 链接，并把 Thread 的 `tasks` 计数加一。缺少任务标题或正数 TTL 时抛 `UserError` 并完整回滚。
- 推进：只有人（`by: 'owner'`）可以批准或拒绝；只有执行器可以通过 `assignmentStarted` / `assignmentEnded` 推进运行态。
- 终止：终态任务不在 `openTasks()` 中，也不能被取消、批准或再次启动。

## 2. 批准门

批准必须在面板完成（[010 设计摘要](010-design.md) §7）。领域侧只接受满足全部条件的批准：

1. 任务存在且状态为 `awaiting-approval`；
2. 任务的 Approval 状态为 `pending`（否则 `already_decided`）；
3. 批准时间 `at < expiresAt`（按 `Date.parse` 数值比较，允许 `+08:00` 等偏移；否则 `approvalExpired`，任务保持等待，交给过期扫描；无法解析的时间抛 `invalidTime`）；
4. 调用方给出非空 `workspace`（否则 `missing_workspace`）。

批准的**一个事务**写入三件事：

- Approval → `approved`，记录 `decidedAt`、`decidedBy: 'owner'` 与备注；
- Task → `approved`，`assignmentId` 指向新派工；
- Assignment → `pending`，带上批准人选择的 `workspace`。

因此不存在「任务已批准但没有授权记录」或「已批准但无处运行」的中间态。拒绝只写 Approval 与 Task，不产生 Assignment。

## 3. Assignment

- 一个任务同一时刻最多一个未结束的 Assignment；`task.assignmentId` 是唯一权威指针。
- `assignmentStarted(taskId, assignmentId, { sessionId? })` 只接受 `approved` 任务与 `pending` 派工，写入 `running` 与 `startedAt`；非空 `sessionId` 同时绑定到派工，空白或省略保持 `null`。绑定在 `assignmentEnded` 之后仍保留，供面板查询执行会话。
- `assignmentEnded(taskId, assignmentId, { outcome, result? })` 只接受 `running` 任务与 `running` 派工：
  - `succeeded` → 任务 `succeeded`；
  - `failed`、`timeout` → 任务 `failed`；
  - 派工 → `ended`，记录 `endedAt`、`outcome`；`result` 原样落到任务上（摘要、会话 ID、产物路径）。
- 不匹配的 `assignmentId`、错误的任务状态、重复上报都会被拒绝（`UserError`），且不改任何状态。迟到的成功上报不能复活已取消或已失败的任务。

执行器（WS2）只负责在自己的事务外调用这两个命令；它不直接写存储。

## 4. 失败、取消与过期

| 情况            | 领域行为                                                                                                                                                 |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 回复投递未知    | Decision → `send_unknown`，Outbound → `unknown`、`attempts + 1`；这是终态，不自动重发，需主人核对通道，只有显式 retry 命令（WS4/WS5 实现）才会再次尝试   |
| 回复投递失败    | Decision → `send_failed`，Outbound → `failed`、`attempts + 1`、记录 `lastError`                                                                          |
| 人取消任务      | 允许 `awaiting-approval` / `approved` / `running` → `cancelled`，记录 `reason`；待批准的 Approval 记为 `expired`；未结束的 Assignment 结束为 `cancelled` |
| 批准过期        | `expireTasks(now)` 把 `expiresAt <= now` 的 pending Approval 与仍等待的任务一起置为 `expired`，返回 taskId 列表；重复扫描幂等                            |
| 执行器失败/超时 | `assignmentEnded` 以 `failed`/`timeout` 结束任务，结果落库；重试是新的派工，不是复活旧任务                                                               |

取消与过期都不删除任何记录：任务、Approval、Assignment 与 Outbound 都保留，供面板与审计追溯。

## 5. 事务边界

- **一个命令一个事务**。`Engine` 的每个写命令都包在 `Repositories.atomic` 里；SQLite 实现用 `BEGIN IMMEDIATE ... COMMIT`，失败 `ROLLBACK`。
- **事务内不允许嵌套事务**。存储拒绝嵌套调用，组合需求应该拆成两个命令，而不是悄然并入外层事务。
- **读查询不开事务**：`thread`、`decision`、`task`、`openTasks`、`pendingApprovals` 只读。
- **领域事件在提交后投递**：事件先收集，`COMMIT` 成功后同步派发；监听器异常不会撤销已提交状态。
- **副作用在提交后入队**：调用方先完成命令事务，再把 `Effects.enqueue` 当作独立写入调用。Effects 不感知领域事务，回调失败按退避重试。
- **执行器回调是独立命令**：WS2 在自己的进程里调用 `assignmentStarted` / `assignmentEnded`，每次都是新的领域事务；崩溃后恢复以任务与派工状态为准。
- **时间以数值比较**：`approveTask`、`expireTasks`、`pendingApprovals` 都先 `Date.parse` 成毫秒再比较，因此调用方传 `+08:00` 偏移不会误判；非法时间抛 `invalidTime`，存储仍统一为 `toISOString()`。

## 6. 与执行器的边界（WS2）

领域提供、执行器消费：

- `openTasks()`、`pendingApprovals(now)`、`task(id)` 读取待办；
- `approveTask` / `rejectTask` / `cancelTask` 由面板路由调用；
- `assignmentStarted` / `assignmentEnded` 由执行器在真实会话启动/结束时调用；启动时用 `sessionId` 绑定会话，结束后仍可从派工查询。
- `Effects` 与 `Passes` 由 app 组合根启动，执行器只注册自己的 effect handler。

领域不提供：启动 DSH 会话、写文件、发钉钉消息、读设置。会话 ID 由执行器在 `assignmentStarted` 时给出；任务结果里的 `result.sessionId` 是可选的重复记录，不是唯一来源。

## 相关文档

- [001 领域模型](001-domain.md)
- [007 架构](007-architecture.md)
- [010 设计摘要](010-design.md)
