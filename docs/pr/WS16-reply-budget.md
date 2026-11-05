# WS16 · 回复预算与单次自动重试

- 分支：`fix/ws16-reply-budget`（worktree `wt-ws16`）
- 基线：`main` `38e84df`（v0.5.0 发布后的坐标提交）
- 提交：`18ac297`（引用预算与正文分离、`sanitized_empty`）、`c0d4b39`（`reply.autoRetry` 单次重试、`notRetryable`）
- 状态：实现与自动化验收完成；**尚未合并、尚未打 tag**；文档与版本收口由 coordinator 提交。**未做真实账号验收**
- 关联：[004 提示词](../004-prompts.md)、[005 面板](../005-panel.md)、[007 架构](../007-architecture.md)、[011 设置合约](../011-settings-contract.md)、[012 发布](../012-release.md)、[兼容矩阵](../compatibility.md)、[WS16 验收报告](../test-reports/WS16.md)

## 1. 现象与证据链

一条需要联网检索的群消息（决策 `decision-3778ba91`）没有发出任何回复，决策状态为 `deferred`、`reason` 为 `compose:empty`；审计里只有一条 defer，没有发送记录。

把这条决策的三段证据拼起来，结论与“模型没说话”相反：

| 证据       | 内容                                                                                                            |
| ---------- | --------------------------------------------------------------------------------------------------------------- |
| 决策       | `decision-3778ba91` → `deferred`，`reason = compose:empty`                                                      |
| 检索结果   | 3 条来源，标题较长；拼成 `参考：` 脚注后共 **362 字符**（按码点计）                                             |
| 人设上限   | `persona.maxReplyChars = 300`（默认值）                                                                         |
| 模型输出   | 第 6 轮（turn 6）**产出了正文**；`composeReply` 的 `detail` 里保留了输出样本，不是空串                          |
| 本地后处理 | 旧 `sanitizeReply` 先算 `bodyBudget = 300 − 362 − 2 = −64`，`bodyBudget <= 0` 时直接把正文置空，最终文本为 `''` |

也就是说：模型给了正文，**是本地预算算法把正文清空的**；清洗结果为空后统一报 `empty`，调用方只能 defer，群聊于是静默失败。

## 2. 根因

1. **预留顺序错了**：旧实现先为引用脚注从 `persona.maxReplyChars` 里扣长度（还额外扣 2 个换行），再截正文。脚注比正文上限长时，正文预算为负，正文被整体丢弃——引用是“证据”，却有权吃掉“回复”本身。
2. **脚注没有自己的边界**：引用长度只受 `maxReplyChars` 间接约束，没有独立上限；3 条来源就能超过默认 300。
3. **失败词太粗**：模型真空输出与“模型有输出但被清洗为空”都报 `empty`，调用方无法判断“再试一次有没有意义”，也就没法安全地自动重试。

## 3. 三条产品决策

| #   | 决策                                                                                                                                                                                                                                                                                | 理由                                                                                                                                       |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | **正文独占 `persona.maxReplyChars`**；引用脚注有独立上限 `CITATIONS_MAX_CHARS = 600` 码点，逐行取舍（整行放得下就保留、放不下就跳过，`citations: 'trimmed'`），一条都放不下则整体丢弃（`'dropped'`），绝不切半条 URL，也绝不因此截短或清空正文                                      | 回复正文是产品交付物，引用是证据；证据可以少几条，回复不能没有。600 码点约为默认正文上限的两倍，够放 3 条常规来源                          |
| 2   | **拆失败词**：模型输出本身空白 → `empty`；模型有输出、但清洗后正文为空 → `sanitized_empty`（带 `detail` 输出样本）                                                                                                                                                                  | 两者对调用方的含义不同：后者值得再试一次，前者多半是路由/模型问题；`detail` 保留排查线索，但不进聊天                                       |
| 3   | **`reply.autoRetry`（默认开）最多重试一次**：`empty`/`sanitized_empty`/`model_error` 重试一次，第二次仍失败才 `defer`；`timeout`/`echoes_system_prompt` 不重试；重试只累加 `decisions.attempts` + 写 host 日志，不覆盖分类 `reason`、不产生新领域事件；**`defer` 仍是唯一失败终态** | 偶发空输出是真实存在的失败模式，多一次调用能救回一部分；但重试必须有界（1 次）、可关（设置）、可解释（日志），不能变成隐藏的循环或状态迁移 |

## 4. 实现要点（文件级）

| 文件                                  | 改动                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/brain/reply.ts`                  | 新增 `CITATIONS_MAX_CHARS = 600`；`buildCitations` 返回行数组、`renderCitations` 拼装、`fitCitations` 负责“逐行取舍/整体丢弃”（超长行只跳过自己，不连坐后面的短行）；`SanitizeResult` 新增 `citations: 'kept' \| 'trimmed' \| 'dropped'`；`sanitizeReply` 改为 `body = truncateSentence(text, maxChars)` 后独立 `fitCitations`；`composeReply` 在清洗前先判模型输出是否空白（`empty`），清洗后为空判 `sanitized_empty`；新增 `isRetryableComposeFailure`（`empty`/`sanitized_empty`/`model_error` 为真） |
| `src/brain/types.ts`                  | `ComposeFailureReason` 增加 `'sanitized_empty'`                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `src/app/effects-chat.ts`             | 新增 `MAX_COMPOSE_RETRIES = 1`；`compose` 失败时若“可重试 + `settings.reply.autoRetry` + `decision.attempts < 1`”→ `engine.recordReplyAttempt` + `logger.warn('compose retry 1/1 for decision <id> after …')` + 重新 `enqueue('compose', …, { research })`；否则 `defer(decisionId, 'compose:<失败词>')`                                                                                                                                                                                                 |
| `src/app/pipeline.ts`、`runtime.ts`   | 把可选的 `ExecutorLogger` 透传给回复路径的 effects；没有 logger 时只跳过日志，不影响重试                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `src/core/engine.ts`                  | 新增 `recordReplyAttempt(decisionId)`：只接受 `classified`，`attempts + 1`，保留 `reason`，不发领域事件（重试不是状态迁移）                                                                                                                                                                                                                                                                                                                                                                              |
| `src/core/errors.ts`                  | 新增 `notRetryable: ['refused', 'Only a classified decision can record a compose retry']`，只由 `recordReplyAttempt` 使用                                                                                                                                                                                                                                                                                                                                                                                |
| `src/shared/fields.ts`、`settings.ts` | `reply.autoRetry`（boolean，默认 `true`），追加在 `reply` block 末尾；`docs/011-settings-contract.md` 由 `pnpm docs:settings` 重新生成（58 字段）                                                                                                                                                                                                                                                                                                                                                        |
| `locale/zh.json`、`locale/en.json`    | 新增 `settings.reply.autoRetry.label/hint`（各 2 个 key）；改写 `settings.persona.maxReplyChars.hint` 为“只约束正文，末尾引用链接不计入”                                                                                                                                                                                                                                                                                                                                                                 |
| `docs/011-settings-contract.md`       | 生成器产出：`reply.autoRetry` 行 + 字段总数 58；**未手改**                                                                                                                                                                                                                                                                                                                                                                                                                                               |

## 5. 测试清单

全量 **894 tests / 63 files**（基线 v0.5.0：880 / 63；+14 条、文件数不变）。

| 文件                                        | 条数 | 新增/变化                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------------------- | ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tests/brain-reply.spec.ts`                 | 28   | +7：引用不再吃正文预算；362 字符脚注 + 300 上限时正文完整保留；脚注超 600 码点时逐行取舍（`trimmed`，放不下的第三条 URL 不出现，`sources` 同步收窄）；超长行只跳过自己、后面的短行仍然保留；一条都放不下整体丢弃（`dropped`）；正文只按 `maxChars` 截断且脚注追加在正文之后；`isRetryableComposeFailure` 的五个失败词真值表；`composeReply` 区分 `empty` 与 `sanitized_empty`（围栏、身份声明） |
| `tests/pipeline-chat.spec.ts`               | 23   | +5：空草稿重试一次后发送第二稿（`attempts=1`、`reason` 仍是分类原因、回复调用 2 次）；清洗为空的草稿同样重试；第二次仍空 → `defer` 且 `reason=compose:empty`；`autoRetry=false` 时只调用 1 次直接 defer；长引用场景正文完整发出（总长 > 300）                                                                                                                                                   |
| `tests/core-engine.spec.ts`                 | 29   | +1：`recordReplyAttempt` 在 `queued`/`deferred`/`drafted` 状态抛 `notRetryable`；`classified` 下 `attempts` 递增且 `reason` 保持不变                                                                                                                                                                                                                                                            |
| `tests/core-invariants.spec.ts`             | 16   | 条数不变：错误码分类表补 `notRetryable: 'refused'` 断言                                                                                                                                                                                                                                                                                                                                         |
| `tests/settings.spec.ts`                    | 12   | +1：`SETTINGS_DEFAULTS.reply.autoRetry === true`、schema 默认 `true`、显式 `false` 生效、非布尔与未知字段被 strict 拒绝                                                                                                                                                                                                                                                                         |
| `tests/__snapshots__/settings.spec.ts.snap` | —    | 设置默认值快照补 `"autoRetry": true`                                                                                                                                                                                                                                                                                                                                                            |

## 6. 兼容与回退

- **无 schema / API / 依赖变化**：`SCHEMA_VERSION` 仍为 2；管理 API 仍 21 条；`engines.dsh` 与 `dsh.compatibility` 不变；没有新增依赖，也不需要迁移脚本。
- **设置字段 57 → 58**：`reply.autoRetry` 带默认值，旧设置行读取时自动补 `true`；`PUT settings/reply` 的块内深合并语义不变。
- **行为变更（需要告知主人）**：① 正文不再被引用脚注挤空，此前因长引用静默失败的消息会开始正常回复；② 默认开启一次自动重试，失败时会多一次模型调用（只一次）；③ `sanitized_empty` 是新失败词，旧版本不认它。
- **回退安全**：回到 v0.5.0 可打开同一个 `state.db`；`reply.autoRetry` 对旧 schema 是未知字段，v0.5.0 启动时会把整个 `reply` block 回退默认并记 warning——回退前先记录该 block 的自定义值，回退后重新保存。回退后引用重新挤占正文预算、失败不再自动重试。
- **不重放历史**：本版不修复、不重发旧的 `deferred` 决策。

## 7. 未做真机验收

本版只有单元测试与假 `dws` 夹具证据，**没有**在真实钉钉账号上触发过：

- 真实模型 + 真实来源标题长度下的引用逐行取舍/丢弃（单测用的是构造来源）；
- `sanitized_empty` 与自动重试在真实模型上的第二稿差异；
- `model_error` 的端到端重试（单测只覆盖 `empty` 与 `sanitized_empty` 的重试路径，`model_error` 由 `isRetryableComposeFailure` 真值表间接覆盖）；
- 重试的 host 日志在真实运行中的可读性（日志只写失败词，不写消息正文）。

真机清单与验收口径见 [012 发布](../012-release.md) §6 与 [WS16 验收报告](../test-reports/WS16.md)。
