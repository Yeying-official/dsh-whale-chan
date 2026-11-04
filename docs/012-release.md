# 012 发布

> 当前状态：**v0.5.0 已合并到 `main` `858f6fd`**（`--no-ff` 合并提交 `chore(merge): ws15 target subscription fixes`）；tag `v0.5.0` **已本地打**、指向 `3a8c788`（本地、未 push）。WS0–WS15 已完成；v0.5.0 修复目标订阅链路（单聊发现、`open:` 出站、服务端拒绝可观测、`mentionOnly`、`GET channel`），管理 API **21 条**，schema 仍为 2，设置字段仍 57 / 9 个 block，locale 中英各 524 个顶层 key。
>
> 版本 `0.5.0`，日期 `2026-11-04`。`private: true`，不发布到 npm。
>
> 真机：**v0.5.0 的订阅/收发链路尚未在真实账号上验收**——证据只有单元测试与假 `dws` 夹具。`at-me` 订阅本身在修复前的排查中以 `--ephemeral` 临时探测到过 ready，但 `at-me` + `group` 同群去重、单聊订阅与单聊出站回复仍未真机确认，见 [WS15 验收报告](test-reports/WS15.md)。历史坐标：v0.4.0 已合并到 `main` `d0ed2e6`，tag `v0.4.0` 指向 `c82027a`（本地、未 push），其归档链路的定向真机验活见 [WS14-live](test-reports/WS14-live.md)。

## 1. 发布决策

| 项         | 规则                                                                                                                                                 |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| 版本       | `0.5.0`；`package.json`、`src/shared/limits.ts` 的 `PLUGIN_VERSION`、`scripts/check-pack.mjs` 三处一致                                               |
| 版本真源   | `tests/contract.spec.ts` 断言 manifest 版本等于 `PLUGIN_VERSION`；`check-pack` 再断言一次                                                            |
| 合约       | 管理 API **21 条**（WS15 新增 `GET channel`）；设置仍 57 字段 / 9 block；schema 仍 2；`dsh.compatibility` 与 `engines` 不变（仍只标记 `0.2.1-rc.5`） |
| 发布渠道   | `private: true`，**不发 npm**；以本地目录或归档 bundle 安装到 DSH                                                                                    |
| 产物       | `pnpm build` 生成 `lib/`；`npm pack --dry-run` 为 **15 个 artifacts**，icon 711 bytes（本版不增删文件）                                              |
| 文档       | `docs/` 与 `CHANGELOG.md` **只在仓库/发行页**；npm 包只含 `README.md` 与运行产物，README 里的 docs 链接包内不可达                                    |
| 合并与发布 | 实现/文档代理只准备发布提交；合并、tag、push 与 profile 安装由发布负责人复核后执行                                                                   |

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

- `pnpm check`：typecheck 0 错误、**880 tests / 63 files** 全通过、build 成功（宿主 ESM + 客户端 CJS）；
- `pnpm format:check`：`All matched files use Prettier code style!`；
- `check-pack`：`pack check passed: 15 artifacts, icon 711 bytes`，版本断言 `0.5.0`；
- `pnpm docs:settings`：`57 fields`，字段表无变化（本版没有新增设置字段）；
- `git diff --exit-code docs/011-settings-contract.md`：无输出（生成模板与已提交的 011 同步；任何差异都说明生成器模板落后于正文，必须先把模板改对再提交，不能靠手工改 011）；
- `git status --porcelain`：为空。

任何一步失败都停止发布，不要在失败的工作区上打 tag。测试数相对 v0.4.0（849 / 62）增加 **31 条**、**1 个文件**：新增 `tests/thread-state.spec.ts`（7 条：单聊出站目标、`threadKeyOf` 去前缀、防环三种历史写法）；其余增量为 `brain-policy` +7、`channel-discover-auth` +5（含 2 条改写）、`client-targets` +4、`channel-supervisor` +3、`channel-targets` +3、`api-routes` +2；`channel-facade`、`contract` 只改断言与夹具形状，条数不变。

## 3. 版本与变更日志

- [x] `package.json` → `"version": "0.5.0"`
- [x] `src/shared/limits.ts` → `PLUGIN_VERSION = '0.5.0'`
- [x] `scripts/check-pack.mjs` → 版本断言 `0.5.0`
- [x] `CHANGELOG.md` → `## [0.5.0] - 2026-11-04`，含摘要、Added / Changed / Fixed / Migration / Known limitations；`0.4.0` 及更早段落保留
- [x] `docs/compatibility.md` → 适用版本 `0.5.0`、订阅链路修复状态与“未真机验收”标注、schema 仍 2、DSH 兼容声明不变、仍存限制
- [x] `docs/PROGRESS.md` → WS15 完成、880 tests / 63 files、分支坐标、订阅链路未真机验收的遗留限制
- [x] `README.md` → v0.5.0 状态、功能表「订阅健康与单聊修复」、21 条路由、三类目标 id 规则与 `mentionOnly` 语义、订阅列排障入口、安装验证版本 `0.5.0`
- [x] `docs/005-panel.md` → 21 条路由、§3.4 订阅列与行内提示、§4 `GET channel` 降级、§5 i18n 计数 524
- [x] `docs/007-architecture.md` → 21 条路由、§6.9 订阅健康数据流与错误处理、§7 边界、测试索引
- [x] `docs/009-dws-protocol.md` → §2/§3 dm id 规则、§3.1 服务端拒绝/退避/冷却、§4.2 `mentionOnly` 落地、§5 `open:` 出站、§8 联系人发现、§9 未验证清单
- [x] `docs/011-settings-contract.md` → 由 `scripts/generate-settings-docs.mjs` 重新生成（header、`GET channel` 契约、`mentionOnly` 与 dm id 规则、21 条路由），字段仍 57 / 9
- [x] `docs/002-authorization.md` → 第 8 条“任一为真”与新增 §6.1 目标行解析顺序
- [x] `docs/001-domain.md` → 新增 §5 线程键与“权威目标”
- [x] `docs/pr/WS15-target-subscriptions.md` → 缺陷清单、修复设计、契约变更、审核返工记录（W1/W2/W3）、测试证据、风险与合并坐标
- [x] `docs/test-reports/WS15.md` → 单测证据、复现命令、真机未覆盖项与已知限制
- [x] 合并坐标：`--no-ff` 合并提交 `858f6fd`（`chore(merge): ws15 target subscription fixes`），合并后工作区干净
- [x] 发布 tag：`v0.5.0` **已打**（annotated，指向 `3a8c788`，本地、未 push）；由发布负责人复核后执行
- [ ] 真机验收：订阅/收发链路**未验收**（只有单测与假 `dws` 夹具）；发布负责人需在真实账号上补一次 `at-me`+`group` 同群、单聊订阅与单聊出站
- [ ] 发布复核人确认“订阅链路未真机验收”的表述与 [WS15 报告](test-reports/WS15.md)、CHANGELOG 一致

## 4. 安装与卸载

命令与 v0.3.0 相同，本版**没有**安装方式变化（不新增 profile 步骤，不改 bundle 结构）。

### 4.1 桌面端（推荐）

1. 启动 DSH Desktop `0.2.1-rc.5`，打开侧栏「插件」→「添加插件」。
2. 选择「安装第三方插件」，在「包名或地址」填本仓库的绝对路径（本地目录会以 `link:` 依赖写入 `desktop` profile）。
3. 安装完成后按提示重启 DSH；侧栏出现「DSH助理」，面板显示 `0.5.0`。
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

- `GET /whale-chan/api/state` 返回 200，版本 `0.5.0`；管理请求带 `x-whale-chan-request: 1`。
- `GET /whale-chan/api/channel` 返回 `{ state, running, targets }`；未配置目标时 `state` 为 `stopped`、`targets` 为空数组。运行时未就绪时该路由返回 `503 state_unavailable`，这是正常启动窗口。
- `GET /whale-chan/api/persona` 返回 `{ persona, revision, defaults, presets }`：从未保存过人设的安装中 `persona` 与 `defaults` 均为空人设（仅 `name=鲸鱼酱`），`presets` 含 `whale-maid`。
- 概览健康检查：`stateDir`、`database`、`lock`、`settings`、`prompts` 正常；`channel` 在没有启用目标时为 `idle`，这是正常状态。
- 「目标」页：表格右侧有只读「订阅」列（`GET channel` 不可用时只出提示条）；`dm` 行提示 `userId` 或 `open:<openDingtalkId>`，「仅 @」开关在非 `group` 行禁用。
- 「目标」页的「工作区」区块显示已启用目标的具体目录（`ready`）或「按会话创建」（`per-conversation`）；`ready` 行右侧有「归档会话」按钮，`per-conversation` 行没有。
- 归档一次后 `GET /whale-chan/api/targets` 的 `workspace` 仍可用；「审计」页出现 `workspace.sessions-archived`（`actor=owner`）。
- 「人设」页两个动作可用且**不会自动保存**：恢复默认只清草稿，载入预设只填草稿；写入仍需点保存。
- `cordis.patch.yml` 已生效：面板出现，两套 preset 行 active（日志无 `agent-preset/not-found`）。

> v0.5.0 起「订阅」列的存在**不**代表订阅已验证：状态列只如实转述运行时的进程状态，`ready` 表示 `dws` 报过带 `subscribe_id` 的就绪行，不表示服务端能持续投递事件。真实账号的收发仍按 §6 单独验收。

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

**v0.5.0 不重跑 T0–T4；本轮修复的订阅/收发链路尚未真机验收。** 理由与边界：WS15 改的是“目标怎么被发现、订阅参数怎么拼、拒绝怎么记录、群消息用哪一行策略、单聊回复用哪个 flag”，这些都是单元测试与假 `dws` 夹具能覆盖的判定，但它们恰好也是只有真实账号才能证明的部分——服务端是否接受该 id、事件里到底有哪些字段、群消息会不会真的投递。`at-me` 订阅在修复前的排查中以 `--ephemeral` 临时探测到 ready（随后撤销），`+chat-list --types p2p` 不含人员 id 与 o2o 事件只带 `sender_open_dingtalk_id` 两点来自同一次排查的实测记录。**因此 v0.5.0 的对外表述统一是“修复已实现、有单测证据、未真机验收”**，不得写成已验证。

| 级别          | 目标                                                       | 本版处理                                                                       | 证据/通过标准                                                                                                                         |
| ------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| T0–T2         | 认证/发现、目标校验、单条发送                              | 不重跑；但**发现与发送参数有变更**（联系人发现、`open:` 出站），需在真机补一次 | [WS8 报告](test-reports/WS8-live.md) 的历史证据只覆盖群与 `--user`；新增路径见 [WS15 报告](test-reports/WS15.md) 的待验收清单         |
| T3            | 群内 @ 自动回复                                            | 不重跑（分类/回复链路未改）；`mentionOnly` 分支需补验                          | [WS8 报告](test-reports/WS8-live.md)；`mentionOnly` 由 `brain-policy` 单测覆盖（27 条）                                               |
| T4            | 任务批准与执行                                             | 不重跑（执行器未改）                                                           | 同上：`awaiting-approval` → `running` → `succeeded`，对外文本不含路由、工具名、会话 id、工作区路径                                    |
| 订阅/单聊     | `at-me`+`group` 同群去重、单聊订阅与单聊出站、服务端拒绝   | **未验收**（只有单测与假 `dws`）                                               | [WS15 报告](test-reports/WS15.md)：需真实账号按 §6 清单逐项跑通后才能改口径                                                           |
| 归档/恢复     | 归档当前回复器后下一条消息换会话、工作区重建、stopActivity | 沿用 v0.4.0 的定向真机验活（归档 → 下一条消息）；其余未覆盖                    | [WS14-live](test-reports/WS14-live.md)；stopActivity/worker/手动移除/单聊/多目标未真机，见 [WS14 报告](test-reports/WS14.md) 与 PR §5 |
| 人设默认/预设 | 空默认、`whale-maid` 预设、面板                            | 沿用 v0.3.0 的重载核对                                                         | [WS12 报告](test-reports/WS12-persona.md)                                                                                             |

记录要求：

- 证据写入对应报告：WS15 的自动化证据写入 `docs/test-reports/WS15.md`；真机验收完成后在**同一文件**追加“真机结论”小节（不要改写成既成事实）。日期、DSH 版本、`dws` 版本、OS、Node、目标类型（不要写真实群名/账号）、命令、脱敏输出与结论齐全。
- 截图必须裁掉真实群名、成员昵称、账号 id 与消息正文；本版未新增浏览器截图，页面行为由组件测试覆盖。
- 验收后把测试群目标设为 `enabled=false`（保留该行与工作区），让通道回到 `idle: no enabled targets`；当前状态是 `targets=[]`、`idle: no enabled targets`。
- v0.5.0 需要补的最小真机清单：① `at-me` 与 `group` 同时订阅同一群时，普通消息按群行、@ 消息按 at-me 行；② 单聊按联系人姓名发现 → 保存 → 订阅 `ready` → 收到消息 → 回复发出；③ 一个故意错误的 `dm` id（`cid…=`）被本地拒绝且提示可读；④ 一个被服务端拒绝的订阅在 `GET channel` 里能看到脱敏原因，并在连续 3 次后停住。补验前先备份 `stateDir`，只在测试群执行。

## 7. 打 tag

```bash
# 最终门禁（干净工作区）
pnpm check
pnpm format:check
node scripts/check-pack.mjs
git status --porcelain

# annotated tag（已打在发布记录提交 3a8c788 上）
git tag -a v0.5.0 -m "dsh-whale-chan-assistant 0.5.0"
git show --stat v0.5.0
```

- **`v0.5.0` 已打 tag**：annotated tag 指向发布记录提交 `3a8c788`（本地，未 push）；合并在 `858f6fd` 已完成。实现/文档代理没有执行 merge、tag 或 push。
- tag 必须指向包含版本 bump、CHANGELOG、compatibility、PROGRESS、001/002/005/007/009/011/012 与 WS15 报告/PR 的提交。
- 打 tag 后如需归档，再执行 `npm pack --ignore-scripts`；产物不入库（`.gitignore` 已忽略 `*.tgz`）。

## 8. 回滚

发布出问题时按“先停、再保数据、最后换版本”的顺序：

1. **停用/卸载 bundle**：DSH 桌面端「插件」→ 已安装 → 停用或卸载，重启 DSH；侧栏入口消失，面板路由不再挂载。
2. **保留状态目录**：不要卸载时顺手删 `~/.dsh-whale-chan`。其中是消息、任务、批准、审计与设置历史，删除不可恢复；会话工作区默认也在其下的 `workspaces/`。
3. **备份**：停机后等 `state.db-wal` 消失（或已合并），复制整个 `stateDir`（含 `workspaces/`）；在线备份用 `sqlite3 state.db ".backup '<backup>.db'"`。
4. **回退版本**：重新安装上一个已知可用版本。0.5.0 **没有 schema 变更**（仍是 2），回退到 v0.4.0 可以打开同一个库；设置字段与 block 未变，已保存的人设原样保留。
5. **回退后的行为差异**：`GET channel` 在 v0.4.0 不存在（旧面板不调用它，无影响）；`mentionOnly` 重新变为不生效，群消息只受全局 `reply.requireMentionInGroups` 约束；单聊发现回到 `+chat-list --types p2p`，会再次产出会话 ID 形态的候选。**若已在 v0.5.0 把单聊 id 改成 `userId`/`open:<id>`，回退后继续保持即可**（v0.4.0 也接受这两种形态）。
6. **回退后注意归档**：`session.reply-generation:*` / `session.worker-generation:*` 会留在 KV 里；若回退到 v0.3.0，它们不被识别，会按 `g0` 解析会话，已被 v0.4.0/v0.5.0 归档的 `g0` 会话会被归档闸门挡住。优先只在未归档过的工作区继续使用。
7. **恢复**：把备份放回一个没有 `.lock` 的目录；确认没有进程占用后再启动。
8. **通知**：在发布记录与 CHANGELOG 中写明回滚原因、影响版本与数据处置。

## 9. 发布后验证

- 面板显示版本 `0.5.0`，健康检查全绿或仅 channel idle（未配置目标）。
- `GET /whale-chan/api/state` 版本 `0.5.0`；`API_ROUTES` 为 21 条，`GET channel` 与 `POST targets/:id/archive-sessions` 都存在。
- `GET /whale-chan/api/channel` 返回 `{ state, running, targets }`；目标全部禁用时为 `stopped`，有启用目标但未就绪时为 `starting`/`degraded`。
- 目标页出现只读「订阅」列；人为让一个订阅被拒（例如保存一个服务端不认的 dm id）时，该行应显示失败与脱敏原因，`GET channel` 的 `lastError` 与面板文本一致。
- `GET /whale-chan/api/persona` 返回四个字段；从未保存过人设的安装中 `persona`/`defaults` 为空人设，`presets` 含 `whale-maid`；已保存的人设不被覆盖。
- 目标页工作区块显示启用目标的目录；`ready` 行有「归档会话」按钮，`per-conversation` 行没有。
- 对一个测试目标归档一次：结果摘要五类计数齐全；若回复器被归档，`replySessionRotated=true`；发一条测试消息，确认回复出现在**新**会话里，且旧会话仍在 DSH 里可查（该链路已于 2026-11-04 在 v0.4.0 上定向验活通过，见 [WS14-live](test-reports/WS14-live.md)）。
- **必须单独确认（v0.5.0 未验收项）**：`at-me` 与群目标同时订阅同一群时的策略分派、单聊订阅与单聊出站回复。未跑通之前，README、CHANGELOG 与兼容矩阵只能写“未真机验收”。
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
- [WS15 验收报告](test-reports/WS15.md)
- [WS15 PR](pr/WS15-target-subscriptions.md)
- [WS12 人设报告](test-reports/WS12-persona.md)
- [WS9/WS10 真机报告](test-reports/WS9-10.md)
- [WS8 真机报告](test-reports/WS8-live.md)
- [WS6 测试报告](test-reports/WS6.md)
