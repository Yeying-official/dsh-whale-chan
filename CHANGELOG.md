# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 的结构与 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

## [0.4.0] - 2026-11-04

**归档一个目标工作区的全部会话，并让该会话在归档或工作区被移除后自愈**（WS14）。当前回复会话被归档后，下一条钉钉消息会落到新会话（正在运行而被拒绝归档的会话继续使用）；在 DSH 里手动移除工作区后，下一次回复或任务会重建记录并尽量附着仍在的旧会话。升级不移动、不删除任何目录与会话日志；schema 仍为 2，设置字段仍 57 个，无新依赖。

### Added

- **`POST /whale-chan/api/targets/:id/archive-sessions`（第 20 条冻结路由）**：body 可选 `{ stopActivity?: boolean }`，非布尔为 `400 invalid_body`；结果把候选按 `archived` / `alreadyArchived` / `refused` / `missing` / `failed` 分区，并返回 `workspace`、`replySessionRotated`、`nextReplySessionId`、`stopActivity`、`truncated`、`candidateCount`。未知目标 `404 unknown_target`、按会话工作区的目标 `400 per_conversation_workspace`、运行时未就绪 `503 state_unavailable`，其余沿用 `403` 同源头守卫。
- **候选枚举**：registry 中同路径记录的 `sessionIds`、`sessionPersistence` 中 `header.cwd` 同路径的会话 id、当前回复器会话 id 三者的并集，按 `realpath` 规范化后比较路径，去重排序；上限 **500**（先排序再截断，当前回复器不丢），截断时 `truncated=true` 并返回 `candidateCount`。
- **回复器 generation（KV `session.reply-generation:<threadKey>`）**：`g0` 与旧版本会话 id 逐字节一致；`g>0` 在 sha1 输入追加 `\u0000g<n>`。当前会话命中 DSH 归档集合时递增一代并写入 KV，重启后不会回到被归档的会话。
- **每轮预检 `prepareReply`**：`mkdir` → registry `resolveByPath`（仅缺失时 `create`，**绝不改已有标题**）→ 重建记录时 best-effort `attachSession` 附着当前会话 → 命中归档集合则递增 generation。显式 attach 失败推进 generation，隐式失败不推进；`mkdir`/`resolve`/`create` 失败降级沿用当前 generation 并写 warning，归档轮换仍然生效。
- **回复器 blocked 单次重试**：`SessionModel` 每轮先预检，id 变化就取消旧会话并 `fresh` 新建；回合以 `failed` 且 `detail` 含 `blocked` 结束（DSH 归档闸门拒绝投递）时，重新预检并用新幂等键 `:r1` 重试**一次**，第二次仍失败走原失败路径。
- **任务侧 generation（KV `session.worker-generation:<base>`）**：worker 会话 id 在归档后变为 `<base>-g<n>`，同一派工的重复运行不会 resume 已归档会话；任务执行器在 `ensureSession` 前重建会话工作区记录（`ensureWorkspace`），所以 DSH 里被移除的记录会在下次运行前补回。
- **面板「归档会话」入口**：目标页「工作区」卡片新增「操作」列；`mode: 'ready'` 的行有「归档会话」按钮 → 确认弹窗（含「同时停止正在运行的会话」开关，默认关）→ 结果摘要（五个分区计数、`refused` 的活动类型、截断提示、是否轮换回复器）并重拉 `targets`。`per-conversation` 目标不显示按钮。
- **审计事件 `workspace.sessions-archived`**：`actor=owner` 出现在面板审计页，记录 threadKey、targetId、四类计数与 `stopActivity`/`replySessionRotated`。

### Changed

- **管理 API 从 19 条增加到 20 条**；`tests/contract.spec.ts` 断言新数量，`docs/011` 与 `docs/007` 同步。
- **回复在每一轮都做一次会话预检**，不再只在重建时判断身份；预检失败不阻断回复，只降级沿用当前 generation。
- **归档后的轮换以宿主归档集合为准**，不看本次 pass 是否“尝试过”归档当前回复器：只要当前回复器在归档集合里（本 pass、更早一次、DSH 手动或并发归档造成），下一条消息就会换新会话；运行中未归档的回复器继续使用原会话。
- 面板新增 **25 个**文案 key（中英各一套）：21 个 `targets.archive.*`、`targets.workspace.actions` 与 3 个 `errors.archive*`；结果区 `role=status aria-live=polite`；locale 仍为 507 个顶层 key（含 `meta`，按既有「`meta` 除外」口径为 506）。

### Fixed

- **预检到投递之间被归档导致丢消息**：blocked 回合改为单次重试（新 `requestId` `:r1`），不再被判为普通失败。
- **手动移除工作区后首条消息不 attach**：没有缓存会话时用当前 generation 命名的 id 作为隐式候选，重建记录后尝试附着，尽量保留可用上下文。
- **任务重跑 resume 已归档 worker 会话**：改为按持久 generation 解析 `<base>-g<n>`。
- **预检变成每轮致命依赖**：`mkdir`/registry 故障降级为沿用当前 generation，只有归档轮换继续生效。
- **客户端审批 fixture 时间炸弹**：`tests/client-harness.tsx` 的 `LATER` 改为 2099 年，测试不再随系统时钟过期（仅测试，无产品代码变化）。

### Migration

- **升级不换会话**：从未归档过的安装 `g0` 与旧版本会话 id 完全相同，升级后继续使用原回复器与 worker 会话；generation KV 只在真正轮换时写入。
- **无 schema、无设置变更**：`SCHEMA_VERSION` 仍为 2，设置仍 9 个 block / 57 个字段，没有新增 block、字段或依赖；不需要迁移脚本。
- **不迁移、不删除**：归档只把会话从可见面隐藏，目录、文件、会话日志都保留；不提供 unarchive，在 DSH 手动 unarchive 也不会回退 generation，旧回复上下文不会自动恢复。
- **回退安全**：回到 v0.3.0 可打开同一个 `state.db`；`session.*-generation` 行会留在 KV 中被旧版本忽略（旧版本按 `g0` 解析会话），归档集合仍由 DSH 自己持有。

### Known limitations

- 候选超过 500 时只处理排序后的前缀，已归档候选仍占名额，**重复调用不会推进尾部**；面板只说明“本次只处理一批”。
- 归档并集包含主人在该目录手动创建的会话，也包含别目标显式批准到本目录的任务会话；`stopActivity=true` 会取消运行中的回复/任务，任务可能因此失败。
- 同一 target id 重复出现时按 settings 行顺序取首行；`nextReplySessionId` 可能指向一个此前已被手动归档的 generation，下一条消息的预检会继续前进。
- 本版未跑真机：DSH `ArchivedSessionGate` 与 activity 结构由 fake 按 `error.name` 模拟，macOS/Linux 未验证。

## [0.3.0] - 2026-11-03

人设默认值改为**空人设**，蓝白鲸鱼女仆改为**可选预设模板**（WS12）。产品显示名、包名与内部标识不变；npm 包仍只含运行产物与 `README.md`，`docs/` 与 CHANGELOG 只在仓库/发行页。

### Added

- **可选预设 `whale-maid`（蓝白鲸鱼女仆）**：`WHALE_MAID_PERSONA` 保存在 `src/shared/persona-defaults.ts`，简体中文、6 条规则、非空身份与 3 条示例；默认**不启用**，升级/启动/读取都不会自动应用。
- **人设页「载入预设：蓝白鲸鱼女仆」**：把人设模板填入草稿并置 dirty，主人检查后自行保存；「恢复默认（空人设）」同理，只清空草稿、不发 `PUT`。
- **`GET /whale-chan/api/persona` 新字段**：返回 `{ persona, revision, defaults, presets }`；`defaults` 是空人设的深拷贝，`presets` 当前只含 `whale-maid` 一项，均为只读投影、不落库。
- **[014 人设默认值与预设](docs/014-persona-defaults.md)**：研究来源、原创与非官方声明、明确排除项、默认值/预设字段表与升级行为。

### Changed

- **persona 默认值改为空人设**：仅保留 `name = 鲸鱼酱`（schema 要求非空）；`identity`、`tone`、`signature`、`knowledge` 为空，`rules`、`samples` 为空数组，`language = auto`。回复回落为自然、克制的产品默认语气。
- **默认人设不再是角色**：产品显示名仍是「DSH助理」，包名 `dsh-whale-chan-assistant`、状态目录、API 前缀、panel / session / preset id 与数据库都不随人设变化。
- 面板人设页在保存按钮上方新增两个动作；旧 host 不返回 `defaults` / `presets` 时两个按钮整块隐藏，页面行为与升级前一致。

### Fixed

- **默认数组改用工厂**：`PersonaSchema` 的 `rules` / `samples` 默认值改为 `() => [...EMPTY_PERSONA.rules]` 一类工厂，`SettingsSchema` 的 persona block 同样处理，避免 schema 解析共享同一份常量数组。

### Migration

- **已保存的 persona 行原样保留**，不自动迁移、不覆盖；升级只影响从未保存过人设（块缺失）的安装，这类安装采用新的空默认。
- **想用女仆需手动启用**：在人设页点「载入预设：蓝白鲸鱼女仆」→ 检查 → 保存；预设只读、不落库，不点保存不会生效。
- 旧 persona 行若保留了旧预设文本，不会被自动清空；需要空人设时用「恢复默认（空人设）」手动应用并保存。

## [0.2.0] - 2026-11-03

按会话工作区（WS9）与目标页只读工作区（WS10）：一个钉钉会话一个目录，回复器与任务共用，升级不移动、不删除任何旧目录。npm 包仍只含运行产物与 `README.md`，`docs/` 与 CHANGELOG 只在仓库/发行页。

### Added

- **按会话/目标的共享工作区（WS9）**：每个钉钉会话（群或普通单聊）在 `<root>/conversation-<sha256(threadKey) 前 16 位>` 拥有一个目录，该会话的回复器会话与它派生出的每个任务会话共用；任务写下的文件，后续回复可以直接看到。目录名只由 threadKey 的摘要决定，不使用标题或会话 id 当路径段。
- **目标页只读工作区（WS10）**：目标页新增「工作区」区块，对每个目标显示标题与目录；有具体会话的目标为 `ready` 并带「已创建」徽标与「复制路径」，`@我` 与 `open:` 单聊没有单一会话，显示「按会话创建」且路径为空（`per-conversation`）。这是派生投影，不落库、不可写。
- **启用即预建**：启用的 `group` 与普通 `dm` 目标在启动和设置热应用时创建目录并写入 DSH workspace registry（标题 `钉钉 · <目标名>`）；`@我` 是全局订阅、`open:` 单聊只有发送用 id，两者在首条消息时惰性创建。重复目标按会话去重，单个目标失败只记日志并跳过。
- **显示名 DSH助理（WS10）**：侧栏、插件列表与面板显示「DSH助理」；**默认人设仍是「鲸鱼酱」**，可在人设页改名。包名 `dsh-whale-chan-assistant`、状态目录 `~/.dsh-whale-chan`、API 前缀、panel/session/preset id 与数据库均不随显示名变化。

### Changed

- `tasks.workspaceRoot` 从「每个任务一个子目录的根」变成**回复与任务共用的根**；留空仍回退到 `<stateDir>/workspaces`。字段名不变，旧设置无需改写。
- 批准与重试任务时留空目录，默认使用该任务所属会话的工作区；显式填写的绝对目录仍然优先，是人工例外。
- 回复器会话布局升到 **v2**：会话 id 的哈希输入加入布局版本（`<threadKey>\0v2`），升级后首次回复会新建会话；旧会话、旧目录、旧 `<stateDir>/workspace` 与 `tasks/<taskId>` 原样保留，无需迁移文件。
- `tasks.workspaceRoot` 写成相对路径时不再被静默解析，而是记录 warning 并回退到 `<stateDir>/workspaces`（DSH 会按宿主工作目录解析相对路径，主人无法预测文件落在哪里）。
- 设置页「工作区根目录」提示、批准弹窗与目标页文案同步新语义：共用根、每会话子目录、相对路径回退。

### Fixed

- **任务加入共享工作区不再改写标题**：任务会话加入已有目录时使用会话标题（`钉钉 · <名>`），不再写入「任务 · …」；`ensureSession` 只在显式传入标题时改名，目标预建时会把已存在记录的标题校正回 `钉钉 · <目标名>`。
- T4 结果回复脱敏延续到新路径：对外文本仍只保留任务标题与摘要，不出现 `Route:`/`Aegis`、工具名、会话 id 或工作区绝对路径；会话 id 只进任务结果、审计与面板。

### Migration

- **旧数据全部保留**：旧会话、旧 `<stateDir>/workspace`（回复器共用目录）与 `tasks/<taskId>` 不迁移、不删除；新消息使用新会话与新工作区，旧历史仍可在 DSH 中打开。
- **新会话、新目录**：升级后第一次回复会新建 `whale-reply-*` 会话（布局 v2），该会话派生的任务默认落在同一个 `conversation-<digest>` 目录。
- **显式批准目录仍是人工例外**：批准弹窗填写的绝对目录不会被改写成会话工作区，也不会因此改会话标题；留空才使用会话工作区。
- **旧标题**：若某会话在早前版本中被任务改成「任务 · …」，下一次预建（启动或改设置）会把它改回 `钉钉 · <目标名>`；插件不会因此移动或删除目录。

## [0.1.0] - 2026-11-03

首个可用版本：WS0–WS8 完成，Windows 真机 T0–T4 通过（见 [WS8 真机报告](docs/test-reports/WS8-live.md)）。npm 包只含 README，`docs/` 与 CHANGELOG 只在仓库/发行页。

### Added

- **核心域与持久化（WS1）**：Message、Thread、Decision、Draft、Task、Approval、Assignment、Outbound；一个命令一个事务；10 条硬不变量；SQLite `state.db` schema v2（13 张表，WAL），前向幂等迁移；持久 effect 队列与 pass 调度（批准过期、授权探测、outbox 恢复）。
- **个人钉钉通道（WS2）**：基于 `dws` 个人授权的事件订阅，支持 `@我`、指定群与指定单聊；每个目标一个 `dws event consume` 子进程；NDJSON 归一化、自消息/广播/媒体过滤、指数退避重启、优雅停止与目标发现/校验。
- **发送层**：固定 `--ai-tag`、`--idempotency-key`、`--wait-delivery`、`--yes`；`sent` / `unknown` / `failed` / `gone` 四类回执语义；`unknown` 为终态，不自动重发；重复幂等键映射为 `unknown`。
- **人设、分类与检索（WS3）**：`settings.persona` 单一来源；五份提示模板；分类 JSON strict 校验；回复后处理（去身份声明、凭证脱敏、URL 白名单、系统提示回声弃稿、按码点截断）；DSH `web.search` 适配与预算/缓存/引用。
- **回复策略**：`auto` / `review` / `off`；16 步判定；静默时段（默认 22:00–08:00，跨午夜，左闭右开）；每会话每小时上限与最小间隔；连续 AI 回复 3 条防环；允许/屏蔽发送者只按 userId 全等匹配。
- **任务执行器与 preset（WS4）**：每个已批准任务一个 `dsh-whale-chan-worker` 会话；批准门在领域与执行器双侧检查；工作区绝对路径校验；超时取消、用户取消、失败重试；两套 agent preset（回复器无 shell/文件/作业/skill；worker 受限工具集）。
- **设置与 19 条管理 API（WS5a）**：9 个 block、57 个字段；block/global revision 乐观并发；深合并 + strict 校验；`x-whale-chan-request` 同源守卫；稳定错误码与状态码映射。
- **组合根与流水线（WS5b）**：启动探测、提示预载、授权门、设置热应用、暂停/恢复、订阅防抖重启、健康检查、停机顺序与锁释放；任务结果走同一 outbox。
- **七页签面板（WS6）**：概览、会话、任务、目标、人设、设置、审计；批准/拒绝/取消/重试；目标发现与校验；设置 revision 冲突恢复；只读会话；中英双语、深色主题、键盘与读屏可用。
- **文档与发布（WS7）**：重写 README 与首次配置、安装；兼容矩阵、CHANGELOG、013 安全基线、012 发布清单；面板截图（裁切去敏）；000/008 从占位补为可读。
- **真机验收（WS8）**：Windows + DSH Desktop `0.2.1-rc.5` + `dws` `1.0.66` 上完成 T0 认证/发现、T1 目标校验、T2 单条发送、T3 群内 @ 自动回复、T4 任务批准与执行；测试群目标验收后停用。

### Changed

- 设置从 WS0 的内存契约改为 SQLite 持久化；`PUT settings/:block` 必须带 revision，冲突返回 409 并带 `actualRevision`。
- 任务状态在 wire 上把领域 `approved` 映射为 `queued`（已批准、等待执行），`GET tasks?status=queued` 反向过滤。
- 健康检查的 channel 语义：禁用监控、主人暂停、无 enabled target 都算正常 `idle`；只有“应有订阅却 stopped”才是 `degraded`。
- Windows 下 `dws` 裸命令自动解析 npm shim（`PATH`、`%APPDATA%\npm`、Node 安装目录），并支持 `dws.binaryPath` 覆盖；解析结果只记录路径。
- 回复路径使用可见的 DSH 会话（replier preset），交互可在「钉钉 · <标题>」会话中回看；真实模型延迟预算放宽为分类/草稿 60s、单回合 90s。任务结果继续走 outbox 与审计。

### Fixed

WS8 真机暴露、单元测试/桩无法发现的问题：

- **`--ttl` 单位**：`dws` 要求 Go duration，目标校验从裸数字改为 `"<hours>h"`；夹具与 009 文档同步。
- **非交互发送缺 `--yes`**：发送参数固定追加 `--yes`；解析 `openMessageId` / `deliveryStatus` 回执；重复幂等键映射 `unknown`，不重发。
- **真实群事件是 snake_case 扁平结构**：归一化支持 `message_id`、`conversation_id`、`sender_open_dingtalk_id`、`content`、`event_time`、`create_time`；`conversationType` 按目标类型推断；`@ownerNick` 文本判定；群事件无 `staffId`/`atUsers` 时仍能工作。
- **回合认领与投递 id**：`TurnTracker` 改为等待下一个 `turn/start` 认领；新增 `deliveryId()` 统一 `dsh-whale-chan:` 前缀，`awaitTurnEnd` 用带前缀 id 匹配。
- **T4 结果回帖泄漏内部信息**：结果模板只保留任务标题与摘要，worker prompt 禁止输出 `Route`、工具名、会话 ID、工作区路径；会话 ID 只进审计/面板，不进入对外文本。
- 其他真机修复：owner nick 传入通道、真实模型延迟预算、输出 token 下限、发送确认与回执解析、结果回复脱敏。

### Security

- 所有管理请求要求 `x-whale-chan-request: 1`；跨源页面无法在无 CORS 预检的情况下伪造。
- AI 角标、幂等键与失败关闭：模型输出无法移除角标；同一 Outbound 只产生一条外部消息；`unknown` 不重发。
- 日志脱敏：默认不含正文、token、账号 id、clientSecret；调试摘要只输出字段名与白名单字段的截断值。
- 任务双重批准门：领域只给已批准任务建派工，`launch` handler 在执行前重查 task/approval/assignment；任一不符只写 `notice`。
- 工作区必须是绝对路径；回退路径里的 `taskId` 不能包含 `/`、`\` 或 `..`；worker 权限只接受 `workspace-write` / `danger-full-access`，其它值按窄权限处理。
- 单实例锁与模板 fail-closed：第二个实例拒绝启动；`prompts/*.md` 缺失/空白时通道、流水线与 effect 队列都不装配。
- 凭证只经 `dws` 本机授权使用，不写入仓库、设置快照或普通日志。

### Known limitations

- **无历史补拉（backfill）**：只处理插件启动后 `dws` 能消费到的消息，不补拉过去对话。
- **通知仅写审计**：任务失败、超时、投递 `unknown` 只写 `notice` 审计事件，不创建 DSH 收件箱会话；需要在「审计」或「概览」核对。
- **review 草稿没有发送路由**：v1 只生成 Draft，19 条冻结路由没有 `decisions/*` 或发送动作，面板也不展示草稿；静默/限速/手动 review 场景需主人自行在钉钉回复。
- **无收件箱会话**：会话页是只读视图，不能新建、回复或标记已读；`unreadCount` 当前恒为 0。
- **无实时推送**：概览与健康 5 秒轮询，其余页签手动刷新；没有 WebSocket/SSE。
- **任务详情字段有限**：`TaskDetail` 不含派工、结果与会话 ID；面板对可选字段做前向兼容，缺失时明确提示。
- **macOS / Linux 未验证**：当前只声明 Windows 10/11；其它平台不要按“已支持”部署。
- **`dws` 仍有 provisional 面**：群事件与回执已按 `1.0.66` 真机确认；单聊 o2o、其它版本、`--ttl` 之外的参数语义仍需逐版核对，见 [009 DWS 协议](docs/009-dws-protocol.md) §9。
- **无钉钉侧批准**：批准只在 DSH 面板；A2UI 卡片批准列入后续版本，不在 v1。
- **`unknown` 无自动重试**：投递结果不可证明时宁可人工对账，不重复打扰对方。
