# 012 发布

> 当前状态：**v0.1.0 已本地打 tag、未 push**。WS0–WS8 已完成；WS8 在 Windows 上 T0–T4 全过（[报告](test-reports/WS8-live.md)）。本文是发布复核与打 tag 的清单。
>
> 版本 `0.1.0`，日期 `2026-11-03`。`private: true`，不发布到 npm。

## 1. 发布决策

| 项         | 规则                                                                                                   |
| ---------- | ------------------------------------------------------------------------------------------------------ |
| 版本       | `0.1.0`；`package.json`、`src/shared/limits.ts` 的 `PLUGIN_VERSION`、`scripts/check-pack.mjs` 三处一致 |
| 版本真源   | `tests/contract.spec.ts` 断言 manifest 版本等于 `PLUGIN_VERSION`；`check-pack` 再断言一次              |
| 发布渠道   | `private: true`，**不发 npm**；以本地目录或归档 bundle 安装到 DSH                                      |
| 产物       | `pnpm build` 生成 `lib/`；`npm pack --dry-run` 为 **15 个 artifacts**，icon 711 bytes                  |
| 文档       | `docs/` 与 `CHANGELOG.md` 只在仓库/发行页；npm 包只含 `README.md`，README 中的 docs 链接在包内不可达   |
| 合并与发布 | 实现代理只准备发布提交；合并、tag、push 与 profile 安装由发布负责人复核后执行                          |

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

- `pnpm check`：typecheck 0 错误、全量测试通过、build 成功（宿主 ESM + 客户端 CJS）；
- `pnpm format:check`：`All matched files use Prettier code style!`；
- `check-pack`：`pack check passed: 15 artifacts, icon 711 bytes`；
- `git status --porcelain`：为空。

任何一步失败都停止发布，不要在失败的工作区上打 tag。

## 3. 版本与变更日志

- [x] `package.json` → `"version": "0.1.0"`
- [x] `src/shared/limits.ts` → `PLUGIN_VERSION = '0.1.0'`
- [x] `scripts/check-pack.mjs` → 版本断言 `0.1.0`
- [x] `CHANGELOG.md` → `## [0.1.0] - 2026-11-03`，含 Added / Changed / Fixed / Security / Known limitations
- [x] `docs/compatibility.md` → 适用版本、WS8 结果与 T0–T4
- [x] `docs/PROGRESS.md` → WS0–WS8 收口、main HEAD、测试数、测试群停用
- [x] `README.md` → v0.1.0 状态、真机范围、安全默认、WS8 报告链接
- [x] 发布复核人确认 `docs/test-reports/WS8-live.md` 与 CHANGELOG 中的真机结论一致
- [x] 复核期间仅文档修正（CHANGELOG 措辞、PROGRESS 坐标）；代码未变，第 2 节门禁已复跑（702 tests、15 artifacts）

## 4. 安装与卸载

### 4.1 桌面端（推荐）

1. 启动 DSH Desktop `0.2.1-rc.5`，打开侧栏「插件」→「添加插件」。
2. 选择「安装第三方插件」，在「包名或地址」填本仓库的绝对路径（本地目录会以 `link:` 依赖写入 `desktop` profile）。
3. 安装完成后按提示重启 DSH；侧栏出现「鲸鱼酱」，面板显示 `0.1.0`。
4. 卸载/停用：「插件」→「已安装」→ 停用或卸载，重启 DSH。状态目录**不会**自动删除。

### 4.2 自建 profile（CLI）

```bash
# 安装本地目录；CLI 把参数转发给 profile 内的 pnpm
dsh plugin --profile <name> add <repo-path>

# 卸载
dsh plugin --profile <name> remove dsh-whale-chan-assistant
```

`desktop` profile 由桌面端保留，不走这个入口；不要在桌面端运行时手动改 profile 的 `package.json`。

### 4.3 安装后验证

- `GET /whale-chan/api/state` 返回 200，版本 `0.1.0`；管理请求带 `x-whale-chan-request: 1`。
- 概览健康检查：`stateDir`、`database`、`lock`、`settings`、`prompts` 正常；`channel` 在没有启用目标时为 `idle`，这是正常状态。
- `cordis.patch.yml` 已生效：面板出现，两套 preset 行 active（日志无 `agent-preset/not-found`）。

## 5. 打包与产物

```bash
pnpm build
npm pack --dry-run --json --ignore-scripts
```

15 个 artifacts：

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

## 6. 真机 T0–T4 验收

真机只允许在测试群进行，按级别放行；每级失败都停在该级，不跳级。v0.1.0 的完整证据见 [WS8 真机报告](test-reports/WS8-live.md)。

| 级别 | 目标            | 操作                                                             | 通过标准                                                                                                               | 证据                          |
| ---- | --------------- | ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| T0   | 认证与目标发现  | `dws --version`、`dws auth status --format json`、`+chat-search` | 版本 `1.0.66`；`authenticated`/`token_valid` 为真；命中测试群；不订阅、不发送                                          | 命令与布尔摘要（不含账号 id） |
| T1   | 目标校验        | `POST /targets/validate`，at-me 与群目标各一条                   | 两个目标 `valid:true`；只做 dry-run，不创建订阅                                                                        | 响应摘要 + 通道 `idle`        |
| T2   | 单条发送        | 面板确认后向测试群发一条                                         | `--yes` + AI 角标 + 幂等键；`deliveryStatus=delivered`、`openMessageId`；同键重发 `CONFLICT_ERROR` 按 `unknown` 不重发 | 钉钉截图 + 审计 + Outbound    |
| T3   | 群内 @ 自动回复 | 另一成员在测试群 @ 主人                                          | 真实群事件 → 归一化 → 分类 → 回复 → `outbound sent` 且有回执                                                           | 面板 + DSH 会话 + 审计        |
| T4   | 任务批准与执行  | @主人请求一项工作 → 面板批准 → worker 执行                       | `awaiting-approval` → `running` → `succeeded`；产物与结果回帖一致，对外文本不含 `Route`、工具名、会话 ID、工作区路径   | 面板 + 工作区 + 审计          |

记录要求：

- 证据写入 `docs/test-reports/WS8-live.md`：日期、DSH 版本、`dws` 版本、OS、Node、目标类型（不要写真实群名/账号）、命令、脱敏输出、结论。
- 截图必须裁掉真实群名、成员昵称、账号 id 与消息正文；README 的截图使用 mock/裁切版本。
- 验收后停用测试群目标（`targets.rows=[]`），让通道回到 `idle: no enabled targets`；重新启用前先核对目标与回复模式。

## 7. 打 tag

```bash
# 最终门禁（干净工作区）
pnpm check
pnpm format:check
node scripts/check-pack.mjs
git status --porcelain

# annotated tag（只在门禁与 T0–T4 全绿、发布复核通过后）
git tag -a v0.1.0 -m "dsh-whale-chan-assistant 0.1.0"
git show --stat v0.1.0
```

- **不要 push，除非发布负责人明确授权**；tag 由复核人打，不在实现代理的发布准备提交里。
- tag 必须指向包含版本 bump、CHANGELOG、compatibility、PROGRESS 与 WS8 记录的提交。
- 打 tag 后如需归档，再执行 `npm pack --ignore-scripts`；产物不入库（`.gitignore` 已忽略 `*.tgz`）。

## 8. 回滚

发布出问题时按“先停、再保数据、最后换版本”的顺序：

1. **停用/卸载 bundle**：DSH 桌面端「插件」→ 已安装 → 停用或卸载，重启 DSH；侧栏入口消失，面板路由不再挂载。
2. **保留状态目录**：不要卸载时顺手删 `~/.dsh-whale-chan`。其中是消息、任务、批准、审计与设置历史，删除不可恢复。
3. **备份**：停机后等 `state.db-wal` 消失（或已合并），复制整个 `stateDir`；在线备份用 `sqlite3 state.db ".backup '<backup>.db'"`。
4. **回退版本**：重新安装上一个已知可用版本。若新版本已把 `state.db` 迁移到更高 schema，旧插件会拒绝打开；此时只能回到新版本，或换一个新的 `stateDir`，**不要手改 `user_version`**。
5. **恢复**：把备份放回一个没有 `.lock` 的目录；确认没有进程占用后再启动。
6. **通知**：在发布记录与 CHANGELOG 中写明回滚原因、影响版本与数据处置。

## 9. 发布后验证

- 面板显示版本 `0.1.0`，健康检查全绿或仅 channel idle（未配置目标）。
- 发一条测试单聊，确认 AI 角标与回执；取消一个测试任务，确认进入 `cancelled` 且不复活。
- 检查 `state.db` 的 schema 仍为 2、`effects` 无 dead 行、`audit` 有本次操作。
- 记录发布日期、tag、安装来源与验证人；更新 `docs/PROGRESS.md` 的发布坐标。

## 相关文档

- [006 部署](006-deployment.md)
- [009 DWS 协议](009-dws-protocol.md)
- [011 设置合约](011-settings-contract.md)
- [013 安全基线](013-security.md)
- [兼容矩阵](compatibility.md)
- [WS8 真机报告](test-reports/WS8-live.md)
- [WS6 测试报告](test-reports/WS6.md)
