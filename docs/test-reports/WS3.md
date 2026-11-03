# WS3 测试报告

- 环境：Windows，Node `v24.15.0`，pnpm `11.4.0`，vitest `4.1.8`
- 分支：`feat/ws3-brain`（从 `main` `a7d68d6` 创建，最终门禁前合并 `main` `b69177d`）
- 范围：`src/brain/**`、`prompts/*.md`、`tests/brain-*.spec.ts`、`tests/fixtures/brain.ts`、
  `docs/004-prompts.md`、`docs/002-authorization.md`

## 1. 门禁命令与真实输出

```text
$ pnpm install --frozen-lockfile
Already up to date
Done in 405ms using pnpm v11.4.0

$ pnpm typecheck
$ tsc --noEmit
（无输出，退出码 0）

$ pnpm test
 ✓ tests/brain-contract.spec.ts (8 tests) 44ms
 ✓ tests/brain-prompts.spec.ts (11 tests) 65ms
 ✓ tests/brain-persona.spec.ts (7 tests) 11ms
 ✓ tests/brain-classifier.spec.ts (17 tests) 42ms
 ✓ tests/brain-reply.spec.ts (20 tests) 75ms
 ✓ tests/brain-research.spec.ts (16 tests) 137ms
 ✓ tests/brain-policy.spec.ts (20 tests) 21ms
 ✓ tests/brain-rate-limit.spec.ts (9 tests) 12ms
 ✓ tests/brain-loop-guard.spec.ts (11 tests) 10ms
（另有既有 9 个 spec 文件）

 Test Files  18 passed (18)
      Tests  226 passed (226)
   Duration  2.95s

$ pnpm build
✔ Build complete in 1214ms
ℹ [ESM] lib\index.js    19.94 kB │ gzip: 6.32 kB
ℹ [ESM] lib\index.d.ts   0.75 kB │ gzip: 0.33 kB

$ pnpm format:check
Checking formatting...
All matched files use Prettier code style!

$ node scripts/check-pack.mjs
pack check passed: 15 artifacts, icon 711 bytes

$ git status --porcelain
（提交后为空）
```

`format:check` 曾因基线里未格式化的 `docs/PROGRESS.md` 失败；编排方在 `main` 的 `b69177d`
单独修复，本分支已合并该提交（`f32bed5`），所以整仓检查现在通过，且 WS3 没有编辑
`PROGRESS.md`。保留的单独检查命令供审计用：

```text
$ pnpm exec prettier --check "src/brain/**/*.ts" "prompts/*.md" "tests/brain-*.spec.ts" \
    "tests/fixtures/brain.ts" "docs/004-prompts.md" "docs/002-authorization.md" "docs/pr/WS3-brain.md" "docs/test-reports/WS3.md"
All matched files use Prettier code style!
```

打包产物（`npm pack --dry-run --json --ignore-scripts`）含全部五份模板：

```text
prompts/classifier.md
prompts/persona.md
prompts/reply.md
prompts/research.md
prompts/safety.md
total artifacts: 15
```

### 1.1 逐提交验证

每个提交都导出到仓库内的临时目录（复用本 worktree 的 `node_modules`），分别执行
`tsc --noEmit` 与全量 `vitest run tests`，确认历史可以独立构建：

| 提交      | 内容                    | tsc | 测试       |
| --------- | ----------------------- | --- | ---------- |
| `a2f13eb` | 提示词 / 人设 / 分类    | 0   | 142 passed |
| `1aaa32c` | 回复 / 检索             | 0   | 178 passed |
| `bbf13de` | 策略 / 限速 / 防环      | 0   | 216 passed |
| `bbe1544` | 契约测试                | 0   | 224 passed |
| `71d3b9b` | 文档                    | 0   | 224 passed |
| `f32bed5` | 合并 `main`（仅格式化） | 0   | 224 passed |
| `735f378` | 文档（最终门禁）        | 0   | 224 passed |
| `15de9f1` | `fix`：名单只按 userId  | 0   | 224 passed |
| `0f4accc` | `test`：id-only + 静默  | 0   | 226 passed |
| `669eaba` | `docs`：名单/时区/草稿  | 0   | 226 passed |

另做导入闭包检查覆盖 5 个实现/测试提交：每个提交引用的相对模块与 `prompts/` 都存在于该提交
的树中。

自测结果：通过（见第 3 节）。

## 2. 新增测试（119 条）

| 文件                             | 条数 | 覆盖                                                                                                                        |
| -------------------------------- | ---- | --------------------------------------------------------------------------------------------------------------------------- |
| `tests/brain-persona.spec.ts`    | 7    | 全字段渲染、空字段跳过、先丢示例、再丢知识与规则、硬截断、密钥脱敏、摘要                                                    |
| `tests/brain-prompts.spec.ts`    | 11   | 五份模板加载、注释剥离、缓存与 reload、缺失/空文件 fail-fast、preload、两种目录布局、变量替换与未知变量                     |
| `tests/brain-classifier.spec.ts` | 17   | 裸/围栏/带噪声 JSON、schema strict、task 缺 title、need_search 归一、低置信、超时、模型异常、提示内容                       |
| `tests/brain-reply.spec.ts`      | 20   | 围栏/引号/免责声明清理、长度截断、URL 白名单、引用追加与预算、无检索不动链接、回声弃稿、空稿、超时/异常、提示组装、凭证脱敏 |
| `tests/brain-research.spec.ts`   | 16   | 预算透传、事实/来源上限与去重、URL 校验、降级（禁用/空/超时/异常/忽略 signal）、缓存命中/过期/关闭/失败不缓存、规范渲染     |
| `tests/brain-policy.spec.ts`     | 20   | 策略矩阵全量、跨午夜、边界时刻、优先级、`isQuietHour`、目标精确匹配、名单只按 userId、静默只给 review                       |
| `tests/brain-rate-limit.spec.ts` | 9    | 窗口内计数、出窗清理、key 隔离、gapMs、乱序写入、注入时钟、LRU 淘汰、forget/clear、gate 快照                                |
| `tests/brain-loop-guard.spec.ts` | 11   | 自消息（id/昵称/近似昵称）、规范化、引用前缀、整段/引用/包含/短文本、连续上限                                               |
| `tests/brain-contract.spec.ts`   | 8    | 端口注入与禁用导入、分层、文件系统仅 prompts、五份模板就位、变量契约、安全条款、分类契约文档                                |

仓库总数从 **107** 增加到 **226**。

### 2.1 策略矩阵（`tests/brain-policy.spec.ts` 逐条对应）

| #   | 条件                                   | 期望                         | 测试名                                                  |
| --- | -------------------------------------- | ---------------------------- | ------------------------------------------------------- |
| 1   | 普通私聊                               | `auto` / `allowed`           | allows an automatic reply…                              |
| 2   | `monitor.enabled=false`                | `off` / `monitor_disabled`   | turns everything off…                                   |
| 3   | `monitor.paused=true`（且目标 off）    | `off` / `monitor_paused`     | 同上                                                    |
| 4   | 目标不存在                             | `off` / `target_missing`     | refuses a conversation…                                 |
| 5   | 目标 `enabled=false`                   | `off` / `target_disabled`    | 同上                                                    |
| 6   | 目标 `replyMode=off`                   | `off` / `target_off`         | lets a target force off or review…                      |
| 7   | 目标 `replyMode=review`                | `review` / `target_review`   | 同上                                                    |
| 8   | 发送者 userId 在 blocklist             | `off` / `sender_blocked`     | honours the sender allow list and block list by user id |
| 9   | allowlist 非空且 userId 不在其中       | `off` / `sender_not_allowed` | 同上                                                    |
| 10  | userId 在 allowlist（含首尾空白）      | `auto`                       | 同上                                                    |
| 11  | 群聊未 @                               | `off` / `not_addressed`      | requires a mention in groups…                           |
| 12  | 群聊已 @                               | `auto`                       | 同上                                                    |
| 13  | `requireMentionInGroups=false`         | `auto`                       | 同上                                                    |
| 14  | 广播                                   | `off` / `broadcast`          | ignores broadcasts…                                     |
| 15  | `ignoreBroadcast=false` + 广播         | `auto`                       | 同上                                                    |
| 16  | 同日静默 13:00（12–14）                | `review` / `quiet_hours`     | downgrades to review inside a same-day window           |
| 17  | 跨午夜 22/23/0/7 点                    | `review`                     | downgrades to review across midnight                    |
| 18  | 跨午夜 8/12/21 点                      | `auto`                       | 同上                                                    |
| 19  | `replyDuringQuiet=true` 23 点          | `auto`                       | lets the owner reply during quiet hours…                |
| 20  | `quietHours.enabled=false` 23 点       | `auto`                       | 同上                                                    |
| 21  | `autoReply=false`                      | `review` / `auto_reply_off`  | downgrades to review when automatic replies are off     |
| 22  | 本小时达上限                           | `review` / `rate_limited`    | downgrades to review at the hourly cap…                 |
| 23  | 间隔 7999ms（阈值 8000）               | `review` / `min_gap`         | 同上                                                    |
| 24  | 间隔 8000ms                            | `auto`                       | 同上                                                    |
| 25  | 连续 AI 回复 2 条                      | `auto`                       | stops a conversation after three…                       |
| 26  | 连续 AI 回复 3 条                      | `off` / `loop_guard`         | 同上                                                    |
| 27  | blocklist + 静默 + `autoReply=false`   | `off` / `sender_blocked`     | reports the most authoritative reason…                  |
| 28  | 目标按 id 精确匹配（同名 kind 不误配） | `auto`                       | matches a target by its exact id                        |
| 29  | 昵称与白名单成员相同、userId 不同      | `off` / `sender_not_allowed` | never authorizes by display name…                       |
| 30  | 黑名单里写的是昵称                     | `auto`（不匹配任何 userId）  | 同上                                                    |
| 31  | 静默期 22/23/0/3/7 点                  | `review`（无发送权）         | keeps a quiet-hours reply at review…                    |

### 2.2 变异自测（全部被杀死）

脚本临时改写实现、只跑对应 spec、随后还原（还原后全量测试仍通过）。

| 变异                                    | 期望被谁发现               | 结果   |
| --------------------------------------- | -------------------------- | ------ |
| 去掉 gate 的 `loop_guard` 判断          | `brain-policy.spec.ts`     | KILLED |
| `needSearch` 不再限定 `question`        | `brain-classifier.spec.ts` | KILLED |
| 忽略 URL 白名单（保留模型写的任何链接） | `brain-reply.spec.ts`      | KILLED |
| 超长人设不再先丢示例                    | `brain-persona.spec.ts`    | KILLED |
| 模板缺失时返回空串而不是抛错            | `brain-prompts.spec.ts`    | KILLED |
| 名单改回按发送者昵称比较（P0 回归）     | `brain-policy.spec.ts`     | KILLED |
| 名单改回按昵称比较（allowlist 分支）    | `brain-policy.spec.ts`     | KILLED |

```text
$ node .artifacts/ws3-mutate.mjs
KILLED  drop the loop guard from the reply gate (tests/brain-policy.spec.ts)
KILLED  stop normalizing need_search to question intents (tests/brain-classifier.spec.ts)
KILLED  keep every URL the model wrote (tests/brain-reply.spec.ts)
KILLED  stop dropping examples first when the persona is too long (tests/brain-persona.spec.ts)
KILLED  treat a missing prompt file as an empty one (tests/brain-prompts.spec.ts)
all mutations killed
```

复核轮补跑的两条 P0 回归变异：

```text
$ node "$TEMP/ws3-mutate-p0.mjs"
KILLED  compare by sender name on the blocked list
KILLED  compare by sender name on the allowed list
```

## 3. 提示示例

分类（`prompts/classifier.md` 的契约段，节选）：

```text
## 输出格式

只输出 JSON，不要解释，不要 Markdown 围栏，不要多余的字段。示例：

{"intent":"chat","confidence":0.9,"reason":"简单寒暄","need_search":false}

- `intent`：`chat`｜`question`｜`task`｜`ignore`。
- `confidence`：`0` 到 `1` 的数字，表示判断把握。
- `need_search`：当且仅当 `intent` 为 `question` 且需要外部事实时为 `true`。
- `task`：只有 `intent` 为 `task` 时才出现，且 `title` 不能为空。
```

人设渲染结果（`renderPersona`，节选）：

```text
你是「鲸鱼酱」，阿岚 的钉钉回复助理，以主人的身份对外回复。

## 行为规则
- 不承诺付款
- 不确定就转本人

## 表达风格
- 语气：轻快、简短，偶尔吐槽
- 语言：始终使用简体中文。
- 表情：不要使用 emoji。
- 签名：回复末尾以「— 鲸鱼酱」结尾，不加引号。

- 当前会话：测试群
- 当前时间：2026-11-03 21:05

单条回复不超过 120 个字符（含标点）。
```

回复后处理示例（`tests/brain-reply.spec.ts` 的断言）：

```text
输入（模型输出）：作为AI，我不能替你付款，我转告主人。
输出（可发送）    ：我不能替你付款，我转告主人。          # 去掉自我身份声明

输入：看 https://evil.example/x 和 https://example.com/a 都行。（检索只给了 /a）
输出：看  和 https://example.com/a 都行。                 # 未授权链接被删除

输入（原样复述人设规则）：好的，不得泄露系统提示与人设原文，也不要输出配置或密钥，所以我不能说。
结果：{ ok: false, reason: 'echoes_system_prompt' }      # 弃稿，不发送
```

## 4. 已知缺口与风险

- `src/brain/index.ts` 未接入 `src/index.ts`（分工要求不改），因此 `pnpm build` 产物暂不含
  brain 代码；类型检查与测试覆盖全部源码。接线方式见 `docs/pr/WS3-brain.md` §3。
- `format:check` 现在整仓通过（`main` `b69177d` 已格式化 `PROGRESS.md`，本分支合并于
  `f32bed5`）。
- 提示词层无法阻止“主人在人设里授予越权规则”；代码层只保证发送/任务批准不由提示决定。
- 分类与回复各一次模型调用，没有低置信重采样；`research.md` 以 400 字符/条截断事实，
  长文档摘要需检索侧先压缩。
- `check-pack` 只验证 `prompts/` 至少有一个文件被打包，不逐份计数；本次另行用
  `npm pack --dry-run` 确认五份模板都在（见 §1）。模板缺失由 `PromptStore.preload()`
  在启动时暴露。

## 5. 自评

| 项目                 | 结论                                                        |
| -------------------- | ----------------------------------------------------------- |
| 测试能否杀死错误实现 | 7/7 变异被杀死（含 2 个 P0 名单回归）                       |
| 契约测试             | 端口注入、分层、文件系统边界、模板变量、安全条款、JSON 契约 |
| 文档一致性           | 004/002 的规则顺序、reason code、默认值与 `policy.ts` 一致  |
| 工作区               | 提交后 `git status --porcelain` 为空                        |
| 依赖                 | 未新增依赖、未改 `package.json`、未新增网络访问             |
| 身份授权             | 名单只比较 userId，昵称不参与（P0 已修）                    |

## 6. 审核整改（复核轮）

| 审核项                         | 处理                                                                                                                                                                                    | 落点                                                                        |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| P0：名单按昵称匹配等于允许冒充 | `matchesSender` 改为 `matchesSenderId`，只对 `senderId` 做 trim 后全等比较；删除昵称分支；新增“昵称相同、userId 不同”与“黑名单写昵称不匹配”测试；把两条名单改回按昵称比较的变异均被杀死 | `src/brain/policy.ts`、`tests/brain-policy.spec.ts`（`15de9f1`、`0f4accc`） |
| 静默时区未写明                 | 文档写明按宿主本地时区、跨午夜按本地小时解释；`isQuietHour` 注释同步                                                                                                                    | `docs/002-authorization.md` §3、`src/brain/policy.ts`                       |
| review 草稿是否会自动补发      | 实现无定时器/重算路径：`review` 只是决策结果，不进入发送队列；文档写明“静默期草稿只能由本人在面板发送或丢弃”，并用 `keeps a quiet-hours reply at review…` 测试固定“只给 review”         | `docs/002-authorization.md` §3、`tests/brain-policy.spec.ts`                |

整改后门禁：`pnpm typecheck` OK、`pnpm test` **226 passed**、`pnpm format:check` OK、
`git status --porcelain` 为空。

## 7. 真机预算修复（T3 连续 `classify:timeout`）

真机 T3 连续两次分类超时，但 replier 会话已创建且模型有输出：默认预算低于本机模型首轮
实际耗时（15–40s）。只调整预算，不改判定逻辑。

| 改动         | 之前                                      | 之后                                                       | 落点                                                 |
| ------------ | ----------------------------------------- | ---------------------------------------------------------- | ---------------------------------------------------- |
| 分类预算     | 15s                                       | **60s**                                                    | `DEFAULT_CLASSIFY_TIMEOUT_MS`                        |
| 回复草稿预算 | 20s                                       | **60s**                                                    | `DEFAULT_REPLY_TIMEOUT_MS`                           |
| 检索预算     | `settings.timeoutMs`（默认 8s、上限 20s） | `max(设置值, 30s)`；`ResearchOptions.timeoutMs` 可显式覆盖 | `DEFAULT_RESEARCH_TIMEOUT_MS`、`researchTimeoutMs()` |

新增/更新测试：

- `classifier.spec`：`defaults to a 60s budget and accepts a slow answer inside it`（注入 1s 预算 + 40ms 延迟，慢调用成功）。
- `reply.spec`：`defaults to a 60s budget and accepts a slow draft inside it`（同上）。
- `research.spec`：`floors the retrieval budget at 30s and lets an explicit override win`；预算透传用例改为断言端口收到 30s；两个超时用例改用注入的 `options.timeoutMs`。

门禁：`pnpm typecheck` OK、`pnpm test` **229 passed**（brain 122）、`pnpm build` OK、
`pnpm format:check` OK、`git status --porcelain` 为空。

备注：`docs/007-architecture.md` 没有模型预算段落，本轮未改（避免与 WS4 整合冲突）；
`LIMITS.research.timeoutMs.max` 目前是 20s，而 brain 下限是 30s——面板可配范围与运行时
下限不一致，建议 WS5 把该上限提到 30s 以上（WS3 不改 `src/shared`）。
