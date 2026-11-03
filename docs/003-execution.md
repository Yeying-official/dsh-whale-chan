# 003 执行

> 当前状态：WS1 已实现领域与持久化侧（`src/core`、`src/app`）；WS4 在其上实现真正的执行器：一个已批准的任务对应一个 DSH worker 会话（`src/executor`）。本文描述领域已经保证的生命周期、批准门与事务边界，以及执行器必须遵守的契约。WS5 负责把两者接起来（HTTP 路由、设置持久化、组合根）。

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

执行器在**创建会话之前**再检查一次：`approval.status === 'approved'`、`task.status === 'approved'` 且 `approval.taskId === task.id`，任何一条不成立就抛 `UserError('notApproved')` 并且**不建工作区、不建会话**。这是本层的 fail-closed 点，它防的是「派工记录被绕过或错配」而不是替代领域校验：领域仍是唯一可以写批准状态的模块。

## 3. Assignment

- 一个任务同一时刻最多一个未结束的 Assignment；`task.assignmentId` 是唯一权威指针。
- `assignmentStarted(taskId, assignmentId, { sessionId? })` 只接受 `approved` 任务与 `pending` 派工，写入 `running` 与 `startedAt`；非空 `sessionId` 同时绑定到派工，空白或省略保持 `null`。绑定在 `assignmentEnded` 之后仍保留，供面板查询执行会话。
- `assignmentEnded(taskId, assignmentId, { outcome, result? })` 只接受 `running` 任务与 `running` 派工：
  - `succeeded` → 任务 `succeeded`；
  - `failed`、`timeout` → 任务 `failed`；
  - 派工 → `ended`，记录 `endedAt`、`outcome`；`result` 原样落到任务上（摘要、会话 ID、产物路径）。
- 不匹配的 `assignmentId`、错误的任务状态、重复上报都会被拒绝（`UserError`），且不改任何状态。迟到的成功上报不能复活已取消或已失败的任务。

执行器只负责在自己的事务外调用这两个命令；它不直接写存储。

## 4. 执行器契约（WS4）

执行器对 app 暴露 `TaskExecutor`，对 DSH 暴露 `SessionHost`。两个端口都在 `src/executor/types.ts`，生产实现分别是 `DshTaskExecutor` 与 `DshSessionHost`。

### 4.1 输入与输出

```ts
interface ExecutorRequest {
  task: Task
  approval: Approval
  settings: Settings
  signal: AbortSignal
}
interface ExecutorResult {
  outcome: 'succeeded' | 'failed' | 'timeout' | 'cancelled'
  summary: string
  sessionId: string
  error?: string
}
```

- `summary` 是 worker 会话的**最后一条 assistant 文本**，去掉首尾空白。会话没有产出时它是空串，执行器不会用「已完成」之类的文字补位：面板必须能看出 worker 什么也没说。
- `error` 是稳定的机器可读值：`timeout`、`cancelled`、`cancelled: <原因>`、`failed: <DSH 原因>`。
- `sessionId` 是 DSH 侧真实使用的会话 id。宿主在 `fresh` 重建时可能返回另一个 id，此时以返回值为准。

### 4.2 回调语义

- `onStarted(taskId, sessionId)` 在会话**已经存在**之后调用一次；app 在这一刻调用 `assignmentStarted`。
- `onFinished(taskId, result)` 在该次运行结束、失败、超时或取消之后调用一次；app 在这一刻调用 `assignmentEnded`。
- 会话建立**之前**就被拒绝的运行不触发任何回调，而是直接抛出：领域里没有任何正在运行的东西可以结束。监听器抛出的异常被捕获并记录，不会改变已经产生的 `ExecutorResult`。

### 4.3 一次运行

1. 批准门（§2）。
2. `runs` 里已存在同一 `taskId` → 抛 `ExecutorError('alreadyRunning')`，不碰会话。
3. 工作区：批准人选择的 `Assignment.workspace` 优先（展开 `~`，必须是绝对路径，否则抛 `UserError('invalidWorkspace')`（领域错误码，API 按用户可纠正错误映射）且不建任何东西）；没有选择时才回退到 `tasks.workspaceRoot`（展开 `~`）或 `<stateDir>/tasks` 拼上 `task.id`。然后 `mkdir -p`。回退路径里 `task.id` 必须是单一安全路径段，含 `/`、`\`、`..` 时抛 `ExecutorError('unsafeTaskId')`。
4. `ensureSession`：会话 id `whale-task-<taskId>-<assignmentId 后 8 位>`、preset `dsh-whale-chan-worker`、权限 `settings.tasks.permissionPreset`（默认 `workspace-write`）、标题 `任务 · <title>`、系统提示与模型路由（见 §5）。
5. 投递任务消息，`requestId = task:<taskId>:<assignmentId|initial>`；同一个派工重复投递不会产生第二条消息（§6）。`task.result.summary` 非空时，消息里追加「上一轮结果（供参考）」段落——重试是全新会话，这是它唯一能看到上次结论的途径。
6. `awaitTurnEnd`，预算 `max(settings.tasks.timeoutMinutes 分钟, 90 秒)`：`tasks.timeoutMinutes` 是任务总预算，
   但单回合永远至少给 90 秒（`MODEL_TURN_TIMEOUT_MS`），否则 1 分钟的任务会在本地模型吐出首 token 前就被掐断。
7. 读最后一条 assistant 文本作为 `summary`，映射 outcome。
8. 无论走哪条路径，`runs` 条目都会被删除，`onFinished` 恰好触发一次。

## 5. 会话、工作区与权限

| 项       | 任务执行会话                                                    | 回复器会话                               |
| -------- | --------------------------------------------------------------- | ---------------------------------------- |
| 会话 id  | `whale-task-<taskId>-<assignmentId 后 8 位>`                    | `whale-reply-<sha1(threadKey) 前 12>`    |
| 工作区   | `Assignment.workspace`，缺省用 `<tasks.workspaceRoot>/<taskId>` | `~/.dsh-whale-chan/workspace`            |
| preset   | `dsh-whale-chan-worker`                                         | `dsh-whale-chan-replier`                 |
| 权限预设 | `settings.tasks.permissionPreset`（默认窄）                     | `workspace-write`                        |
| 模型     | `settings.models.worker`                                        | `settings.models.reply`                  |
| 标题     | `任务 · <title>`                                                | `钉钉 · <thread 标题>`                   |
| 系统提示 | 人设 + 任务 brief/要求/发起人 + 安全规则 + 汇报                 | preset 的 persona 段；完整指示随消息投递 |

- **系统提示**由 `renderPersona(persona, …)` 渲染的人设块加任务段组成，通过 `agent.ctx.systemPrompt.section({ name: 'dsh-whale-chan-task', order: 900, interpolate: false })` 注册。它不是 `complete` 段：preset 自带的 persona 与指令段落保留，本段追加在后。`interpolate: false` 保证主人写进人设的字面 `{{…}}` 不会被 DSH 变量替换。
- **权限**只取设置里的两个值；其它值一律按 `workspace-write` 处理。
- **工作区以批准为准**：`ExecutorRequest.workspace` 由 WS5 从 `Assignment.workspace` 传入，优先于 `tasks.workspaceRoot`；两者都没有配置时用 `<stateDir>/tasks/<taskId>`。相对路径一律拒绝（`UserError('invalidWorkspace')`，属领域 `refused` 组），因为 DSH 会按宿主工作目录解析它，主人无法预测任务落在哪里。
- **模型**来自设置的两个独立路由：worker 用 `settings.models.worker`，回复器用 `settings.models.reply`。路由在会话创建后、首个回合前写入会话日志（`model/selection`），并只注入第一次模型请求；`provider` 或 `model` 为空则跳过，用部署默认模型。它**不修改** DSH 的全局默认模型，所以回复路由不会变成所有新会话的默认；会话已有选择或已开过请求头时也不覆盖，主人在面板里换的模型始终优先。
- 会话按需重建：`whale-reply-*` 在满 20 轮或空闲 30 分钟后重建（先取消旧会话的回合，再以 `fresh` 请求新会话）；`whale-task-*` 的 id 带派工后缀，因此**重试是新会话**，不会复用上次失败的对话。

## 6. 投递与幂等

- 消息 id 由 `requestId` 派生：`MessageId('dsh-whale-chan:' + requestId)`，source 固定为 `{ kind: 'dsh-whale-chan' }`（`MessageSourceMap` 的模块扩展）。
- 投递前先查**会话自己的日志**与 agent inbox：同 id 的 `user/message` 已经在日志里，或仍在 `nextTurn`/`nextStep` 队列里，就跳过。不需要额外的账本，重启后也不会重复投递。
- `queue` 模式走 `agent.followup(message)`，开一个新回合；`steer` 模式走 `agent.steer(message)`，并入正在运行的回合。
- 本插件投递的消息 source 不是 `user`，因此 DSH 与面板不会把它当成主人手写的消息。

## 7. 回合结束、超时与取消

- `awaitTurnEnd` 的匹配单位是**一次投递所在的回合**：投递消息的 `user/message` 事件决定回合号，该回合的 `turn/end` 才算结束。别的回合、别的会话的事件都不算。
- 订阅先建立、历史后扫描，扫描期间到达的事件会补放，因此不会漏掉「刚好在订阅前后结束」的回合；如果回合在等待开始前就已经结束，直接返回 `completed`。
- 结果只有四种：`completed`、`timeout`、`aborted`、`failed`（`failed` 带上 DSH 的结束原因，例如 `aborted by hook`）。
- 超时：执行器调用 `host.cancel` 取消会话回合，返回 `timeout`；不 SIGKILL 任何进程。
- **单回合上限 90 秒**（`MODEL_TURN_TIMEOUT_MS`，回复器和执行器共用）：本机模型首 token 可能 15–30 秒，90 秒给慢但健康的回合留出余量。它与任务总超时是两回事：任务的总预算仍是 `tasks.timeoutMinutes`，只是不会低于一个回合的上限。
- 取消：`cancel(taskId)` 先中止调用方生命周期，再 `agent.cancel({ kind: 'hook', reason }, { keepInbox: false })`——中止当前回合并清空队列，避免取消后又被排队消息唤醒。重复取消是幂等的，运行结束后再取消返回 `false`。
- 外部（面板、别人在 DSH 里点停止）结束的回合不是本层的取消，按 `failed` 上报，避免把别人的操作说成领域取消。

## 8. 失败、取消与过期

| 情况            | 领域行为                                                                                                                                                 |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 回复投递未知    | Decision → `send_unknown`，Outbound → `unknown`、`attempts + 1`；这是终态，不自动重发，需主人核对通道，只有显式 retry 命令（WS4/WS5 实现）才会再次尝试   |
| 回复投递失败    | Decision → `send_failed`，Outbound → `failed`、`attempts + 1`、记录 `lastError`                                                                          |
| 人取消任务      | 允许 `awaiting-approval` / `approved` / `running` → `cancelled`，记录 `reason`；待批准的 Approval 记为 `expired`；未结束的 Assignment 结束为 `cancelled` |
| 批准过期        | `expireTasks(now)` 把 `expiresAt <= now` 的 pending Approval 与仍等待的任务一起置为 `expired`，返回 taskId 列表；重复扫描幂等                            |
| 执行器失败/超时 | `assignmentEnded` 以 `failed`/`timeout` 结束任务，结果落库；重试是新的派工，不是复活旧任务                                                               |

取消与过期都不删除任何记录：任务、Approval、Assignment 与 Outbound 都保留，供面板与审计追溯。

## 9. 并发

- 会话层没有全局可变表：`SessionHost` 的每个方法都以调用方传入的 `SessionRef` 寻址，两个任务不可能读到对方的 inbox 或回合边界。
- 执行器内部只有一张 `taskId → 运行记录` 的表，用来拒绝同一任务的第二次并发运行，以及让 `cancel` 找到要中止的运行；它不跨任务共享任何状态。
- 全局并发上限（`tasks.maxConcurrent`）属于 app 层调度（WS5），执行器只保证「同一任务不并发」。

## 10. 事务边界

- **一个命令一个事务**。`Engine` 的每个写命令都包在 `Repositories.atomic` 里；SQLite 实现用 `BEGIN IMMEDIATE ... COMMIT`，失败 `ROLLBACK`。
- **事务内不允许嵌套事务**。存储拒绝嵌套调用，组合需求应该拆成两个命令，而不是悄然并入外层事务。
- **读查询不开事务**：`thread`、`decision`、`task`、`openTasks`、`pendingApprovals` 只读。
- **领域事件在提交后投递**：事件先收集，`COMMIT` 成功后同步派发；监听器异常不会撤销已提交状态。
- **副作用在提交后入队**：调用方先完成命令事务，再把 `Effects.enqueue` 当作独立写入调用。Effects 不感知领域事务，回调失败按退避重试。
- **执行器回调是独立命令**：执行器在自己的进程里调用 `assignmentStarted` / `assignmentEnded`，每次都是新的领域事务；崩溃后恢复以任务与派工状态为准。
- **时间以数值比较**：`approveTask`、`expireTasks`、`pendingApprovals` 都先 `Date.parse` 成毫秒再比较，因此调用方传 `+08:00` 偏移不会误判；非法时间抛 `invalidTime`，存储仍统一为 `toISOString()`。

## 11. 与执行器的边界

领域提供、执行器消费：

- `openTasks()`、`pendingApprovals(now)`、`task(id)` 读取待办；
- `approveTask` / `rejectTask` / `cancelTask` 由面板路由调用；
- `assignmentStarted` / `assignmentEnded` 由执行器在真实会话启动/结束时调用；启动时用 `sessionId` 绑定会话，结束后仍可从派工查询。
- `Effects` 与 `Passes` 由 app 组合根启动，执行器只注册自己的 effect handler。

领域不提供：启动 DSH 会话、写文件、发钉钉消息、读设置。会话 ID 由执行器在 `assignmentStarted` 时给出；任务结果里的 `result.sessionId` 是可选的重复记录，不是唯一来源。执行器也不发钉钉消息：任务结果由 app 转成 Outbound，走与回复相同的发送路径（[007 架构](007-architecture.md) §6）。

## 相关文档

- [001 领域模型](001-domain.md)
- [006 部署](006-deployment.md)
- [007 架构](007-architecture.md)
- [010 设计摘要](010-design.md)
