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
3. **目标只认显式 ID**：订阅/发送路径不接受名称；`at-me` 全局唯一，其行 id 只作为消息 `targetId`（WS5 初始化为 `at-me`）；`group` 订阅群内全部消息，mention 过滤属于 WS3 策略层；`open:<id>` 是本项目区分 `--user` 与 `--open-dingtalk-id` 的约定。
4. **归一化保守**：消息 id/发送者/会话 id 任一缺失即 `malformed`；未知字段只输出名称；正文/发送者/id 永不进入调试摘要；纯媒体事件以 `unsupported` + `detail=media-only` 跳过（v1 不回复），带文字说明的图文按文字处理。
5. **supervisor 无重叠**：每目标一个进程；重启定时器或活动进程存在时拒绝二次 launch；退避 `1s → 2s → … → restartBackoffMaxSeconds`。
6. **facade 无 Cordis 依赖**：`DingTalkChannel` 接受 `settingsProvider` 与 `logger`，`src/app` 可直接组合；`monitor.enabled=false` 或 `paused=true` 时不订阅。
7. **dryRun 不发消息**：`advanced.dryRun` 时 facade 返回 `skipped` 且不 spawn；`skipped` 不是失败，上层不得改变 Outbound 状态或按失败重试。
8. **Windows 命令解析**：`resolveDwsCommand` 在没有路径、没有已知扩展名时，按 `PATH` → `%APPDATA%\npm` → `%ProgramFiles%\nodejs` → `%LOCALAPPDATA%\Programs\nodejs` 搜索 `.cmd`/`.exe`/`.bat`/原文件，命中后统一用绝对路径 spawn（`createRunner`/`runOnce` 与 `DwsProcess` 共享）；解析失败保留原命令，路径写入日志与 health。

## 4. 测试证据

```text
pnpm install --frozen-lockfile   -> Done, exit 0
pnpm typecheck                   -> tsc --noEmit, exit 0
pnpm test                        -> 46 files, 579 tests passed (WS2: 12 files / 126 tests)
pnpm build                       -> lib/index.js, lib/index.d.ts, lib/client.js, exit 0
node scripts/check-pack.mjs      -> pack check passed: 10 artifacts, icon 711 bytes
pnpm format:check                -> All matched files use Prettier code style!
```

WS2 用例分布：

| 文件                            | 数量 | 覆盖                                                                                                   |
| ------------------------------- | ---- | ------------------------------------------------------------------------------------------------------ |
| `channel-normalize.spec.ts`     | 22   | at/group/dm、self、broadcast、empty、纯媒体跳过、图文、坏行、别名、时间、调试摘要                      |
| `channel-targets.spec.ts`       | 11   | 事件键、群/单聊/open 参数、TTL、profile、去重、owner 无回退                                            |
| `channel-process.spec.ts`       | 11   | 就绪行、行切分、stdin 停止、SIGTERM、orphaned、dry-run、超时、spawn 失败                               |
| `channel-supervisor.spec.ts`    | 9    | 双目标、顺序、sink 抛错、坏行、退避重启、无重叠、非法目标、stop 收敛、孤儿清理、无 owner 拒绝          |
| `channel-send.spec.ts`          | 18   | 四种结果、幂等键、ledger、超时 unknown、回执分类                                                       |
| `channel-confirm.spec.ts`       | 3    | 缺 `--yes` → failed；`deliveryStatus` 非白名单 → unknown；重复 key → unknown 且一条 ledger             |
| `channel-discover-auth.spec.ts` | 16   | 发现容错/上限/去重、dry-run 校验、auth 降级、owner userId 与脱敏                                       |
| `channel-log.spec.ts`           | 9    | token/secret/query/JSON 脱敏、单行错误、截断                                                           |
| `channel-facade.spec.ts`        | 8    | paused/disabled 不订阅、无目标空闲、重复 start、dryRun skipped、owner 拒绝                             |
| `channel-review.spec.ts`        | 8    | owner userId 与脱敏、owner 拒绝启动、dryRun skipped、纯媒体、JSON 脱敏                                 |
| `channel-command.spec.ts`       | 10   | win32 解析顺序、APPDATA/ProgramFiles/LOCALAPPDATA 回退、路径/扩展名原样、无命中、非 win32、shim 端到端 |
| `channel-ttl.spec.ts`           | 4    | `--ttl` Go duration（1h/24h）、fake 拒收裸数字、validate argv 记录 24h                                 |

### 4.1 Review round 1 修复（REQUEST_CHANGES）

| 项   | 落点                                                                                                                                                                                      | 测试                                                                     |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| P0.1 | `AuthState.userId` 从 `auth status` 别名读取并只交给宿主；`DingTalkChannel.start` 与 `ChannelSupervisor.start` 在 enabled target 存在且 owner 为空时抛 `owner-unknown`；删除 at-me 行回退 | auth 3 条（返回值/别名/redact 后不落日志）、supervisor 1 条、facade 1 条 |
| P0.2 | `SendResult` 增加 `skipped`；`advanced.dryRun` 时 `sendWithReceipt` 返回 `{result:'skipped'}`，不 spawn、不产生失败语义                                                                   | facade 1 条（skipped + ledger 不存在）                                   |
| P0.3 | `normalize` 对纯媒体事件返回 `{skip:'unsupported', detail:'media-only'}`；有文字说明的图文仍按文字处理                                                                                    | normalize 2 条（纯媒体跳过、图文保留）                                   |
| 决策 | group `mentionOnly` 归 WS3；at-me 行 id 作为 `targetId`；owner 不回退；PROGRESS.md 格式由整合方在 main 修复                                                                               | —                                                                        |

review 同步：已 merge `main` `b69177d`（仅 `docs/PROGRESS.md` 格式修复），整仓 `pnpm format:check` 现为绿；review 修复提交为 `fix(channel): require owner identity and skip dry-run sends`、`test(channel): cover owner identity, skipped sends and media-only`、`docs: record ws2 review decisions`。

### 4.2 Review round 2：Windows shim 解析

现网 `available=false` 而终端 `dws --version` 正常，根因是宿主 `PATH` 不含 `%APPDATA%\npm`，`cross-spawn` 无法解析裸 `dws`。修复：

- 新增 `src/channel/command.ts`：`resolveDwsCommand(command, env, platform)`，规则与测试见 009 §3.1；
- `runOnce` 与 `DwsProcess.start` 在实际 spawn 前解析，`probeAuth`/`send`/`discover`/`validate`/supervisor 全部共享，不在各处重复；
- supervisor 解析一次、日志打印一次，`TargetHealth.command` 暴露解析后的路径（仅路径）；
- `channel-command.spec.ts` 10 条：PATH `.cmd`、`%APPDATA%` 回退、`%ProgramFiles%` 与 `.cmd` 优先、`%LOCALAPPDATA%` 存在性、`Path` 拼写、绝对路径、已带扩展名、无命中、非 win32、以及通过 `.cmd` shim 端到端 `probeAuth`（win32）。

现网复核（由整合方执行）：`available=true`、`authenticated=true`、`ownerKnown=true`、channel idle。

### 4.3 Review round 3：T1 实测 `--ttl` 需要 Go duration

T1 真机 dry-run 发现 `--ttl 1` 被 dws 拒绝：`exit=3`、`invalid argument "1" for "--ttl" flag: time: missing unit in duration "1"`。修复：`consumeSpec` 通过 `ttlDuration(hours)` 统一输出 `<hours>h`（1→`1h`、24→`24h`），`fake-dws` 同步校验单位并在缺失时退出 3，validate 成功路径经 fake trace 断言 argv 为 `24h`。

### 4.4 Review round 4：T2 发送确认与真实回执

T2 真机发现非交互 `+messages-send` 缺少 `--yes` 会被 dws 拒绝（exit 3，`confirmation_required`）；成功回执为 `{conversationId, deliveryStatus, idempotencyKey, openMessageId}`；同一 key 第二次返回 exit 1 的 `CONFLICT_ERROR` / `Request is repeated with uuid`。

- `buildSendArgs` 固定追加 `--yes`（发送属于主人已配置/已批准流程，不能依赖 stdin）；`event stop` 原本已带 `--yes`，`chat +chat-search`/`+chat-list`/`auth status` 经审计无需确认。
- `receiptOf` 优先 `openMessageId`，保留 messageId/msgId/processQueryKey；`deliveryStatus` 缺失或为 `delivered|sent|ok` 才算 sent，非白名单（unknown/pending/failed）→ unknown。
- 重复 key 明确映射 unknown（detail=`duplicate idempotency key`），不重发、不产生第二条；回执 JSON 允许出现在 stderr，并按嵌套 `error` 取 code/message。
- fake 同步模拟：缺 `--yes` → `confirmation_required` + exit 3 且不写 ledger；同 key 第二次 → `CONFLICT_ERROR` + exit 1 且不新增 ledger；成功回执改为真实字段。

测试：`buildSendArgs` 精确 argv 含 `--yes`；缺 `--yes` → failed（非 unknown）且 ledger 空；成功解析 `openMessageId` 且 ledger 含 `--yes`；`deliveryStatus: unknown` → unknown；重复 key → unknown 且 ledger 保持 1 条；dryRun 仍不 spawn。

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
| ⑩    | 提交规范、工作区干净                   | 通过：全部提交遵循 Conventional Commits；最终 `git status --porcelain` 为空                              |
| ⑪    | Windows 命令解析                       | 通过：`resolveDwsCommand` 10 条测试（临时目录 + 注入 env/platform），`.cmd` shim 端到端可 probeAuth      |

## 7. 已决事项与遗留

review round 1/2 已决定，不再需要额外决策：

1. **owner 身份**：来源为 `probeAuth().userId`，由宿主注入；缺失时 `start` 抛 `owner-unknown` 并拒绝订阅，没有 at-me 行回退。
2. **group `mentionOnly`**：通道如实输出 `addressed`，是否回复由 WS3 策略层决定；通道不丢弃未 @ 的群消息。
3. **`at-me` 目标 id**：保留 `target.id` 作为消息 `targetId`；WS5 会把该行初始化为 `at-me`。
4. **dryRun 发送**：`skipped`，不改变 Outbound 状态、不按失败重试。
5. **`format:check`**：整合方已在 `main` `b69177d` 修复 `docs/PROGRESS.md`，本分支 merge 后整仓通过。
6. **`--ttl` 单位**：dws 按 Go duration 解析，v1 固定 `<hours>h`；T1 裸数字被拒的回归已由测试固化。
7. **非交互发送**：`--yes` 固定追加；重复 key 视为已受理（unknown），按幂等键对账，不重发。
8. **Windows `dws` 解析**：自动解析 npm shim；找不到时保留原命令或由 `dws.binaryPath` 绝对路径覆盖，不再要求宿主 `PATH` 与交互 shell 一致。

遗留只有真机验证：§5 列出的 provisional 项需要在 T1–T2 逐项核对；不一致时先改 009 与测试，再改实现。
