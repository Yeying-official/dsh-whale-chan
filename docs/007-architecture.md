# 007 架构

> 当前状态：WS1 建立 core 领域层、SQLite 存储、持久 effect 队列与 pass 调度器；WS2 实现 dws 通道；WS3 实现人设、提示、分类、检索与回复策略；WS4 实现 DSH 任务执行器、会话式回复模型与两套 agent preset；WS5a 实现持久化设置服务（schema v2）、管理 API、视图与状态目录锁；WS5b 完成组合根：通道订阅、回复流水线、任务执行与结果回帖、暂停/恢复、过期清扫与真实健康；WS6 实现面板；WS14 增加会话归档、回复器/worker generation 与工作区记录重建；WS15 增加按目标的订阅健康（`GET channel`）、服务端拒绝的可观测性与单聊 open id 出站规则，管理 API 增至 **21 条**。**本文是各层整合的统一入口**：每层对外提供什么端口、依赖允许指向哪里，以本文为准。

## 1. 分层与依赖方向

| 层                    | 职责                                                                                                     | 允许依赖                                                                                                                                                                                                       | 禁止                                                              |
| --------------------- | -------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `src/shared`          | 设置 schema、API 合约、字段表、边界常量                                                                  | 浏览器与 Node 通用的纯模块                                                                                                                                                                                     | Node 内置模块、宿主实现、DSH 包                                   |
| `src/core`            | 领域类型与规则（`Engine`）                                                                               | 本层、`src/shared` 的纯类型                                                                                                                                                                                    | I/O、`node:*`、`@deepseek-ai/*`、app/channel/executor/client      |
| `src/app`             | 存储、迁移、effect 队列、pass 调度、KV、只读查询、会话工作区服务、会话归档与恢复、组合根（`runtime.ts`） | core、shared、Node 本地能力；**仅组合根**可 import channel/executor；`workspaces.ts`、`session-recovery.ts`、`session-archive.ts` 可 import `executor/workspace.ts` / `executor/reply-session.ts` 的纯命名函数 | 除上述例外，app 模块不得依赖 channel、executor、client、HTTP 宿主 |
| `src/channel`（WS2）  | dws 子进程、事件解码、发送参数、目标发现                                                                 | shared、core 类型                                                                                                                                                                                              | 领域决策、绕过 sender 直接写库                                    |
| `src/brain`（WS3）    | 人设/提示渲染、分类、回复策略与生成、检索预算、限流                                                      | shared 设置类型、自有端口                                                                                                                                                                                      | I/O 直连、DSH 包、core                                            |
| `src/executor`（WS4） | DSH 会话与任务执行、回复器模型、检索适配、preset                                                         | core/brain 的端口类型、DSH 服务、Node                                                                                                                                                                          | 直接发钉钉消息、写领域存储                                        |
| `src/client`          | Web 面板                                                                                                 | shared 类型与字段表                                                                                                                                                                                            | 宿主实现、Node 模块、发送层                                       |

```text
                              ┌────────────────────────────────────────────────┐
                              │              src/app/runtime.ts                │
                              │  组合根：启动探测、设置热应用、暂停/恢复、健康  │
                              └───┬───────────┬───────────────┬────────────┬───┘
                                  │           │               │            │
   dws 子进程 ◄───────────────────┘           │               │            │
        │                                     │               │            │
        │ InboundMessage                      │               │            │
        ▼                                     ▼               ▼            ▼
 ┌─────────────┐   receive    ┌──────────────┐  enqueue  ┌──────────┐   ┌────────────┐
 │   channel   │─────────────►│    engine    │◄─────────│ effects  │◄──│   passes   │
 └─────────────┘              └──────┬───────┘  (domain) └────┬─────┘   └────────────┘
        ▲                            │ 领域事件/状态           │ 处理器
        │ send(outbound)             ▼                        │
        │                     ┌──────────────┐                 │
        │                     │  store (SQLite)│  events / kv     │
        │                     └──────────────┘                 │
        │                            │ 读 / 写                  │
        │                            ▼                        ▼
        │                     ┌──────────────┐          ┌──────────────┐
        │                     │   brain      │◄─────────│   executor   │
        │                     │ policy/reply │  ports   │  DSH 会话    │
        │                     └──────┬───────┘          └──────┬───────┘
        │                            │                         │
        └──────── outbox ◄───────────┴───── SessionHost ────────┘
                    （Outbound 表 · 幂等键 · send effect）
```

更准确地说，`effects` 是唯一的异步驱动者：`classify → research → compose → send` 与 `launch → finish → send` 都是持久 effect；`passes` 只负责「到期」与「启动恢复」，不解释业务。`channel` 不知道领域，`engine` 不做 I/O，`brain` 与 `executor` 只经端口看见彼此。

依赖方向固定为 `client → shared`、`channel / brain / executor → core → shared`，`src/app` 的存储与调度模块只依赖 core/shared/Node，**只有组合根** `runtime.ts`（及其 `dingtalk-channel.ts` 适配器）可以 import `src/channel` 与 `src/executor`。app 层另有一组**纯命名例外**，只复用 executor 中的无 I/O 模块：`src/app/workspaces.ts` 用 `src/executor/workspace.ts` 的目录/标题命名；`src/app/session-recovery.ts` 用 `src/executor/reply-session.ts` 的 `replySessionIdForGeneration`/`threadDigest`；`src/app/session-archive.ts` 用 `src/executor/workspace.ts` 的 `isSameWorkspacePath`。这些被复用的模块只有 `crypto` + `path`，不碰 DSH 服务、HTTP 或会话；若让 app 各写一份，“会话 id 怎么算”“两个路径算不算同一个目录”就会有两套实现并悄悄漂移。`brain` 与 `executor` 只通过端口互相看见（`executor` 复用 `brain` 的 `ModelPort`/`ResearchPort` 类型，`brain` 不认识 `executor`）。`tests/contract.spec.ts` 强制检查：

- core 不包含 `require`；每个 import 只能是 `./…` 或 `../shared/…`，不得是 `node:*`、`@deepseek-ai/*` 或 `../app|channel|executor|client`；
- `store`、`store-read`、`migration`、`effects`、`passes`、`kv` 不依赖 channel、executor、client 或 HTTP 宿主；
- client 不依赖宿主实现，shared 不含 Node 内置模块。

## 2. 端到端数据流

一次群聊消息的完整路径：

1. **通道（WS2）**：`DingTalkChannel` 为每个启用目标维持一个 `dws event consume` 子进程，按行解码成 `InboundMessage`，过滤自己发出的消息、广播与无效行，投给 `EventSink`。
2. **领域（WS1）**：app 调用 `engine.receive(message)` 落库并建 Decision（`queued`），随后的写命令各自一个事务。
3. **分类（WS3）**：`classify()` 用 `ModelPort` 判定 `chat|question|task|ignore` 与置信度，app 调 `engine.classify`。
4. **回复（WS3）**：`gateReply()` 读设置与计数器决定是否回、是否需要检索；`composeReply()` 生成并清洗文本（正文按 `persona.maxReplyChars` 截断，引用脚注按 `CITATIONS_MAX_CHARS` 逐行取舍或整体丢弃）；可重试失败（`empty`/`sanitized_empty`/`model_error`）在 `reply.autoRetry` 开启时**最多重试一次**，重试携带上一次的 `research` 结果，只累加 `decisions.attempts` 并写 host 日志；第二次仍失败才 `defer`。app 调 `engine.draft` 与 `engine.queueReply`，领域写入 Outbound（`pending`）。
5. **任务（WS4）**：`intent: 'task'` 时领域建 Task + Approval，等人在面板批准；批准后 app 交给 `DshTaskExecutor.execute()`，`onStarted`/`onFinished` 映射为 `assignmentStarted`/`assignmentEnded`。
6. **投递（outbox）**：`Effects` 的 `send` handler 取 `pending` Outbound，交给 `DingTalkChannel.send()`；`sent` / `unknown` / `failed` 分别由 `replySent`/`replyUnknown`/`replyFailed` 或 `outboundSent`/`outboundUnknown`/`outboundFailed` 落库。任务结果也走这条路——执行器不自己发消息。
7. **观察与清扫**：`store-read` 的分页查询与 `/whale-chan/api/*` 路由供面板读状态；`Passes` 负责批准过期扫描（60 s）、授权探测（5 min）与启动时的 outbox 恢复。

## 3. core 内部

| 模块        | 内容                                                                                                                    |
| ----------- | ----------------------------------------------------------------------------------------------------------------------- |
| `model.ts`  | 领域类型：`InboundMessage`、`Thread`、`Decision`、`Draft`、`Task`、`Approval`、`Assignment`、`Outbound`，全部为只读纯值 |
| `errors.ts` | `UserError` 与稳定错误码表；`missing`/`invalid`/`refused` 区分「找不到」「输入可纠正」「状态不允许」                    |
| `ports.ts`  | `Repositories`（同步、事务化）、`Ids`、`Clock`、领域事件类型、`EngineOptions`                                           |
| `engine.ts` | 唯一写入口；每个命令一个事务；读查询不开事务                                                                            |
| `index.ts`  | 唯一公开出口，供 app/channel/executor 引用                                                                              |

`Engine` 构造参数是 `{ repos, ids, clock, emit? }`。它不持有数据库、定时器或日志器，所以可以在纯内存实现上完整测试。

对外签名中与执行器直接相关的两个细节：`assignmentStarted(taskId, assignmentId, { sessionId? })` 在启动派工时绑定执行器会话；`assignmentEnded(taskId, assignmentId, { outcome, result? })` 的 `outcome` 与执行器的 `ExecutorResult.outcome` 是同一套词表。

## 4. app：持久化

### 4.1 `Store`

- `Store.open(stateDir)` 打开 `<stateDir>/state.db`，创建父目录，设置 `journal_mode=WAL`、`synchronous=FULL`、`foreign_keys=ON`、`busy_timeout=5000`。
- 用 `PRAGMA user_version` 记录 schema 版本（当前 `SCHEMA_VERSION = 2`）。`migrate()` 是前向、幂等的：版本相同直接返回，版本更低逐级升级，版本更高直接拒绝（不降级）。v1→v2 只新增设置三表，可重复执行。
- `atomic(fn)`：`BEGIN IMMEDIATE` / `COMMIT` / `ROLLBACK`；嵌套调用抛错。
- JSON 列读取失败抛 `StoreCorruptionError(table, column, id)`，消息不含 SQL 与文件路径。
- `close()` 关闭句柄；`trimThread(key, keep)` 只裁剪消息，不删 Decision/Task；`appendEvent` 写审计事件。
- `Store` 实现 core 的 `Repositories`，另暴露 `read`（只读查询）与 `db`（供 Effects 使用）。

### 4.2 表与索引

| 表                 | 关键列                                                                                                                                   | 索引                                   |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| `messages`         | `id` PK、`thread_key`、`kind`、`sender_*`、`text`、`addressed`、`at`、`received_at`、`mentions_json`；WS1 增列 `sender_open_id`、`title` | `messages(thread_key, at)`             |
| `threads`          | `key` PK、`peer_json`、`last_message_at`、`counts_json`                                                                                  | —                                      |
| `decisions`        | `id` PK、`message_id UNIQUE`、`status`、`draft_json`、`outbound_id`、`task_id`、`confidence`（WS1 增列）、`updated_at`                   | `decisions(thread_key, at)`            |
| `tasks`            | `id` PK、`status`、`approval_id`、`assignment_id`、`result_json`、`reason`（WS1 增列）、`updated_at`                                     | `tasks(status, updated_at)`            |
| `approvals`        | `id` PK、`task_id UNIQUE`、`status`、`expires_at`                                                                                        | `approvals(status, expires_at)`        |
| `assignments`      | `id` PK、`task_id`、`state`、`session_id`、`workspace`、`outcome`                                                                        | —                                      |
| `outbound`         | `id` PK、`idempotency_key UNIQUE`、`status`、`attempts`                                                                                  | `outbound(status)`                     |
| `events`           | `seq` 自增 PK、`type`、`at`、`data_json`                                                                                                 | `events(at)`                           |
| `kv`               | `k` PK、`v_json`                                                                                                                         | —                                      |
| `settings`         | `block` PK、`value_json`、`revision`、`updated_at`                                                                                       | —                                      |
| `settings_history` | `id` 自增 PK、`block`、`value_json`、`revision`、`source`、`saved_at`                                                                    | `settings_history(block, id)`          |
| `settings_meta`    | `id`（固定 1）、`revision`、`updated_at`                                                                                                 | —                                      |
| `effects`          | 见 §5                                                                                                                                    | `effects(state, due_at)`、部分唯一索引 |

标量列只用于索引与筛选，聚合的嵌套值以 JSON 列为准；写入时由 Store 同时维护两者。

### 4.3 只读查询（`store-read.ts`）

`listThreads`、`threadMessages`（`before` 为排他时间游标）、`listTasks`（状态筛选）、`pendingApprovals(now)`、`pendingOutbound`、`audit`。全部分页返回 `{ items, nextOffset | nextBefore }`，不写库。行映射与 JSON 解码也在这里，`Store` 复用同一套映射，避免读写两套形状。

### 4.4 KV（`kv.ts`）

`kv` 表是通用持久键值区。`Kv` 提供 `get/set/delete/keys`；`record`/`family` 给后续工作流（设置、游标）注册类型化键。WS1 不预设业务键，避免与 WS5 的设置键冲突。

### 4.5 设置服务（`settings.ts`，WS5a）

- `SettingsService(store, clock)`：启动时把 `settings` 表读入内存；缺失/损坏/不再匹配 schema 的行回退默认值并记入 `warnings()`，启动不失败，`view()` 仍包含全部 9 个 block。
- `update(block, patch, expectedRevision)`：块内深合并（数组/标量/null 替换）+ `SettingsSchema` strict 校验 + **单事务**写 `settings`、`settings_history`、`settings_meta`；revision 不匹配抛 `SettingsConflictError`（HTTP 409）。
- `patchInternal(block, patch, source = 'internal')`：宿主系统写入（如暂停），不要求 expected revision，仍校验、仍记 history。
- `view()`、`persona()`、`current()`、`history(block?)`、`onChange(listener)`；全局 revision 缺失或落后时启动会向上修复。

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

### 5.1 已注册的 effect 种类（WS5b）

| kind       | key            | 输入 payload                                             | 下一步                                                                                                                                                  | 幂等依据                                             |
| ---------- | -------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| `classify` | `decisionId`   | `{decisionId}`                                           | `research` / `compose` / 终点（task、ignore、defer）                                                                                                    | `decision.status === 'queued'`                       |
| `research` | `decisionId`   | `{decisionId}`                                           | `compose`（带 `ResearchResult`，降级也继续）                                                                                                            | `classified` + `intent === 'question'`               |
| `compose`  | `decisionId`   | `{decisionId, research?}`（重试原样携带同一 `research`） | `draft`；`auto` 再 `queueReply` 并 enqueue `send`；可重试失败在 `reply.autoRetry` 开启时重试一次（只累加 `attempts`），第二次仍失败或不可重试则 `defer` | 只处理 `classified`；闸门拒绝或失败终态一律 `defer`  |
| `send`     | `outboundId`   | `{outboundId, decisionId?, threadKey?}`                  | `replySent`/`outboundSent`（或 unknown/failed）                                                                                                         | 只处理 `outbound.status === 'pending'`               |
| `launch`   | `taskId`       | `{assignmentId?, workspace?}`                            | `finish`（成功）或 `notify`（失败/拒绝）                                                                                                                | 只处理 `approved` + `approved` 批准 + `pending` 派工 |
| `finish`   | `taskId`       | `{taskId, assignmentId, summary, sessionId}`             | `queueFollowup` 后 enqueue `send`                                                                                                                       | 任务必须 `succeeded`；外发键固定                     |
| `probe`    | `auth`         | 无                                                       | 更新健康；授权失效则停通道                                                                                                                              | 探测只读；重复执行无副作用                           |
| `notify`   | `kind:目标 id` | `{kind, taskId?, outboundId?, decisionId?, …}`           | 写一条 `notice` 审计事件（v1 不建 DSH 会话）                                                                                                            | 事件追加，重复写只影响审计                           |

`finish` 的群回复只渲染任务标题与面向发起人的摘要：按行剔除 `Route:`、`Aegis Reason Note:`、`会话：`、`Session:` 等内部行后再折叠、截断；`sessionId` 只留在任务结果/审计与面板，不进入 outbound 文本。

任务结果回帖**不经过 Decision**：`Engine.queueFollowup` 直接落一条 `Outbound`，`outbound.queued/sent/unknown/failed/dropped` 是它自己的生命周期（见 §6.4）。

## 6. 各层的端口与职责

### 6.1 channel（WS2）

| 端口/类型                                                      | 作用                                                                                                 |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `CommandRunner.run`                                            | 执行一次 `dws` 命令；测试替换它，生产用 `cross-spawn` 起子进程                                       |
| `EventSink`                                                    | 接收解码后的 `InboundMessage`；由 app 层提供，负责落库                                               |
| `ChannelLogger`                                                | 已脱敏的日志接口                                                                                     |
| `DingTalkChannel`                                              | 门面：`start/stop/send/sendWithReceipt/discoverGroups/discoverPeers/validateTarget/probeAuth/health` |
| `ChannelSupervisor`                                            | 每个目标一个订阅进程，指数退避重启，服务端拒绝单独计数，`stop()` 不 SIGKILL                          |
| `DwsTarget` / `TargetCandidate` / `TargetHealth` / `AuthState` | 对外只读状态；`TargetHealth` 带 `state`/`restarts`/`readyAt`/`lastError`（脱敏）                     |

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

| 端口/类型                                                                     | 作用                                                                                                                                                                                    |
| ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TaskExecutor.execute/cancel`                                                 | 执行一个已批准任务；`onStarted`/`onFinished` 对应领域两个命令                                                                                                                           |
| `SessionHost.ensureSession/deliver/awaitTurnEnd/readFinalText/cancel/dispose` | 所有 DSH 调用的唯一入口，按 `SessionRef` 寻址，无跨任务状态                                                                                                                             |
| `DshSessionHost`                                                              | 真实实现：`sessionController`、`workspaceRegistry`、`permissionPresets`、`agents`、`session/event`；`ensureSession` 只在显式 `workspaceTitle` 时 `setTitle`，任务加入会话工作区不会改名 |
| `DshTaskExecutor`                                                             | worker 会话生命周期、系统提示、超时（单回合 90 秒 / 任务总预算 `timeoutMinutes`）、取消、结果映射；批准未指定目录时使用注入的会话工作区                                                 |
| `SessionModel`（`implements ModelPort`）                                      | 每个线程一个可见 DSH 会话（`whale-reply-*`），带 replier preset 与工具；串行、限轮、限时、限长；工作区由注入的 `workspaceFor` 按会话解析                                                |
| `conversationWorkspace` / `conversationWorkspaceTitle`（`workspace.ts`）      | 纯函数：`<root>/conversation-<sha256(threadKey) 前 16 位>` 与 `钉钉 · <标题>`；`WORKSPACE_LAYOUT_VERSION` 只参与会话 id                                                                 |
| `WorkspaceService`（`src/app/workspaces.ts`）                                 | 根解析（`tasks.workspaceRoot` → `<stateDir>/workspaces`）、目标投影、启用群/单聊的 best-effort 预建与标题更新                                                                           |
| `DshResearch`（`implements ResearchPort`）                                    | `ctx.web.search` 适配，空结果/异常/中止一律降级为空                                                                                                                                     |
| `seedRoleModel` / `routeSelection`                                            | 把 `settings.models.*` 播种到新会话（`model/selection` + 首次请求注入），不改全局默认                                                                                                   |

执行器不写领域存储、不发钉钉消息；它把任务结果交给 app，由 app 写 `assignmentEnded` 并把摘要转成 Outbound。

**工作区归属**：一个会话一个目录，名字由 `threadKey` 的 SHA-256 前 16 位决定，回复器与任务共用。纯命名规则在 `src/executor/workspace.ts`（无宿主依赖），根、目标预建和注册表写在 `src/app/workspaces.ts`；`Runtime` 把同一个解析器注入 `SessionModelPool` 与 `DshTaskExecutor`，HTTP 批准/重试的缺省目录也走它，因此三条路径不可能算出不同目录。`at-me` 与 `open:` 目标没有单一会话，只在首条消息时惰性创建。

回复器使用真实 DSH 会话，因此回合结算必须经过 TurnTracker：DSH 先写 inbox 的 `user/message`、再发 `turn/start`；未认领的消息只能由下一个 `turn/start` 认领，不能用上一轮 `turn/end` 结算。T3 真机“7–12 秒完成却超时”的根因就在这里（`05762fa` 修复），与 replier preset 的工具 schema 无关。`LlmModel`（`src/executor/llm-model.ts`）是未接线的直连实验，仅保留作对照。

执行器也**不从 `src/index.ts` 导出**：宿主入口保持零执行器副作用（不会把 `@deepseek-ai/dsh-llm`、`dsh-session` 拉进插件模块图），由 WS5 的组合根显式 import `src/executor/index.ts`。

### 6.4 outbox（跨层）

「发件箱」不是单独一层，而是三段拼起来的：

1. 领域 `Outbound` 表是唯一权威队列，`idempotency_key` 保证一条外部消息只对应一条记录；
2. app 在命令提交后 `Effects.enqueue('send', key, ...)`；
3. `send` handler 调 `DingTalkChannel.send()`（WS2），把结果回写成 `sent` / `unknown` / `failed`。

`unknown` 永不自动重发：投递结果不可证明时，宁可让人对账，也不重复打扰对方。

Outbound 有两条入口，共用同一个发送处理器：

| 入口           | 领域命令                                | 绑定 Decision | 发送结果回写                                                              |
| -------------- | --------------------------------------- | ------------- | ------------------------------------------------------------------------- |
| 回复           | `queueReply(decisionId, …)`             | 是            | `replySent` / `replyUnknown` / `replyFailed`                              |
| 任务结果与通知 | `queueFollowup({threadKey, target, …})` | 否            | `outboundSent` / `outboundUnknown` / `outboundFailed` / `outboundDropped` |

`queueFollowup` 校验线程存在、`target.kind` 与线程 kind 一致、文本非空，并按 `idempotency_key` 去重；`outboundSent/Unknown/Failed/Dropped` 只更新 `pending` 行，重复上报不改变终态。启动恢复与暂停恢复都只做一件事：把 `pending` 行重新 enqueue `send`。

### 6.5 app：HTTP（WS5a）

`createHttpHandler(HttpDeps)` 实现 21 条冻结路由；`httpDeps(runtime)` 用 getter 惰性取 `settings`/`store`/`engine`/`effects`/`clock`，因此路由可以在启动完成前挂载，未就绪时统一返回 503。`Runtime` 打开 `<stateDir>/state.db`、`SettingsService`、`Engine`、`Effects`，并持有 `<stateDir>/.lock`（proper-lockfile，stale 10 s）。通道端口 `ChannelPort` 来自组合根；没有通道时 `targets/discover|validate` 返回 503 `channel_unavailable`。任务动作只 `enqueue('launch', …)`，实际执行由 `launch` handler 负责。

视图全部由 `src/app/views.ts` 从领域对象投影到 `src/shared/models.ts`：domain `approved` → 面板 `queued`，审计行来自 `events` 表（引擎事件由 Runtime 的 `emit` 写入）。`targetsView` 额外填充只读的 `workspace` 投影（`ready` 带具体目录，`per-conversation` 的 `path` 为 `null`），字段来自 `WorkspaceService`，不落库、不可写。

### 6.6 组合根（WS5b，`src/app/runtime.ts`）

组合根只做装配与生命周期，不实现业务规则：

1. **存储先行**：`mkdir` → 锁 → `Store.open` → `SettingsService` → `Engine` → `Effects` → 持久计数器（KV）。
2. **提示词预载**：`PromptStore.preload()`；缺失/空白模板记为 health `prompts: error`，且**通道、流水线与 effect 队列都不装配**。模板属于包完整性的一部分，半运行只会让 classify/compose 反复失败；修复需要重新安装完整 bundle。
3. **授权探测**：构造探测用的 `DingTalkChannel`（无 owner），调用 `probeAuth()`。`available && authenticated && tokenValid && userId` 缺一不可；缺失时 health 红、**不启动订阅**。探测返回的可选 `userName`（auth 的 `user_name`）在启动运行通道时作为 `ownerNick` 传入——群事件没有 `staffId`/`atUsers`，正文里的 `@昵称` 是唯一的 addressed 信号；该值只在内存中，不落库、不记日志。
4. **服务装配**：`WorkspaceService`（根 + 目标预建）→ `DshSessionHost` → `SessionModelPool`（每线程一个可见 `whale-reply-*` 会话，工作区为该会话的 `conversation-<digest>`，persona/models 变更时重建）→ `DshResearch` → `DshTaskExecutor`（注入同一工作区解析器）；注册全部 effect handler；`Passes` 注册 `expire`（60 s，启动即跑）与 `probe`（5 min）。
5. **启动**：`Effects.start({concurrency: 8})` → `Passes.start()` → 有 owner 时 `channel.start(sink)`；`sink` 调 `engine.receive` 并对新 decision enqueue `classify`。
6. **崩溃恢复**：通道启动后 `resumeOutbox()` 把所有 `pending` Outbound 重新 enqueue `send`。
7. **设置热应用**：`persona` 变 → 重建回复器会话；`models` 变 → 更新路由并重建 `SessionModel`；`monitor` 变 → 立即 reconcile（暂停即停通道）；`targets` 变 → 立即 best-effort 预建新启用目标的工作区，再 500 ms 防抖重启订阅；`tasks` 变 → 重新预建（`workspaceRoot` 可能移动了根，旧目录保留）；`dws` 变 → 500 ms 防抖后重启订阅。
8. **停止顺序**（可重复调用）：取消生命周期信号 → `effects.drain()`（不再领取新行，等待运行中的尝试）→ `channel.stop()` → `executor.dispose()` → `model.dispose()` → `passes.stop()` → `sessionHost.dispose()` → 释放锁、关闭数据库。

健康字段（`GET health` 的 `checks`；`dws` 汇总在顶层）：

| check      | 来源                                                      | error 条件                                                                                                                                                     |
| ---------- | --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `state`    | `Runtime.info()`                                          | 无                                                                                                                                                             |
| `stateDir` | 目录可写                                                  | 不可写                                                                                                                                                         |
| `database` | `state.db` 打开、schema 版本                              | 未打开                                                                                                                                                         |
| `lock`     | 状态目录锁                                                | 锁丢失为 degraded                                                                                                                                              |
| `settings` | 加载警告                                                  | 有警告为 degraded                                                                                                                                              |
| `prompts`  | 五份模板预载                                              | 缺失/空白 → error                                                                                                                                              |
| `effects`  | `pending`/`dead` 计数                                     | 有 dead 行 → degraded                                                                                                                                          |
| `channel`  | 通道 health（state/running/targets）、启动错误            | 启动失败或授权无效 → error；禁用/暂停/无 enabled target → `ok`（idle）；应有订阅却 stopped → degraded；目标 `failed` 的具体原因在 `GET channel` 的 `lastError` |
| `auth`     | `probeAuth()` 的 available/authenticated/tokenValid/owner | 未安装、未登录、token 失效、无账号 id → error                                                                                                                  |
| `executor` | 是否装配、运行中的任务数                                  | 未装配 → degraded `unknown`（仅 API-only 模式）                                                                                                                |

`monitor.running` 与 `overview.monitor.running` 取真实通道运行状态，不再写死 `false`。

### 6.7 配置与并发

- `tasks.maxConcurrent` 由 app 层的 `launch` handler 执行：达到上限时抛 `Later`，effect 在 1 秒后重试，不会堆积第二个运行。执行器自身只保证「同一任务不并发」。
- `Effects` 的并发为 8：长时间的 `launch` 不会阻塞 `classify`/`send`。
- 通知（`notify`）v1 只写 `notice` 审计事件，便于 audit/overview 排障；不创建 DSH 收件箱会话。

### 6.8 会话归档与恢复（WS14）

**问题**：DSH 会话一旦被归档，宿主会在 `agent/pre-step` 用归档闸门拒绝投递；工作区记录被人在 DSH 里删掉后，目录可能还在，但新会话没有可归属的记录。两者都会让“这个群还能不能回”取决于人有没有在 DSH 里点过东西。

**两个持久事实**（KV，`src/app/session-recovery.ts`）：

| 键                                        | 值                  | 写入时机                                     |
| ----------------------------------------- | ------------------- | -------------------------------------------- |
| `session.reply-generation:<threadKey>`    | `{ generation: n }` | 当前回复器命中归档集合，或显式 attach 失败时 |
| `session.worker-generation:<baseSession>` | `{ generation: n }` | worker 基 id 命中归档集合时                  |

两者都只增不减。`g0` 的会话 id 与历史公式逐字节相同（`<threadKey>\0<layout>`），`g>0` 追加 `\0g<n>`（纯函数在 `src/executor/reply-session.ts`）。worker 用 `<base>-g<n>`，`g0` 即历史 id。

**每轮预检**（`ConversationSessions.prepareReply`，在 per-thread 互斥里）：

```text
mkdir(path, 0700)
  └─ registry.resolveByPath(path)
       ├─ 存在 → 原样复用（绝不 setTitle）
       └─ 缺失 → create(path, title) → 本轮新建
                   └─ attachSession(候选)：成功则附着；显式候选失败 → generation+1
                                          隐式候选失败 → 不推进（ensureSession 会新建）
skipArchived(generation)：命中 archivedSessionIds 就前进，最多 32 步，并持久化
```

`mkdir`/`resolveByPath`/`create` 抛错时**不**让本轮失败：记 warning，沿用当前 generation 返回（归档轮换只需要归档集合，因此仍然生效）。返回 `{sessionId, workspace, generation, rotated, workspaceRecreated, attached}`。

**回复模型**（`src/executor/model.ts`）：每轮先预检；返回 id 与缓存不同 → `host.cancel(旧会话, 'replier session rotated')`、清空缓存、`fresh: true` 新建。投递后回合 `failed` 且 `detail` 含 `blocked`（闸门拒绝）→ 再预检一次，用 `<requestId>:r1` 重试一次；第二次仍 blocked 按普通失败上抛。超时/中止/`deliver` 自身抛错不走这条重试。

**任务执行器**（`src/executor/task.ts`）：先 `prepareSessionId`（→ `ensureWorkerSessionId`）再 `prepareWorkspace`，然后 `ensureWorkspace`（重建 registry 记录），最后 `ensureSession`。顺序保证取消能定位到正确的 `run.sessionId`，且 worker 不会跑在未注册目录。

**归档命令**（`src/app/session-archive.ts`，`POST targets/:id/archive-sessions`）：

1. settings 的 `targets.rows` 用 `find` 取首行；缺失 → `unknown_target` 404；`targetThreadKey` 为空 → `per_conversation_workspace` 400；未装配 registry → `state_unavailable` 503。
2. 候选并集：registry 同路径记录的 `sessionIds` ∪ `sessionPersistence` 中 `header.cwd` 同路径的 id ∪ 当前回复器 id；路径两边 `realpath`（失败退回 `resolve`）后用 `isSameWorkspacePath` 比较，一次 pass 内缓存。
3. 排序后截断到 500（当前回复器不丢），`truncated`/`candidateCount` 如实返回。
4. 已在归档集合 → `alreadyArchived`；否则 `archiveSession(id, {stopActivity})`，按错误名分到 `refused`（活动会话，activity 归一化）/`missing`（未知会话）/`failed`（其它，内部消息只进日志）。
5. 重新读一次 `archivedSessionIds`；**当前**回复器在其中才 `rotateReplySession`（判据是宿主现状，不是本次是否尝试过）。
6. 审计 `workspace.sessions-archived`（`actor=owner`），记录 threadKey、targetId 与四类计数。

**与其它组件的关系**：

- `Runtime` 装配 `ConversationSessions` 与 `SessionArchiveService`，把 `prepareReply` 注入 `SessionModelPool`、把 `ensureWorkspace`/`prepareSessionId` 注入 `DshTaskExecutor`；`registry`/`sessionPersistence` 缺席时归档路由返回 503，回复与任务退回历史行为（`g0`）。
- 归档命令与回复预检共用同一把 per-thread 锁，所以“归档并轮换”对一条消息是原子的：要么消息先预检（随后被归档并被替换），要么后预检（已看到新一代）。
- `archivedSessionIds`、`archiveSession` 的行为属于宿主（DSH 归档闸门）；本插件只读归档集合、调用归档，不实现归档存储。

**边界**：不删目录、不删文件、不删会话日志、不 unarchive、无回滚；generation 只增，所以在 DSH 手动 unarchive 旧会话不会恢复上下文。候选 >500 时只处理有序前缀，已归档候选仍占名额。审计只记计数，不记 session id 列表。

### 6.9 订阅健康与错误（WS15）

订阅状态不在数据库里，它是一条**只读投影链**：

```text
DwsProcess / ChannelSupervisor       每个目标一个 child，state ∈ starting|ready|stopped|failed|orphaned
        │  TargetHealth{state,restarts,readyAt,lastError}
        ▼
DingTalkChannel.health()             { state, running, targets[] }（聚合状态由目标状态推导）
        │
        ▼
Runtime.status() → RuntimeServiceStatus.channelState / channelTargets / channelError
        │
        ├─▶ GET health 的 channel 检查项（健康徽标、概览）
        └─▶ channelView() → ChannelHealthView → GET channel → 目标页「订阅」列
```

- **`running` 是派生的**：`channelState !== 'stopped'`；`stopped` 是“没有任何订阅”的唯一聚合状态，所以面板不需要第二个布尔。
- **`lastError` 只存最近一次失败/拒绝**，写入前 `redact` + 压成单行 + 截断 240 字符；`GET channel` 原样透出，面板用 `title` 保留全文。它是数据而不是文案，不做翻译。
- **失败语义**：服务端拒绝（stdout 上的 `{"error":{…}}`）先记原因再进入退避；连续 3 次拒绝且没有 `retry_after_seconds` 时**不再重启**，`state` 停在 `failed`，避免用退出噪音覆盖真实原因。启动错误（`ChannelError`）记在 `RuntimeServiceStatus.channelError`，与目标级 `lastError` 分开。
- **`GET channel` 不写库、不改状态**：它不触发重启、不清空 `lastError`，也不读写设置；运行时未就绪返回 `503 state_unavailable`。面板把它当纯增量数据源——该路由失败时表格少一列，编辑/保存/发现/校验/归档完全不受影响。
- **`orphaned` 只是标签**：进程没能在宽限期内退出时保留可见，清理仍靠 `dws event stop`（见 009 §6），`GET channel` 不会代替运维动手。

## 7. 与其它工作流的边界

| 工作流          | 交界                                                                                                                                                                                                                                                                                       |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| WS2 通道/执行器 | 调用 `Engine` 命令与 `openTasks`/`pendingApprovals`；启动派工时用 `assignmentStarted(..., { sessionId })` 绑定会话；注册 Effects handler；不直接写 Store，不 import core 内部文件（只经 `src/core/index.ts`）                                                                              |
| WS3 人设与检索  | 由 app 生成 Draft 文本后调用 `engine.draft`；领域不读设置                                                                                                                                                                                                                                  |
| WS4 执行器      | 只经 `TaskExecutor` 与 app 交互；复用 brain 的端口类型；preset 由 `cordis.patch.yml` 声明                                                                                                                                                                                                  |
| WS5 设置/HTTP   | 通过 `store-read` 提供只读视图，通过 `Engine` 提供命令；组合根用 `DshSessionHost` 同时构建 worker 执行器与 `SessionModel`（回复器会话）；`launch`/`finish`/`send` 由 app 注册，不改领域状态机                                                                                              |
| WS6 面板        | 只经 WS5 的 HTTP 合约读状态与发命令                                                                                                                                                                                                                                                        |
| WS14 归档/恢复  | app 层的 `session-recovery.ts` 只读 `workspaceRegistry`（`resolveByPath`/`create`/`archivedSessionIds`）与 KV；`session-archive.ts` 只读 registry `list`/`archivedSessionIds`、`sessionPersistence.list` 并调用 `archiveSession`；executor 只经组合根注入的两个回调参与，不直接写 app 状态 |
| WS15 订阅健康   | `channel` 只产出 `TargetHealth`（含脱敏 `lastError`），不认识 HTTP 与设置；`views.ts` 的 `channelView` 只做投影；面板只经 `GET channel` 读，不持有订阅状态、不触发重启                                                                                                                     |

## 8. 测试索引

| 文件                                | 覆盖                                                                                                                                                 |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tests/core-engine.spec.ts`         | 领域命令、事件、会话绑定与标题；`recordReplyAttempt` 只接受 `classified`（29 条）                                                                    |
| `tests/core-invariants.spec.ts`     | 10 条硬不变量 + 中途失败回滚 + 迟到批准 + 偏移时间与非法时间（16 条）                                                                                |
| `tests/store.spec.ts`               | 打开/迁移/索引/往返/回滚/唯一约束/损坏 JSON/分页/裁剪/KV（13 条）                                                                                    |
| `tests/effects.spec.ts`             | 顺序、并发、覆盖、运行中重排、退避、上限、Later、dead、drain（10 条）                                                                                |
| `tests/passes.spec.ts`              | 间隔、runAtStart、单飞、异常隔离、stop、重复注册（6 条）                                                                                             |
| `tests/channel-*.spec.ts`           | dws 参数、解码、发送结果、重启退避、目标发现与授权（WS2）                                                                                            |
| `tests/brain-*.spec.ts`             | 分类、闸门、回复清洗、检索预算、人设与提示（WS3）                                                                                                    |
| `tests/executor-task.spec.ts`       | 批准门、工作区（批准目录优先、会话工作区缺省/标题保留）、模型路由、四种结局、回调次数、并发、重试、ensureWorkspace 顺序与 worker generation（45 条） |
| `tests/executor-model.spec.ts`      | 提示组装与截断、串行、模型路由、轮数/空闲重建、超时与异常、dispose、每轮预检与 blocked 单次重试（32 条）                                             |
| `tests/workspaces.spec.ts`          | 会话目录命名/哈希/路径安全、标题、根解析、目标 ready/per-conversation、预建幂等/去重/失败隔离（26 条）                                               |
| `tests/session-recovery.spec.ts`    | 回复器 g0/g1 公式、generation 持久化、工作区重建/attach/轮换、预检降级、per-thread 锁、worker generation（26 条）                                    |
| `tests/session-archive.spec.ts`     | 候选并集与路径身份、五类分区、stopActivity、轮换与幂等、审计、拒绝、500 上限、并发锁（23 条）                                                        |
| `tests/executor-research.spec.ts`   | 映射、上限、非 http(s) 过滤、空结果、异常与中止降级（10 条）                                                                                         |
| `tests/executor-session.spec.ts`    | 回合匹配、订阅/扫描竞态、超时、中止、工作区标题保留/显式改名（23 条）                                                                                |
| `tests/executor-role-model.spec.ts` | 模型路由映射、空配置不注入、已有选择不覆盖、解析失败回退（12 条）                                                                                    |
| `tests/presets.spec.ts`             | 宿主行仍在、两套 preset 的字段与工具集、中性人设前缀、无重复 id（17 条）                                                                             |
| `tests/contract.spec.ts`            | 分层依赖规则、共享合约（含 21 条路由与版本一致）、文档数量                                                                                           |
| `tests/settings-service.spec.ts`    | 默认值、持久化、revision、冲突、深合并、损坏降级、v1→v2、history（16 条）                                                                            |
| `tests/api-routes.spec.ts`          | 21 条路由、分页、错误码、audit、channel 503/400、`GET channel` 200/503、归档 200/400/404/405/403/503（32 条）                                        |
| `tests/thread-state.spec.ts`        | 单聊出站目标保留 `open:` 前缀、`threadKeyOf` 去前缀、防环 SQL 三种历史写法（7 条）                                                                   |
| `tests/task-actions.spec.ts`        | 批准/拒绝/取消/重试、会话工作区缺省、launch effect（10 条）                                                                                          |
| `tests/runtime-lock.spec.ts`        | 打开/持久化/锁冲突/释放/启动失败（6 条）                                                                                                             |
| `tests/core-outbound.spec.ts`       | `queueFollowup` 幂等/目标匹配/空值；outbound 终态与重复上报（10 条）                                                                                 |
| `tests/rate-counters.spec.ts`       | 窗口滚动、裁剪、跨重启、gap、损坏恢复、消息窗口与回环状态（11 条）                                                                                   |
| `tests/pipeline-chat.spec.ts`       | 自动回复、闸门降级/拒绝、检索、回声、unknown/failed 发送、一次 compose 重试与 `autoRetry` 开关（23 条）                                              |
| `tests/pipeline-task.spec.ts`       | 任务批准可见、批准后执行与回帖、未批准/取消/派工不符不执行、失败只通知、内部行脱敏（9 条）                                                           |
| `tests/runtime-pipeline.spec.ts`    | 启动授权门、暂停/恢复、防抖重启、outbox 恢复、过期/probe pass、停机顺序、ownerNick、会话式重建（18 条）                                              |
| `tests/health-view.spec.ts`         | channel 健康语义：disabled/paused/无 target 为 ok，有 target 却 stopped 为 degraded（4 条）                                                          |
| `tests/display-name.spec.ts`        | 显示名 DSH助理与默认人设鲸鱼酱并存：只改展示，不动包名/状态目录/API 前缀/panel 与 preset id（10 条）                                                 |

## 9. v1 限制

- **没有历史补拉（backfill）**：`dws` 事件流只支持按 TTL 的消费窗口，WS2 没有实现「过去消息」补拉；插件只处理启动后收到的消息，不在本期伪造历史。
- **回复失败的唯一终态是 `defer`**：自动重试不改变状态机，只在 `classified` 上累加 `decisions.attempts`（`Engine.recordReplyAttempt`）；`timeout` 与 `echoes_system_prompt` 不重试，第二次可重试失败后同样 `defer`，没有第三条失败路径。
- **模板缺失即插件降级**：`prompts/*.md` 属于包完整性；任一模板缺失/空白时通道、流水线与 effect 队列都不装配，health 显示 `prompts: error`。这是有意的 fail-closed，不尝试通用提示词。
- **review 无发送路由**：闸门降级为 `review` 时只写 Draft；面板（WS6）只读展示并允许复制，由主人自行在钉钉发送。`POST decisions/:id/send` 需要扩 21 条冻结合约，列入 v0.2 backlog。
- **归档只增不减**：`session.*-generation` 只前进；在 DSH 手动 unarchive 旧会话不会回退 generation，旧回复上下文不会自动恢复。归档并集包含主人手建的会话与别目标显式批准到该目录的任务会话，且不删目录/文件/日志、不提供 unarchive。
- **归档候选有上限**：单次最多枚举 500 个候选（排序后截断、当前回复器不丢）；超过时 `truncated=true`，已归档候选仍占名额，重复调用不会推进尾部。
- **归档审计只有计数**：`workspace.sessions-archived` 记录 threadKey/targetId 与四类计数，不记录 session id 列表；需要逐条核对时看面板结果摘要或 DSH 的归档列表。
- **通知不进 DSH 收件箱**：`notify` 只写 `notice` 审计事件（面板 audit/overview 可见），不创建 DSH 会话，也不注入消息。任务失败/未知投递的本地告警因此只能在审计与健康里看到。
- **单实例**：状态目录锁保证同一 `stateDir` 只有一个进程；锁 stale 10 秒，崩溃后需等待接管，不支持多实例共享。
- **未知投递不重发**：`unknown` 是终态，只有人核对通道后才能另行处理；没有自动重试命令。
- **review 不自动发送**：闸门降级为 `review` 时只 `draft`，v1 没有「人确认后发送」的路由；需要发送时由主人改 `replyMode`/设置后重新触发。
- **任务并发**：`tasks.maxConcurrent` 在 `launch` handler 中执行（`Later` 1 秒重试）；没有跨进程配额，也没有全局排队面板。

## 相关文档

- [001 领域模型](001-domain.md)
- [003 执行](003-execution.md)
- [006 部署](006-deployment.md)
- [010 设计摘要](010-design.md)
- [011 设置合约](011-settings-contract.md)
