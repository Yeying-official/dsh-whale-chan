# 007 架构

> 当前状态：WS1 建立 core 领域层、SQLite 存储、持久 effect 队列与 pass 调度器；WS2 实现 dws 通道；WS3 实现人设、提示、分类、检索与回复策略；WS4 实现 DSH 任务执行器、直接调用模型的回复端口与两套 agent preset。HTTP 路由、设置持久化与组合根接线仍属 WS5。**本文是各层整合的统一入口**：每层对外提供什么端口、依赖允许指向哪里，以本文为准。

## 1. 分层与依赖方向

| 层                    | 职责                                                | 允许依赖                              | 禁止                                                         |
| --------------------- | --------------------------------------------------- | ------------------------------------- | ------------------------------------------------------------ |
| `src/shared`          | 设置 schema、API 合约、字段表、边界常量             | 浏览器与 Node 通用的纯模块            | Node 内置模块、宿主实现、DSH 包                              |
| `src/core`            | 领域类型与规则（`Engine`）                          | 本层、`src/shared` 的纯类型           | I/O、`node:*`、`@deepseek-ai/*`、app/channel/executor/client |
| `src/app`             | 存储、迁移、effect 队列、pass 调度、KV、只读查询    | core、shared、Node 本地能力           | channel、executor、client、HTTP 宿主                         |
| `src/channel`（WS2）  | dws 子进程、事件解码、发送参数、目标发现            | shared、core 类型                     | 领域决策、绕过 sender 直接写库                               |
| `src/brain`（WS3）    | 人设/提示渲染、分类、回复策略与生成、检索预算、限流 | shared 设置类型、自有端口             | I/O 直连、DSH 包、core                                       |
| `src/executor`（WS4） | DSH 会话与任务执行、回复器模型、检索适配、preset    | core/brain 的端口类型、DSH 服务、Node | 直接发钉钉消息、写领域存储                                   |
| `src/client`          | Web 面板                                            | shared 类型与字段表                   | 宿主实现、Node 模块、发送层                                  |

```text
                    ┌──────────────┐
   dws 子进程 ◄─────│   channel    │──────► InboundMessage / Outbound
                    └──────┬───────┘
                           │ 领域命令（classify / reply / task …）
                    ┌──────▼───────┐        ┌──────────────┐
                    │    engine    │◄───────│     app      │  Store · Effects · Passes · Kv
                    └──────┬───────┘        └──────┬───────┘
                           │ 领域事件/待办          │ 只读查询
                    ┌──────▼───────┐               │
                    │    brain     │  ModelPort / ResearchPort
                    └──────┬───────┘               │
                           │                       │
                    ┌──────▼───────┐               │
                    │   executor   │  SessionHost  │
                    └──────┬───────┘               │
                           │ DSH 会话              │
                    ┌──────▼───────┐               │
                    │  DSH 宿主    │◄──────────────┘
                    └──────────────┘
```

依赖方向固定为 `client → shared`、`channel / brain / executor → app → core → shared`，且 `brain` 与 `executor` 只通过端口互相看见（`executor` 复用 `brain` 的 `ModelPort`/`ResearchPort` 类型，`brain` 不认识 `executor`）。`tests/contract.spec.ts` 强制检查：

- core 不包含 `require`；每个 import 只能是 `./…` 或 `../shared/…`，不得是 `node:*`、`@deepseek-ai/*` 或 `../app|channel|executor|client`；
- `store`、`store-read`、`migration`、`effects`、`passes`、`kv` 不依赖 channel、executor、client 或 HTTP 宿主；
- client 不依赖宿主实现，shared 不含 Node 内置模块。

## 2. 端到端数据流

一次群聊消息的完整路径：

1. **通道（WS2）**：`DingTalkChannel` 为每个启用目标维持一个 `dws event consume` 子进程，按行解码成 `InboundMessage`，过滤自己发出的消息、广播与无效行，投给 `EventSink`。
2. **领域（WS1）**：app 调用 `engine.receive(message)` 落库并建 Decision（`queued`），随后的写命令各自一个事务。
3. **分类（WS3）**：`classify()` 用 `ModelPort` 判定 `chat|question|task|ignore` 与置信度，app 调 `engine.classify`。
4. **回复（WS3）**：`gateReply()` 读设置与计数器决定是否回、是否需要检索；`composeReply()` 生成并清洗文本；app 调 `engine.draft` 与 `engine.queueReply`，领域写入 Outbound（`pending`）。
5. **任务（WS4）**：`intent: 'task'` 时领域建 Task + Approval，等人在面板批准；批准后 app 交给 `DshTaskExecutor.execute()`，`onStarted`/`onFinished` 映射为 `assignmentStarted`/`assignmentEnded`。
6. **投递（outbox）**：`Effects` 的 `send` handler 取 `pending` Outbound，交给 `DingTalkChannel.send()`；`sent` / `unknown` / `failed` 由 `engine.reportReply` 落库。任务结果也走这条路——执行器不自己发消息。
7. **观察**：`store-read` 的分页查询与 `/whale-chan/api/*` 路由（WS5）供面板读状态；`Passes` 负责批准过期扫描与 effect 重试。

## 3. core 内部

| 模块        | 内容                                                                                                                    |
| ----------- | ----------------------------------------------------------------------------------------------------------------------- |
| `model.ts`  | 领域类型：`InboundMessage`、`Thread`、`Decision`、`Draft`、`Task`、`Approval`、`Assignment`、`Outbound`，全部为只读纯值 |
| `errors.ts` | `UserError` 与稳定错误码表；`missing` 与 `refused` 区分「找不到」与「状态不允许」                                       |
| `ports.ts`  | `Repositories`（同步、事务化）、`Ids`、`Clock`、领域事件类型、`EngineOptions`                                           |
| `engine.ts` | 唯一写入口；每个命令一个事务；读查询不开事务                                                                            |
| `index.ts`  | 唯一公开出口，供 app/channel/executor 引用                                                                              |

`Engine` 构造参数是 `{ repos, ids, clock, emit? }`。它不持有数据库、定时器或日志器，所以可以在纯内存实现上完整测试。

对外签名中与执行器直接相关的两个细节：`assignmentStarted(taskId, assignmentId, { sessionId? })` 在启动派工时绑定执行器会话；`assignmentEnded(taskId, assignmentId, { outcome, result? })` 的 `outcome` 与执行器的 `ExecutorResult.outcome` 是同一套词表。

## 4. app：持久化

### 4.1 `Store`

- `Store.open(stateDir)` 打开 `<stateDir>/state.db`，创建父目录，设置 `journal_mode=WAL`、`synchronous=FULL`、`foreign_keys=ON`、`busy_timeout=5000`。
- 用 `PRAGMA user_version` 记录 schema 版本（当前 `SCHEMA_VERSION = 1`）。`migrate()` 是前向、幂等的：版本相同直接返回，版本更低逐级升级，版本更高直接拒绝（不降级）。
- `atomic(fn)`：`BEGIN IMMEDIATE` / `COMMIT` / `ROLLBACK`；嵌套调用抛错。
- JSON 列读取失败抛 `StoreCorruptionError(table, column, id)`，消息不含 SQL 与文件路径。
- `close()` 关闭句柄；`trimThread(key, keep)` 只裁剪消息，不删 Decision/Task；`appendEvent` 写审计事件。
- `Store` 实现 core 的 `Repositories`，另暴露 `read`（只读查询）与 `db`（供 Effects 使用）。

### 4.2 表与索引

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
| `effects`     | 见 §5                                                                                                                                    | `effects(state, due_at)`、部分唯一索引 |

标量列只用于索引与筛选，聚合的嵌套值以 JSON 列为准；写入时由 Store 同时维护两者。

### 4.3 只读查询（`store-read.ts`）

`listThreads`、`threadMessages`（`before` 为排他时间游标）、`listTasks`（状态筛选）、`pendingApprovals(now)`、`pendingOutbound`、`audit`。全部分页返回 `{ items, nextOffset | nextBefore }`，不写库。行映射与 JSON 解码也在这里，`Store` 复用同一套映射，避免读写两套形状。

### 4.4 KV（`kv.ts`）

`kv` 表是通用持久键值区。`Kv` 提供 `get/set/delete/keys`；`record`/`family` 给后续工作流（设置、游标）注册类型化键。WS1 不预设业务键，避免与 WS5 的设置键冲突。

## 5. app：Effects（持久副作用队列）

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

## 6. 各层的端口与职责

### 6.1 channel（WS2）

| 端口/类型                                                      | 作用                                                                                                 |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `CommandRunner.run`                                            | 执行一次 `dws` 命令；测试替换它，生产用 `cross-spawn` 起子进程                                       |
| `EventSink`                                                    | 接收解码后的 `InboundMessage`；由 app 层提供，负责落库                                               |
| `ChannelLogger`                                                | 已脱敏的日志接口                                                                                     |
| `DingTalkChannel`                                              | 门面：`start/stop/send/sendWithReceipt/discoverGroups/discoverPeers/validateTarget/probeAuth/health` |
| `ChannelSupervisor`                                            | 每个目标一个订阅进程，指数退避重启，`stop()` 不 SIGKILL                                              |
| `DwsTarget` / `TargetCandidate` / `TargetHealth` / `AuthState` | 对外只读状态                                                                                         |

通道不认识领域、不写库、不决定要不要回复；它只把「收到的消息」与「要发的消息」变成 CLI 调用。

### 6.2 brain（WS3）

| 端口/函数                                           | 作用                                                      |
| --------------------------------------------------- | --------------------------------------------------------- |
| `ModelPort.complete(req, signal)`                   | 唯一模型出口；实现方负责路由与重试（WS4 用 DSH 会话实现） |
| `ResearchPort.search(q, {limit,timeoutMs}, signal)` | 唯一检索出口；返回 `{facts, sources}`                     |
| `CounterStore.hit(key, at, windowMs)`               | 限流计数只读视图                                          |
| `PromptSource.get(name)`                            | 五个提示模板；`PromptStore` 从 `prompts/*.md` 读取并缓存  |
| `classify` / `gateReply` / `composeReply`           | 分类、策略闸门、回复生成                                  |
| `renderPersona` / `render`                          | 人设块与模板变量替换                                      |

brain 不开 socket、不 spawn 进程、不 import DSH 包：所有外部能力都在端口后面。

### 6.3 executor（WS4）

| 端口/类型                                                                     | 作用                                                                                                         |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `TaskExecutor.execute/cancel`                                                 | 执行一个已批准任务；`onStarted`/`onFinished` 对应领域两个命令                                                |
| `SessionHost.ensureSession/deliver/awaitTurnEnd/readFinalText/cancel/dispose` | 所有 DSH 调用的唯一入口，按 `SessionRef` 寻址，无跨任务状态                                                  |
| `DshSessionHost`                                                              | 真实实现：`sessionController`、`workspaceRegistry`、`permissionPresets`、`agents`、`session/event`           |
| `DshTaskExecutor`                                                             | worker 会话生命周期、系统提示、超时（单回合 90 秒 / 任务总预算 `timeoutMinutes`）、取消、结果映射            |
| `LlmModel`（`implements ModelPort`）                                          | 回复路径：一次 `ctx.llm.stream`，只带 `system` + 一条 user 消息，无工具/无会话/无工作区（T3 后取代会话实现） |
| `DshResearch`（`implements ResearchPort`）                                    | `ctx.web.search` 适配，空结果/异常/中止一律降级为空                                                          |
| `seedRoleModel` / `routeSelection`                                            | 把 `settings.models.*` 播种到新会话（`model/selection` + 首次请求注入），不改全局默认                        |

执行器不写领域存储、不发钉钉消息；它把任务结果交给 app，由 app 写 `assignmentEnded` 并把摘要转成 Outbound。

执行器也**不从 `src/index.ts` 导出**：宿主入口保持零执行器副作用（不会把 `@deepseek-ai/dsh-llm`、`dsh-session` 拉进插件模块图），由 WS5 的组合根显式 import `src/executor/index.ts`。

### 6.4 outbox（跨层）

「发件箱」不是单独一层，而是三段拼起来的：

1. 领域 `Outbound` 表是唯一权威队列，`idempotency_key` 保证一条外部消息只对应一条记录；
2. app 在命令提交后 `Effects.enqueue('send', key, ...)`；
3. `send` handler 调 `DingTalkChannel.send()`（WS2），把结果回写成 `sent` / `unknown` / `failed`。

`unknown` 永不自动重发：投递结果不可证明时，宁可让人对账，也不重复打扰对方。

## 7. 与其它工作流的边界

| 工作流          | 交界                                                                                                                                                                                                           |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| WS2 通道/执行器 | 调用 `Engine` 命令与 `openTasks`/`pendingApprovals`；启动派工时用 `assignmentStarted(..., { sessionId })` 绑定会话；注册 Effects handler；不直接写 Store，不 import core 内部文件（只经 `src/core/index.ts`）  |
| WS3 人设与检索  | 由 app 生成 Draft 文本后调用 `engine.draft`；领域不读设置                                                                                                                                                      |
| WS4 执行器      | 只经 `TaskExecutor` 与 app 交互；复用 brain 的端口类型；preset 由 `cordis.patch.yml` 声明                                                                                                                      |
| WS5 设置/HTTP   | 通过 `store-read` 提供只读视图，通过 `Engine` 提供命令；组合根用 `DshSessionHost` 构建任务执行器，用 `replyModelFor(ctx, settings.models.reply)` 构建回复端口（**不要**用 `SessionModel`）；不得改动领域状态机 |
| WS6 面板        | 只经 WS5 的 HTTP 合约读状态与发命令                                                                                                                                                                            |

## 8. 测试索引

| 文件                                | 覆盖                                                                              |
| ----------------------------------- | --------------------------------------------------------------------------------- |
| `tests/core-engine.spec.ts`         | 领域命令、事件、会话绑定与标题（23 条）                                           |
| `tests/core-invariants.spec.ts`     | 10 条硬不变量 + 中途失败回滚 + 迟到批准 + 偏移时间与非法时间（15 条）             |
| `tests/store.spec.ts`               | 打开/迁移/索引/往返/回滚/唯一约束/损坏 JSON/分页/裁剪/KV（13 条）                 |
| `tests/effects.spec.ts`             | 顺序、并发、覆盖、运行中重排、退避、上限、Later、dead、drain（10 条）             |
| `tests/passes.spec.ts`              | 间隔、runAtStart、单飞、异常隔离、stop、重复注册（6 条）                          |
| `tests/channel-*.spec.ts`           | dws 参数、解码、发送结果、重启退避、目标发现与授权（WS2）                         |
| `tests/brain-*.spec.ts`             | 分类、闸门、回复清洗、检索预算、人设与提示（WS3）                                 |
| `tests/executor-task.spec.ts`       | 批准门、工作区（批准目录优先）、模型路由、四种结局、回调次数、并发、重试（28 条） |
| `tests/executor-model.spec.ts`      | 提示组装与截断、串行、模型路由、轮数/空闲重建、超时与异常、dispose（19 条）       |
| `tests/executor-research.spec.ts`   | 映射、上限、非 http(s) 过滤、空结果、异常与中止降级（10 条）                      |
| `tests/executor-session.spec.ts`    | 回合匹配、订阅/扫描竞态、超时、中止（13 条）                                      |
| `tests/executor-role-model.spec.ts` | 模型路由映射、空配置不注入、已有选择不覆盖、解析失败回退（12 条）                 |
| `tests/presets.spec.ts`             | 宿主行仍在、两套 preset 的字段与工具集、中性人设前缀、无重复 id（17 条）          |
| `tests/contract.spec.ts`            | 分层依赖规则、共享合约、文档数量                                                  |

## 相关文档

- [001 领域模型](001-domain.md)
- [003 执行](003-execution.md)
- [006 部署](006-deployment.md)
- [010 设计摘要](010-design.md)
- [011 设置合约](011-settings-contract.md)
