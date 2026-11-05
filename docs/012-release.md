# 012 发布

> 当前状态：**v0.6.0 收口中**——实现提交 `18ac297`（引用预算与正文分离）与 `c0d4b39`（`reply.autoRetry` 单次重试）已在分支 `fix/ws16-reply-budget`（worktree `wt-ws16`）；本文与版本号由文档代理收口，文档提交、`--no-ff` 合并与 tag 由发布负责人复核后执行。WS0–WS16 已完成；v0.6.0 只改回复后处理（正文与引用预算分离、`sanitized_empty`、一次自动重试），管理 API 仍 **21 条**，schema 仍为 2，设置字段 57 → **58 / 9 个 block**，locale 中英各 **526** 个顶层 key（按「`meta` 除外」口径 525）。
>
> 版本 `0.6.0`，日期 `2026-11-05`。`private: true`，不发布到 npm。
>
> 真机：**v0.6.0 未做真实账号验收**——证据只有单元测试与假 `dws` 夹具，没有在真实钉钉账号上触发过“长引用 + 失败重试”的组合，见 [WS16 验收报告](test-reports/WS16.md)。
>
> 历史（v0.5.0，2026-11-04）：已合并到 `main` `858f6fd`（`--no-ff` 合并提交 `chore(merge): ws15 target subscription fixes`）；tag `v0.5.0` 已本地打（annotated，指向 `3a8c788`，本地、未 push）；管理 API 21 条，schema 2，设置 57 / 9，测试 880 / 63；其订阅/收发链路同样**未真机验收**（只有单测与假 `dws` 夹具），见 [WS15 报告](test-reports/WS15.md)。更早坐标：v0.4.0 已合并到 `main` `d0ed2e6`，tag `v0.4.0` 指向 `c82027a`（本地、未 push），归档链路的定向真机验活见 [WS14-live](test-reports/WS14-live.md)。

## 1. 发布决策

| 项         | 规则                                                                                                                                                                    |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 版本       | `0.6.0`；`package.json`、`src/shared/limits.ts` 的 `PLUGIN_VERSION`、`scripts/check-pack.mjs` 三处一致                                                                  |
| 版本真源   | `tests/contract.spec.ts` 断言 manifest 版本等于 `PLUGIN_VERSION`；`check-pack` 再断言一次                                                                               |
| 合约       | 管理 API **21 条**（本版不新增路由）；设置 **58 字段 / 9 block**（新增 `reply.autoRetry`）；schema 仍 2；`engines` 与 `dsh.compatibility` 不变（仍只标记 `0.2.1-rc.5`） |
| 发布渠道   | `private: true`，**不发 npm**；以本地目录或归档 bundle 安装到 DSH                                                                                                       |
| 产物       | `pnpm build` 生成 `lib/`；`npm pack --dry-run` 为 **15 个 artifacts**，icon 711 bytes（本版不增删文件）                                                                 |
| 文档       | `docs/` 与 `CHANGELOG.md` **只在仓库/发行页**；npm 包只含 `README.md` 与运行产物，README 里的 docs 链接包内不可达                                                       |
| 合并与发布 | 实现/文档代理只准备发布提交；合并、tag、push 与 profile 安装由发布负责人复核后执行                                                                                      |

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

期望（**数字为本分支实测**）：

- `pnpm check`：typecheck 0 错误、**894 tests / 63 files** 全通过、build 成功（宿主 ESM + 客户端 CJS）；
- `pnpm format:check`：`All matched files use Prettier code style!`；
- `check-pack`：`pack check passed: 15 artifacts, icon 711 bytes`，版本断言 `0.6.0`；
- `pnpm docs:settings`：`wrote docs/011-settings-contract.md with 58 fields`；
- `git diff --exit-code docs/011-settings-contract.md`：无输出（生成模板与已提交的 011 同步；任何差异都说明生成器模板落后于正文，必须先把模板改对再提交，不能靠手工改 011）；
- `git status --porcelain`：为空。

测试数相对 v0.5.0（**880 / 63**）增加 **14 条**、文件数不变：`brain-reply` +7（引用逐行取舍/整体丢弃、正文不被挤空、`sanitized_empty`、超长行不连坐）、`pipeline-chat` +5（重试一次、开关关闭、研究结果随重试、失败词）、`core-engine` +1（`recordReplyAttempt` 只接受 `classified`，否则 `notRetryable`）、`settings` +1（`reply.autoRetry` 默认与 strict 校验）；`core-invariants` 只补 `notRetryable` 的 `refused` 断言，条数不变。

## 3. 版本与变更日志

- [x] `package.json` → `"version": "0.6.0"`
- [x] `src/shared/limits.ts` → `PLUGIN_VERSION = '0.6.0'`
- [x] `scripts/check-pack.mjs` → 版本断言 `0.6.0`
- [x] `CHANGELOG.md` → `## [0.6.0] - 2026-11-05`，含摘要、Added / Changed / Fixed / Migration / Known limitations；`0.5.0` 及更早段落保留
- [x] `docs/compatibility.md` → 适用版本 `0.6.0`、§5.5 行为变更（正文/引用预算分离、默认一次重试、无 schema/API/DSH 依赖变化）、设置字段 58、仍存限制与“未真机验收”
- [x] `docs/PROGRESS.md` → WS16 行、发布坐标（版本 0.6.0、894 / 63、58 字段）、快照时间 2026-11-05
- [x] `README.md` → v0.6.0 状态、功能表「正文上限与引用分离 + 一次自动重试开关」、安装验证版本 `0.6.0`、011 索引 58 字段、文末当前版本
- [x] `docs/005-panel.md` → locale 计数 526 / 525、WS16 新增 2 个 key 与 `persona.maxReplyChars.hint` 文案变更、回复 block 的 `autoRetry`
- [x] `docs/007-architecture.md` → 数据流第 4 步与 `compose` effect 行补“可重试失败最多重试一次（`reply.autoRetry`）、payload 携带 research”；§9 补“defer 是唯一失败终态”
- [x] `docs/004-prompts.md` → §5 后处理 6/7/8 改为正文/引用分离、`sources` 口径不变、失败语义加 `sanitized_empty`；§7 预算表新增引用脚注行
- [x] `docs/014-persona-defaults.md` → `maxReplyChars` 两处表格与 brain 说明补“只约束正文，引用不计入”
- [x] `docs/011-settings-contract.md` → 由 `scripts/generate-settings-docs.mjs` 重新生成（58 字段，含 `reply.autoRetry`）；**未手改**
- [x] `docs/pr/WS16-reply-budget.md` → 现象与证据链、根因、三条产品决策、文件级实现、测试清单、兼容与回退、未做真机验收
- [x] `docs/test-reports/WS16.md` → 门禁实测输出、新增用例清单、覆盖缺口
- [ ] 合并坐标：`--no-ff` 合并提交由发布负责人执行（本分支实现提交 `18ac297` / `c0d4b39`，文档提交待 coordinator 生成）
- [ ] 发布 tag：`v0.6.0` 待打（annotated，由发布负责人复核后执行）
- [ ] 真机验收：v0.6.0 **未验收**；发布负责人需在真实账号上补一次“长引用正文正常发出 + 可重试失败只重试一次”
- [ ] 发布复核人确认“v0.6.0 未真机验收”的表述与 [WS16 报告](test-reports/WS16.md)、CHANGELOG 一致

## 4. 安装与卸载

命令与 v0.3.0 相同，本版**没有**安装方式变化（不新增 profile 步骤，不改 bundle 结构）。

### 4.1 桌面端（推荐）

1. 启动 DSH Desktop `0.2.1-rc.5`，打开侧栏「插件」→「添加插件」。
2. 选择「安装第三方插件」，在「包名或地址」填本仓库的绝对路径（本地目录会以 `link:` 依赖写入 `desktop` profile）。
3. 安装完成后按提示重启 DSH；侧栏出现「DSH助理」，面板显示 `0.6.0`。
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

- `GET /whale-chan/api/state` 返回 200，版本 `0.6.0`；管理请求带 `x-whale-chan-request: 1`。
- `GET /whale-chan/api/channel` 返回 `{ state, running, targets }`；未配置目标时 `state` 为 `stopped`、`targets` 为空数组。运行时未就绪时该路由返回 `503 state_unavailable`，这是正常启动窗口。
- `GET /whale-chan/api/persona` 返回 `{ persona, revision, defaults, presets }`：从未保存过人设的安装中 `persona` 与 `defaults` 均为空人设（仅 `name=鲸鱼酱`），`presets` 含 `whale-maid`。
- 概览健康检查：`stateDir`、`database`、`lock`、`settings`、`prompts` 正常；`channel` 在没有启用目标时为 `idle`，这是正常状态。
- 「设置 → 回复」块末尾出现 **「失败时自动重试一次」**（`reply.autoRetry`，默认开）；「设置 → 人设」的字数上限 hint 为“单条回复正文的最大字符数；末尾的引用链接不计入该上限”。
- 「目标」页：表格右侧有只读「订阅」列（`GET channel` 不可用时只出提示条）；`dm` 行提示 `userId` 或 `open:<openDingtalkId>`，「仅 @」开关在非 `group` 行禁用。
- 「目标」页的「工作区」区块显示已启用目标的具体目录（`ready`）或「按会话创建」（`per-conversation`）；`ready` 行右侧有「归档会话」按钮，`per-conversation` 行没有。
- 归档一次后 `GET /whale-chan/api/targets` 的 `workspace` 仍可用；「审计」页出现 `workspace.sessions-archived`（`actor=owner`）。
- 「人设」页两个动作可用且**不会自动保存**：恢复默认只清草稿，载入预设只填草稿；写入仍需点保存。
- `cordis.patch.yml` 已生效：面板出现，两套 preset 行 active（日志无 `agent-preset/not-found`）。

> v0.6.0 的回复预算与重试没有真机证据：面板显示版本与开关只证明安装成功，不证明长引用场景与重试行为在真实模型上成立。

## 5. 打包与产物

```bash
pnpm build
npm pack --dry-run --json --ignore-scripts
```

15 个 artifacts（与 v0.5.0 相同，本版不增删文件）：

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

**v0.6.0 不重跑 T0–T4；本版改动的回复链路尚未真机验收。** 理由与边界：本版只改 `sanitizeReply` 的预算切分、失败词与一次重试，这些都是单元测试能覆盖的纯文本/状态逻辑；但“真实模型的引用长度、真实来源标题长度、重试后的第二稿差异”只有真实账号能证明。

| 级别          | 目标                             | 本版处理                                                                                           | 证据/通过标准                                                                                      |
| ------------- | -------------------------------- | -------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| T0–T2         | 认证/发现、目标校验、单条发送    | 不重跑（通道未改）                                                                                 | [WS8 报告](test-reports/WS8-live.md)；v0.5.0 的订阅/单聊待补验见 [WS15 报告](test-reports/WS15.md) |
| T3            | 群内 @ 自动回复                  | 不重跑分类/策略；**补验长引用正文**：检索返回 3 条长来源时正文仍完整发出，脚注被跳过或省略但不为空 | [WS8 报告](test-reports/WS8-live.md)；`brain-reply` 单测覆盖取舍/丢弃                              |
| T4            | 任务批准与执行                   | 不重跑（执行器未改）                                                                               | 同 v0.5.0                                                                                          |
| 回复预算/重试 | 长引用、`sanitized_empty`、重试  | **未验收**（只有单测与假 `dws`）                                                                   | [WS16 报告](test-reports/WS16.md)：需真实账号确认正文不被脚注挤空、可重试失败只多调用一次          |
| 订阅/单聊     | v0.5.0 遗留项                    | 未验收（沿用 v0.5.0 的待办）                                                                       | [WS15 报告](test-reports/WS15.md)                                                                  |
| 归档/恢复     | 归档当前回复器后下一条消息换会话 | 沿用 v0.4.0 的定向真机验活                                                                         | [WS14-live](test-reports/WS14-live.md)                                                             |
| 人设默认/预设 | 空默认、`whale-maid` 预设、面板  | 沿用 v0.3.0 的重载核对                                                                             | [WS12 报告](test-reports/WS12-persona.md)                                                          |

记录要求：

- 证据写入 `docs/test-reports/WS16.md`；真机验收完成后在**同一文件**追加“真机结论”小节（不要改写成既成事实）。日期、DSH 版本、`dws` 版本、OS、Node、目标类型（不要写真实群名/账号）、命令、脱敏输出与结论齐全。
- 截图必须裁掉真实群名、成员昵称、账号 id 与消息正文；本版未新增浏览器截图，页面行为由组件测试覆盖。
- 验收后把测试群目标设为 `enabled=false`（保留该行与工作区），让通道回到 `idle: no enabled targets`。
- v0.6.0 需要补的最小真机清单：① 一条会检索的问题，返回 3 条长标题来源，确认群里的回复正文完整、脚注最多 3 条且没有被截半；② 人为制造一次 `empty`/`model_error`（例如临时把模型路由指向不可用模型），确认只重试一次后 `defer`，`decisions.attempts` +1，host 日志出现 `compose retry 1/1 for decision <id>`；③ 关掉 `reply.autoRetry` 后同样的失败直接 `defer`，不再多调用。补验前先备份 `stateDir`，只在测试群执行。

## 7. 打 tag

```bash
# 最终门禁（干净工作区）
pnpm check
pnpm format:check
node scripts/check-pack.mjs
git status --porcelain

# annotated tag（待打在 v0.6.0 发布记录提交上）
git tag -a v0.6.0 -m "dsh-whale-chan-assistant 0.6.0"
git show --stat v0.6.0
```

- **`v0.6.0` 尚未打 tag**：实现提交在 `fix/ws16-reply-budget`（`18ac297`、`c0d4b39`），文档与版本收口由 coordinator 提交；合并、tag 与 push 由发布负责人执行。实现/文档代理没有执行 merge、tag 或 push。
- tag 必须指向包含版本 bump、CHANGELOG、compatibility、PROGRESS、004/005/007/011/012/014 与 WS16 报告/PR 的提交。
- 打 tag 后如需归档，再执行 `npm pack --ignore-scripts`；产物不入库（`.gitignore` 已忽略 `*.tgz`）。

## 8. 回滚

发布出问题时按“先停、再保数据、最后换版本”的顺序：

1. **停用/卸载 bundle**：DSH 桌面端「插件」→ 已安装 → 停用或卸载，重启 DSH；侧栏入口消失，面板路由不再挂载。
2. **保留状态目录**：不要卸载时顺手删 `~/.dsh-whale-chan`。其中是消息、任务、批准、审计与设置历史，删除不可恢复；会话工作区默认也在其下的 `workspaces/`。
3. **备份**：停机后等 `state.db-wal` 消失（或已合并），复制整个 `stateDir`（含 `workspaces/`）；在线备份用 `sqlite3 state.db ".backup '<backup>.db'"`。
4. **回退版本**：重新安装上一个已知可用版本。0.6.0 **没有 schema 变更**（仍是 2），回退到 v0.5.0 可以打开同一个库；设置多出的 `reply.autoRetry` 会被 v0.5.0 的 strict 校验当作未知字段，v0.5.0 启动时会把整个 `reply` block 回退默认并记 warning——回退前先记录该 block 的自定义值（允许/屏蔽发送者、限速、@ 规则等），回退后重新保存。
5. **回退后的行为差异**：引用脚注重新挤占 `persona.maxReplyChars` 的预算，长引用场景会再次出现 `compose:empty` 丢回复；失败不再自动重试，一次失败即 `defer`；`sanitized_empty` 重新并入 `empty`（旧代码不认这个词）。既有数据不受影响。
6. **回退后注意归档**：`session.reply-generation:*` / `session.worker-generation:*` 会留在 KV 里；若回退到 v0.3.0，它们不被识别，会按 `g0` 解析会话，已被 v0.4.0/v0.5.0 归档的 `g0` 会话会被归档闸门挡住。优先只在未归档过的工作区继续使用。
7. **恢复**：把备份放回一个没有 `.lock` 的目录；确认没有进程占用后再启动。
8. **通知**：在发布记录与 CHANGELOG 中写明回滚原因、影响版本与数据处置。

## 9. 发布后验证

- 面板显示版本 `0.6.0`，健康检查全绿或仅 channel idle（未配置目标）。
- `GET /whale-chan/api/state` 版本 `0.6.0`；`API_ROUTES` 为 21 条（本版不新增路由）。
- `GET /whale-chan/api/settings` 的 `reply` block 含 `autoRetry: true`；`PUT settings/reply` 不带该字段时保持原值（块内深合并），带非布尔值时返回 `400 invalid_settings`。
- 触发一次带检索的回复：正文完整，`参考：` 之后最多 3 条来源；来源标题很长时脚注被跳过或整体省略，正文不受影响。
- 人为让一次回复失败（模型空输出或不可用路由）：`decisions.attempts` 从 0 变 1，host 日志出现 `compose retry 1/1 for decision <id> after <失败词>`；第二次仍失败时审计/决策 `reason` 为 `compose:<失败词>`，`defer` 是终态。
- 关闭 `reply.autoRetry` 后重复上面的失败：不再多调用一次，直接 `defer`。
- 检查 `state.db` 的 schema 仍为 2、`effects` 无 dead 行；设置历史出现一次 `reply` block 的更新（若主人保存过）。
- 记录发布日期、tag、安装来源与验证人；更新 `docs/PROGRESS.md` 的发布坐标。

## 相关文档

- [004 提示词](004-prompts.md)
- [005 面板](005-panel.md)
- [006 部署](006-deployment.md)
- [007 架构](007-architecture.md)
- [009 DWS 协议](009-dws-protocol.md)
- [011 设置合约](011-settings-contract.md)
- [013 安全基线](013-security.md)
- [014 人设默认值与预设](014-persona-defaults.md)
- [兼容矩阵](compatibility.md)
- [WS14 验收报告](test-reports/WS14.md)
- [WS14 PR](pr/WS14-archive-sessions.md)
- [WS15 验收报告](test-reports/WS15.md)
- [WS15 PR](pr/WS15-target-subscriptions.md)
- [WS16 验收报告](test-reports/WS16.md)
- [WS16 PR](pr/WS16-reply-budget.md)
- [WS12 人设报告](test-reports/WS12-persona.md)
- [WS9/WS10 真机报告](test-reports/WS9-10.md)
- [WS8 真机报告](test-reports/WS8-live.md)
- [WS6 测试报告](test-reports/WS6.md)
