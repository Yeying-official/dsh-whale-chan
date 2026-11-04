# 005 面板

> 状态：WS6 已实现七个页签的管理面板（`feat/ws6-panel`）；WS14 在目标页工作区卡片上增加「归档会话」；WS15 在目标表增加只读「订阅」列与按类型的行内提示。入口 `src/client/index.tsx`；视图在 `src/client/pages/*`；数据层在 `src/client/api.ts`；文案在 `locale/{zh,en}.json`（命名空间 `dshWhaleChan`）。面板只调用 `/whale-chan/api/*` 的 21 条冻结路由，不导入宿主实现层。

面板是DSH助理**唯一的人工入口**：查看运行状态、浏览只读会话、批准/拒绝/取消/重试任务、维护目标与人设、按块修改设置、核对审计记录。它不发送钉钉消息，也不直接写数据库。

## 1. 结构

```text
sidebar.panellist  ──  DSH助理图标
main(whale-chan)
└─ wc-panel                    固定高度、内部滚动
   ├─ wc-shell-head            标题「DSH助理」+ 健康徽标 + 刷新
   ├─ wc-tabs                  role=tablist，七个页签
   └─ wc-tabpanel              role=tabpanel，独立滚动区域
      └─ 当前页签视图
```

- 页签顺序固定：概览、会话、任务、目标、人设、设置、审计。
- 当前页签写入 `localStorage["whale-chan.tab"]`，同时镜像到 URL hash（`#tasks`）；启动时 **hash 优先**，其次持久化值，最后概览。页签切换用 `history.replaceState`，不产生额外历史记录。
- 刷新按钮重建当前页签轮询并重新拉取健康；切换页签会卸载旧页签，未保存草稿随组件卸载丢弃（同一页签内切换设置 block 不丢）。
- 响应式：≥900px 时概览/人设/目标使用两栏或表单+预览栅格，窄屏单列；表格容器横向滚动；`.wc-tabpanel` 独立 `overflow:auto`，不撑破侧栏。
- 页签条使用不透明面板底色（`--dsw-alias-bg-base`）而不是透明叠加，隐藏滚动条但保留 `overflow-x:auto`，窄屏可横向滚动；焦点/激活态用内嵌描边，不会被滚动容器裁切。桌面壁纸/装饰浮层可能悬浮在页面最上层（例如拉绳挂饰盖住最右侧页签），此时可拖动装饰、用键盘 ←/→ 或概览的快捷入口进入被遮挡的页签。

## 2. 七个页签与数据来源

| 页签 | 视图                                                                                   | 路由（全部经 `apiUrl`）                                                                                                                                                                                 |
| ---- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 概览 | 监控开关、通道状态、待批准/运行中/会话/启用目标计数、健康检查、最近 5 条审计、快捷入口 | `GET overview`（5s）、`GET health`（壳层 5s）、`GET tasks?status=running&limit=100`、`GET audit?limit=5`、`POST monitor/pause`                                                                          |
| 会话 | 只读会话列表 → 消息详情；加载更早消息                                                  | `GET threads?offset&limit=20`、`GET threads/:key?before&limit=50`                                                                                                                                       |
| 任务 | 状态筛选、任务详情、审批与动作弹窗                                                     | `GET tasks?status&offset&limit=20`、`GET tasks/:id`、`POST tasks/:id/{approve,reject,cancel,retry}`、`GET settings`（仅取 `tasks.workspaceRoot` 提示）                                                  |
| 目标 | 目标表编辑、发现、校验、逐块保存、归档会话、订阅状态                                   | `GET targets`、`GET settings`（取 `targets` 的 revision）、`POST targets/discover`、`POST targets/validate`、`POST targets/:id/archive-sessions`、`PUT settings/targets`、`GET channel`（只读订阅状态） |
| 人设 | 注册表驱动的表单 + 本地实时预览                                                        | `GET persona`、`PUT settings/persona`                                                                                                                                                                   |
| 设置 | monitor/reply/research/tasks/models/dws/advanced 七个 block 的注册表表单               | `GET settings`、`PUT settings/:block`                                                                                                                                                                   |
| 审计 | 时间/类型/摘要表格，加载更多                                                           | `GET audit?offset&limit=50`                                                                                                                                                                             |

轮询只在概览与壳层健康徽标上启用（5s）；其余页签首次加载后手动刷新。所有请求都有 `AbortController`、15s 超时与卸载取消，卸载后不会再有状态写入。

`targets` 与 `persona` 有独立页签，所以设置页只渲染其余七个 block；字段顺序、类型、范围与 label/hint 全部来自 `src/shared/fields.ts` 的 `FIELDS`，没有第二份表单定义。

## 3. 交互规则

### 3.1 暂停监控与通道状态

概览的通道状态从 `GET overview.health.checks` 的 `channel` 项推导，不直接使用 `monitor.running`：`detail` 含 `idle` → 「空闲（未启用目标）」；含 `paused by the owner` → 「已暂停」；含 `ready` → 「运行中」；`status=error` → 「异常」并附 detail；`monitoring is disabled in settings` → 「监控已关闭」；`degraded` → 「未就绪」并附 detail；没有 channel 检查项 → 「未接入」。顶部健康徽标仍以 `health.status` 为准。

概览的开关调用 `POST monitor/pause { paused }`。点击后先乐观更新，成功提示并按 `GET overview` 重新校准；失败回滚开关并显示错误。`monitor.enabled=false` 时开关禁用并说明原因。暂停会立即停止新的监控与回复，不改其他配置。

### 3.2 任务审批与动作

| 任务状态（wire）    | 批准                          | 拒绝 | 取消 | 重试 |
| ------------------- | ----------------------------- | ---- | ---- | ---- |
| `awaiting-approval` | ✅（审批 `pending` 且未过期） | ✅   | ✅   | —    |
| `queued`            | —                             | —    | ✅   | —    |
| `running`           | —                             | —    | ✅   | —    |
| `failed`            | —                             | —    | —    | ✅   |
| 其他                | —                             | —    | —    | —    |

- **批准**弹窗：工作区（可选）+ 备注（可选）。工作区留空时任务使用该会话的共用工作区（见 3.4）；非空必须是绝对路径（`C:\…`、`/…`、`\\…` 或 `~/…`），否则本地拦截。填写会覆盖并脱离共用工作区，属人工例外。提交体为 `{ approvalId?, workspace?, note? }`。
- **重试**仅失败任务可用，提交 `{ workspace? }`；**拒绝/取消**可填理由。审批已过期时显示只读提示，批准/拒绝保持禁用。
- 动作成功后关闭弹窗、提示、重拉详情与列表；`409`（如 `alreadyDecided`、`notAwaitingApproval`）或 `404` 会立即重拉详情纠正状态。`400 invalidWorkspace` 等错误定位到弹窗字段。
- 详情接口当前不返回派工/结果/会话 ID；若响应中出现 `assignment.sessionId`（或顶层 `sessionId`），面板显示「打开执行会话」并调用 `uiWorkspace.openSession`，会话目录未就绪/未列出时给出本地化错误；否则明确显示「宿主未提供执行会话 ID」。

### 3.3 设置与 revision 冲突

- 每个 block 独立草稿、独立 revision；保存发送 `{ value, revision }`。`400 invalid_settings` 的 `issues[].path` 映射到对应字段（去掉可选的 `block.` 前缀），字段标红并聚焦，消息同时提示。
- 每个 `PUT settings/:block` 成功后使用响应里的 value/revision 刷新草稿，并重拉 `GET settings`。
- `409 settings_conflict`：提示「配置已在别处更新」，**保留当前草稿**，用响应里的 `actualRevision` 刷新本地 revision，并自动重拉最新配置；用户可直接重试保存（用新 revision），或点「重新载入」丢弃草稿。目标页使用同一策略，重试保存即用新 revision。
- 设置页的「撤销修改」把当前 block 恢复为最近一次服务端值；目标页的「撤销修改/重新载入」丢弃整份目标草稿并重拉。

### 3.4 目标

- 行编辑：类型、目标 ID、名称、仅 @、回复模式、启用；新增/删除仅在草稿中生效，保存时才 `PUT settings/targets`。
- **按类型的行内提示（WS15）**：`at-me` 行的 ID 输入框提示「仅作标记，不参与订阅」；`dm` 行提示「userId 或 `open:<openDingtalkId>`」，并说明会话 ID（`cid…`）会被拒绝；「仅 @」开关**只在 `group` 行可用**，`at-me`/`dm` 行禁用并显示原因（恒视为已定向），避免主人以为开关能生效。
- **只读「订阅」列（WS15）**：`GET channel` 成功时表格多一列，每行显示该目标订阅状态的徽标（就绪/启动中/已停止/失败/残留/未知）、`N 次重启`（`restarts > 0` 时）与 `lastError` 原文；原因过长时视觉截断，`title` 保留全文。徽标按 `targetId` 匹配——同一个 id 出现多行时它们共享同一个状态，这是数据本身的边界而不是渲染取舍。列**只读**：点不动、不写入 `PUT settings/targets`，也不会因为状态是 `failed` 而阻止保存或校验。
- 目标行编辑器下方是**只读工作区**区块：遍历 `GET targets` 的 `targets[].workspace`，显示目标名称/类型与 `path`（等宽字体，可复制到剪贴板）；`mode: 'ready'` 显示「已创建」，`mode: 'per-conversation'`（`at-me` 与 `open:` 单聊）显示「按会话创建」。该投影由宿主派生，不是可编辑字段，也从不写入 `PUT settings/targets`；响应中没有 `workspace` 时整个区块隐藏。`tasks.workspaceRoot` 是回复与任务的共用根，每个会话在根下拥有独立子目录；相对路径会被宿主忽略并回退到 `<stateDir>/workspaces`，设置页与目标页的提示文案同步说明这一点。
- 发现：选择类型 + 关键词，`POST targets/discover` 返回候选；重复目标提示，加入草稿后需保存。单聊类型要求输入**联系人姓名**（placeholder 与群聊不同），候选优先带 `userId`，只有 open id 时给出 `open:<openDingtalkId>`。通道未接入时宿主返回 `503 channel_unavailable`，面板显示「通道尚未接入」。
- 校验：`POST targets/validate` 校验当前草稿行，显示有效/无效计数与逐行原因；同样处理 503。`--dry-run` 只证明参数被 dws 解析，**不证明服务端能注册**；因此 `cid…=` 形态的 `dm` id 由宿主在本地先拒绝，面板按普通无效行展示原因。

**归档会话（WS14）**

- 工作区块表格多一列「操作」。只有 `mode: 'ready'` 的行有「归档会话」按钮（`aria-label` 含目标名）；`per-conversation` 行只保留「按会话创建」徽标，**不渲染按钮**，也不可能发出请求——这类目标没有单一工作区可归档。
- 点按钮打开确认弹窗，不直接发请求。弹窗内容：目标名与 `workspace.path`、归档范围说明（该目录下全部会话，包括主人在 DSH 里手动建在此目录的会话与任务会话）、破坏性警告（只隐藏、不删目录/文件/日志，不提供 unarchive；被归档的旧会话不会再回复），以及「同时停止正在运行的会话」开关（`stopActivity`，默认关）。开关说明写明打开后会取消运行中的回复与任务，任务可能因此失败。
- 确认后 `POST targets/:id/archive-sessions`，body 为 `{ stopActivity }`（始终显式发送布尔值）。请求期间两个按钮都禁用，确认按钮文案变为「正在归档…」，取消按钮保持「取消」；重复点击不会发第二个请求；Esc 在非 pending 时关闭弹窗并复位开关与结果。
- 结果留在同一个弹窗内（`role=status`、`aria-live=polite`），关闭后不保留：
  - 五个分区计数：已归档 / 原本已归档 / 运行中未归档 / 未找到 / 失败；
  - `refused` 逐条列出 session id 与 activity 家族（`kind` 与 `items[].label (id)`，`kind` 是数据不翻译）；
  - `failed` 逐条列出 session id 与稳定错误码；
  - `truncated` 时显示警示条「本次只处理了一批（共 N 个候选）」；
  - 末尾说明回复器是否轮换：轮换则「下一条消息会使用新会话」，否则「回复器未轮换」。
- 成功后重拉 `GET targets`（工作区块的标题/路径可能与新记录不同），但结果摘要仍留在弹窗里，直到主人点「关闭」。
- 错误：`per_conversation_workspace`、`unknown_target`、`state_unavailable` 各有专用文案；其余（离线、超时、`409`、`500`、`invalid_body`）复用 §4 的通用映射。错误显示在弹窗内且弹窗保持打开，可直接重试。

### 3.5 人设

表单编辑 name/identity/tone/language/signature/rules/knowledge/samples/allowEmoji/maxReplyChars；右侧预览完全在本地渲染（示例回复、签名、字数上限、emoji 状态），不调用后端。保存 `PUT settings/persona`，冲突恢复同 3.3。

表单底部 `FormActions` 上方有两个只改草稿的动作：

- **「恢复默认（空人设）」**：用 `GET persona` 的 `defaults`（只有 `name = 鲸鱼酱`，其余为空）替换草稿；清空字段错误、置 `dirty`，提示“已填入默认空人设，保存后生效”。**不会自动保存**。
- **「载入预设：蓝白鲸鱼女仆」**：用 `presets` 里的 `whale-maid.persona` 替换草稿，同样只置 `dirty` 并提示保存后生效。预设是可选模板，默认不启用。

两者都不改变已有保存语义：真正的写入仍由 `PUT settings/persona` 完成，「撤销修改」仍恢复为服务端当前值。旧 host 的 `GET persona` 没有 `defaults` / `presets` 时，对应按钮整块隐藏，页面保持升级前的行为。默认值、预设来源与升级行为见 [014 人设默认值与预设](014-persona-defaults.md)。

### 3.6 审计与会话

审计按 `events` 倒序分页，展示时间、事件类型、摘要（操作者 + 对象 + detail）、结果徽标。会话视图只读：列表显示标题/类型/最后消息/未读数；详情显示发送者、方向、时间、正文，并支持用 `before` 游标加载更早消息。

## 4. 错误、加载与空态

| 情况                             | 表现                                                                                                                       |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| 无数据且首次加载                 | 骨架屏（`role=status`，label 本地化）                                                                                      |
| 离线 / 超时                      | 错误横幅 + 重试；离线文案「无法连接…」，超时单独提示                                                                       |
| `400`                            | 有 `issues` 时显示字段问题数并逐字段标注；否则显示输入不合法                                                               |
| `400 per_conversation_workspace` | 归档弹窗内专用文案：该目标按会话创建工作区，没有单一工作区可归档                                                           |
| `403`                            | 提示缺少同源校验头                                                                                                         |
| `404`                            | 记录不存在或被删除；任务动作后自动重拉                                                                                     |
| `404 unknown_target`             | 归档弹窗内专用文案：目标已被删除或不在当前设置里；弹窗保持打开可重试（不自动重拉 targets）                                 |
| `409 settings_conflict`          | 「配置已在别处更新」+ 保留草稿 + 自动重拉 + 可重试                                                                         |
| `409` 其他（状态冲突）           | 按 `code` 显示当前状态不允许，并重拉详情                                                                                   |
| `503 channel_unavailable`        | 「钉钉通道尚未接入」                                                                                                       |
| `GET channel` 失败（任意原因）   | 目标表只显示「订阅状态不可用」的提示条，**不**替换表格、不清空草稿、不拦编辑/保存/发现/校验/归档；刷新或等运行时就绪后再看 |
| `503` 其他 / `state_unavailable` | 「宿主尚未就绪，请稍后重试」（归档弹窗内为归档专用文案）                                                                   |
| 空列表                           | 本地化空态（会话/任务筛选/目标/审计/消息/最近活动）                                                                        |

所有失败都只显示稳定错误码与本地化文案，不回显宿主内部路径或堆栈。

## 5. i18n

- 全部 UI 文案来自 `ctx.locale` 的 `dshWhaleChan` 命名空间；`locale/zh.json` 与 `locale/en.json` 各 **524 个顶层 key**（含 `meta`；按既有「`meta` 除外」口径为 **523**），key 集合由测试强制一致。WS14 新增 25 个 key（21 个 `targets.archive.*`、`targets.workspace.actions`、3 个 `errors.archive*`）；WS15 再新增 17 个（9 个 `targets.health.*`、`targets.discover.queryPlaceholderDm`、`settings.rows.idPlaceholder.*` 2 个、`settings.rows.idHint.*` 2 个、`settings.rows.mentionOnly.*` 3 个）。
- 覆盖页签、按钮、字段 label/hint、空态、错误、确认、成功/失败提示、危险项说明、无障碍标签；`src/client/**` 不含中文字面量（测试扫描），英文词典不含中文。
- 插值沿用 DSH locale 的 `{name}` 语法（如 `{status}`、`{count}`、`{block}`、`{root}`）。
- 宿主返回的检查详情、事件类型、目标 ID 是数据而非文案，按原样显示；事件类型使用等宽字体，避免伪装成翻译。

## 6. 无障碍与键盘

- 页签：`role=tablist` / `role=tab` / `role=tabpanel`，`aria-selected`、`aria-controls`、roving `tabIndex`；←/→/Home/End 移动并聚焦。
- 焦点环统一使用 `:focus-visible` 描边（按钮、页签、输入、开关、目标行按钮）。
- 开关是 `role=switch` + `aria-checked`；刷新、暂停、打开会话、加载更多均有 `aria-label`；健康徽标 `aria-live=polite`。
- 弹窗：`role=dialog`、`aria-modal`、标题 `aria-labelledby`；打开后聚焦第一个输入，Esc 关闭，关闭后焦点回到触发按钮；点击遮罩关闭。
- 键盘可完成批准/保存/取消/页签切换：Tab 可达全部控件，Enter/Space 激活按钮；审批弹窗内可从工作区输入 Tab 到「确认批准」回车提交（测试覆盖）。
- 字段错误 `role=alert`，控件带 `aria-invalid`；骨架动画尊重 `prefers-reduced-motion`。
- 归档弹窗沿用同一套 `role=dialog` 语义；结果区 `role=status aria-live=polite`，读屏会播报分区计数、截断提示与是否轮换；「归档会话」按钮的 `aria-label` 含目标名；pending 时 Esc 不关闭，避免误关掉正在进行的请求。
- 主题只使用 `--dsw-alias-*` token 与 `color-mix`，无新增图标库；页面在深色主题下使用层级背景 + 语义色，对比度满足正文可读。

## 7. 已知限制（v1）

1. **无收件箱会话**：会话页是只读视图，不能新建/回复/标记已读；宿主 `ThreadsPage` 的 `unreadCount` 目前恒为 0。任务失败或投递结果 `unknown` 只写审计通知，不创建 DSH 收件箱会话，因此这类事件在审计/概览中查看。
2. **review 模式草稿没有面板入口**：闸门降级为 `review` 时后端只生成草稿、不自动发送；21 条冻结路由中没有 `decisions/*` 或发送动作，`GET threads/:key` 也只返回收到的消息。因此面板无法展示或确认草稿，主人需在钉钉中手动处理；扩展该能力需要新增路由与共享视图（v0.2 backlog）。
3. **无实时推送**：概览与健康每 5s 轮询，其余页签手动刷新；没有 WebSocket 或 SSE。轮询在卸载时取消，不泄漏。
4. **会话详情字段有限**：`MessageView` 没有「是否 @」与决策/草稿状态，v1 只展示发送者、方向、时间、正文；接口扩展后才能补齐。
5. **任务详情字段有限**：`TaskDetail` 只有 task/approval/messages，没有派工、结果与会话 ID；面板对可选的 `assignment`/`sessionId` 做前向兼容读取，缺失时明确提示。
6. **运行中任务计数**：`GET overview.counts` 没有 running 字段，面板用 `GET tasks?status=running&limit=100` 统计；达到 100 时显示「100+」，不是精确总数。
7. **目标发现/校验依赖通道**：WS5a 未接入通道时返回 503，面板只解释不可用，不伪造结果。
8. **草稿生命周期**：切换主页签会卸载页面并丢弃未保存草稿；同一设置页内切换 block 保留草稿。
9. **健康检查详情**：`checks[].detail` 与 `health.dws` 是宿主技术数据，保持英文原样，不参与翻译。

## 8. 相关文档

- [007 架构](007-architecture.md)
- [011 设置合约](011-settings-contract.md)
- [013 安全](013-security.md)
- [WS6 PR](pr/WS6-panel.md)
- [WS6 测试报告](test-reports/WS6.md)
- [WS14 PR](pr/WS14-archive-sessions.md)
- [WS14 测试报告](test-reports/WS14.md)
- [WS15 PR](pr/WS15-target-subscriptions.md)
- [WS15 测试报告](test-reports/WS15.md)
