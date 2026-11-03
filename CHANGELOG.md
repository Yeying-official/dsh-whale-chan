# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 的结构与 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

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
