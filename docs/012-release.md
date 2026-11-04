# 012 发布

> 当前状态：**v0.4.0 已合并到 `main` `d0ed2e6`**（`--no-ff` 合并提交 `chore(merge): ws14 archive workspace sessions`）；tag `v0.4.0` 指向 `c82027a`（本地、未 push），tag 之后有发布后定向真机验活补验提交 `ee6bb97`。WS0–WS14 已完成；v0.4.0 增加会话归档与工作区自愈，管理 API 20 条，schema 仍为 2，设置字段仍 57 / 9 个 block。
>
> 版本 `0.4.0`，日期 `2026-11-04`。`private: true`，不发布到 npm。
>
> 真机：**T3/T4 未重跑**；归档/恢复只改变“消息送到哪个会话”，分类、发送与任务回帖链路未改。发布后已补做**定向真机验活并通过**（归档 → 下一条消息：面板归档 3 / 原本已归档 2 / 0 拒绝 / 0 失败，generation 1→2，下一条群消息新建 g2 并回复），见 [WS14-live 真机验活报告](test-reports/WS14-live.md)。`stopActivity=true` 取消、任务 worker 归档、DSH 手动移除工作区、单聊与多目标仍未真机覆盖。Windows 真机 T0–T4 证据来自 v0.1.0，v0.2.0 的 T3/T4 复验见 [WS9/WS10 报告](test-reports/WS9-10.md)。

## 1. 发布决策

| 项         | 规则                                                                                                                                                                       |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 版本       | `0.4.0`；`package.json`、`src/shared/limits.ts` 的 `PLUGIN_VERSION`、`scripts/check-pack.mjs` 三处一致                                                                     |
| 版本真源   | `tests/contract.spec.ts` 断言 manifest 版本等于 `PLUGIN_VERSION`；`check-pack` 再断言一次                                                                                  |
| 合约       | 管理 API **20 条**（WS14 新增 `POST targets/:id/archive-sessions`）；设置仍 57 字段 / 9 block；schema 仍 2；`dsh.compatibility` 与 `engines` 不变（仍只标记 `0.2.1-rc.5`） |
| 发布渠道   | `private: true`，**不发 npm**；以本地目录或归档 bundle 安装到 DSH                                                                                                          |
| 产物       | `pnpm build` 生成 `lib/`；`npm pack --dry-run` 为 **15 个 artifacts**，icon 711 bytes（本版不增删文件）                                                                    |
| 文档       | `docs/` 与 `CHANGELOG.md` **只在仓库/发行页**；npm 包只含 `README.md` 与运行产物，README 里的 docs 链接包内不可达                                                          |
| 合并与发布 | 实现/文档代理只准备发布提交；合并、tag、push 与 profile 安装由发布负责人复核后执行                                                                                         |

## 2. 发布门禁

在干净工作区（`git status --porcelain` 为空）按顺序执行：

```bash
pnpm install --frozen-lockfile
pnpm check
pnpm format:check
node scripts/check-pack.mjs
pnpm docs:settings
git diff --exit-code docs/011-settings-contract.md
git status --porcelain
```

期望：

- `pnpm check`：typecheck 0 错误、**849 tests / 62 files** 全通过、build 成功（宿主 ESM + 客户端 CJS）；
- `pnpm format:check`：`All matched files use Prettier code style!`；
- `check-pack`：`pack check passed: 15 artifacts, icon 711 bytes`，版本断言 `0.4.0`；
- `pnpm docs:settings`：`57 fields`，字段表无变化（本版没有新增设置字段）；
- `git diff --exit-code docs/011-settings-contract.md`：无输出（生成模板与已提交的 011 同步；任何差异都说明生成器模板落后于正文，必须先把模板改对再提交，不能靠手工改 011）；
- `git status --porcelain`：为空。

任何一步失败都停止发布，不要在失败的工作区上打 tag。测试数相对 v0.3.0（765 / 60）增加 84 条：后端 68（`session-recovery`、`session-archive`、`executor-model`、`executor-task`、`api-routes`、`contract`）与前端 16（`client-targets`、`client-api`）。

## 3. 版本与变更日志

- [x] `package.json` → `"version": "0.4.0"`
- [x] `src/shared/limits.ts` → `PLUGIN_VERSION = '0.4.0'`
- [x] `scripts/check-pack.mjs` → 版本断言 `0.4.0`
- [x] `CHANGELOG.md` → `## [0.4.0] - 2026-11-04`，含 Added / Changed / Fixed / Migration / Known limitations；`0.3.0`、`0.2.0`、`0.1.0` 段落保留
- [x] `docs/compatibility.md` → 适用版本 `0.4.0`、归档行为、schema 仍 2、DSH 兼容声明不变、发布后定向真机验活与仍存缺口
- [x] `docs/PROGRESS.md` → WS14 完成并合并、849 tests / 62 files、合并提交 `d0ed2e6`、tag 与真机补验回填、归档相关限制、冻结决策补充
- [x] `README.md` → v0.4.0 状态、功能表「会话归档与自愈」、20 条路由、工作区段新增归档/自愈要点、安装验证版本 `0.4.0`、排障入口
- [x] `docs/005-panel.md` → 20 条路由、§3.4 归档按钮/确认弹窗/结果摘要/错误码、§4 错误表、§5 i18n 计数
- [x] `docs/007-architecture.md` → 20 条路由、纯命名例外、§6.8 会话归档与恢复、测试索引
- [x] `docs/011-settings-contract.md` → 20 条契约、归档路由请求/响应/错误、明确无新增字段
- [x] `docs/013-security.md` → 追加“会话归档与恢复（v0.4.0）”小节（只追加）
- [x] `docs/pr/WS14-archive-sessions.md` → 需求、设计、契约、破坏性边界、测试证据、5 项评审修复、风险与合并坐标
- [x] `docs/test-reports/WS14.md` → 归档会话与恢复的验收报告（脱敏，由 QA 提供；『文档未完成』已由 QA 在 `77810e7` 回填为“已完成”）
- [x] `docs/test-reports/WS14-live.md` → 发布后定向真机验活报告（归档 → 下一条消息，tag 之后补验 `ee6bb97`）
- [x] 合并坐标：`--no-ff` 合并提交 `d0ed2e6`（`chore(merge): ws14 archive workspace sessions`），合并前工作区干净
- [x] 发布 tag：`v0.4.0` 指向 `c82027a`（本地，未 push；实现代理未执行 tag/push）
- [x] 发布后真机补验：2026-11-04 定向验活通过，见 [WS14-live](test-reports/WS14-live.md)
- [ ] 发布复核人确认“T3/T4 未重跑、归档链路已定向真机验活”的表述与两份 WS14 报告、CHANGELOG 一致

## 4. 安装与卸载

命令与 v0.3.0 相同，本版**没有**安装方式变化（不新增 profile 步骤，不改 bundle 结构）。

### 4.1 桌面端（推荐）

1. 启动 DSH Desktop `0.2.1-rc.5`，打开侧栏「插件」→「添加插件」。
2. 选择「安装第三方插件」，在「包名或地址」填本仓库的绝对路径（本地目录会以 `link:` 依赖写入 `desktop` profile）。
3. 安装完成后按提示重启 DSH；侧栏出现「DSH助理」，面板显示 `0.4.0`。
4. 卸载/停用：「插件」→「已安装」→ 停用或卸载，重启 DSH。状态目录与工作区目录**不会**自动删除。

### 4.2 自建 profile（CLI）

```bash
# 安装本地目录；CLI 把参数转发给 profile 内的 pnpm
dsh plugin --profile <name> add <repo-path>

# 卸载
dsh plugin --profile <name> remove dsh-whale-chan-assistant
```

`desktop` profile 由桌面端保留，不走这个入口；不要在桌面端运行时手动改 profile 的 `package.json`。

### 4.3 安装后验证

- `GET /whale-chan/api/state` 返回 200，版本 `0.4.0`；管理请求带 `x-whale-chan-request: 1`。
- `GET /whale-chan/api/persona` 返回 `{ persona, revision, defaults, presets }`：从未保存过人设的安装中 `persona` 与 `defaults` 均为空人设（仅 `name=鲸鱼酱`），`presets` 含 `whale-maid`。
- 概览健康检查：`stateDir`、`database`、`lock`、`settings`、`prompts` 正常；`channel` 在没有启用目标时为 `idle`，这是正常状态。
- 「目标」页的「工作区」区块显示已启用目标的具体目录（`ready`）或「按会话创建」（`per-conversation`）；`ready` 行右侧有「归档会话」按钮，`per-conversation` 行没有。
- 归档一次后 `GET /whale-chan/api/targets` 的 `workspace` 仍可用；「审计」页出现 `workspace.sessions-archived`（`actor=owner`）。
- 「人设」页两个动作可用且**不会自动保存**：恢复默认只清草稿，载入预设只填草稿；写入仍需点保存。
- `cordis.patch.yml` 已生效：面板出现，两套 preset 行 active（日志无 `agent-preset/not-found`）。

## 5. 打包与产物

```bash
pnpm build
npm pack --dry-run --json --ignore-scripts
```

15 个 artifacts（与 v0.3.0 相同，本版不增删文件）：

```text
package.json
README.md
LICENSE
cordis.patch.yml
assets/icon.svg
lib/index.js
lib/index.d.ts
lib/client.js
prompts/safety.md
prompts/persona.md
prompts/classifier.md
prompts/reply.md
prompts/research.md
locale/zh.json
locale/en.json
```

- `src/`、`tests/`、`docs/`、`CHANGELOG.md` 不在包内；不要为了 README 的 docs 链接把 docs 加进 `files`，否则会改变 15 artifacts 的约定。
- `npm pack` 产物只用于归档/内部分发；仓库 `private: true`，不执行 `npm publish`。

## 6. 真机验收

真机只允许在测试群进行，按级别放行；每级失败都停在该级，不跳级。

**T3/T4 未在 v0.4.0 重跑；发布后已补做定向真机验活（归档 → 下一条消息）并通过。** 理由：WS14 不改分类、prompt、发送参数、任务执行与结果回帖，只决定“消息投递到哪个会话 / 任务用哪个 worker 会话 / 工作区记录是否存在”；这些分支由 `session-recovery`、`session-archive`、`executor-model`、`executor-task`、`api-routes` 与组件测试覆盖，QA 另跑 18 项独立探针（含 blocked 重试、手动归档、工作区重建、`stopActivity` 分支、>500 截断）。2026-11-04 13:37–13:53 在运行中的 DSH Desktop `0.2.1-rc.5` 上（插件 0.4.0，通过插件管理器 disable→enable 热重载，宿主未重启）验活了核心链路：面板归档 `archived=3`/`alreadyArchived=2`/`refused=failed=missing=0`、`replySessionRotated=true`，generation 1→2，第二条群消息 13:50:04 入库、13:50:06 新建 g2、13:50:21 群内出现回复，g0/g1 已归档而 g2 未归档，三个会话目录保留。证据见 [WS14-live](test-reports/WS14-live.md)。

| 级别          | 目标                                                       | 本版处理                                              | 证据/通过标准                                                                                                                         |
| ------------- | ---------------------------------------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| T0–T2         | 认证/发现、目标校验、单条发送                              | 不重跑（未改 `dws` 通道、目标或发送层）               | [WS8 报告](test-reports/WS8-live.md)                                                                                                  |
| T3            | 群内 @ 自动回复                                            | 不重跑（未改分类/回复链路；只改会话身份）             | [WS8 报告](test-reports/WS8-live.md) + [WS9/WS10 报告](test-reports/WS9-10.md)                                                        |
| T4            | 任务批准与执行                                             | 不重跑（未改执行器判定；只改 worker 会话身份）        | 同上：`awaiting-approval` → `running` → `succeeded`，对外文本不含路由、工具名、会话 id、工作区路径                                    |
| 归档/恢复     | 归档当前回复器后下一条消息换会话、工作区重建、stopActivity | **定向真机验活通过**（归档 → 下一条消息）；其余未覆盖 | [WS14-live](test-reports/WS14-live.md)；stopActivity/worker/手动移除/单聊/多目标未真机，见 [WS14 报告](test-reports/WS14.md) 与 PR §5 |
| 人设默认/预设 | 空默认、`whale-maid` 预设、面板                            | 沿用 v0.3.0 的重载核对                                | [WS12 报告](test-reports/WS12-persona.md)                                                                                             |

记录要求：

- 证据写入对应报告：WS14 的自动化验收写入 `docs/test-reports/WS14.md`，发布后定向真机验活写入 `docs/test-reports/WS14-live.md`；其余沿用 WS8 / WS9-10 / WS12。日期、DSH 版本、`dws` 版本、OS、Node、目标类型（不要写真实群名/账号）、命令、脱敏输出与结论齐全。
- 截图必须裁掉真实群名、成员昵称、账号 id 与消息正文；README 的截图使用 mock/裁切版本。本版未新增浏览器截图，页面行为由组件测试覆盖。
- 验收后把测试群目标设为 `enabled=false`（保留该行与工作区），让通道回到 `idle: no enabled targets`；本次真机补验后已清空目标（`targets=[]`），通道 `idle: no enabled targets`。
- 已完成的真机补验只覆盖“归档 → 下一条消息”；仍需补的项：`stopActivity=true` 的真实取消、任务 worker 归档、DSH 手动移除工作区后的重建/attach、单聊、多目标并发与 Windows symlink/realpath。补验前先备份 `stateDir`（归档不可撤销），只在测试群执行，并在 WS14-live 追加结论后再改 README/兼容矩阵措辞。

## 7. 打 tag

```bash
# 最终门禁（干净工作区）
pnpm check
pnpm format:check
node scripts/check-pack.mjs
git status --porcelain

# annotated tag（合并后由协调者执行）
git tag -a v0.4.0 -m "dsh-whale-chan-assistant 0.4.0"
git show --stat v0.4.0
```

- **tag 由发布负责人复核后由协调者打在合并后的 docs 提交上**（本地，未 push）；实现/文档代理没有执行 merge、tag 或 push。
- tag 必须指向包含版本 bump、CHANGELOG、compatibility、PROGRESS、005/007/011/012/013 与 WS14 报告/PR 的提交。
- 打 tag 后如需归档，再执行 `npm pack --ignore-scripts`；产物不入库（`.gitignore` 已忽略 `*.tgz`）。

## 8. 回滚

发布出问题时按“先停、再保数据、最后换版本”的顺序：

1. **停用/卸载 bundle**：DSH 桌面端「插件」→ 已安装 → 停用或卸载，重启 DSH；侧栏入口消失，面板路由不再挂载。
2. **保留状态目录**：不要卸载时顺手删 `~/.dsh-whale-chan`。其中是消息、任务、批准、审计与设置历史，删除不可恢复；会话工作区默认也在其下的 `workspaces/`。
3. **备份**：停机后等 `state.db-wal` 消失（或已合并），复制整个 `stateDir`（含 `workspaces/`）；在线备份用 `sqlite3 state.db ".backup '<backup>.db'"`。
4. **回退版本**：重新安装上一个已知可用版本。0.4.0 **没有 schema 变更**（仍是 2），回退到 v0.3.0 可以打开同一个库；设置字段与 block 未变，已保存的人设原样保留。
5. **回退后注意归档**：`session.reply-generation:*` / `session.worker-generation:*` 会留在 KV 里，但 **v0.3.0 不认识它们**，会按 `g0` 解析会话。如果这些 `g0` 会话已被 v0.4.0 归档，旧版本的回复会被 DSH 归档闸门挡住且没有重试，表现为“消息没有回复”。需要回退时，优先只在未归档过的工作区继续使用，或先保留 v0.4.0；不要在回退后再对同一工作区手工恢复旧会话并期待上下文回来（generation 只增）。
6. **恢复**：把备份放回一个没有 `.lock` 的目录；确认没有进程占用后再启动。
7. **通知**：在发布记录与 CHANGELOG 中写明回滚原因、影响版本与数据处置。

## 9. 发布后验证

- 面板显示版本 `0.4.0`，健康检查全绿或仅 channel idle（未配置目标）。
- `GET /whale-chan/api/state` 版本 `0.4.0`；`API_ROUTES` 为 20 条，`POST targets/:id/archive-sessions` 存在。
- `GET /whale-chan/api/persona` 返回四个字段；从未保存过人设的安装中 `persona`/`defaults` 为空人设，`presets` 含 `whale-maid`；已保存的人设不被覆盖。
- 目标页工作区块显示启用目标的目录；`ready` 行有「归档会话」按钮，`per-conversation` 行没有。
- 对一个测试目标归档一次：结果摘要五类计数齐全；若回复器被归档，`replySessionRotated=true`；发一条测试消息，确认回复出现在**新**会话里，且旧会话仍在 DSH 里可查。该链路已于 2026-11-04 定向真机验活通过，见 [WS14-live](test-reports/WS14-live.md)。
- 在 DSH 里手动移除该工作区的记录后，再发一条消息，确认目录/记录被重建（标题保持原样）、回复正常。
- 检查 `state.db` 的 schema 仍为 2、`effects` 无 dead 行、`audit` 有本次 `workspace.sessions-archived`。
- 记录发布日期、tag、安装来源与验证人；更新 `docs/PROGRESS.md` 的发布坐标。

## 相关文档

- [006 部署](006-deployment.md)
- [009 DWS 协议](009-dws-protocol.md)
- [011 设置合约](011-settings-contract.md)
- [013 安全基线](013-security.md)
- [014 人设默认值与预设](014-persona-defaults.md)
- [兼容矩阵](compatibility.md)
- [WS14 验收报告](test-reports/WS14.md)
- [WS14 PR](pr/WS14-archive-sessions.md)
- [WS12 人设报告](test-reports/WS12-persona.md)
- [WS9/WS10 真机报告](test-reports/WS9-10.md)
- [WS8 真机报告](test-reports/WS8-live.md)
- [WS6 测试报告](test-reports/WS6.md)
