# 项目进度（v0.2.0 发布准备）

> 快照时间：2026-11-03 19:20（Asia/Shanghai）。
> 状态：**WS0–WS10 完成**；`0.2.0` 发布提交已就绪。**tag、push、profile 安装均未执行**，等发布复核。
> 真机：Windows + DSH Desktop `0.2.1-rc.5` + `dws` `1.0.66` 上 T0–T4 全过；v0.2.0 的工作区改造做了 T3/T4 冒烟；验收后测试群目标停用。

---

## 1. 总体完成度

| 工作流                                          | 状态           | 收口坐标                                                    |
| ----------------------------------------------- | -------------- | ----------------------------------------------------------- |
| WS0 骨架 + rc.5 spike + 两轮契约修复            | **完成并合并** | `main` `f1312c6`                                            |
| WS1 core 领域 + SQLite store + effects + passes | **完成并合并** | `main` `e700ad8`                                            |
| WS2 `dws` 个人通道                              | **完成并合并** | `main` `e5742d3`，后续真机修复已入 main                     |
| WS3 人设/提示/分类/检索/策略                    | **完成并合并** | `main` `5da9601`                                            |
| WS4 任务执行器 + agent preset                   | **完成并合并** | `main` `226847e`，后续 LLM/回合修复已入 main                |
| WS5a 设置持久化 + 19 条 API + 视图/任务动作     | **完成并合并** | `main` `8dc9b93`                                            |
| WS5b 组合根 + 流水线 + 健康                     | **完成并合并** | `main` `4ebb2ca`                                            |
| WS6 面板 UI 全页签                              | **完成并合并** | `main` `28d5645`                                            |
| WS7 README/安装/兼容矩阵/CHANGELOG/013 安全基线 | **完成并合并** | `b0891fc`（`docs: write the security baseline`）            |
| WS8 端到端 + 真机 T0–T4 验收                    | **完成并合并** | [WS8-live](test-reports/WS8-live.md)，`main` `3ac88bb`      |
| WS9 按会话共享工作区                            | **完成并合并** | `main` `5c713f7`（合并），实现 `e823136`…`06bc9ed`          |
| WS10 目标页只读工作区 + 显示名 DSH助理          | **完成并合并** | `main` `1ffb919`（合并），实现 `9d98251`…`fbf8d21`          |
| WS11 版本/文档/验收报告收口                     | **完成**       | 本文件与 `chore(release): v0.2.0`，分支 `feat/ws11-release` |

## 2. 发布坐标与门禁

| 项          | 值                                                                 |
| ----------- | ------------------------------------------------------------------ |
| `main` HEAD | `5e01938`（v0.2.0 发布合并；tag 指向随后的文档修正提交）           |
| 发布分支    | `feat/ws11-release`，发布提交 `chore(release): v0.2.0`，已合并     |
| 版本        | `0.2.0`（`package.json`、`PLUGIN_VERSION`、`check-pack` 三处一致） |
| 全量测试    | **755 tests / 60 files**（发布门禁实跑）                           |
| 打包        | `15 artifacts`，icon 711 bytes（本版不增删产物）                   |
| tag         | **`v0.2.0`**（本地，未 push；指向发布复核提交）                    |
| 安装        | 未执行 profile 安装/升级；真机验收使用已安装的 link 版本           |

## 3. WS9/WS10 真机结论

v0.2.0 的工作区改造在测试群复验 T3/T4，完整记录见 [WS9-10 报告](test-reports/WS9-10.md)。

| 项                        | 结论                 | 关键证据                                                                                       |
| ------------------------- | -------------------- | ---------------------------------------------------------------------------------------------- |
| 目标页工作区投影          | 通过                 | 启用测试群后 `GET targets` 返回 `workspace.mode=ready` 与 `...\workspaces\conversation-<hash>` |
| 目录与注册记录            | 通过                 | 目录实际存在，DSH workspace registry 有同 path 记录                                            |
| 回复 + 任务同一 workspace | 通过                 | `whale-reply-…` 与 `whale-task-…` 两个会话的 `sessionIds` 属于同一 workspace                   |
| 任务可写共享工作区        | 通过                 | 任务写入 `ws-check.txt`，内容 `workspace-ok`                                                   |
| 会话标题                  | 通过（修复后）       | 标题为 `钉钉 · <测试群名>`，任务加入不再改写                                                   |
| T3 人设                   | 通过                 | 回复仍以鲸鱼酱人设发出                                                                         |
| T4 结果回执               | 通过                 | 回执已发送，不含内部路由与会话 id                                                              |
| 显示名                    | 通过                 | 侧栏与面板显示「DSH助理」（默认人设仍为鲸鱼酱）                                                |
| 旧数据                    | 未迁移、未删除       | 旧会话/旧 `<stateDir>/workspace`/`tasks/<taskId>` 原样保留                                     |
| `@我` / `open:` 惰性      | 仅单测覆盖，未做真机 | 全局订阅与仅发送 id 无单一会话，首条消息时创建目录                                             |

验收后动作：测试群目标已停用（`targets.rows=[]`），通道回到 `idle: no enabled targets`；测试期间临时文件已删除，不入库。

## 4. 已验证的证据

- `pnpm check`（`main` `1ffb919`）：typecheck 0 错误，**755 tests / 60 files**，build 成功。
- `pnpm format:check` 通过；`node scripts/check-pack.mjs` → `15 artifacts`，icon 711 bytes。
- 文档门禁：README / CHANGELOG / 012 / 013 / 兼容矩阵 / PROGRESS / WS9-10 报告链接核对通过。
- WS8 真机：见 [WS8-live](test-reports/WS8-live.md)；WS9/WS10 真机：见 [WS9-10](test-reports/WS9-10.md)；两份报告都不含 corpId/userId/token/完整群 id。
- 面板：侧边栏「DSH助理」可见；七页签、批准流、设置 revision、健康检查、目标页工作区块均在真机使用。

## 5. 已知限制与未覆盖

- 单聊 o2o 链路未真机触发；群事件与群发送已确认。
- `@我` 与 `open:` 单聊的工作区只在单测中验证惰性创建，未做真机。
- 静默时段、`review` 模式、多目标并发、限流与重启退避未做真机压测。
- 无历史补拉；通知只写审计，不建 DSH 收件箱会话；review 草稿没有发送路由。
- 旧工作区目录不迁移：升级后旧目录与旧会话保留但不被新消息使用，需要主人自己决定何时归档。
- `unknown` 不自动重发；任务失败/超时只写审计通知。
- Windows 已实测；macOS/Linux 未验证，不作支持承诺。
- `dws` 其它版本、`--profile` 位置、Windows 关闭 stdin 的优雅退出仍需逐版核对。
- 没有应用层数据库加密；依赖 OS 账户与磁盘加密。

## 6. 已冻结的决策

| 决策       | 值                                                                                                                             |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------ |
| 插件身份   | 包名 `dsh-whale-chan-assistant` / 显示名「DSH助理」/ 默认人设「鲸鱼酱」                                                        |
| 工作区归属 | 一个钉钉会话一个 `conversation-<digest>` 目录，回复器与该会话的任务共用；`<root>` 默认 `<stateDir>/workspaces`                 |
| 工作区迁移 | 不迁移、不删除旧目录；布局版本只参与回复器会话 id，换布局即换新会话                                                            |
| 标题归属   | 会话标题由目标预建与回复器负责；任务加入已有目录不改名                                                                         |
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
