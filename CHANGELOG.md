# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 的结构与 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

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
- 回复路径改为直接使用 DSH 的模型服务，并放宽真实模型延迟的预算；任务结果继续走 outbox 与审计。

### Fixed

WS8 真机暴露、单元测试/桩无法发现的问题：

- **`--ttl` 单位**：`dws` 要求 Go duration，目标校验从裸数字改为 `"<hours>h"`；夹具与 009 文档同步。
- **非交互发送缺 `--yes`**：发送参数固定追加 `--yes`；解析 `openMessageId` / `deliveryStatus` 回执；重复幂等键映射 `unknown`，不重发。
- **真实群事件是 snake_case 扁平结构**：归一化支持 `message_id`、`conversation_id`、`sender_open_dingtalk_id`、`content`、`event_time`、`create_time`；`conversationType` 按目标类型推断；`@ownerNick` 文本判定；群事件无 `staffId`/`atUsers` 时仍能工作。
- **回合认领与投递 id**：`TurnTracker` 改为等待下一个 `turn/start` 认领；新增 `deliveryId()` 统一 `dsh-whale-chan:` 前缀，`awaitTurnEnd` 用带前缀 id 匹配。
- **T4 结果回帖泄漏内部信息**：结果模板只保留任务标题与摘要，worker prompt 禁止输出 `Route`、工具名、会话 ID、工作区路径；会话 ID 只进审计/面板，不进入对外文本。
- 其他真机修复：owner nick 传入通道、回复器模型直接走 LLM 运行时、慢模型预算与输出 token 下限、可见会话回复、发送确认回执解析。

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
