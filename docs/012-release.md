# 012 发布

> 当前状态：**v0.3.0 发布提交已就绪，tag 未打**。WS0–WS12 已完成；T3/T4 真机证据沿用 v0.1.0 的 T0–T4 与 v0.2.0 的 T3/T4 复验（[WS8 报告](test-reports/WS8-live.md)、[WS9/WS10 报告](test-reports/WS9-10.md)）。WS12 只改人设默认值与只读预设投影，不涉及回复/发送链路，本轮**不重跑** T3/T4。
>
> 版本 `0.3.0`，日期 `2026-11-03`。`private: true`，不发布到 npm。

## 1. 发布决策

| 项         | 规则                                                                                                              |
| ---------- | ----------------------------------------------------------------------------------------------------------------- |
| 版本       | `0.3.0`；`package.json`、`src/shared/limits.ts` 的 `PLUGIN_VERSION`、`scripts/check-pack.mjs` 三处一致            |
| 版本真源   | `tests/contract.spec.ts` 断言 manifest 版本等于 `PLUGIN_VERSION`；`check-pack` 再断言一次                         |
| 发布渠道   | `private: true`，**不发 npm**；以本地目录或归档 bundle 安装到 DSH                                                 |
| 产物       | `pnpm build` 生成 `lib/`；`npm pack --dry-run` 为 **15 个 artifacts**，icon 711 bytes                             |
| 文档       | `docs/` 与 `CHANGELOG.md` **只在仓库/发行页**；npm 包只含 `README.md` 与运行产物，README 里的 docs 链接包内不可达 |
| 合并与发布 | 实现代理只准备发布提交；合并、tag、push 与 profile 安装由发布负责人复核后执行                                     |

## 2. 发布门禁

在干净工作区（`git status --porcelain` 为空）按顺序执行：

```bash
pnpm install --frozen-lockfile
pnpm check
pnpm format:check
node scripts/check-pack.mjs
git status --porcelain
```

期望：

- `pnpm check`：typecheck 0 错误、**765 tests / 60 files** 全通过、build 成功（宿主 ESM + 客户端 CJS）；
- `pnpm format:check`：`All matched files use Prettier code style!`；
- `check-pack`：`pack check passed: 15 artifacts, icon 711 bytes`；
- `git status --porcelain`：为空。

任何一步失败都停止发布，不要在失败的工作区上打 tag。

## 3. 版本与变更日志

- [x] `package.json` → `"version": "0.3.0"`
- [x] `src/shared/limits.ts` → `PLUGIN_VERSION = '0.3.0'`
- [x] `scripts/check-pack.mjs` → 版本断言 `0.3.0`
- [x] `CHANGELOG.md` → `## [0.3.0] - 2026-11-03`，含 Added / Changed / Fixed / Migration；`0.2.0`、`0.1.0` 段落保留
- [x] `docs/compatibility.md` → 适用版本、0.3.0 人设默认/预设行为、旧 persona 行保留、不涉及 DSH 版本变化
- [x] `docs/PROGRESS.md` → WS12 完成并合并、main HEAD、765 tests、WS12 真机结论、tag 未打、测试目标停用
- [x] `README.md` → v0.3.0 状态、安装验证版本 `0.3.0`、人设段核对（默认为空、预设手动载入、已保存不覆盖）、014 链接
- [x] `docs/013-security.md` → 追加预设只读与无新权限（只追加，不改结构）
- [x] `docs/test-reports/WS12-persona.md` → 空默认/预设/面板动作的验收报告（脱敏）
- [ ] 发布复核人确认 T3/T4 沿用结论（WS8、WS9/WS10）与 `docs/test-reports/WS12-persona.md`、CHANGELOG 一致

## 4. 安装与卸载

命令与 v0.2.0 相同，本版**没有**安装方式变化（不新增 profile 步骤，不改 bundle 结构）。

### 4.1 桌面端（推荐）

1. 启动 DSH Desktop `0.2.1-rc.5`，打开侧栏「插件」→「添加插件」。
2. 选择「安装第三方插件」，在「包名或地址」填本仓库的绝对路径（本地目录会以 `link:` 依赖写入 `desktop` profile）。
3. 安装完成后按提示重启 DSH；侧栏出现「DSH助理」，面板显示 `0.3.0`。
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

- `GET /whale-chan/api/state` 返回 200，版本 `0.3.0`；管理请求带 `x-whale-chan-request: 1`。
- `GET /whale-chan/api/persona` 返回 `{ persona, revision, defaults, presets }`：从未保存过人设的安装中 `persona` 与 `defaults` 均为空人设（仅 `name=鲸鱼酱`），`presets` 含 `whale-maid`。
- 概览健康检查：`stateDir`、`database`、`lock`、`settings`、`prompts` 正常；`channel` 在没有启用目标时为 `idle`，这是正常状态。
- 「目标」页的「工作区」区块显示已启用目标的具体目录（`ready`）或「按会话创建」（`per-conversation`）；`GET /whale-chan/api/targets` 的 `workspace.mode` 与之一致。
- 「人设」页两个动作可用且**不会自动保存**：恢复默认只清草稿，载入预设只填草稿；写入仍需点保存。
- `cordis.patch.yml` 已生效：面板出现，两套 preset 行 active（日志无 `agent-preset/not-found`）。

## 5. 打包与产物

```bash
pnpm build
npm pack --dry-run --json --ignore-scripts
```

15 个 artifacts（与 v0.2.0 相同，本版不增删文件）：

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

真机只允许在测试群进行，按级别放行；每级失败都停在该级，不跳级。v0.3.0 不涉及回复、发送、任务执行或回帖链路，**T3/T4 本轮不重跑**，沿用 v0.1.0 的 T0–T4 与 v0.2.0 的 T3/T4 复验结论；人设默认/预设做一次轻量真机核对。

| 级别          | 目标                            | 本版处理                                | 证据/通过标准                                                                                                                                |
| ------------- | ------------------------------- | --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| T0–T2         | 认证/发现、目标校验、单条发送   | 不重跑（未改 `dws` 通道、目标或发送层） | [WS8 报告](test-reports/WS8-live.md)                                                                                                         |
| T3            | 群内 @ 自动回复                 | 不重跑（未改分类/回复链路）             | [WS8 报告](test-reports/WS8-live.md) + [WS9/WS10 报告](test-reports/WS9-10.md)                                                               |
| T4            | 任务批准与执行                  | 不重跑（未改执行器、工作区与结果回帖）  | 同上：`awaiting-approval` → `running` → `succeeded`，对外文本不含路由、工具名、会话 id、工作区路径                                           |
| 人设默认/预设 | 空默认、`whale-maid` 预设、面板 | 轻量真机核对（重载后读接口 + 面板）     | `GET persona` 的 `persona`/`defaults` 为空人设、`presets` 含 `whale-maid`；面板显示「DSH助理」；见 [WS12 报告](test-reports/WS12-persona.md) |

记录要求：

- 证据写入对应报告：WS12 写入 `docs/test-reports/WS12-persona.md`，其余沿用 WS8 / WS9-10；日期、DSH 版本、`dws` 版本、OS、Node、目标类型（不要写真实群名/账号）、命令、脱敏输出与结论齐全。
- 截图必须裁掉真实群名、成员昵称、账号 id 与消息正文；README 的截图使用 mock/裁切版本。本轮未新增浏览器截图，页面行为由组件测试覆盖。
- 验收后停用测试群目标（`targets.rows=[]`），让通道回到 `idle: no enabled targets`；重新启用前先核对目标与回复模式。

## 7. 打 tag

```bash
# 最终门禁（干净工作区）
pnpm check
pnpm format:check
node scripts/check-pack.mjs
git status --porcelain

# annotated tag（只在门禁全绿、发布复核通过后）
git tag -a v0.3.0 -m "dsh-whale-chan-assistant 0.3.0"
git show --stat v0.3.0
```

- **tag 由发布负责人复核后打**，不在实现代理的发布准备提交里；**不要 push，除非发布负责人明确授权**。
- tag 必须指向包含版本 bump、CHANGELOG、compatibility、PROGRESS、014 与 WS12 报告的提交。
- 打 tag 后如需归档，再执行 `npm pack --ignore-scripts`；产物不入库（`.gitignore` 已忽略 `*.tgz`）。

## 8. 回滚

发布出问题时按“先停、再保数据、最后换版本”的顺序：

1. **停用/卸载 bundle**：DSH 桌面端「插件」→ 已安装 → 停用或卸载，重启 DSH；侧栏入口消失，面板路由不再挂载。
2. **保留状态目录**：不要卸载时顺手删 `~/.dsh-whale-chan`。其中是消息、任务、批准、审计与设置历史，删除不可恢复；会话工作区默认也在其下的 `workspaces/`。
3. **备份**：停机后等 `state.db-wal` 消失（或已合并），复制整个 `stateDir`（含 `workspaces/`）；在线备份用 `sqlite3 state.db ".backup '<backup>.db'"`。
4. **回退版本**：重新安装上一个已知可用版本。0.3.0 没有 schema 变更（仍是 2），回退到 v0.2.0 可以打开同一个库；已保存的 persona 原样保留，0.3.0 新增的空默认与预设按钮只是面板/接口投影，回退后不再出现。若未来版本已把 `state.db` 迁移到更高 schema，旧插件会拒绝打开；此时只能回到新版本，或换一个新的 `stateDir`，**不要手改 `user_version`**。
5. **恢复**：把备份放回一个没有 `.lock` 的目录；确认没有进程占用后再启动。
6. **通知**：在发布记录与 CHANGELOG 中写明回滚原因、影响版本与数据处置。

## 9. 发布后验证

- 面板显示版本 `0.3.0`，健康检查全绿或仅 channel idle（未配置目标）。
- `GET /whale-chan/api/persona` 返回四个字段；从未保存过人设的安装中 `persona`/`defaults` 为空人设，`presets` 含 `whale-maid`；已保存的人设不被覆盖。
- 人设页点「载入预设：蓝白鲸鱼女仆」后草稿被填满但未发 `PUT`；点保存后才写入，刷新后 `persona` 为预设内容。点「恢复默认（空人设）」同理。
- 目标页工作区块显示启用目标的目录；任选一个目标，确认该目录存在且与 `GET targets` 的 `workspace.path` 一致。
- 发一条测试单聊或群 @，确认回复器会话出现、AI 角标与回执正常，且回复会话与后续任务落在同一 `conversation-<digest>` 目录。
- 检查 `state.db` 的 schema 仍为 2、`effects` 无 dead 行、`audit` 有本次操作。
- 记录发布日期、tag、安装来源与验证人；更新 `docs/PROGRESS.md` 的发布坐标。

## 相关文档

- [006 部署](006-deployment.md)
- [009 DWS 协议](009-dws-protocol.md)
- [011 设置合约](011-settings-contract.md)
- [013 安全基线](013-security.md)
- [014 人设默认值与预设](014-persona-defaults.md)
- [兼容矩阵](compatibility.md)
- [WS12 人设报告](test-reports/WS12-persona.md)
- [WS9/WS10 真机报告](test-reports/WS9-10.md)
- [WS8 真机报告](test-reports/WS8-live.md)
- [WS6 测试报告](test-reports/WS6.md)
