# 007 架构

> 当前状态：WS1 建立 core 领域层、SQLite 存储、持久 effect 队列与 pass 调度器。通道、执行器、HTTP 路由与面板仍属后续工作流。

## 1. 分层与依赖方向

| 层                    | 职责                                      | 允许依赖                    | 禁止                                                           |
| --------------------- | ----------------------------------------- | --------------------------- | -------------------------------------------------------------- |
| `src/shared`          | 设置 schema、API 合约、视图模型、边界常量 | 浏览器与 Node 通用的纯模块  | Node 内置模块、宿主实现                                        |
| `src/core`            | 领域类型与规则（Engine）                  | 本层、`src/shared` 的纯类型 | I/O、`node:*`、`@deepseek-ai/*`、`app/channel/executor/client` |
| `src/app`             | 存储、迁移、effect 队列、pass 调度、KV    | core、shared、Node 本地能力 | channel、executor、client、HTTP 宿主                           |
| `src/channel`（WS2）  | dws 子进程、事件解码、发送参数            | shared、app 端口            | 领域决策、绕过 sender                                          |
| `src/executor`（WS2） | DSH 会话与任务执行                        | app/core 端口               | 自己发钉钉消息                                                 |
| `src/client`          | Web 面板                                  | shared 类型与字段表         | 宿主实现、Node 模块、发送层                                    |

依赖方向固定为 `client → shared`、`channel/executor → app → core → shared`。`tests/contract.spec.ts` 强制检查：

- core 不包含 `require`；每个 import 只能是 `./…` 或 `../shared/…`，不得是 `node:*`、`@deepseek-ai/*` 或 `../app|channel|executor|client`；
- `store`、`store-read`、`migration`、`effects`、`passes`、`kv` 不依赖 channel、executor、client 或 HTTP 宿主；
- client 不依赖宿主实现，shared 不含 Node 内置模块。

## 2. core 内部

| 模块        | 内容                                                                                                                    |
| ----------- | ----------------------------------------------------------------------------------------------------------------------- |
| `model.ts`  | 领域类型：`InboundMessage`、`Thread`、`Decision`、`Draft`、`Task`、`Approval`、`Assignment`、`Outbound`，全部为只读纯值 |
| `errors.ts` | `UserError` 与稳定错误码表；`missing` 与 `refused` 区分「找不到」与「状态不允许」                                       |
| `ports.ts`  | `Repositories`（同步、事务化）、`Ids`、`Clock`、领域事件类型、`EngineOptions`                                           |
| `engine.ts` | 唯一写入口；每个命令一个事务；读查询不开事务                                                                            |
| `index.ts`  | 唯一公开出口，供 app/channel/executor 引用                                                                              |

`Engine` 构造参数是 `{ repos, ids, clock, emit? }`。它不持有数据库、定时器或日志器，所以可以在纯内存实现上完整测试。

对外签名中与后续工作流直接相关的两个细节：`assignmentStarted(taskId, assignmentId, { sessionId? })` 在启动派工时绑定执行器会话；`InboundMessage.title` 是通道提供的会话标题，领域只在非空且与现值不同时更新 Thread 标题。

## 3. app：持久化

### 3.1 `Store`

- `Store.open(stateDir)` 打开 `<stateDir>/state.db`，创建父目录，设置 `journal_mode=WAL`、`synchronous=FULL`、`foreign_keys=ON`、`busy_timeout=5000`。
- 用 `PRAGMA user_version` 记录 schema 版本（当前 `SCHEMA_VERSION = 1`）。`migrate()` 是前向、幂等的：版本相同直接返回，版本更低逐级升级，版本更高直接拒绝（不降级）。
- `atomic(fn)`：`BEGIN IMMEDIATE` / `COMMIT` / `ROLLBACK`；嵌套调用抛错。
- JSON 列读取失败抛 `StoreCorruptionError(table, column, id)`，消息不含 SQL 与文件路径。
- `close()` 关闭句柄；`trimThread(key, keep)` 只裁剪消息，不删 Decision/Task；`appendEvent` 写审计事件。
- `Store` 实现 core 的 `Repositories`，另暴露 `read`（只读查询）与 `db`（供 Effects 使用）。

### 3.2 表与索引

| 表            | 关键列                                                                                                                                   | 索引                                   |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| `messages`    | `id` PK、`thread_key`、`kind`、`sender_*`、`text`、`addressed`、`at`、`received_at`、`mentions_json`；WS1 增列 `sender_open_id`、`title` | `messages(thread_key, at)`             |
| `threads`     | `key` PK、`peer_json`、`last_message_at`、`counts_json`                                                                                  | —                                      |
| `decisions`   | `id` PK、`message_id UNIQUE`、`status`、`draft_json`、`outbound_id`、`task_id`、`confidence`（WS1 增列）、`updated_at`                   | `decisions(thread_key, at)`            |
| `tasks`       | `id` PK、`status`、`approval_id`、`assignment_id`、`result_json`、`reason`（WS1 增列）、`updated_at`                                     | `tasks(status, updated_at)`            |
| `approvals`   | `id` PK、`task_id UNIQUE`、`status`、`expires_at`                                                                                        | `approvals(status, expires_at)`        |
| `assignments` | `id` PK、`task_id`、`state`、`session_id`、`workspace`、`outcome`                                                                        | —                                      |
| `outbound`    | `id` PK、`idempotency_key UNIQUE`、`status`、`attempts`                                                                                  | `outbound(status)`                     |
| `events`      | `seq` 自增 PK、`type`、`at`、`data_json`                                                                                                 | `events(at)`                           |
| `kv`          | `k` PK、`v_json`                                                                                                                         | —                                      |
| `effects`     | 见 §4                                                                                                                                    | `effects(state, due_at)`、部分唯一索引 |

标量列只用于索引与筛选，聚合的嵌套值以 JSON 列为准；写入时由 Store 同时维护两者。

### 3.3 只读查询（`store-read.ts`）

`listThreads`、`threadMessages`（`before` 为排他时间游标）、`listTasks`（状态筛选）、`pendingApprovals(now)`、`pendingOutbound`、`audit`。全部分页返回 `{ items, nextOffset | nextBefore }`，不写库。行映射与 JSON 解码也在这里，`Store` 复用同一套映射，避免读写两套形状。

### 3.4 KV（`kv.ts`）

`kv` 表是通用持久键值区。`Kv` 提供 `get/set/delete/keys`；`record`/`family` 给后续工作流（设置、游标）注册类型化键。WS1 不预设业务键，避免与 WS5 的设置键冲突。

## 4. app：Effects（持久副作用队列）

表：

```text
effects(id PK, kind, key, payload_json, state CHECK IN ('waiting','running','dead'),
        attempts, due_at, last_error, created_at, updated_at, generation)
UNIQUE INDEX effects_active ON effects(kind, key) WHERE state IN ('waiting','running')
```

语义：

- `enqueue(kind, key, payload)`：同键的 `waiting` 行直接覆盖为最新载荷并立即到期；同键 `running` 行被覆盖载荷、`generation + 1`，当前尝试结束后该行回到 `waiting` 并以新载荷重跑；否则插入新行。**运行中的重排不会丢任务**，也不会让当前尝试误删新载荷。
- **为什么不是“插入新的 waiting 行”**：部分唯一索引保持 `UNIQUE(kind, key) WHERE state IN ('waiting','running')`，SQLite 不允许同键同时存在一条 `running` 与一条 `waiting`。在运行中 enqueue 时，覆盖该活动行的载荷并递增 `generation`，让结束时的尝试发现代际变化并把行放回 `waiting`，语义上等价于新排队一条任务，同时保留唯一约束与崩溃安全；当前尝试按自己开始时读到的载荷执行，不会读到半更新的数据。
- **attempts 规则**：`waiting` 行被覆盖、或 `running` 行被覆盖时都重置为 0；一次失败 `attempts + 1` 并按 `attempts` 计算退避；`Later` 不计数；成功删除行；达到 `maxAttempts` 转 `dead` 并记录最后一次错误。
- `handle(kind, run, { maxAttempts, baseDelayMs })`：每种 kind 只能注册一个处理器。
- `start({ concurrency })`：并发上限为全局上限；按 `due_at`、行序取到期行。
- 失败退避：`min(5 分钟, baseDelayMs × 2^(attempts-1))` 再加不超过 10% 的抖动；`Later` 延后 1 秒且不计失败次数；达到 `maxAttempts` 置 `dead` 并保留错误。
- `drain()`：先领取当前到期工作，然后停止新的领取，等待运行中的尝试结束；`waiting` 行留给下一次 `start`。
- `idle()`：等到没有运行中的尝试也没有可立即开始的到期行。
- `pending()`/`dead()`：供面板与测试查看状态，返回解码后的载荷。

Effects 不感知领域事务：调用方必须在命令事务提交后入队。这样「先落库、后发送」的顺序在崩溃后仍成立。

## 5. app：Passes（周期相位）

- `register(name, run, { intervalMs, runAtStart })`：同名只能注册一次，间隔必须为正。
- `tick(now)`：按注入时间触发到期的 pass；同一 pass 单飞，正在运行时本次 tick 直接跳过，不排队堆积。
- 单个 pass 抛错（同步或异步）交给 `onError`，不影响其他 pass 的同一轮，也不影响后续轮次。
- `start()` 用 `setInterval` 驱动 `tick(clock.now())`，定时器 `unref` 以便进程退出；`stop()` 清除定时器并等待正在进行的轮次结束。
- `tick(now)` 是测试入口：测试传固定时间即可验证间隔与单飞，不需要真实等待。

## 6. 与其它工作流的边界

| 工作流          | 交界                                                                                                                                                                                                          |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| WS2 通道/执行器 | 调用 `Engine` 命令与 `openTasks`/`pendingApprovals`；启动派工时用 `assignmentStarted(..., { sessionId })` 绑定会话；注册 Effects handler；不直接写 Store，不 import core 内部文件（只经 `src/core/index.ts`） |
| WS3 人设与检索  | 由 app 生成 Draft 文本后调用 `engine.draft`；领域不读设置                                                                                                                                                     |
| WS4 面板        | 通过 app 的只读查询（`store-read`）与 HTTP 路由读状态；批准/拒绝/取消走 `Engine` 命令                                                                                                                         |
| WS5 设置持久化  | 使用 `Kv` 或新增表；不得改动 WS1 的领域状态机与 schema v1 语义，只能追加迁移                                                                                                                                  |

## 7. 测试索引

| 文件                            | 覆盖                                                                  |
| ------------------------------- | --------------------------------------------------------------------- |
| `tests/core-engine.spec.ts`     | 领域命令、事件、会话绑定与标题（23 条）                               |
| `tests/core-invariants.spec.ts` | 10 条硬不变量 + 中途失败回滚 + 迟到批准 + 偏移时间与非法时间（15 条） |
| `tests/store.spec.ts`           | 打开/迁移/索引/往返/回滚/唯一约束/损坏 JSON/分页/裁剪/KV（13 条）     |
| `tests/effects.spec.ts`         | 顺序、并发、覆盖、运行中重排、退避、上限、Later、dead、drain（10 条） |
| `tests/passes.spec.ts`          | 间隔、runAtStart、单飞、异常隔离、stop、重复注册（6 条）              |
| `tests/contract.spec.ts`        | 分层依赖规则、共享合约、文档数量                                      |

## 相关文档

- [001 领域模型](001-domain.md)
- [003 执行](003-execution.md)
- [010 设计摘要](010-design.md)
- [011 设置合约](011-settings-contract.md)
