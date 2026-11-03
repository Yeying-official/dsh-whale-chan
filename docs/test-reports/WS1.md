# WS1 测试报告

- 环境：Windows，Node `v24.15.0`，pnpm `11.4.0`，vitest `4.1.8`，`node:sqlite` 的 `DatabaseSync`
- 分支：`feat/ws1-core`
- 范围：core 领域层、SQLite store/migration、effects、passes、契约测试调整

## 1. 门禁命令与真实输出

```text
$ pnpm typecheck
$ tsc --noEmit
（无输出，退出码 0）

$ pnpm test
 ✓ tests/core-invariants.spec.ts (15 tests) 66ms
 ✓ tests/client-api.spec.ts (4 tests) 79ms
 ✓ tests/core-engine.spec.ts (23 tests) 74ms
 ✓ tests/passes.spec.ts (6 tests) 14ms
 ✓ tests/contract.spec.ts (13 tests) 67ms
 ✓ tests/settings.spec.ts (7 tests) 37ms
 ✓ tests/effects.spec.ts (10 tests) 327ms
 ✓ tests/state.spec.ts (16 tests) 229ms
 ✓ tests/store.spec.ts (13 tests) 383ms

 Test Files  9 passed (9)
      Tests  107 passed (107)
   Duration  1.53s

$ pnpm build
ℹ Cleaning 4 files
ℹ [CJS] lib\client.js  42.04 kB │ gzip: 12.48 kB
✔ Build complete in 1829ms
ℹ [ESM] lib\index.js    19.94 kB │ gzip: 6.32 kB
ℹ [ESM] lib\index.d.ts   0.75 kB │ gzip: 0.33 kB
✔ Build complete in 1833ms

$ pnpm format:check
Checking formatting...
All matched files use Prettier code style!

$ git status --porcelain
（空）
```

`pnpm check`（typecheck + test + build）通过。新增测试：**67 条**（engine 23、invariants 15、store 13、effects 10、passes 6），另有 `contract.spec.ts` 新增 1 条分层检查。测试总数从 39 条增加到 107 条。

### 1.1 逐提交验证

用临时 worktree（复用本仓依赖）对 9 个提交分别执行 `tsc --noEmit` 与 `vitest run`，确认历史可独立构建：

| 提交                                                         | typecheck | tests      |
| ------------------------------------------------------------ | --------- | ---------- |
| `feat(core): domain model and engine`                        | OK        | 39 passed  |
| `feat(core): invariants and errors`                          | OK        | 52 passed  |
| `feat(store): sqlite repositories and migration`             | OK        | 52 passed  |
| `feat(app): durable effects and passes`                      | OK        | 52 passed  |
| `test: cover engine, store, effects and passes`              | OK        | 103 passed |
| `docs: document domain, execution and architecture`          | OK        | 103 passed |
| `fix(core): bind assignment session and numeric expiry`      | OK        | 103 passed |
| `test: cover session binding, titles and offset times`       | OK        | 107 passed |
| `docs: record session binding, titles and effects semantics` | OK        | 107 passed |

临时 worktree 在验证后已删除；`git worktree list` 只保留主工作区。

## 2. 不变量到测试的映射

| #    | 不变量                                                                                       | 测试文件 :: 测试名                                                                                         |
| ---- | -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| 1    | 重复 `receive` 同 id → 一条 Decision、`duplicate: true`、计数不重复                          | `core-invariants.spec.ts` :: `1. deduplicates an inbound message by id and counts it once`                 |
| 2    | `approveTask` 仅 `awaiting-approval`；重复批准/拒绝后批准 → `UserError`，无第二个 Assignment | `core-invariants.spec.ts` :: `2. approves only an awaiting task and never creates a second assignment`     |
| 3    | 未批准任务 `assignmentStarted` → 拒绝                                                        | `core-invariants.spec.ts` :: `3. refuses to start an assignment for a task that is not approved`           |
| 4    | `assignmentEnded` 的 assignmentId/状态不匹配 → 抛错且不改状态                                | `core-invariants.spec.ts` :: `4. refuses an assignment report that does not match the running task`        |
| 5    | 同 `idempotencyKey` 两次 `queueReply` → 一条 Outbound                                        | `core-invariants.spec.ts` :: `5. queues one outbound message per idempotency key`                          |
| 6    | `classify(task)` 缺 `approvalTtlMs` → 抛错且无 Task/Approval 残留                            | `core-invariants.spec.ts` :: `6. rolls back a task classification that lacks an approval TTL`              |
| 6b   | 命令写入中途失败 → 整条回滚（注入存储故障）                                                  | `core-invariants.spec.ts` :: `6b. rolls back the writes of a command that fails in the middle`             |
| 7    | `expireTasks` 只过期 `expiresAt <= now`；返回列表；幂等                                      | `core-invariants.spec.ts` :: `7. expires only overdue pending approvals and stays idempotent`              |
| 8    | `cancelTask` running 时结束 Assignment；之后不能改回 succeeded                               | `core-invariants.spec.ts` :: `8. cancels a running task and refuses to revive it through its assignment`   |
| 9    | Thread 计数只在 receive/replySent/任务创建各加一次                                           | `core-invariants.spec.ts` :: `9. increments every thread counter exactly once per domain event`            |
| 10   | 每个命令 `updatedAt` 由注入 clock 决定                                                       | `core-invariants.spec.ts` :: `10. stamps every command with the injected clock`                            |
| 补充 | 缺任务标题也回滚                                                                             | `core-invariants.spec.ts` :: `refuses a task classification without task detail and leaves nothing behind` |
| 补充 | 迟到批准被拒绝                                                                               | `core-invariants.spec.ts` :: `refuses a late approval once its deadline passed`                            |
| 补充 | 偏移时间按数值比较                                                                           | `core-invariants.spec.ts` :: `compares approval deadlines numerically across UTC offsets`                  |
| 补充 | 非法时间抛 `invalidTime`                                                                     | `core-invariants.spec.ts` :: `refuses a malformed time with invalidTime`                                   |
| 补充 | 启动时绑定会话，结束后保留                                                                   | `core-engine.spec.ts` :: `binds the executor session to the assignment and keeps it after the end`         |
| 补充 | 通道标题、改名与空白回退                                                                     | `core-engine.spec.ts` :: `uses the title the channel reports and follows a rename`                         |

## 3. 测试能否失败：变异实验

每个变异都临时改坏实现，运行对应测试，确认测试失败，然后从备份还原（还原后完整套件仍 107 条通过）。

| 变异 | 改动                                                  | 预期失败的测试     | 实测结果                                                                    |
| ---- | ----------------------------------------------------- | ------------------ | --------------------------------------------------------------------------- |
| M1   | `expireTasks` 的边界由 `expiresAt > cutoff` 改为 `>=` | 不变量 7           | `× 7. expires only overdue pending approvals and stays idempotent`          |
| M2   | `receive` 不再把 `inbound` 计数加一                   | 不变量 9           | `× 9. increments every thread counter exactly once per domain event`        |
| M3   | `Engine.command` 去掉 `repos.atomic` 包装             | 6b 中途失败回滚    | `× 6b. rolls back the writes of a command that fails in the middle`         |
| M4   | effects 成功回执始终删除行（丢弃运行中重排的新载荷）  | 运行中重复 enqueue | `× keeps a re-enqueue that arrives while the effect is running`             |
| M5   | 去掉 pass 的单飞判断                                  | passes 单飞        | `× never overlaps one pass with itself`                                     |
| M6   | 审批时间退回 ISO 字符串比较                           | 偏移时间           | `× compares approval deadlines numerically across UTC offsets`              |
| M7   | `assignmentStarted` 不写入 `sessionId`                | 会话绑定           | `× binds the executor session to the assignment and keeps it after the end` |
| M8   | 建 Thread 时忽略通道标题                              | 标题               | `× uses the title the channel reports and follows a rename`                 |

结论：不变量测试、事务测试、effects 重排测试、passes 单飞测试以及第二轮的三项修复都不是空跑。

## 4. 已知缺口与设计取舍

1. **运行中重排的索引取舍**：部分唯一索引保持 `UNIQUE(kind,key) WHERE state IN ('waiting','running')`；运行中 enqueue 覆盖 payload 并 `generation + 1`，当前尝试结束后回到 `waiting` 重跑。按审核要求在 007 文档化了原因与 attempts 重置规则；行为上不丢任务。若未来要求字面「新 waiting 行」，需要改索引或引入独立的运行记录列。
2. **事件持久化未接线**：`Engine.emit` 的订阅者与 `Store.appendEvent` 的连接属于组合根（WS2）；WS1 只提供两者与 `audit` 查询。
3. **目录锁缺失**：按计划留给 WS5；当前依赖 WAL + `busy_timeout`。
4. **只支持 schema v1**：迁移框架已就绪，但没有历史版本可测；`migrate()` 的幂等与新版本拒绝有测试。`messages.title` 直接加入首版 schema（v1 尚未合并发布）。
5. **Effects 的排序粒度**：`pending()` 以 `due_at`、rowid 排序；未实现「同 kind 严格串行」语义（评审未要求），并发由全局 `concurrency` 限制。
6. **标题来源依赖通道**：`InboundMessage.title` 由 WS2 提供；缺失时领域仍回退 targetId / sender.nick，WS1 不猜测真实群名。
7. **发送 unknown 的显式重试**：WS1 只把状态落到终态，retry 命令由 WS4/WS5 实现。

## 5. 自评

- 依赖方向：core 无 I/O、无 `node:*`、无 DSH/app 层引用；契约测试对每个 core 文件逐一检查 import，并新增 app 持久化模块的禁用依赖检查。
- 事务边界：每个写命令一个 `atomic`；内存仓储用全量快照验证回滚；真实 SQLite 有回滚、嵌套拒绝与唯一约束测试。
- 存储：schema/索引/迁移/损坏 JSON/分页/裁剪/KV 均有测试；`StoreCorruptionError` 消息不含 SQL 与路径；`messages.title` 与 `assignments.session_id` 往返有断言。
- Effects：顺序、并发、覆盖等待行、运行中重排、退避与上限、Later、dead、drain 均有测试；`drain` 后 `waiting` 行保留并在下次 `start` 继续。
- Passes：间隔、`runAtStart`、单飞、异常隔离、`stop` 收敛、重复注册/非法间隔均有测试。
- 第二轮审核修复已落地：会话绑定、通道标题、数值时间比较与 `invalidTime`，均有新增测试与变异实验（M6–M8）。
- 与评审文字的差异已在 PR 文档 §2.6 与 §6 列出，未改动 `src/shared`、`package.json`、`src/index.ts`、`http.ts`、client。
- 待决问题：无。effects 语义已按要求在 007 文档化；会话绑定与标题已在领域内落地。
