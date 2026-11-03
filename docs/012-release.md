# 012 发布

> 当前状态：**未发布**。WS0–WS6 已合并到 `main`；WS7 文档评审中；WS8 真机 T0–T3 未完成。
> 当前版本 `0.1.0-dev.0`，没有 tag。本文是验收通过后执行 `0.1.0` 发布的清单；未打勾的项目不得发布。

## 1. 发布前决策

| 项         | 规则                                                                                                              |
| ---------- | ----------------------------------------------------------------------------------------------------------------- |
| 版本号     | 验收通过后从 `0.1.0-dev.0` bump 到 `0.1.0`；本次文档不改版本号                                                    |
| 版本真源   | `package.json` 与 `src/shared/limits.ts` 的 `PLUGIN_VERSION` 必须一致；`tests/contract.spec.ts` 会断言            |
| 打包门禁   | `scripts/check-pack.mjs` 目前硬编码期望 `0.1.0-dev.0`；bump 时必须同步改成 `0.1.0`，否则门禁会失败                |
| 发布渠道   | `private: true`，**不发 npm**；以本地目录或归档 bundle 安装到 DSH                                                 |
| 产物       | `pnpm build` 生成 `lib/`；`npm pack --dry-run` 当前为 **15 个 artifacts**（README 已包含，CHANGELOG/docs 不随包） |
| 合并与安装 | 由人工执行；实现代理不自动合并、不 push、不安装 profile                                                           |

## 2. 发布门禁

在干净工作区（`git status --porcelain` 为空）按顺序执行：

```bash
pnpm install --frozen-lockfile
pnpm check
pnpm format:check
node scripts/check-pack.mjs
```

期望：

- `pnpm check`：typecheck 0 错误、全部测试通过、build 成功（宿主 ESM + 客户端 CJS）；
- `pnpm format:check`：`All matched files use Prettier code style!`；
- `check-pack`：`pack check passed: 15 artifacts, icon ... bytes`；
- `git status --porcelain`：为空。

任何一步失败都停止发布，不要在失败的工作区上打 tag。

## 3. 版本与变更日志

- [ ] `package.json` → `"version": "0.1.0"`
- [ ] `src/shared/limits.ts` → `PLUGIN_VERSION = '0.1.0'`
- [ ] `scripts/check-pack.mjs` → 版本断言改为 `0.1.0`
- [ ] `CHANGELOG.md`：`## [Unreleased]` 改为 `## [0.1.0] - YYYY-MM-DD`；确认 Added / Changed / Security / Known limitations 与实际一致
- [ ] `docs/compatibility.md`：更新“最后核对”日期与 WS8 结果
- [ ] `docs/PROGRESS.md`：把 WS7/WS8 状态改为完成，记录 tag 与提交
- [ ] 若本轮有设置字段或 API 变化：先跑 `pnpm docs:settings`，并确认 `docs/011-settings-contract.md` 无遗漏

## 4. 干净 profile 安装

必须在**没有旧状态、没有旧 `node_modules` 缓存**的环境验证，不能只在已 link 的开发 profile 上点一下。

1. 准备一台干净的 Windows 10/11，安装 DSH Desktop `0.2.1-rc.5`，首次启动完成 profile 初始化。
2. 复制构建产物或仓库到目标机；在仓库内执行 `pnpm install --frozen-lockfile && pnpm build`。
3. 通过桌面端「插件」→「添加插件」→「安装第三方插件」→「包名或地址」填本地目录绝对路径，安装并重启。
4. 确认侧栏出现「鲸鱼酱」；`GET /whale-chan/api/state` 返回 200；状态目录（默认 `~/.dsh-whale-chan`）被创建。
5. 可选：在自建 non-desktop profile 上用 `dsh plugin --profile <name> add <本地路径>` 验证 CLI 路径；`desktop` profile 由桌面端保留，不走 CLI。

安装后必须确认 `package.json` 的 `dsh.bundle.patch` 指向的 `cordis.patch.yml` 已生效：面板出现、两套 preset 行处于 active（日志无 `agent-preset/not-found`）。

## 5. 真机 T0–T3 验收

真机只允许在测试群进行，按级别放行；每级失败都停在该级，不跳级。

| 级别 | 目标      | 操作                                                                | 通过标准                                                                         | 证据                          |
| ---- | --------- | ------------------------------------------------------------------- | -------------------------------------------------------------------------------- | ----------------------------- |
| T0   | 只读      | `dws --version`、`dws auth status --format json`                    | 版本 `1.0.66`；`authenticated`/`token_valid` 为真；不订阅、不发送                | 命令与布尔摘要（不含账号 id） |
| T1   | 观察      | 测试群开启订阅，`dryRun` 打开，发几条 @我/普通消息                  | 事件被解码、去重、自消息被过滤；断线重连有界；`dryRun` 不发送；`unknown` 不重发  | 日志摘要 + 审计事件           |
| T2   | 单条发送  | 关闭 `dryRun`，面板确认后向测试群发一条回复                         | 消息带 AI 角标；只出现一条；回执 `sent`；幂等键可追溯                            | 钉钉截图 + 审计 + Outbound    |
| T3   | @我全链路 | 测试群 @我 触发分类 → 回复/任务 → 面板批准 → worker 会话 → 结果回帖 | 回复内容符合人设与策略；任务只有在批准后执行；结果摘要回到原会话；失败路径不发送 | 面板截图 + DSH 会话 + 审计    |

记录要求：

- 证据写入 `docs/test-reports/WS8.md`：日期、DSH 版本、`dws` 版本、OS、Node、目标类型（不要写真实群名/账号）、命令、脱敏输出、结论。
- 截图必须裁掉真实群名、成员昵称、账号 id 与消息正文；README 的截图使用 mock/裁切版本。
- 任何 provisional 字段与实现不一致：先改测试与文档，再改实现；不要只改文档掩盖失败。

## 6. 打包、tag 与发布

```bash
# 最终门禁（干净工作区）
pnpm check
pnpm format:check
node scripts/check-pack.mjs
git status --porcelain

# 归档产物（可选；*.tgz 已在 .gitignore）
npm pack --ignore-scripts

# 打 annotated tag（只在门禁与 T0–T3 全绿后）
git tag -a v0.1.0 -m "dsh-whale-chan-assistant 0.1.0"
git show --stat v0.1.0
```

- **不要 push，除非发布负责人明确授权**；不要在主仓库 checkout 上直接操作，发布在独立 worktree/分支完成。
- tag 必须指向包含版本 bump、CHANGELOG、compatibility 与 WS8 记录的提交。
- `npm pack` 产物只用于归档/内部分发；仓库 `private: true`，不执行 `npm publish`。

## 7. 回滚

发布出问题时按“先停、再保数据、最后换版本”的顺序：

1. **停用/卸载 bundle**：DSH 桌面端「插件」→ 已安装 → 停用或卸载，重启 DSH；侧栏入口消失，面板路由不再挂载。
2. **保留状态目录**：不要卸载时顺手删 `~/.dsh-whale-chan`。其中是消息、任务、批准、审计与设置历史，删除不可恢复。
3. **备份**：停机后等 `state.db-wal` 消失（或已合并），复制整个 `stateDir`；在线备份用 `sqlite3 state.db ".backup '<backup>.db'"`。
4. **回退版本**：重新安装上一个已知可用版本。若新版本已把 `state.db` 迁移到更高 schema，旧插件会拒绝打开；此时只能回到新版本，或换一个新的 `stateDir`，**不要手改 `user_version`**。
5. **恢复**：把备份放回一个没有 `.lock` 的目录；确认没有进程占用后再启动。
6. **通知**：在发布记录与 CHANGELOG 中写明回滚原因、影响版本与数据处置。

## 8. 发布后验证

- 面板显示版本 `0.1.0`，健康检查全绿或仅 channel idle（未配置目标）。
- 发一条测试单聊，确认 AI 角标与回执；取消一个测试任务，确认进入 `cancelled` 且不复活。
- 检查 `state.db` 的 schema 仍为 2、`effects` 无 dead 行、`audit` 有本次操作。
- 记录发布日期、tag、安装来源与验证人；更新 `docs/PROGRESS.md`。

## 相关文档

- [006 部署](006-deployment.md)
- [009 DWS 协议](009-dws-protocol.md)
- [011 设置合约](011-settings-contract.md)
- [兼容矩阵](compatibility.md)
- [WS6 测试报告](test-reports/WS6.md)
