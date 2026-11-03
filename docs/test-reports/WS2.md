# WS2 测试报告

- 日期：2026-11-03（Asia/Shanghai）
- 分支：`feat/ws2-dws`（worktree `E:/DSHWork/wt-ws2`，基线 `main` `a7d68d6`）
- 环境：Windows、Node `v24.15.0`、pnpm `11.4.0`、vitest `4.1.8`、TypeScript `6.0.3`
- 范围：`src/channel/**`、`tests/channel*.spec.ts`、`tests/fixtures/fake-dws.mjs`、`docs/009`、`docs/006`、PR 文档
- **未执行**：真实 `dws event` 订阅、真实 `+messages-send`、profile 安装、`~/.dsh` 修改、合并/push

## 1. 门禁命令与真实输出

| 命令                             | 结果                                                                                |
| -------------------------------- | ----------------------------------------------------------------------------------- |
| `pnpm install --frozen-lockfile` | `Done in 1m 34.6s using pnpm v11.4.0`，exit 0                                       |
| `pnpm typecheck`                 | `tsc --noEmit`，无错误，exit 0                                                      |
| `pnpm test`                      | `17` 个文件、`216` 条测试全部通过（其中 WS2 `8` 文件 / `109` 条）                   |
| `pnpm build`                     | `lib/index.js` 19.94 kB、`lib/index.d.ts` 0.75 kB、`lib/client.js` 42.04 kB，exit 0 |
| `node scripts/check-pack.mjs`    | `pack check passed: 10 artifacts, icon 711 bytes`，exit 0                           |
| `pnpm format:check`（整仓）      | `All matched files use Prettier code style!`，exit 0（merge `main` `b69177d` 后）   |
| `git status --porcelain`         | 提交后复跑输出为空                                                                  |

WS2 用例明细（`pnpm test`）：

```text
tests/channel-normalize.spec.ts      22 passed
tests/channel-targets.spec.ts        11 passed
tests/channel-process.spec.ts        11 passed
tests/channel-supervisor.spec.ts      9 passed
tests/channel-send.spec.ts           15 passed
tests/channel-discover-auth.spec.ts  16 passed
tests/channel-log.spec.ts             9 passed
tests/channel-facade.spec.ts          8 passed
tests/channel-review.spec.ts          8 passed
WS2 total                           109 passed
整仓 total                          216 passed / 18 files
```

## 2. 覆盖策略

- **归一化**：at-me / group / dm 三条主路径；self、broadcast（含关闭开关与同时 @ 本人）、空文本、纯媒体跳过（`unsupported/media-only`）、图文保留、坏行、缺 id、缺会话、撤回事件、别名、嵌套 content、时间三种单位、正文截断、调试摘要白名单。
- **targets**：三个事件键、群/单聊/`open:` 参数、TTL、profile 尾部、空 id 报错、去重（含第二个 at-me）、settings 行映射、owner 仅取显式值（无行回退）。
- **process**：真实 fake 子进程的就绪/NDJSON/stdin 停止；意外退出；`--dry-run` 退出码；注入 stub 断言 `stdin.end → SIGTERM`、`orphaned`、绝不 `SIGKILL`、stop 幂等、超时只发 SIGTERM、spawn 失败不抛。
- **supervisor**：双目标就绪与 targetId 标记、慢 sink 顺序、sink 抛错隔离、坏行计数与重复透传、单目标停止、指数退避 + trace 断言无重叠、非法目标不重启、stop 收敛（全部 stdin-end、无 signal）、孤儿 `event stop` 清理调用、无 owner 时拒绝启动且不 spawn。
- **send**：argv 精确断言、单聊/open id、缺幂等键不 spawn、sent/failed/gone/unknown（真实超时）、回执分类 5 种边界。
- **discover/auth/validate**：查询过滤、50 条上限、去重、空查询不 spawn、非 JSON/非零退出错误、p2p 解析 `userId` 与 `open:` 前缀、本地过滤、dry-run 成功/失败/空 id、auth 正常/非 JSON/缺二进制/版本失败/epoch 过期、owner userId 返回与别名、redact 后不落日志。
- **日志**：token/secret/header/query/JSON 键值脱敏、普通文本不变、单行错误、堆栈不输出、截断。
- **facade**：paused/disabled 不启动、无目标空闲、缺 sink 与重复 start 报错、dryRun 返回 `skipped` 且不 spawn、owner 缺失抛 `owner-unknown`、真实发送走同一设置源、发现/校验/auth 透出。

所有测试只运行 `tests/fixtures/fake-dws.mjs`，不存在真实钉钉流量。

## 3. 字段映射风险

| 风险                                 | 影响                               | 缓解                                                                    |
| ------------------------------------ | ---------------------------------- | ----------------------------------------------------------------------- |
| `senderStaffId` / `userId` 二选一    | 自跳过与 mention 判断可能失准      | 别名表 + ownerUserId 注入；真机 T1 抓一条事件核对                       |
| `auth status` 账号 id 字段名未知     | 取不到 owner，通道拒绝启动         | 接受 user_id/userId/staff_id 等别名；真机 T1 核对，取不到时 fail-closed |
| `conversationType` 取值集合未知      | 群/单聊 threadKey 可能取错         | 数字与常见字符串双向映射，缺失时按目标 kind 推断                        |
| `atUsers` 元素为对象时字段名未知     | `addressed` 可能漏判               | 依次取 userId/staffId/openDingTalkId/user/id/name/nick                  |
| `createAt` 单位未知                  | 时间偏移                           | ≤10 位按秒、否则按毫秒；无法解析回退接收时间                            |
| `+chat-list --types p2p` 结构未实测  | 单聊候选可能为空或 id 类型错误     | 防御性解析 + `open:` 前缀 + 50 条上限 + 文档标注 provisional            |
| `+messages-send` 成功字段未知        | 可能把成功误判为 unknown（偏保守） | 识别 success/ok/errcode/messageId/processQueryKey；无回执即 unknown     |
| `--format json` 是否被 chat 命令接受 | 发现命令可能直接失败               | 失败会以 `ChannelError` 暴露，不静默；T1 核对                           |
| `--profile` 位置                     | 参数被拒/被忽略                    | 统一追加末尾；T1 核对                                                   |
| Windows `SIGTERM` 无法被捕获         | 优雅停止可能退化为强杀语义         | 停止先关 stdin；文档明确要求 T1 验证；不依赖信号做清理                  |
| `event stop` 语法未实测              | 孤儿清理可能失败                   | best-effort，失败只记 debug，不改变 orphaned 状态                       |

## 4. 未验证项（真机 T1–T2）

1. 三个事件键在登录态下的实际订阅与补收行为。
2. NDJSON 真实字段名与嵌套结构（见上表）。
3. `dws event status` / `dws event stop <id> --yes` 的真实输出与权限。
4. `stdin.end()` 在 Windows 上能否让 `event consume` 自行退出。
5. `+messages-send --wait-delivery` 的成功/失败回执字段与 AI 角标效果。
6. TTL 过期、断线重连、重复投递的真实语义（通道透传重复事件，去重由领域按 message id 保证）。
7. `--profile` 与 `auth status --format json` 在真实账号上的字段拼写（含账号 id 的 `user_id`/`userId`/`staff_id` 等别名）。
8. 群目标订阅全部消息是否受管理员授权限制。

## 5. 与相邻工作流的接口

- WS4/WS5 通过 `DingTalkChannel` 组合：`settingsProvider` 读取设置、`logger` 接入宿主日志、`sink` 接收 `InboundMessage`、`send(outbound)` 消费 core `Outbound`。
- 宿主必须先调用 `probeAuth()`，把返回的 `userId` 作为 `ownerUserId` 注入；缺失时 `start` 抛 `owner-unknown` 并拒绝订阅（这是防回环的硬前提，通道没有行 id 回退）。
- 通道不写 Store；`Outbound` 的幂等键与状态推进仍由 app/Outbox 负责。
- 领域按 `message.id` 幂等；通道会透传重复事件，这是刻意行为（补收窗口可能重复），已在 supervisor 测试中固化。

## 6. 整仓 `format:check` 现状

review round 1 时发现 `docs/PROGRESS.md` 在 WS2 基线（`a7d68d6`）不符合 Prettier；整合方已在 `main` `b69177d` 修复。WS2 分支已 merge `main`，整仓门禁现为绿：

```text
pnpm format:check
  -> All matched files use Prettier code style!
```

WS2 新增/改写的全部文件也通过 Prettier（`src/channel`、9 个 spec、fake fixture、006/009、PR 与测试报告）。

## 7. 自评

| 项                                | 结论                                                                      |
| --------------------------------- | ------------------------------------------------------------------------- |
| 不碰真实 dws / 不泄露消息与 token | 是；全部 fake，auth 只保留布尔与时间，日志脱敏有单测                      |
| 停止无 kill -9 / 订阅可清理       | 是；stdin → SIGTERM → orphaned → best-effort `event stop`                 |
| 未知字段保守可审计                | 是；只输出字段名与白名单值，未知值不落日志                                |
| owner fail-closed / 纯媒体不回复  | 是；无 owner 抛 `owner-unknown` 且不 spawn；媒体-only 以 unsupported 跳过 |
| dryRun 不产生失败语义             | 是；返回 `skipped`，不 spawn，不改 Outbound 状态                          |
| auth userId 不外泄                | 是；仅返回宿主，`redact` 掩码，无日志/持久化路径                          |
| unknown 语义与幂等键              | 是；超时/无回执/未分类禁止重发，缺键不 spawn                              |
| supervisor 不并发、退避有上限     | 是；trace 级断言 start/exit 交替，退避封顶                                |
| 测试非 happy path                 | 是；坏行、超时、重复、抛错、非法目标、降级路径均有覆盖                    |
| 文档区分夹具/真机                 | 是；009 使用 [F]/[H]/[P]/[T1] 标记，006 标注 Windows 待验证               |
| 依赖方向干净                      | 是；`src/channel` 无 `@deepseek-ai/*`，未改其他层                         |
| Windows 可运行                    | 是；cross-spawn、参数数组、UTF-8、`windowsHide`，本机跑通                 |
| 提交规范与工作区                  | 是；6 个 Conventional Commits，最终 `git status --porcelain` 为空         |
