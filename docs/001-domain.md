# 001 领域模型

> 当前状态：WS1 已实现。领域类型在 `src/core/model.ts`，规则在 `src/core/engine.ts`。本文与实现不一致时，以本文的语义为准并修正实现。WS15 补了 §5：线程键的推导与“权威目标”为什么在策略层而不是 `Thread.targetId` 上解析。

## 1. 概念

领域只描述「一条消息如何变成一次经过批准的回复或任务」。它不接触 `dws`、子进程、HTTP、DSH 会话或任何 I/O。

| 概念       | 定义                                  | 关键规则                                                                                                                                                                                                                                    | 代码             |
| ---------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| Message    | 通道接受的一条入站消息，带稳定事件 ID | 按 `id` 幂等：同一 id 最多产生一条 Decision；保存发送者、正文、会话与时间，不做内容改写                                                                                                                                                     | `InboundMessage` |
| Thread     | 一个可追踪会话                        | 键由目标与会话推导，由调用方给出；`counts.inbound/replied/tasks` 各只在对应事件上加一次；`lastMessageAt` 只前进不后退；标题来自 `InboundMessage.title`（WS2 提供），缺失时群聊回退 `targetId`、私聊回退 `sender.nick`，后续非空新标题会更新 | `Thread`         |
| Decision   | 对一条消息的判断与其后续动作          | `queued` 是唯一入口；`task_created` 与回复链路互斥；同一消息只有一条                                                                                                                                                                        | `Decision`       |
| Draft      | 待发送的回复草稿                      | 只由 `draft` 命令写入；`sources` 保留检索引用                                                                                                                                                                                               | `Draft`          |
| Task       | 从消息捕获、需要人批准的可执行单元    | 只能由 `classify(task)` 创建，创建时必须同时有 Approval；终态不可复活                                                                                                                                                                       | `Task`           |
| Approval   | 人对一个任务的明确授权                | 每个任务至多一条；`pending` 才可被批准或拒绝；过期后迟到批准无效                                                                                                                                                                            | `Approval`       |
| Assignment | 已批准任务到执行器的派工              | 每个任务同一时刻最多一个未结束派工；只有匹配的 `assignmentId` 与 `running` 状态能结束任务；`sessionId` 在 `assignmentStarted` 时可选绑定，未绑定为 `null`，结束/取消后保留                                                                  | `Assignment`     |
| Outbound   | 已排队的对外消息                      | `idempotencyKey` 唯一，同一键最多产生一条外部消息；状态由通道回执推进                                                                                                                                                                       | `Outbound`       |

`Decision.confidence` 与 `Task.reason` 是 WS1 为可解释性补充的字段：前者记录分类置信度，后者记录人工取消的原因；它们不引入新的状态。`InboundMessage.title` 是通道提供的会话标题，只影响 Thread 展示，不参与任何判断。

## 2. 状态机

### 2.1 Decision

```text
queued ──classify(chat|question)──> classified ──draft──> drafted ──queueReply──> sending
                                                                                   ├─ replySent ────> sent
                                                                                   ├─ replyUnknown ─> send_unknown
                                                                                   └─ replyFailed ──> send_failed
queued ──classify(ignore)──> ignored
queued|classified ──defer──> deferred
queued ──classify(task)──> task_created
```

- `sending → *` 只由通道回执推进；`sent` 之后不再改变。
- `send_unknown` 是终态：不自动重发，需主人核对通道；后续只能由显式的 retry 命令（WS4/WS5 实现）重新发起。
- `deferred` 与终态都不能再被分类或排队。
- `task_created` 只表示任务已捕获，回复要等任务执行结束后由新的 Decision 产生（WS2 起）。

### 2.2 Task

```text
awaiting-approval ──approve──> approved ──assignmentStarted──> running ──assignmentEnded(succeeded)──> succeeded
                                                                        └─ assignmentEnded(failed|timeout) ─> failed
awaiting-approval ──reject──> rejected
awaiting-approval|approved|running ──cancel──> cancelled
awaiting-approval ──expire──> expired
```

- `captured` 是保留的入口状态，WS1 不产生；所有新任务直接进入 `awaiting-approval`。
- `approved` 表示人已批准且存在待启动的 Assignment；没有 Approval 的任务不能进入 `approved`，没有 `approved` 的任务不能进入 `running`。
- `running` 只能由匹配的 Assignment 结束；任务被取消或过期后，迟到的执行器回调一律拒绝。
- 终态：`succeeded`、`failed`、`rejected`、`cancelled`、`expired`。

## 3. 不变量

每条不变量都有同名测试（`tests/core-invariants.spec.ts` 中的编号即下表编号）。

| #   | 不变量                                                                                                                      | 测试                                                                                                                   |
| --- | --------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| 1   | `receive` 按消息 id 幂等：重复调用返回同一 Decision、`duplicate: true`，Thread 计数不重复累加                               | `1. deduplicates an inbound message by id and counts it once`                                                          |
| 2   | 只有 `awaiting-approval` 且 Approval 为 `pending` 的任务可批准；重复批准或拒绝后批准抛 `UserError`，不产生第二个 Assignment | `2. approves only an awaiting task and never creates a second assignment`                                              |
| 3   | 未批准任务不能 `assignmentStarted`（没有 approved 状态就没有执行）                                                          | `3. refuses to start an assignment for a task that is not approved`                                                    |
| 4   | `assignmentEnded` 的 assignmentId 或任务状态不匹配时抛错且不改状态                                                          | `4. refuses an assignment report that does not match the running task`                                                 |
| 5   | 同一 `idempotencyKey` 的 `queueReply` 只产生一条 Outbound                                                                   | `5. queues one outbound message per idempotency key`                                                                   |
| 6   | `classify(task)` 缺 `approvalTtlMs` 或任务标题时抛错，事务回滚，无 Task/Approval 残留                                       | `6. rolls back a task classification that lacks an approval TTL`、`refuses a task classification without task detail…` |
| 6b  | 命令在写入中途失败时整条回滚（由注入的存储故障验证，而不是只靠前置校验）                                                    | `6b. rolls back the writes of a command that fails in the middle`                                                      |
| 7   | `expireTasks` 只过期 `expiresAt <= now` 的 pending Approval；返回 taskId 列表；重复调用幂等                                 | `7. expires only overdue pending approvals and stays idempotent`                                                       |
| 8   | `cancelTask` 在 running 时同时结束 Assignment；之后 `assignmentEnded` 不能把任务改回成功                                    | `8. cancels a running task and refuses to revive it through its assignment`                                            |
| 9   | Thread 计数只在 `receive`（inbound）、`replySent`（replied）、任务创建（tasks）各加一次                                     | `9. increments every thread counter exactly once per domain event`                                                     |
| 10  | 每个命令的 `updatedAt` 由注入 clock 决定；`decidedAt`/`startedAt`/`endedAt` 也来自 clock 或被显式传入                       | `10. stamps every command with the injected clock`                                                                     |

补充规则（各有测试）：

- 迟到批准（`at >= expiresAt`）被拒绝为 `approvalExpired`，任务保持 `awaiting-approval`，等过期扫描处理。
- 所有时间比较按 `Date.parse` 的数值进行，接受带时区偏移的 ISO 时间；非法时间抛 `invalidTime`。`expiresAt` 仍以 `toISOString()` 存储。
- `assignmentStarted(taskId, assignmentId, { sessionId? })` 在启动时绑定执行器会话；空字符串按未绑定处理，结束后仍可查询。
- `receive` 的 Thread `lastMessageAt` 取消息时间与既有值的较大者；标题只在非空且不同时更新。
- 领域事件在事务提交后同步投递；监听器抛错不会回滚已提交命令。

## 4. 幂等与显式 ID

- **消息**：`decisions.message_id` 唯一，`receive` 先按消息 id 查 Decision，再写入。
- **回复**：`outbound.idempotency_key` 唯一；`queueReply` 命中既有键时复用该 Outbound，不新建、不重复计数。
- **批准**：`approvals.task_id` 唯一，一个任务至多一条授权记录。
- **ID 来源**：`Ids.next(prefix)` 由调用方注入；测试用确定性序列，生产用随机 ID。聚合之间不共享计数器。
- **时间**：`Clock.now()` 由调用方注入；领域层不读系统时间，测试可断言每个 `updatedAt`。

## 5. 线程键与“权威目标”（WS15）

线程键由通道按会话推导，领域只接收它、不重新计算：

| 来源           | `threadKey`                  | 说明                                                                                               |
| -------------- | ---------------------------- | -------------------------------------------------------------------------------------------------- |
| 群（含 at-me） | `group:<openConversationId>` | at-me 事件本身也发生在某个群里，因此与群目标**共用同一个线程键**                                   |
| 单聊           | `dm:<对端 id>`               | 对端 id 是 `userId`，只拿到 open id 时是裸 open id（`open:` 只是发送侧前缀，`threadKeyOf` 会去掉） |

`Thread.targetId` 只记录“创建这条线程的那个目标”，**不是**“这条消息该用哪一行策略”。原因很直接：同一个群可以同时被 `at-me` 与群目标订阅，两条事件流都会落成同一个 `group:<cid>`，谁先到谁就写了 `Thread.targetId`；拿它当权威目标，普通消息可能套用 at-me 行的 `mentionOnly`/回复模式，@ 消息又可能套用群行的策略（WS15 修掉的 D6）。

因此策略层按**来源 → 会话 → 回退**解析权威目标（`policy.findTarget`，详见 [002 授权与回复策略](002-authorization.md) §6.1）：at-me 消息取全局 at-me 行；否则按线程里的会话 id 找 `group:<cid>` 行；都没有才回退到 `Thread.targetId` 指向的行；仍然没有就是 `target_missing`。领域层不参与这个解析——它不读设置，`Thread` 也不存“当前生效的策略行”。

## 6. 领域事件

| 事件                                            | 数据                                               |
| ----------------------------------------------- | -------------------------------------------------- |
| `message.received`                              | `messageId`、`threadKey`                           |
| `decision.queued`                               | `decisionId`、`threadKey`                          |
| `decision.classified`                           | `decisionId`、`intent`                             |
| `reply.drafted`                                 | `decisionId`                                       |
| `reply.queued`                                  | `decisionId`、`outboundId`、`idempotencyKey`       |
| `reply.sent` / `reply.unknown` / `reply.failed` | `decisionId`、`outboundId`（失败事件另带 `error`） |
| `task.created`                                  | `taskId`、`decisionId`、`threadKey`                |
| `task.approved`                                 | `taskId`、`approvalId`、`assignmentId`             |
| `task.rejected` / `task.expired`                | `taskId`、`approvalId`                             |
| `task.cancelled`                                | `taskId`、`reason`                                 |
| `assignment.started`                            | `taskId`、`assignmentId`                           |
| `assignment.ended`                              | `taskId`、`assignmentId`、`outcome`                |

事件数据只放 ID 与必要状态，不放消息正文、昵称或凭证。审计落盘由 app 层决定（`Store.appendEvent`），领域层不写事件表。

## 相关文档

- [003 执行](003-execution.md)
- [007 架构](007-architecture.md)
- [010 设计摘要](010-design.md)
