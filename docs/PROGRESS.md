# 项目进度（v0.4.0 发布）

> 快照时间：2026-11-04 13:25（Asia/Shanghai）。
> 状态：**WS0–WS14 完成**；`0.4.0` 已合并到 `main` `d0ed2e6`，tag `v0.4.0` 由协调者打在本 docs 提交上（本地、未 push）；profile 安装未执行。
> 真机：Windows + DSH Desktop `0.2.1-rc.5` + `dws` `1.0.66` 上 T0–T4 全过（v0.1.0）；v0.2.0 的工作区改造做了 T3/T4 冒烟；v0.3.0 的人设默认/预设做了重载后接口与面板核对；**v0.4.0 的归档/恢复未跑真机**，由单测/集成/组件测试与 QA 独立探针覆盖（[WS14 报告](test-reports/WS14.md)）。验收后测试群目标 `enabled=false`（保留该行与工作区）。

---

## 1. 总体完成度

| 工作流                                           | 状态           | 收口坐标                                                                                                                                                                                                                                   |
| ------------------------------------------------ | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| WS0 骨架 + rc.5 spike + 两轮契约修复             | **完成并合并** | `main` `f1312c6`                                                                                                                                                                                                                           |
| WS1 core 领域 + SQLite store + effects + passes  | **完成并合并** | `main` `e700ad8`                                                                                                                                                                                                                           |
| WS2 `dws` 个人通道                               | **完成并合并** | `main` `e5742d3`，后续真机修复已入 main                                                                                                                                                                                                    |
| WS3 人设/提示/分类/检索/策略                     | **完成并合并** | `main` `5da9601`                                                                                                                                                                                                                           |
| WS4 任务执行器 + agent preset                    | **完成并合并** | `main` `226847e`，后续 LLM/回合修复已入 main                                                                                                                                                                                               |
| WS5a 设置持久化 + 初始 19 条 API + 视图/任务动作 | **完成并合并** | `main` `8dc9b93`（WS14 起为 20 条）                                                                                                                                                                                                        |
| WS5b 组合根 + 流水线 + 健康                      | **完成并合并** | `main` `4ebb2ca`                                                                                                                                                                                                                           |
| WS6 面板 UI 全页签                               | **完成并合并** | `main` `28d5645`                                                                                                                                                                                                                           |
| WS7 README/安装/兼容矩阵/CHANGELOG/013 安全基线  | **完成并合并** | `b0891fc`（`docs: write the security baseline`）                                                                                                                                                                                           |
| WS8 端到端 + 真机 T0–T4 验收                     | **完成并合并** | [WS8-live](test-reports/WS8-live.md)，`main` `3ac88bb`                                                                                                                                                                                     |
| WS9 按会话共享工作区                             | **完成并合并** | `main` `5c713f7`（合并），实现 `e823136`…`06bc9ed`                                                                                                                                                                                         |
| WS10 目标页只读工作区 + 显示名 DSH助理           | **完成并合并** | `main` `1ffb919`（合并），实现 `9d98251`…`fbf8d21`                                                                                                                                                                                         |
| WS11 版本/文档/验收报告收口                      | **完成并合并** | `main` `5e01938`（v0.2.0 发布合并），tag `v0.2.0`                                                                                                                                                                                          |
| WS12 空默认人设 + 可选鲸鱼女仆预设               | **完成并合并** | `main` `a733193`（合并），实现 `be013d7`，[WS12 报告](test-reports/WS12-persona.md)                                                                                                                                                        |
| WS13 v0.3.0 版本/文档/验收报告收口               | **完成并合并** | 发布提交 `chore(release): v0.3.0`；合并 `main` `da51b48`                                                                                                                                                                                   |
| WS14 会话归档 + 工作区自愈                       | **完成并合并** | `main` `d0ed2e6`（`--no-ff` 合并）：`7bdf048`/`9b8a423`（后端）、`5ad5a0a`（fixture 修复）、`0771c1a`/`fe2cf92`（面板）、`3e7c97d`（[WS14 报告](test-reports/WS14.md)）、`ceb13a7`/`0650fb0`/`872a9a0`（文档与发布）、`77810e7`（QA 回填） |

## 2. 发布坐标与门禁

| 项          | 值                                                                                                            |
| ----------- | ------------------------------------------------------------------------------------------------------------- |
| `main` HEAD | `d0ed2e6`（`--no-ff` 合并提交 `chore(merge): ws14 archive workspace sessions`；tag 指向随后的 docs 提交）     |
| 发布分支    | `feat/ws14-archive-sessions`，发布提交 `chore(release): v0.4.0`（`0650fb0`），已以 `--no-ff` 合并到 `d0ed2e6` |
| 版本        | `0.4.0`（`package.json`、`PLUGIN_VERSION`、`check-pack` 三处一致）                                            |
| 管理 API    | **20 条**（WS14 新增 `POST targets/:id/archive-sessions`）；设置仍 57 字段 / 9 block                          |
| 全量测试    | **849 tests / 62 files**（本分支门禁实跑；基线 v0.3.0 为 765 / 60）                                           |
| 打包        | `15 artifacts`，icon 711 bytes（本版不增删产物）                                                              |
| tag         | **`v0.4.0`**（本地，未 push；指向本 docs 提交）                                                               |
| 安装        | 未执行 profile 安装/升级；本版没有安装方式变化                                                                |

## 3. WS14 与 v0.4.0 结论

WS14 增加“归档一个目标工作区的全部会话”和“归档或 DSH 移除工作区后自动恢复”。完整验收见 [WS14 报告](test-reports/WS14.md)，设计与边界见 [WS14 PR](pr/WS14-archive-sessions.md)。历史真机结论（WS12 与更早）仍有效：见 [WS12 报告](test-reports/WS12-persona.md)、[WS9/WS10 报告](test-reports/WS9-10.md)、[WS8 报告](test-reports/WS8-live.md)。

| 项                | 结论                | 关键证据                                                                                                       |
| ----------------- | ------------------- | -------------------------------------------------------------------------------------------------------------- |
| 归档路由与分区    | 通过（测试）        | `POST targets/:id/archive-sessions` 200/400/404/405/403/503；五类分区互斥；20 条路由由 `contract.spec.ts` 钉住 |
| 回复器 generation | 通过（测试）        | g0 与旧公式逐字节相等；手动归档后下一轮轮换 g1；KV 重开后保持；重启首条消息仍 attach 旧会话                    |
| blocked 单次重试  | 通过（测试 + 探针） | 预检后归档 → 恰好 2 次 delivery、第二次 `:r1`；第二次 blocked 不再重试                                         |
| worker generation | 通过（测试 + 探针） | 未归档不变；归档后 `<base>-g1`；重启保留；`-g1` 也归档 → `-g2`                                                 |
| 工作区记录重建    | 通过（测试 + 探针） | 只删记录/目录也在 → mkdir + create；已有记录不改标题；显式 attach 失败轮换、隐式失败不轮换                     |
| 降级              | 通过（测试 + 探针） | mkdir 抛 EACCES 时预检仍完成一轮；归档时仍轮换                                                                 |
| 截断              | 部分                | `truncated`/`candidateCount` 已返回；>500 时已归档候选仍占名额，重复调用不推进尾部（P2-6）                     |
| 面板              | 通过（组件测试）    | ready-only、确认前无请求、body 带 `stopActivity`、结果/truncated/rotated、4 类错误码、Esc、pending             |
| 真机              | **未执行**          | 未启动 DSH Desktop；`ArchivedSessionGate` 与 activity 结构由 fake 按 `error.name` 模拟                         |
| 文档随版本更新    | 完成（本快照）      | README / CHANGELOG / 005 / 006 / 007 / 008 / 010 / 011 / 012 / 013 / 兼容矩阵 / PR / 本文件                    |

> [WS14 报告](test-reports/WS14.md) 第 0 节的“文档随版本更新”已由 QA 在合并窗口回填为“已完成”（`77810e7`）；本文档代理不改 QA 报告正文。

## 4. 已验证的证据

- `pnpm typecheck`：0 错误。
- `pnpm test`：**849 tests / 62 files** 全通过（`feat/ws14-archive-sessions`）。
- `pnpm build`：成功（宿主 ESM + 客户端 CJS）。
- `pnpm format:check` 通过；`node scripts/check-pack.mjs` → `15 artifacts`，icon 711 bytes，版本断言 `0.4.0`。
- `pnpm docs:settings` → `57 fields`，字段表无变化（本版没有新增设置字段）。
- 独立验证：[WS14 报告](test-reports/WS14.md) 的 18 项探针与红队核对（P0-1、P0-2、P1-3、P1-4、P2-7 确认修复；P1-5 部分、P2-6 仍存在）；报告不含 corpId/userId/token/完整群 id。
- 文档门禁：README / CHANGELOG / 005 / 006 / 007 / 008 / 010 / 011 / 012 / 013 / 兼容矩阵 / 014 / PR / 报告链接核对通过。
- 合并坐标：`main` 合并提交 `d0ed2e6`（`--no-ff`）；tag `v0.4.0` 由协调者打在本 docs 提交上（本地、未 push）。
- 面板：七页签、批准流、设置 revision、健康检查、目标页工作区块与「归档会话」入口由组件测试覆盖；本版未新增浏览器截图。

## 5. 已知限制与未覆盖

- **归档未真机**：DSH 的归档闸门、`stopActivity` 取消运行中回复/任务、Windows 上 symlink/realpath 规范化都没有活体证据；macOS/Linux 未验证。
- **归档不可撤销**：不删目录/文件/会话日志，但不提供 unarchive；在 DSH 手动 unarchive 不会回退 generation，旧回复上下文不会自动恢复。
- **归档范围超预期**：候选包含主人在该目录手建的会话与别目标显式批准到本目录的任务会话；`stopActivity=true` 会取消运行中的工作，任务可能失败。
- **候选上限 500**：只处理排序后的前缀，已归档候选仍占名额，重复调用不会推进尾部（P2-6）。
- **重复 target id**：settings 允许重复 id，归档按行顺序取首行；未写测试。
- **`nextReplySessionId` 轻微不一致**：若该代此前已被手动归档，下一条消息的预检会继续前进到再下一代。
- **二次 blocked / 任务竞态**：第二次仍 blocked 会显式失败（聊天里没有回复）；任务在 prepare→deliver 之间被归档没有单次重试。
- **审计只有计数**：`workspace.sessions-archived` 不记 session id 列表。
- 测试替身保真度：`FakeWorkspaceRegistry.archiveSession` 忽略 `stopActivity`，“活动会话被归档并发出 stop”只有 QA 局部替身证明；“活动会话被归档”分支仍需真实契约复验。
- 单聊 o2o 链路未真机触发；`@我` 与 `open:` 单聊的工作区只在单测中验证惰性创建。
- 静默时段、`review` 模式、多目标并发、限流与重启退避未做真机压测。
- 无历史补拉；通知只写审计，不建 DSH 收件箱会话；review 草稿没有发送路由。
- 旧工作区目录不迁移：升级后旧目录与旧会话保留但不被新消息使用。
- `unknown` 不自动重发；任务失败/超时只写审计通知。
- Windows 已实测（v0.1.0–v0.3.0）；macOS/Linux 未验证，不作支持承诺。
- `dws` 其它版本、`--profile` 位置、Windows 关闭 stdin 的优雅退出仍需逐版核对。
- 没有应用层数据库加密；依赖 OS 账户与磁盘加密。
- 已保存的旧 persona 行不自动迁移成空人设；需要空默认时手动「恢复默认（空人设）」并保存。
- `whale-maid` 预设是非官方二创模板、只读；不点保存不会生效。
- v0.4.0 未重跑 T3/T4（只改会话身份与工作区记录，不改分类/发送/任务判定）；归档后的真实 DSH gate 未真机验证。

## 6. 已冻结的决策

| 决策            | 值                                                                                                                                                                  |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 插件身份        | 包名 `dsh-whale-chan-assistant` / 显示名「DSH助理」/ 默认空人设（仅 `name=鲸鱼酱`）；`whale-maid` 是可选预设                                                        |
| 人设默认        | `EMPTY_PERSONA` 为唯一来源：name 鲸鱼酱，identity/tone/signature/knowledge 空，rules/samples 空数组，language `auto`；预设只读、不落库                              |
| 工作区归属      | 一个钉钉会话一个 `conversation-<digest>` 目录，回复器与该会话的任务共用；`<root>` 默认 `<stateDir>/workspaces`                                                      |
| 工作区迁移      | 不迁移、不删除旧目录；布局版本只参与回复器会话 id，换布局即换新会话                                                                                                 |
| 会话 generation | `session.reply-generation:<threadKey>` / `session.worker-generation:<base>` 持久、只增；`g0` 与 v0.3.0 会话 id 逐字节一致；只有归档（或被归档闸门拒绝）才前进       |
| 归档语义        | 归档 = 会话终结：不删目录/文件/日志，不提供 unarchive；当前回复会话被归档后，下一条消息用新会话（被拒绝的运行中会话继续使用）；DSH 手动 unarchive 不回退 generation |
| 归档范围        | registry 同路径 + sessionPersistence `header.cwd` 同路径 + 当前回复器的并集；含主人手建与别目标批准到该目录的任务会话                                               |
| 归档上限        | 单次最多 500 个候选，排序后截断且当前回复器不丢；>500 时重复调用不推进尾部；`truncated`/`candidateCount` 如实返回                                                   |
| 重复 target id  | 按 settings `targets.rows` 顺序取首行；不合并、不猜测                                                                                                               |
| 标题归属        | 会话标题由目标预建与回复器负责；任务加入已有目录不改名；预检**绝不**改已有记录标题                                                                                  |
| 代回复披露      | 固定钉钉 AI 角标；不额外加前缀；v1 不提供关闭开关                                                                                                                   |
| 批准通道        | 仅 DSH 面板；钉钉 A2UI 卡片留后续版本                                                                                                                               |
| 管理 API        | 20 个端点；`GET persona` 只读并返回 `persona/revision/defaults/presets`；`PUT settings/:block` 必带 revision，块内深合并                                            |
| 设置默认        | `quietHours.enabled=true`（22:00–08:00）、`replyDuringQuiet=false`、`dryRun=false`                                                                                  |
| 任务执行        | 无 `Approval(approve)` 不得创建 Assignment；迟到批准拒绝；取消后不可复活                                                                                            |
| 发送未知        | `replyUnknown` 为终态，不自动重发，需主人核对                                                                                                                       |
| effects         | 保留 `UNIQUE(kind,key) WHERE state IN ('waiting','running')`；运行中 enqueue 覆盖 payload + `generation+1`，当前尝试结束后重跑                                      |
| 监听目标        | 运行时只用已解析的 `openConversationId`/`userId`，不在监听期按名字解析                                                                                              |
| 真机测试        | 仅测试群；T0 只读 → T1 目标校验 → T2 单条 → T3 @我 → T4 任务批准；验收后停用目标                                                                                    |

## 7. 记录规范（延续）

- 每个 WS：独立分支 + `docs/pr/WSn-*.md` + `docs/test-reports/WSn.md`；合并用 `--no-ff`。
- 改设置字段 → 同步 `docs/011-settings-contract.md`；改协议 → `docs/009-dws-protocol.md`；改面板 → `docs/005-panel.md`；改安全边界 → `docs/013-security.md`。
- 发布：SemVer + `CHANGELOG.md` + tag；兼容矩阵在 `package.json.dsh.compatibility`。
