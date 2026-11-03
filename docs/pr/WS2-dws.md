# WS2 · dws 个人授权通道（进程、归一化、目标、发送、supervisor）

- 分支：`feat/ws2-dws`（worktree `E:/DSHWork/wt-ws2`，基线 `main` `a7d68d6`）
- 状态：实现与本地门禁通过；**未合并、未 push、未安装 profile、未改动 `~/.dsh`**
- 关联：[009 DWS 协议](../009-dws-protocol.md)、[006 部署](../006-deployment.md)、[WS2 测试报告](../test-reports/WS2.md)

## 1. 目标

实现 `dws` 个人授权通道：

- 按显式目标管理 `event consume` 子进程（就绪探测、止损、退避重启、永不强杀）；
- 把 NDJSON 事件归一化成 core 的 `InboundMessage`，对未知字段保守、可审计；
- 以本人身份发送，拥有正确的幂等键与 `unknown` 语义；
- 提供目标发现、非破坏校验、授权探测与日志脱敏；
- 用 fake 可执行文件覆盖全部路径，不触达真实钉钉。

## 2. 交付物

| 文件                          | 职责                                                                                       |
| ----------------------------- | ------------------------------------------------------------------------------------------ |
| `src/channel/types.ts`        | `DwsTarget`、`ChannelEvent`、`SendResult`、`ChannelHealth`、`TargetCandidate`、`AuthState` |
| `src/channel/errors.ts`       | `ChannelError` 与稳定错误码                                                                |
| `src/channel/log.ts`          | `redact`、`describeError`、`truncate`、`describeExit`                                      |
| `src/channel/process.ts`      | `DwsProcess`（就绪/停止/orphaned）、`runOnce`、`createRunner`、`parseReadyLine`            |
| `src/channel/normalize.ts`    | 别名表、`addressed`、skip 原因、threadKey、调试白名单摘要                                  |
| `src/channel/targets.ts`      | `EVENT_KEYS`、`consumeSpec`、`targetsFromSettings`、`dedupeTargets`、`parsePeerAddress`    |
| `src/channel/discover.ts`     | `discoverGroups` / `discoverPeers`，容错解析与 50 条上限                                   |
| `src/channel/validate.ts`     | `--dry-run` 校验，不创建订阅                                                               |
| `src/channel/auth.ts`         | `probeAuth`，只读布尔/版本/过期时间                                                        |
| `src/channel/sender.ts`       | `+messages-send` 参数、回执分类、`unknown` 语义                                            |
| `src/channel/supervisor.ts`   | 每目标一个进程、退避重启、无重叠、顺序 sink、stop 收敛、孤儿清理                           |
| `src/channel/index.ts`        | `DingTalkChannel` facade，注入 `settingsProvider` 与 `logger`                              |
| `tests/fixtures/fake-dws.mjs` | fake `dws`：版本/授权/订阅/发现/发送，全部状态只写临时目录                                 |
| `tests/channel*.spec.ts`      | 8 个测试文件，101 条通道用例                                                               |

依赖方向：`src/channel → src/core`（只读模型类型）与 `src/shared/settings.ts`；无 `@deepseek-ai/*`，无新增依赖（仅使用已有的 `cross-spawn`、`zod`）。未改 `src/core`、`src/app`、`src/shared`、`src/client`、`src/index.ts`、`package.json`、`cordis.patch.yml`、`docs/007-architecture.md`。

## 3. 关键设计

1. **不 kill -9**：停止顺序固定为 `stdin.end()` → grace → `SIGTERM` → term → `orphaned`；`runOnce` 超时同样只发 `SIGTERM`。孤儿状态保留在 health，并 best-effort 执行 `dws event stop <subscribe_id> --yes`。
2. **unknown 语义**：发送超时、退出 0 无回执、无法分类的非零退出都映射为 `unknown`；上层禁止重发。缺 `idempotencyKey` 时不 spawn。
3. **目标只认显式 ID**：订阅/发送路径不接受名称；`at-me` 全局唯一；`group` 订阅群内全部消息，mention 过滤在归一化/决策层；`open:<id>` 是本项目区分 `--user` 与 `--open-dingtalk-id` 的约定。
4. **归一化保守**：消息 id/发送者/会话 id 任一缺失即 `malformed`；未知字段只输出名称；正文/发送者/id 永不进入调试摘要；空正文但有媒体时保留消息而非丢弃事实。
5. **supervisor 无重叠**：每目标一个进程；重启定时器或活动进程存在时拒绝二次 launch；退避 `1s → 2s → … → restartBackoffMaxSeconds`。
6. **facade 无 Cordis 依赖**：`DingTalkChannel` 接受 `settingsProvider` 与 `logger`，`src/app` 可直接组合；`monitor.enabled=false` 或 `paused=true` 时不订阅。
7. **dryRun 不发消息**：`advanced.dryRun` 时 facade 返回 `failed` 且不 spawn，避免演练模式产生外部消息。

## 4. 测试证据

```text
pnpm install --frozen-lockfile   -> Done, exit 0
pnpm typecheck                   -> tsc --noEmit, exit 0
pnpm test                        -> 17 files, 208 tests passed (WS2: 8 files / 101 tests)
pnpm build                       -> lib/index.js, lib/index.d.ts, lib/client.js, exit 0
node scripts/check-pack.mjs      -> pack check passed: 10 artifacts, icon 711 bytes
pnpm format:check                -> 见下（仓库级被既有 docs/PROGRESS.md 阻塞）
```

WS2 用例分布：

| 文件                            | 数量 | 覆盖                                                                           |
| ------------------------------- | ---- | ------------------------------------------------------------------------------ |
| `channel-normalize.spec.ts`     | 22   | at/group/dm、self、broadcast、empty、媒体、坏行、别名、时间、调试摘要          |
| `channel-targets.spec.ts`       | 11   | 事件键、群/单聊/open 参数、TTL、profile、去重、owner 解析                      |
| `channel-process.spec.ts`       | 11   | 就绪行、行切分、stdin 停止、SIGTERM、orphaned、dry-run、超时、spawn 失败       |
| `channel-supervisor.spec.ts`    | 9    | 双目标、顺序、sink 抛错、坏行、退避重启、无重叠、非法目标、stop 收敛、孤儿清理 |
| `channel-send.spec.ts`          | 15   | 四种结果、幂等键、ledger、超时 unknown、回执分类                               |
| `channel-discover-auth.spec.ts` | 16   | 发现容错/上限/去重、dry-run 校验、auth 降级与脱敏                              |
| `channel-log.spec.ts`           | 9    | token/secret/query 脱敏、单行错误、截断                                        |
| `channel-facade.spec.ts`        | 8    | paused/disabled 不订阅、无目标空闲、重复 start、dryRun send、facade 操作       |

## 5. 风险与未验证项

完整 provisional 清单见 [009 §9](../009-dws-protocol.md)。重点：

1. **`+chat-list --types p2p` 结构未实测**：发现单聊依赖防御性解析，真机 T1 前需要确认字段名与分页。
2. **NDJSON 字段名**：`senderStaffId`、`conversationType`、`atUsers` 元素结构、`createAt` 单位来自既有实测记录，未在本工作流重新抓取真实事件。
3. **Windows 信号**：Node 的 `SIGTERM` 在 Windows 上是强制终止；优雅停止实际依赖 `stdin.end()`，必须真机确认。
4. **`event stop` 语法**：best-effort 清理路径按 `<subscribe_id> --yes` 实现，尚未真机执行。
5. **`--wait-delivery` 回执**：成功字段名（messageId / processQueryKey / errcode）为防御性识别；真机需确认。
6. **`--profile` 位置**：统一追加在参数末尾，未在真机核对。
7. **`--format json`**：发现命令的格式开关按既有用法使用，未在真机核对。
8. **`open:` 前缀**是本项目约定，不是 dws 语法；若 dws 实际支持自动识别，可在 T1 后简化。

以上任一项与真机不一致时，先改 009 与测试，再改实现，不允许静默降级。

## 6. 审核清单自评

| 序号 | 项                                     | 结论                                                                                                     |
| ---- | -------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| ①    | 不碰真实 dws、不外泄消息/token         | 通过：全部测试使用 `tests/fixtures/fake-dws.mjs`；`redact`/`describeError` 有单测；auth 只保留布尔与时间 |
| ②    | 停止无 kill -9、可清理订阅             | 通过：停止仅 stdin/SIGTERM；孤儿路径 best-effort `event stop`；测试断言 `kills === ['SIGTERM']`          |
| ③    | normalize 未知字段保守且可审计         | 通过：别名表 + 5 类 skip + debug 仅字段名/白名单截断                                                     |
| ④    | sender unknown 语义与幂等键正确        | 通过：超时/无回执/未分类 → `unknown`；缺键不 spawn；测试覆盖四种结果                                     |
| ⑤    | supervisor 不并发同 target、退避有上限 | 通过：launch 守卫 + 指数退避封顶；trace 断言 start/exit 严格交替                                         |
| ⑥    | 测试真实覆盖，非只跑 happy path        | 通过：坏行、超时、超限、重复、sink 抛错、非法目标、spawn 失败、auth 降级                                 |
| ⑦    | 文档区分夹具/真机证据                  | 通过：009 全文标注 [F]/[H]/[P]/[T1]；006 标注 Windows 待验证                                             |
| ⑧    | 依赖方向干净、无 `@deepseek-ai/*`      | 通过：`grep` 确认 `src/channel` 无该 import；只 import core 模型与 shared 设置                           |
| ⑨    | Windows 可运行                         | 通过：cross-spawn、参数数组、UTF-8 `setEncoding`、`windowsHide`；本机 Windows 跑通全部门禁               |
| ⑩    | 提交规范、工作区干净                   | 通过：6 个 Conventional Commits；提交后 `git status --porcelain` 为空                                    |

## 7. 需要决策的问题

1. **owner 身份来源**：settings 没有 `ownerUserId` 字段（WS5 契约已冻结，本工作流无权改）。目前由 facade 注入，缺省时回退到 `at-me` 目标的 id。建议 WS5/WS4 显式传入真实 userId，避免用户把占位 id 写进 at-me 行。
2. **group 的 `mentionOnly` 语义**：当前订阅群内全部消息，由归一化输出真实 `addressed`，决策层按 `mentionOnly` 过滤。若希望通道层直接丢弃未 @ 的消息，需要新增 skip 原因（会改变 009 的五类 skip 契约）。
3. **`at-me` 目标 id**：settings 行要求非空 id，但全局订阅不需要会话 id。当前把该 id 作为消息的 `targetId`。是否改为固定 `at-me` 并允许空 id，需要 WS5 决定。
4. **dryRun 的发送语义**：`advanced.dryRun` 时 facade 返回 `failed`（不发、不重试）。若 WS5 希望区分“演练跳过”和“真正失败”，需要扩展 `SendResult` 或 `Outbound.status`。
5. **仓库级 `format:check`**：`docs/PROGRESS.md` 在基线 `a7d68d6` 就已不符合 Prettier（用 `git show HEAD:docs/PROGRESS.md` 复现），本工作流按范围未改它。合并前需由整合方格式化该文件，否则整仓门禁无法通过。
