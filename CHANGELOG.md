# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 的结构与 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

## [0.6.0] - 2026-11-05

**修好“正文被引用脚注挤空、群聊收不到回复”这条链路**（WS16）。`persona.maxReplyChars` 现在只约束回复正文；末尾的引用脚注有独立上限 `CITATIONS_MAX_CHARS`（600 码点），超出时逐行取舍（放得下的整行保留、放不下的整行跳过），一行都放不下就整体丢弃，**不会**再截短或清空正文。模型一个字都没给与“给了但被清洗成空”现在是两个失败词：后者为新增的 `sanitized_empty`。回复块新增 `reply.autoRetry`（默认开）：`empty`/`sanitized_empty`/`model_error` 最多自动重试一次，第二次仍失败才 `defer`；`timeout` 与 `echoes_system_prompt` 不重试。管理 API 仍 21 条、schema 仍 2、无迁移；设置字段 57 → **58 / 9**，locale 中英各 526 个顶层 key。**本版只有单测证据，未做真实账号验收。**

### Added

- **`reply.autoRetry`（boolean，默认 `true`）**：设置页「回复」块的新开关。开启时，可重试的回复生成失败（`empty`、`sanitized_empty`、`model_error`）会先自动重试**一次**，第二次仍失败才把决策置为 `deferred`（`reason` 为 `compose:<失败词>`）；关闭后恢复“一次失败即 defer”。`timeout` 与 `echoes_system_prompt` 属于确定性失败，无论开关如何都不重试。
- **失败词 `sanitized_empty`**（`src/brain/reply.ts`）：模型有输出、但清洗（去围栏/引号、去身份声明、URL 白名单、凭证脱敏）后正文为空时使用，`detail` 带模型输出前 200 字符样本。模型输出本身就是空白时仍是 `empty`。完整失败词表：`timeout` / `empty` / `sanitized_empty` / `echoes_system_prompt` / `model_error`。
- **`SanitizeResult.citations`**：取值 `kept` / `trimmed` / `dropped`，记录引用脚注这次是完整保留、逐行取舍还是整体丢弃；`sources` 的语义不变，仍只报告最终文本里出现的检索 URL。`dropped` 同时覆盖“没有请求引用”和“请求了但一行都放不下”两种情况，调用方不应从该值反推原因。
- **内部错误码 `notRetryable`**（`refused`）：只由 `Engine.recordReplyAttempt` 使用——只有 `classified` 状态的决策才能记一次重试，其它状态记了也用不上。管理 API 不暴露这个错误码，也没有新增路由。

### Changed

- **引用预算与正文预算分离（行为变更）**：旧实现先从 `persona.maxReplyChars` 里扣掉引用脚注的长度，再截正文，三条长来源（362 字符）对上默认 300 上限时正文预算为负，整条回复被清空并 `defer` 为 `compose:empty`，群聊收不到任何回复。现在正文独占 `maxReplyChars`（1–800，按码点、优先断在句末标点），引用脚注另按 `CITATIONS_MAX_CHARS = 600` 码点逐行取舍：整行放得下就保留，放不下就跳过，绝不切半条 URL；一条都放不下时脚注整体消失（`citations: 'dropped'`），正文照发。**升级后，此前“因为引用太长而静默失败”的消息会开始正常回复**，这是本版最明显的行为变化。
- **`persona.maxReplyChars` 的提示文案**：面板 hint 改为“单条回复正文的最大字符数；末尾的引用链接不计入该上限”，避免主人误以为引用会挤占正文。
- **设置字段 57 → 58，block 仍 9**：`reply.autoRetry` 追加在 `reply` block 末尾；`docs/011-settings-contract.md` 由 `pnpm docs:settings` 重新生成。locale 中英各新增 2 个 key（`settings.reply.autoRetry.label/hint`），并改写 `settings.persona.maxReplyChars.hint`，顶层 key 524 → **526**（按既有「`meta` 除外」口径 523 → **525**）。
- **重试只累加 `decisions.attempts`**：重试不是状态迁移，决策保持 `classified` 以便再次 compose；分类时的 `reason` 原样保留，不会被重试原因覆盖；不写新的领域事件，只在 host logger 记一条 `compose retry 1/1 for decision <id> after <失败词>`（不含消息正文）。重试会携带上一次的 `research` 结果，第二次草稿仍能引用同一批来源。

### Fixed

- **正文被引用脚注挤空**：`sanitizeReply` 不再为引用预留正文预算，`persona.maxReplyChars` 全部给正文；引用在自己的 600 码点预算内逐行取舍或整体丢弃。默认 300 字正文 + 3 条长来源不再互相打架。
- **“模型没说话”与“被我们清空”混为一谈**：旧实现两者都报 `empty`；现在只有真空输出是 `empty`，清洗后为空是 `sanitized_empty`，调用方据此决定是否值得重试。
- **失败一次就放弃**：可重试的失败现在默认多花一次模型调用；第二次仍失败才 defer，减少“模型偶发空输出”导致的丢回复。

### Migration

- **默认开启的一次重试会让失败时多一次模型调用**：`reply.autoRetry` 默认 `true`，`empty`/`sanitized_empty`/`model_error` 失败时最多多调用一次模型（只一次，不循环）。若主人希望保持 v0.5.0 的“一次失败即 defer”与调用成本，在「设置 → 回复」关掉该开关即可；开关只影响未来失败，不改历史决策。
- **无 schema / API / 依赖变化**：`SCHEMA_VERSION` 仍为 2，管理 API 仍 **21 条**，`engines` 与 `dsh.compatibility` 不变，没有新增依赖，也不需要迁移脚本。设置只多一个带默认值的布尔字段，旧设置行读取时自动补 `true`。
- **回退安全**：回到 v0.5.0 可打开同一个 `state.db`；多出来的 `reply.autoRetry` 会被旧 schema 的 strict 校验当作未知字段，v0.5.0 启动时会把整个 `reply` block 回退默认值并记录 warning（`SettingsService` 的既有行为）——回退前请先记录该 block 的自定义值（允许/屏蔽发送者、限速、@ 规则等），回退后重新保存。引用语义回退后重新变成“脚注挤占正文”，长引用场景会再次丢回复。
- **不需要重发旧消息**：本版不重放、不修复历史 `deferred` 决策；被旧版本 `compose:empty` 丢掉的回复不会自动补发，需要主人在钉钉里手动处理。

### Known limitations

- **重试原因只在 host 日志**：自动重试不产生独立审计事件，`decisions.attempts` 会 +1，但面板与审计流看不到“这次多试了一次”；排障需要看 host logger 的 `compose retry …` 行。
- **本版未做真实账号验收**：证据只有单元测试（`tests/brain-reply.spec.ts`、`tests/pipeline-chat.spec.ts`、`tests/core-engine.spec.ts` 等）与假 `dws` 夹具，没有在真实钉钉账号上触发过“长引用 + 失败重试”的组合。真实模型是否会在重试后给出不同草稿、引用取舍在真实来源长度下的表现，均未实测。
- **引用取舍是静默的**：脚注被 `trimmed`/`dropped` 时，聊天里只表现为“少了几条参考”，没有面向主人的提示；`SanitizeResult.citations` 目前只给代码与测试用。
- **`timeout` 不重试**：60 秒预算耗尽后直接 defer；如果首轮只是慢而不是坏，本版不会为它多等一轮。

## [0.5.0] - 2026-11-04

**修好“订阅建立不起来、失败看不见原因、单聊发不出去”这条链路**（WS15）。单聊目标改由通讯录按姓名发现，只接受对端 `userId` 或 `open:<openDingtalkId>`；单聊回复的出站 id 保留 `open:` 前缀，防环查询同时认得三种历史写法；`supervisor` 把 `dws` stdout 上的结构化错误当作服务端拒绝来记录（不再算 malformed 事件），按 `retry_after_seconds` 退避，并在连续 3 次无重试提示的拒绝后停止自动重启；新增 `GET channel` 与目标页「订阅」列，让每个目标的 `state`/`restarts`/`lastError` 可见。`mentionOnly` 现在真正生效：群消息在目标行或全局 `requireMentionInGroups` 任一为真时要求已 @。管理 API 20 → 21 条；schema 仍为 2，设置字段仍 57 / 9，无迁移、无新依赖。**订阅与收发链路本轮只有单测与假 `dws` 夹具覆盖，尚未在真实账号上验收。**

### Added

- **`GET /whale-chan/api/channel`（第 21 条冻结路由）**：返回 `ChannelHealthView`（`state`、`running`、`targets[]`）；每个目标带 `targetId`、`kind`、可选 `label`、`state`（`starting`/`ready`/`stopped`/`failed`/`orphaned`）、`restarts` 与可选的 `readyAt`、`lastError`（单行、已脱敏）。只读订阅状态，不读写设置；运行时未就绪为 `503 state_unavailable`。
- **目标页「订阅」列**：`GET channel` 成功时每行显示状态徽标、`N 次重启` 与失败原因原文（`title` 保留全文）；`GET channel` 失败时只显示「订阅状态不可用」，其余编辑/发现/校验/保存/归档不受影响。
- **单聊按姓名发现**：`dws contact user search --query <姓名> --format json` 发现单聊候选，优先 `userId`，只有 open id 时生成 `open:<openDingtalkId>`；输入框与提示按类型区分（单聊要求填联系人姓名）。
- **目标行内提示**：`at-me` 的 id 仅作标记、`dm` 的 id 形态（`userId` 或 `open:<openDingtalkId>`）、`mentionOnly` 仅 `group` 生效——开关在非 `group` 行禁用并说明原因。

### Changed

- **管理 API 从 20 条增加到 21 条**；`tests/contract.spec.ts` 断言新数量，`docs/011`、`docs/007` 与 README 同步。
- **`mentionOnly` 语义落地（行为变更）**：`policy.findTarget` 先按消息来源分派——at-me 消息取全局 at-me 行、否则取 `group:<cid>` 会话行、最后回退到创建线程的目标行；群消息在 `target.mentionOnly || reply.requireMentionInGroups` **任一为真**时要求 `addressed`，否则 `not_addressed`。`at-me` 与 `dm` 恒视为已定向，`mentionOnly` 对它们无效。
- **dm 目标 id 规则收紧**：`dm` 只接受对端 `userId` 或 `open:<openDingtalkId>`；形如 `cid…=`（含 `open:cid…=`）的会话 ID 在本地直接判 `invalid-target` 并提示改填，不再等到服务端拒绝。
- **`supervisor` 失败策略**：`dws` stdout 上的结构化 `{"error":{…}}` 记为服务端拒绝（不再计入 malformed 事件）；退避取 `max(指数退避, retry_after_seconds)` 并以 `dws.restartBackoffMaxSeconds` 封顶；连续 3 次拒绝且没有 `retry_after_seconds` 时停止自动重启（`state=failed`），把真实原因留在 `lastError`。
- **面板新增 17 个文案 key**（中英各一套：`targets.health.*` 9 个、`targets.discover.queryPlaceholderDm`、`settings.rows.idPlaceholder.*` / `idHint.*` / `mentionOnly.*` 7 个）；locale 为 524 个顶层 key（含 `meta`，按既有「`meta` 除外」口径为 523）。

### Fixed

- **D1 单聊订阅必然被拒**：`dws chat +chat-list --types p2p` 只返回 `openConversationId`（会话 ID），没有 `userId`/`openDingtalkId`；旧实现把会话 ID 当成 open id 去订阅，服务端返回 `SYSTEM_ERROR: subscribeUser failed: registerToEventCenter failed`。现在单聊发现改走 `contact user search`，p2p 会话列表不再作为单聊订阅来源。
- **D2 单聊回复发不出去**：单聊事件只带 `sender_open_dingtalk_id`；`threadTarget` 现在为单聊输出 `open:<openDingTalkId>`（发送走 `--open-dingtalk-id`），`threadKeyOf` 去掉前缀让计数与防环仍落在同一会话；防环 SQL 同时匹配 `userId`、裸 open id 与 `open:<openId>` 三种历史写法，升级后不会把旧出站记录当别人说的话。
- **D3 拒绝原因被吞掉**：订阅失败过去只表现为“进程退出 + 退避重启”，`lastError` 为空；现在记录脱敏后的服务端原因，`GET channel` 与目标页「订阅」列都能看到。
- **D4 `--dry-run` 通过但服务端拒绝**：`validateTarget` 只证明参数被解析，不证明服务端能注册；对 `cid…=` 形态的 dm id 现在本地先拒绝，避免“校验通过、订阅失败”的误导。
- **D5/D6 群消息被 `mentionOnly` 静默丢弃、at-me 与 group 共用同群时策略串味**：按消息来源分派目标行后，普通群消息按 `group` 行、@ 消息按 at-me 行；at-me 与 group 同时订阅同一群时不再互相覆盖。

### Migration

- **必须改的旧配置**：v0.4.0 及更早通过「单聊」发现加进来、id 是会话 ID（`cid…=`，或 `open:cid…=`）的目标行，升级后会被判 `invalid-target`，订阅不会建立。请在目标页改成对端 `userId` 或 `open:<openDingtalkId>`（用「单聊」+ 联系人姓名重新搜索即可得到）。这是有意的失败关闭：旧 id 无论如何都订阅不上。
- **`mentionOnly` 新语义**：此前该字段在策略层没有生效，群消息只受全局 `reply.requireMentionInGroups` 约束；现在目标行的 `mentionOnly=true` 也会要求 @。若某群目标原本靠“全局关闭 + 行内 true”侥幸回复全部消息，升级后会开始只回 @ 消息——把该行 `mentionOnly` 关掉即可恢复。
- **无 schema、无设置变更**：`SCHEMA_VERSION` 仍为 2，设置仍 9 个 block / 57 个字段，没有新增 block、字段或依赖；不需要迁移脚本。
- **回退安全**：回到 v0.4.0 可打开同一个 `state.db`；`GET channel` 只是新增只读路由，旧面板不调用它。回退后 `mentionOnly` 重新失效、单聊仍需手工维护 id，但既有数据不受影响。

### Known limitations

- **订阅/收发链路未真机验收**：本轮修复的证据只有单元测试与假 `dws` 夹具（`tests/fixtures/fake-dws.mjs`）。`at-me` 订阅本身在真实 `dws` 上曾以 `--ephemeral` 临时探测到 ready（修复前排查时执行），但 `at-me` + `group` 同群去重、单聊订阅与单聊出站回复均未在真实账号上跑通。
- **`contact user search` 的形状只来自一次实测**：字段别名按 `userId`/`staffId`/`openDingtalkId` 等容错解析；同名联系人、跨部门重名与分页语义未验证，候选仍需人工确认。
- **`GET channel` 是进程内视图**：`orphaned` 进程不会因此被清理，`lastError` 只保留最近一次失败原因；插件重启后状态清零。
- **本地规则的边界**：`cid…=` 判断基于正则形状而不是服务端契约；服务端若引入新的会话 id 形态，本地仍可能放过一个注定失败的 id。
- **`retry_after_seconds` 只认数字秒**：字符串或其它单位按无提示处理，仍走本地指数退避。

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
- 发布后（2026-11-04）在 Windows 真机做了**定向**验活并通过（归档 → 下一条消息：归档 3 / 原本已归档 2、generation 1→2、下一条群消息新建会话并回复）。完整 T3/T4 未重跑；`stopActivity=true`、任务 worker 归档、DSH 手动移除工作区、单聊、多目标与 Windows symlink 未真机覆盖，macOS/Linux 未验证。

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
