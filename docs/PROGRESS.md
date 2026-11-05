# 项目进度（v0.6.0 发布）

> 快照时间：2026-11-05 16:50（Asia/Shanghai）。
> 状态：**WS0–WS16 完成**；`0.6.0` 在分支 `fix/ws16-reply-budget`（worktree `wt-ws16`）收口——实现提交 `18ac297`（引用预算与正文分离）与 `c0d4b39`（`reply.autoRetry` 单次重试）已提交，文档与版本收口由 coordinator 提交后合并；**尚未合并、尚未打 tag**。历史：`0.5.0` 已合并到 `main` `858f6fd`，tag `v0.5.0` 已打（annotated，指向 `3a8c788`，本地、未 push）；profile 安装未执行。
> 真机：Windows + DSH Desktop `0.2.1-rc.5` + `dws` `1.0.66` 上 T0–T4 全过（v0.1.0）；v0.2.0 的工作区改造做了 T3/T4 冒烟；v0.3.0 的人设默认/预设做了重载后接口与面板核对；v0.4.0 于 2026-11-04 发布后做了定向真机验活并通过（归档 → 下一条消息），完整 T3/T4 未重跑；**v0.5.0 的订阅/收发链路与 v0.6.0 的回复预算/重试均未在真实账号上验收**（只有单测与假 `dws` 夹具），见 [WS15 报告](test-reports/WS15.md) 与 [WS16 报告](test-reports/WS16.md)。

---

## 1. 总体完成度

| 工作流                                           | 状态               | 收口坐标                                                                                                                                                                                                                                                                                                                              |
| ------------------------------------------------ | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| WS0 骨架 + rc.5 spike + 两轮契约修复             | **完成并合并**     | `main` `f1312c6`                                                                                                                                                                                                                                                                                                                      |
| WS1 core 领域 + SQLite store + effects + passes  | **完成并合并**     | `main` `e700ad8`                                                                                                                                                                                                                                                                                                                      |
| WS2 `dws` 个人通道                               | **完成并合并**     | `main` `e5742d3`，后续真机修复已入 main                                                                                                                                                                                                                                                                                               |
| WS3 人设/提示/分类/检索/策略                     | **完成并合并**     | `main` `5da9601`                                                                                                                                                                                                                                                                                                                      |
| WS4 任务执行器 + agent preset                    | **完成并合并**     | `main` `226847e`，后续 LLM/回合修复已入 main                                                                                                                                                                                                                                                                                          |
| WS5a 设置持久化 + 初始 19 条 API + 视图/任务动作 | **完成并合并**     | `main` `8dc9b93`（WS14 起为 20 条，WS15 起为 21 条）                                                                                                                                                                                                                                                                                  |
| WS5b 组合根 + 流水线 + 健康                      | **完成并合并**     | `main` `4ebb2ca`                                                                                                                                                                                                                                                                                                                      |
| WS6 面板 UI 全页签                               | **完成并合并**     | `main` `28d5645`                                                                                                                                                                                                                                                                                                                      |
| WS7 README/安装/兼容矩阵/CHANGELOG/013 安全基线  | **完成并合并**     | `b0891fc`（`docs: write the security baseline`）                                                                                                                                                                                                                                                                                      |
| WS8 端到端 + 真机 T0–T4 验收                     | **完成并合并**     | [WS8-live](test-reports/WS8-live.md)，`main` `3ac88bb`                                                                                                                                                                                                                                                                                |
| WS9 按会话共享工作区                             | **完成并合并**     | `main` `5c713f7`（合并），实现 `e823136`…`06bc9ed`                                                                                                                                                                                                                                                                                    |
| WS10 目标页只读工作区 + 显示名 DSH助理           | **完成并合并**     | `main` `1ffb919`（合并），实现 `9d98251`…`fbf8d21`                                                                                                                                                                                                                                                                                    |
| WS11 版本/文档/验收报告收口                      | **完成并合并**     | `main` `5e01938`（v0.2.0 发布合并），tag `v0.2.0`                                                                                                                                                                                                                                                                                     |
| WS12 空默认人设 + 可选鲸鱼女仆预设               | **完成并合并**     | `main` `a733193`（合并），实现 `be013d7`，[WS12 报告](test-reports/WS12-persona.md)                                                                                                                                                                                                                                                   |
| WS13 v0.3.0 版本/文档/验收报告收口               | **完成并合并**     | 发布提交 `chore(release): v0.3.0`；合并 `main` `da51b48`                                                                                                                                                                                                                                                                              |
| WS14 会话归档 + 工作区自愈                       | **完成并合并**     | `main` `d0ed2e6`（`--no-ff` 合并）：`7bdf048`/`9b8a423`（后端）、`5ad5a0a`（fixture 修复）、`0771c1a`/`fe2cf92`（面板）、`3e7c97d`（[WS14 报告](test-reports/WS14.md)）、`ceb13a7`/`0650fb0`/`872a9a0`（文档与发布）、`77810e7`（QA 回填）、`ee6bb97`（[真机验活](test-reports/WS14-live.md)）                                        |
| WS15 目标订阅 + 订阅健康 + 单聊修复              | **完成并合并**     | `main` `858f6fd`（`--no-ff` 合并 `chore(merge): ws15 target subscription fixes`）：`1ecea26`（open id 出站）、`320fbe8`（联系人发现）、`488cf0a`（目标行策略）、`a80f6b3`（服务端拒绝）、`a0ec771`（`GET channel`）、`aebc663`（订阅列与提示）、`dbab720`（v0.5.0 发布）、`829e9f6`（文档）；验收见 [WS15 报告](test-reports/WS15.md) |
| WS16 回复预算 + 单次自动重试                     | **完成（待合并）** | 分支 `fix/ws16-reply-budget`（worktree `wt-ws16`）：`18ac297`（引用预算与正文分离、`sanitized_empty`）、`c0d4b39`（`reply.autoRetry` 单次重试、`notRetryable`）；验收见 [WS16 报告](test-reports/WS16.md)，设计见 [WS16 PR](pr/WS16-reply-budget.md)；**尚未合并、未打 tag**                                                          |

## 2. 发布坐标与门禁

| 项          | 值                                                                                                                              |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `main` HEAD | `858f6fd`（v0.5.0 `--no-ff` 合并提交，`chore(merge): ws15 target subscription fixes`）；WS16 尚未合并                           |
| 发布分支    | `fix/ws16-reply-budget`（worktree `wt-ws16`），实现 `18ac297` + `c0d4b39`；文档与版本收口由 coordinator 提交，合并后进入 `main` |
| 版本        | `0.6.0`（`package.json`、`PLUGIN_VERSION`、`check-pack` 三处一致）                                                              |
| 管理 API    | **21 条**（WS16 不新增路由）；设置 **58 字段 / 9 block**（新增 `reply.autoRetry`）；schema 仍 2                                 |
| 全量测试    | **894 tests / 63 files**（本分支门禁实跑；基线 v0.5.0 为 880 / 63，WS16 +14 条）                                                |
| 打包        | `15 artifacts`，icon 711 bytes（本版不增删产物）                                                                                |
| 真机        | **v0.6.0 回复预算/重试未验收**（单测 + 假 `dws` 夹具）；v0.5.0 订阅/单聊同样未验收                                              |
| tag         | `v0.5.0` 已打（annotated，指向 `3a8c788`，本地、未 push）；**`v0.6.0` 待打**；历史 tag `v0.4.0` 指向 `c82027a`                  |
| 安装        | 未执行 profile 安装/升级；本版没有安装方式变化                                                                                  |

## 3. WS16 与 v0.6.0 结论

WS16 修的是“回复正文被引用脚注挤空、失败一次就丢回复”这一组问题：`persona.maxReplyChars` 只约束正文，引用脚注按 `CITATIONS_MAX_CHARS`（600 码点）逐行取舍或整体丢弃；模型真空输出与清洗后为空拆成 `empty` / `sanitized_empty`；新增 `reply.autoRetry`（默认开）让可重试失败最多多试一次，第二次仍失败才 `defer`。自动化验收见 [WS16 报告](test-reports/WS16.md)，设计与证据链见 [WS16 PR](pr/WS16-reply-budget.md)。历史结论（WS15 与更早）仍有效：见 [WS15 报告](test-reports/WS15.md)、[WS14 报告](test-reports/WS14.md)、[WS14-live](test-reports/WS14-live.md)、[WS12 报告](test-reports/WS12-persona.md)、[WS9/WS10 报告](test-reports/WS9-10.md)、[WS8 报告](test-reports/WS8-live.md)。

| 项                 | 结论              | 关键证据                                                                                                                                                               |
| ------------------ | ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 正文与引用预算分离 | 通过（测试）      | `brain-reply.spec.ts` 28 条：正文按 `maxReplyChars` 截断、引用逐行取舍（`trimmed`，超长行不连坐后面的短行）、一条都放不下整体丢弃（`dropped`）、正文不再被脚注挤空     |
| `sanitized_empty`  | 通过（测试）      | `brain-reply.spec.ts`：真空输出 → `empty`；有输出但被清洗为空 → `sanitized_empty` 且 `detail` 带样本；`pipeline-chat` 断言该词会触发重试                               |
| `reply.autoRetry`  | 通过（测试）      | `pipeline-chat.spec.ts` 23 条（+5）：重试一次、第二次失败才 `defer`、开关关闭不重试、重试携带 `research`；`settings.spec.ts` 12 条（+1）断言默认 `true` 与 strict 校验 |
| 重试不迁移状态     | 通过（测试）      | `core-engine.spec.ts` 29 条（+1）：`recordReplyAttempt` 只接受 `classified`，否则 `notRetryable`（`refused`）；只累加 `attempts`，不覆盖 `reason`、不发领域事件        |
| 设置契约           | 通过（测试/生成） | `pnpm docs:settings` → 58 fields；`docs/011` 由生成器产出；locale 中英各 526 个顶层 key（`meta` 除外 525）                                                             |
| 真机               | **未验收**        | 只有单测与假 `dws` 夹具（63 files / 894 tests）；未在真实账号上触发“长引用 + 失败重试”，见 [WS16 报告](test-reports/WS16.md) §5                                        |
| 文档随版本更新     | 完成（本快照）    | README / CHANGELOG / 004 / 005 / 007 / 011 / 012 / 014 / 兼容矩阵 / PR / WS16 报告 / 本文件                                                                            |

> v0.6.0 的对外口径统一是“修复已实现、有单测证据、**未真机验收**”。真机跑通前不要在任何文档里把引用预算/重试链路写成“已验证”。

## 4. 已验证的证据

- `pnpm typecheck`：0 错误。
- `pnpm test`：**894 tests / 63 files** 全通过（`fix/ws16-reply-budget`）。
- `pnpm build`：成功（宿主 ESM + 客户端 CJS，`pnpm check` 内）。
- `pnpm format:check` 通过；`node scripts/check-pack.mjs` → `15 artifacts`，icon 711 bytes，版本断言 `0.6.0`。
- `pnpm docs:settings` → `58 fields`（新增 `reply.autoRetry`）；重新生成后 `git diff --exit-code docs/011-settings-contract.md` 无输出。
- 单测证据（见 [WS16 报告](test-reports/WS16.md)）：`brain-reply`（引用逐行取舍/丢弃、正文预算、`sanitized_empty`，28 条）、`pipeline-chat`（重试一次/开关/研究结果随重试，23 条）、`core-engine`（`recordReplyAttempt` 与 `notRetryable`，29 条）、`core-invariants`（错误码分类，16 条）、`settings`（`reply.autoRetry` 默认与校验，12 条）。
- 增量相对 v0.5.0：**+14 tests / 0 files**（`brain-reply` +7、`pipeline-chat` +5、`core-engine` +1、`settings` +1）。
- **没有真机证据**：v0.6.0 的引用预算与重试未在真实账号上跑过；v0.5.0 的订阅/收发链路同样未验收。
- 文档门禁：README / CHANGELOG / 004 / 005 / 007 / 011 / 012 / 014 / 兼容矩阵 / PR / 报告链接核对通过；`docs/011` 由生成器产出，未手改。
- 坐标：分支 `fix/ws16-reply-budget`（worktree `wt-ws16`），实现提交 `18ac297` 与 `c0d4b39`；合并、tag、push 与 profile 安装由发布负责人执行。历史：`v0.5.0` 已以 `--no-ff` 合并到 `main` `858f6fd`，tag `v0.5.0` 已打（annotated，指向 `3a8c788`，本地、未 push）。
- 面板：`reply.autoRetry` 由字段表渲染、`persona.maxReplyChars.hint` 文案变更由 locale 契约测试覆盖；本版未新增浏览器截图。

## 5. 已知限制与未覆盖

- **v0.6.0 回复预算/重试未真机验收**：长引用正文、`sanitized_empty` 触发、重试后的第二稿差异只有单测证据；真机清单见 [012 发布](012-release.md) §6。
- **重试原因只在 host 日志**：自动重试不产生独立审计事件，面板与审计流看不到“多试了一次”，只有 `decisions.attempts` +1 与 `compose retry 1/1 for decision <id>` 日志。
- **引用取舍是静默的**：脚注 `trimmed`/`dropped` 时聊天里只表现为“少了几条参考”，没有面向主人的提示；`SanitizeResult.citations` 目前只给代码与测试用。
- **`timeout` 不重试**：60 秒预算耗尽后直接 `defer`，不会为“只是慢”的调用多等一轮。
- **v0.5.0 订阅/收发链路未真机验收**：`at-me`+`group` 同群去重、单聊订阅与单聊出站回复只有单测与假 `dws` 夹具证据；`o2o` 事件键在登录态下的 ready 也未实测。
- **`contact user search` 只实测过一种形状**：同名/重名联系人排序、分页与 `nick`≠`name` 的表现未验证；候选仍需人工确认。
- **`cid…=` 是形状判断**：服务端若引入新的会话 id 形态，本地可能放过一个注定失败的 id；反之极少数合法 userId 若以 `cid` 开头会被误拒。
- **`GET channel` 是进程内快照**：不清理 `orphaned`、不持久化 `lastError`，插件重启后清零；同一 `targetId` 在多行时共享同一状态。
- **`retry_after_seconds` 只认数字秒**：字符串或其它单位按无提示处理，仍走本地指数退避。
- **历史限制仍有效**：归档只做定向真机补验（`stopActivity=true`、worker 归档、手动移除工作区、多目标、symlink 未覆盖）；归档不可撤销、候选上限 500；无历史补拉；通知只写审计；review 草稿没有发送路由；`unknown` 不自动重发；静默时段/限流/多目标未做真机压测；单聊 o2o 链路未真机触发；`@我` 与 `open:` 单聊的工作区只在单测中验证惰性创建。
- **Windows 已实测（v0.1.0–v0.4.0）**；v0.4.0 为发布后定向真机验活（归档 → 下一条消息），v0.5.0 与 v0.6.0 无真机；macOS/Linux 未验证，不作支持承诺。
- `dws` 其它版本、`--profile` 位置、Windows 关闭 stdin 的优雅退出仍需逐版核对。
- 没有应用层数据库加密；依赖 OS 账户与磁盘加密。
- 已保存的旧 persona 行不自动迁移成空人设；`whale-maid` 预设是非官方二创模板、只读，不点保存不会生效。

## 6. 已冻结的决策

| 决策            | 值                                                                                                                                                                     |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 插件身份        | 包名 `dsh-whale-chan-assistant` / 显示名「DSH助理」/ 默认空人设（仅 `name=鲸鱼酱`）；`whale-maid` 是可选预设                                                           |
| 人设默认        | `EMPTY_PERSONA` 为唯一来源：name 鲸鱼酱，identity/tone/signature/knowledge 空，rules/samples 空数组，language `auto`；预设只读、不落库                                 |
| 工作区归属      | 一个钉钉会话一个 `conversation-<digest>` 目录，回复器与该会话的任务共用；`<root>` 默认 `<stateDir>/workspaces`                                                         |
| 工作区迁移      | 不迁移、不删除旧目录；布局版本只参与回复器会话 id，换布局即换新会话                                                                                                    |
| 会话 generation | `session.reply-generation:<threadKey>` / `session.worker-generation:<base>` 持久、只增；`g0` 与 v0.3.0 会话 id 逐字节一致；只有归档（或被归档闸门拒绝）才前进          |
| 归档语义        | 归档 = 会话终结：不删目录/文件/日志，不提供 unarchive；当前回复会话被归档后，下一条消息用新会话（被拒绝的运行中会话继续使用）；DSH 手动 unarchive 不回退 generation    |
| 归档范围        | registry 同路径 + sessionPersistence `header.cwd` 同路径 + 当前回复器的并集；含主人手建与别目标批准到该目录的任务会话                                                  |
| 归档上限        | 单次最多 500 个候选，排序后截断且当前回复器不丢；>500 时重复调用不推进尾部；`truncated`/`candidateCount` 如实返回                                                      |
| 重复 target id  | 按 settings `targets.rows` 顺序取首行；不合并、不猜测                                                                                                                  |
| 标题归属        | 会话标题由目标预建与回复器负责；任务加入已有目录不改名；预检**绝不**改已有记录标题                                                                                     |
| 代回复披露      | 固定钉钉 AI 角标；不额外加前缀；v1 不提供关闭开关                                                                                                                      |
| 批准通道        | 仅 DSH 面板；钉钉 A2UI 卡片留后续版本                                                                                                                                  |
| 管理 API        | 21 个端点；`GET persona` 只读并返回 `persona/revision/defaults/presets`；`PUT settings/:block` 必带 revision，块内深合并                                               |
| 目标 id 形态    | `group` → `openConversationId`；`dm` → 对端 `userId` 或 `open:<openDingtalkId>`（会话 ID `cid…=` 本地拒绝）；`at-me` 的 id 只是标记，不参与订阅                        |
| mentionOnly     | 与全局 `reply.requireMentionInGroups` 取**或**；只对 `group` 生效，`at-me`/`dm` 恒视为已定向                                                                           |
| 权威目标解析    | 来源（at-me 行）→ 会话（`group:<cid>` 行）→ 回退（创建线程的行）；不使用 `Thread.targetId` 直接当策略行                                                                |
| 单聊出站        | 事件只带 `sender_open_dingtalk_id` → `threadTarget` 输出 `open:<id>`，发送走 `--open-dingtalk-id`；防环 SQL 同时匹配 `userId`/裸 open id/`open:<id>`                   |
| 订阅失败策略    | 结构化 `{"error":{…}}` 记为服务端拒绝；退避 `max(指数, retry_after_seconds)` 且封顶；连续 3 次无 retry 提示停止重启（`failed`）                                        |
| 订阅健康        | `GET channel` 只读投影（`state`/`running`/`targets[]`，含 `restarts`/`readyAt`/脱敏 `lastError`）；不落库、不触发重启                                                  |
| 回复预算        | `persona.maxReplyChars` 只约束正文（1–800）；引用脚注独立上限 `CITATIONS_MAX_CHARS = 600` 码点，逐行取舍或整体丢弃，绝不挤占正文                                       |
| 回复失败语义    | `timeout` / `empty` / `sanitized_empty` / `echoes_system_prompt` / `model_error`；`defer` 是唯一失败终态                                                               |
| 自动重试        | `reply.autoRetry`（默认 `true`）：`empty`/`sanitized_empty`/`model_error` 最多重试 **1 次**；`timeout`/`echoes_system_prompt` 不重试；只累加 `attempts` + 写 host 日志 |
| 设置默认        | `quietHours.enabled=true`（22:00–08:00）、`replyDuringQuiet=false`、`dryRun=false`、`reply.autoRetry=true`                                                             |
| 任务执行        | 无 `Approval(approve)` 不得创建 Assignment；迟到批准拒绝；取消后不可复活                                                                                               |
| 发送未知        | `replyUnknown` 为终态，不自动重发，需主人核对                                                                                                                          |
| effects         | 保留 `UNIQUE(kind,key) WHERE state IN ('waiting','running')`；运行中 enqueue 覆盖 payload + `generation+1`，当前尝试结束后重跑                                         |
| 监听目标        | 运行时只用已解析的 `openConversationId`/`userId`/`open:<openDingtalkId>`；不在监听期按名字解析；单聊发现只走 `contact user search`                                     |
| 真机测试        | 仅测试群；T0 只读 → T1 目标校验 → T2 单条 → T3 @我 → T4 任务批准；验收后停用目标；v0.5.0 订阅/单聊与 v0.6.0 回复预算/重试待补验                                        |

## 7. 记录规范（延续）

- 每个 WS：独立分支 + `docs/pr/WSn-*.md` + `docs/test-reports/WSn.md`；合并用 `--no-ff`。
- 改设置字段 → 同步 `docs/011-settings-contract.md`；改协议 → `docs/009-dws-protocol.md`；改面板 → `docs/005-panel.md`；改安全边界 → `docs/013-security.md`。
- 发布：SemVer + `CHANGELOG.md` + tag；兼容矩阵在 `package.json.dsh.compatibility`。
