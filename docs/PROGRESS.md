# 项目进度（v0.1.0 发布准备）

> 快照时间：2026-11-03 16:45（Asia/Shanghai）。
> 状态：**WS0–WS8 完成**；`0.1.0` 发布提交已就绪。**tag、push、profile 安装均未执行**，等发布复核。
> 真机：Windows + DSH Desktop `0.2.1-rc.5` + `dws` `1.0.66` 上 T0–T4 全过；验收后测试群目标已停用。

---

## 1. 总体完成度

| 工作流                                          | 状态           | 收口坐标                                               |
| ----------------------------------------------- | -------------- | ------------------------------------------------------ |
| WS0 骨架 + rc.5 spike + 两轮契约修复            | **完成并合并** | `main` `f1312c6`                                       |
| WS1 core 领域 + SQLite store + effects + passes | **完成并合并** | `main` `e700ad8`                                       |
| WS2 `dws` 个人通道                              | **完成并合并** | `main` `e5742d3`，后续真机修复已入 main                |
| WS3 人设/提示/分类/检索/策略                    | **完成并合并** | `main` `5da9601`                                       |
| WS4 任务执行器 + agent preset                   | **完成并合并** | `main` `226847e`，后续 LLM/回合修复已入 main           |
| WS5a 设置持久化 + 19 条 API + 视图/任务动作     | **完成并合并** | `main` `8dc9b93`                                       |
| WS5b 组合根 + 流水线 + 健康                     | **完成并合并** | `main` `4ebb2ca`                                       |
| WS6 面板 UI 全页签                              | **完成并合并** | `main` `28d5645`                                       |
| WS7 README/安装/兼容矩阵/CHANGELOG/013 安全基线 | **完成并合并** | `b0891fc`（`docs: write the security baseline`）       |
| WS8 端到端 + 真机 T0–T4 验收                    | **完成**       | [WS8-live](test-reports/WS8-live.md)，`main` `f43d7c3` |

## 2. 发布坐标与门禁

| 项          | 值                                                                 |
| ----------- | ------------------------------------------------------------------ |
| `main` HEAD | `f43d7c3`（含 `7850149` / `90f95a5` 等 WS8 真机修复与 T4 脱敏）    |
| 发布分支    | `feat/ws7-docs`，发布提交 `chore(release): v0.1.0`                 |
| 版本        | `0.1.0`（`package.json`、`PLUGIN_VERSION`、`check-pack` 三处一致） |
| 全量测试    | **702 tests**（脱敏修复合并后的 main；发布提交需复跑确认）         |
| 打包        | `15 artifacts`，icon 711 bytes                                     |
| tag         | **未打**；由发布复核后执行 `v0.1.0`                                |
| 安装        | 未执行 profile 安装/升级；真机验收使用已安装的 link 版本           |

## 3. WS8 真机结论（T0–T4）

| 级别 | 结论                             | 关键证据                                                                                                 |
| ---- | -------------------------------- | -------------------------------------------------------------------------------------------------------- |
| T0   | 通过                             | `auth status` authenticated/token valid；`+chat-search` 命中测试群                                       |
| T1   | 通过（修复 `--ttl` 后）          | at-me 与群目标均 `valid:true`；未创建订阅                                                                |
| T2   | 通过（修复 `--yes` 后）          | AI 角标 + 幂等键；`deliveryStatus=delivered`、`openMessageId`；重复键 `CONFLICT_ERROR` 按 `unknown` 处理 |
| T3   | 通过（修复归一化后）             | 真实群事件 → 分类 → 回复；outbound `sent` 且有回执                                                       |
| T4   | 通过（修复回合认领与结果脱敏后） | `awaiting-approval` → 批准 → `running` → `succeeded`；产物与结果回帖一致，对外文本不含内部路由/会话 ID   |

真机修复（已入 main）：

- `--ttl` 改为 Go duration（`"<hours>h"`）；
- 非交互发送追加 `--yes`，解析 `openMessageId`/`deliveryStatus`，重复幂等键按 `unknown`；
- 归一化适配真实 snake_case 扁平事件（`message_id`/`conversation_id`/`sender_open_dingtalk_id`/`content`/`event_time`/`create_time`），`@ownerNick` 文本判定；
- `TurnTracker` 等待下一个 `turn/start` 认领；`deliveryId()` 统一 `dsh-whale-chan:` 前缀。
- T4 结果回帖脱敏：结果模板只保留标题与摘要，worker prompt 禁止输出 `Route`、工具名、会话 ID、工作区路径；702 tests 覆盖。

验收后动作：测试群目标已停用（`targets.rows=[]`），通道回到 `idle: no enabled targets`；测试期间临时文件已删除，不入库。

## 4. 已验证的证据

- `pnpm check`（main）：typecheck 0 错误，**702 tests**，build 成功。
- `pnpm format:check` 通过；`node scripts/check-pack.mjs` → `15 artifacts`，icon 711 bytes。
- WS7 文档门禁：`pnpm check`、`format:check`、`check-pack` 通过；README/CHANGELOG/012/013/兼容矩阵链接核对通过。
- WS8 真机：见 [WS8-live](test-reports/WS8-live.md)；报告不含 corpId/userId/token/完整群 id。
- 面板：侧边栏「鲸鱼酱」可见；七页签、批准流、设置 revision、健康检查均在真机使用。

## 5. 已知限制与未覆盖

- 单聊 o2o 链路未真机触发；群事件与群发送已确认。
- 静默时段、`review` 模式、多目标并发、限流与重启退避未做真机压测。
- 无历史补拉；通知只写审计，不建 DSH 收件箱会话；review 草稿没有发送路由。
- `unknown` 不自动重发；任务失败/超时只写审计通知。
- Windows 已实测；macOS/Linux 未验证，不作支持承诺。
- `dws` 其它版本、`--profile` 位置、Windows 关闭 stdin 的优雅退出仍需逐版核对。
- 没有应用层数据库加密；依赖 OS 账户与磁盘加密。

## 6. 已冻结的决策

| 决策       | 值                                                                                                                             |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------ |
| 插件身份   | `dsh-whale-chan-assistant` /「鲸鱼酱 · 钉钉助理」/ 默认二次元助理语气                                                          |
| 代回复披露 | 固定钉钉 AI 角标；不额外加前缀；v1 不提供关闭开关                                                                              |
| 批准通道   | 仅 DSH 面板；钉钉 A2UI 卡片留后续版本                                                                                          |
| 管理 API   | 19 个端点；`GET persona` 只读；`PUT settings/:block` 必带 revision，块内深合并                                                 |
| 设置默认   | `quietHours.enabled=true`（22:00–08:00）、`replyDuringQuiet=false`、`dryRun=false`                                             |
| 任务执行   | 无 `Approval(approve)` 不得创建 Assignment；迟到批准拒绝；取消后不可复活                                                       |
| 发送未知   | `replyUnknown` 为终态，不自动重发，需主人核对                                                                                  |
| effects    | 保留 `UNIQUE(kind,key) WHERE state IN ('waiting','running')`；运行中 enqueue 覆盖 payload + `generation+1`，当前尝试结束后重跑 |
| 监听目标   | 运行时只用已解析的 `openConversationId`/`userId`，不在监听期按名字解析                                                         |
| 真机测试   | 仅测试群；T0 只读 → T1 目标校验 → T2 单条 → T3 @我 → T4 任务批准；验收后停用目标                                               |

## 7. 记录规范（延续）

- 每个 WS：独立分支 + `docs/pr/WSn-*.md` + `docs/test-reports/WSn.md`；合并用 `--no-ff`。
- 改设置字段 → 同步 `docs/011-settings-contract.md`；改协议 → `docs/009-dws-protocol.md`；改面板 → `docs/005-panel.md`；改安全边界 → `docs/013-security.md`。
- 发布：SemVer + `CHANGELOG.md` + tag；兼容矩阵在 `package.json.dsh.compatibility`。
