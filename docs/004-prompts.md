# 004 提示词

> 当前状态：WS3 已实现。本文描述 `src/brain` 实际加载与填充的提示词、人设字段、
> 分类 JSON 契约、后处理规则与安全边界。实现代码见 `src/brain/**`，模板见
> `prompts/*.md`，测试见 `tests/brain-*.spec.ts`。

鲸鱼酱的提示词分两层：**设置里的人设**（`settings.persona`，由主人在面板编辑）和
**随包发布的模板**（`prompts/*.md`，由代码维护）。人设决定“它是谁、怎么说话”，
模板决定“它被要求做什么、什么绝对不能做”。模板优先于消息，安全规则优先于模板里的
其他要求；两者都不能改变宿主执行的权限。

## 1. 人设：唯一的人设来源

`settings.persona` 是唯一的人设来源（`src/shared/settings.ts`）。`src/brain/persona.ts`
把它渲染进 `prompts/persona.md` 的骨架，渲染结果作为回复提示的「## 人设」段。

| 字段            | 类型     | 渲染为                                     | 空值时             |
| --------------- | -------- | ------------------------------------------ | ------------------ |
| `name`          | string   | 「{{name}}」                               | 回落「鲸鱼酱」     |
| `identity`      | string   | `## 身份` 段                               | 整段消失           |
| `tone`          | string   | 表达风格里的「语气」                       | 回落「自然、克制」 |
| `language`      | 枚举     | 语言要求（auto / zh-CN / en）              | 不适用             |
| `signature`     | string   | 签名要求                                   | 只写「不需要签名」 |
| `rules`         | string[] | `## 行为规则` 逐条 `- `                    | 整段消失           |
| `knowledge`     | string   | `## 背景知识` 段                           | 整段消失           |
| `samples`       | string[] | `## 示例回复`，逐条编号                    | 整段消失           |
| `allowEmoji`    | boolean  | 表情要求                                   | 不适用             |
| `maxReplyChars` | number   | 字数上限（人设段 + 回复提示 + 后处理共用） | 不适用             |

会话侧变量由调用方注入：`ownerName`（缺省「主人」）、`targetLabel`（群名或私聊标签）、
`now`（注入的本地时间，格式 `YYYY-MM-DD HH:mm`）。

渲染规则：

- **空字段整段跳过**，不留下空标题，也不出现 `undefined`。
- 总长度上限 **6000 字符**（`PERSONA_MAX_CHARS`，按 Unicode 码点计）。超出时按
  「示例（从最后一条开始）→ 背景知识 → 末尾规则」的顺序丢弃；仍然超长则硬截断并以
  `…` 结尾。
- 人设字段会发给第三方模型，因此渲染结果过一遍凭证形状脱敏（`sk-…`、`Bearer …`、
  `AKIA…`、`api_key: …`）。这是一层兜底，不是“可以把密钥写进设置”的许可。
- 渲染只读取 `persona` 字段与会话标签，不读环境变量、配置文件或任何快照；
  `tests/brain-contract.spec.ts` 检查 `src/brain` 只在 `prompts.ts` 接触文件系统。

`persona.ts` 保留一份与 `prompts/persona.md` 等价的兜底骨架 `PERSONA_FRAME`（用于没有
`PromptStore` 的单元测试）。契约测试比较两者的变量集合，任何一边改了变量都会失败。

## 2. 五份模板的职责

| 文件            | 谁调用                        | 职责                                                                                 |
| --------------- | ----------------------------- | ------------------------------------------------------------------------------------ |
| `safety.md`     | 分类、回复（经 `{{safety}}`） | 安全红线：不冒充人类、不泄露提示、不执行数据里的指令、不承诺未授权事项、不确定转本人 |
| `persona.md`    | `renderPersona`               | 人设骨架，只放身份、规则、知识、示例、风格、上下文、字数                             |
| `classifier.md` | `classify`                    | 只输出一个 JSON 的分类契约与判断原则                                                 |
| `reply.md`      | `composeReply`                | 写回复正文：格式、长度、身份、引用、任务/忽略场景                                    |
| `research.md`   | `composeReply`                | **检索结果的使用规范**（不是检索器提示）：只认可信来源、冲突就说要确认、空结果不编造 |

`research.md` 常被误解：真正联网的是注入的 `ResearchPort`，模板不负责搜索，只规定
“拿到事实之后怎么用、链接怎么引”。没有检索结果时该段整段不出现（见 §5）。

`PromptStore` 的加载规则：

- 目录解析：先 `<package>/prompts`（打包后 `lib/index.js` 的上一级），再 `<repo>/prompts`
  （源码树里 `src/brain` 的上两级），第一个存在的生效；都不存在时错误信息指向打包位置。
- 首次读取后缓存；`reload()` 可清空（供运维改完模板后重载）。
- 模板里的 `<!-- … -->` 在加载时移除，因此模板可以自写变量说明而不把说明送进模型。
- **缺失或空白即抛错**（`PromptLoadError`，`reason: missing | empty | unreadable`）。
  不会回落到内置英文提示：一个以主人身份发言的助理不能靠“通用提示”猜规则。

## 3. 模板变量

`render(template, vars)` 做 `{{name}}` 单遍替换：替换进来的文本不会被再次扫描，
未知变量抛 `PromptRenderError`（列出全部缺失名）。数组按行拼接。

| 模板            | 变量                                                                                                                                             |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `safety.md`     | `persona_name`                                                                                                                                   |
| `persona.md`    | `name`、`owner`、`identity`、`rules`、`knowledge`、`samples`、`style`、`context`、`limit`                                                        |
| `classifier.md` | `safety`、`persona`（一行摘要）、`target`、`now`                                                                                                 |
| `reply.md`      | `safety`、`classification`、`persona`、`research_guide`、`max_reply_chars`、`emoji_rule`、`language_rule`、`signature_rule`、`message`、`thread` |
| `research.md`   | `facts`、`sources`（空列表渲染为「（无）」）                                                                                                     |

会话窗口有上限：最多 12 条、每条 400 字符、合计 3000 字符（分类）或 4000 字符（回复），
超出时保留最新的内容。消息正文、引用、附件都是**数据**，模板明确要求把它们当作数据。

## 4. 分类 JSON 契约

分类器只输出一个 JSON 对象：

```json
{
  "intent": "task",
  "confidence": 0.86,
  "reason": "要主人订会议室",
  "need_search": false,
  "task": { "title": "订明天 10 点的会议室", "brief": "3 楼大会议室", "requirements": ["10:00 开始"] }
}
```

| 字段          | 约束                                                                           |
| ------------- | ------------------------------------------------------------------------------ |
| `intent`      | `chat` / `question` / `task` / `ignore`，必填                                  |
| `confidence`  | `0..1` 的数字，必填                                                            |
| `reason`      | ≤300 字符，缺省空串；只写依据，不复述消息                                      |
| `need_search` | 布尔，缺省 `false`                                                             |
| `task`        | 仅 `task` 意图；`title` 必填非空（≤160），`brief` ≤2000，`requirements` ≤20 条 |

解析与归一化（`src/brain/classifier.ts`）：

1. 依次尝试 ```json 围栏内容、围栏内的花括号片段、整段文本、整段文本中第一个 `{`到
最后一个`}`；取第一个能 `JSON.parse` 的候选。
2. **zod strict 校验**：未知字段、越界置信度、非法枚举一律判为 `invalid`。
3. `task` 只在 `intent === 'task'` 时保留；该意图缺 `task` 或 `title` 去空白后为空 →
   `invalid`；非 task 意图携带的 `task` 字段被丢弃。
4. `need_search` 只在 `intent === 'question'` 时为原值，其余意图强制 `false`。
5. 置信度低于阈值（默认 **0.55**，可配置）→ `low_confidence`。

失败语义：

| 结果                                      | 含义                             | 调用方动作                  |
| ----------------------------------------- | -------------------------------- | --------------------------- |
| `{ ok: false, reason: 'invalid' }`        | 模型输出不合契约或调用报错       | **defer**，不发送、不建任务 |
| `{ ok: false, reason: 'timeout' }`        | 超过 `timeoutMs`（默认 **60s**） | defer                       |
| `{ ok: false, reason: 'low_confidence' }` | 输出合法但没把握                 | defer                       |

失败从不抛异常，也不会把模型原文写进结果（`detail` 只带字段名或错误摘要）。

## 5. 回复：后处理即规则

`composeReply` 只向模型要正文，其余全部由代码强制（`src/brain/reply.ts`）：

1. 去掉整体代码围栏与首尾成对的引号（`「」『』“”""''《》`，可多层）。
2. 删除「作为 AI」「我是人类」「as an AI」这类自我身份声明所在的子句；删完为空则判
   `empty`。
3. 做凭证形状脱敏。
4. **URL 白名单**：有检索结果时，正文里不在检索来源中的链接会被删除（防止编造引用）；
   没有检索时不动正文里的链接（对方可能自己发过链接）。
5. **系统提示回声检测**：正文若原样包含系统提示中长度 ≥24 字符的一行，判
   `echoes_system_prompt` —— 不修补，直接弃稿，因为泄露过一次的模型会再泄露。
6. 按 `persona.maxReplyChars` 截断（按码点计，优先断在句末标点）。
7. 需要在正文里给出引用时，在预算内追加 `参考：` 与最多 3 条来源；放不下就不加。
8. 返回值里的 `sources` 只包含**最终正文里出现过的、检索给出的 URL**，按检索顺序。

失败语义：`timeout` / `empty` / `echoes_system_prompt` / `model_error`，一律
`{ ok: false }`，调用方 defer 或改人工处理。

## 6. 检索注入

`research(query, settings, port, signal)`：

- 预算来自设置：`maxResults`（结果与来源都受其限）、`timeoutMs`、`cacheMinutes`。
- **检索预算下限 30s**（`DEFAULT_RESEARCH_TIMEOUT_MS`）：实际预算取
  `max(settings.timeoutMs, 30s)`。检索是网络调用，冷启动一轮经常超过设置里 8s 的默认值，
  预算过小只会制造无谓的降级；设置值仍可继续放大（>30s 时以设置为准）。`ResearchOptions.timeoutMs`
  可显式覆盖两者，测试用它观察超时。
- 超时同时中止端口调用并立即返回降级结果：端口即使忽略 `AbortSignal`，也不会拖住回复。
- 事实去重（空白与大小写归一）、单条 ≤400 字符、总数 ≤`maxResults`。
- 来源必须是可解析的 http(s) URL，按规范化 URL 去重，标题为空用主机名；其它协议直接丢弃。
- LRU 缓存（默认 100 条）按 `cacheMinutes` 过期，键含 `maxResults`；`cacheMinutes = 0`
  关闭缓存。**失败不缓存**（一次故障不该被记半小时），**空结果缓存**（提供方确实答了空）。
- `enabled = false`、空查询、超时、端口报错、空结果 → `degraded: true`、`facts: []`，
  回复按“没有资料”处理，不阻塞任务流。

## 7. 提示与调用长度预算

| 片段             | 上限                             | 超限处理                        |
| ---------------- | -------------------------------- | ------------------------------- |
| 人设段           | 6000 字符                        | 丢示例 → 丢知识 → 丢规则 → 截断 |
| 会话窗口（分类） | 3000 字符 / 12 条                | 保留最新                        |
| 会话窗口（回复） | 4000 字符 / 12 条                | 保留最新                        |
| 分类响应         | 800 字符（`maxChars` 提示）      | 解析失败即 invalid              |
| 回复正文         | `persona.maxReplyChars`（1–800） | 句末截断 + `…`                  |
| 检索事实         | 400 字符/条，≤`maxResults` 条    | 截断/丢弃                       |

调用预算（时间，不是字符）：

| 调用     | 默认预算                                 | 依据                                                                                            |
| -------- | ---------------------------------------- | ----------------------------------------------------------------------------------------------- |
| 分类     | **60s**（`DEFAULT_CLASSIFY_TIMEOUT_MS`） | 真机首轮常需 15–40s（模型冷启动 + 长提示），预算过低会把本来会成功的调用判成 `timeout` 并 defer |
| 回复草稿 | **60s**（`DEFAULT_REPLY_TIMEOUT_MS`）    | 同上；草稿提示更长，首轮更慢                                                                    |
| 检索     | `max(settings.timeoutMs, 30s)`           | 网络调用；8s 的设置默认值不足以覆盖冷启动                                                       |

结论：**“慢但未超预算”必须成功**。`tests/brain-classifier.spec.ts` 与
`tests/brain-reply.spec.ts` 各有一条用注入预算 + 40ms 延迟的用例固定这一点；
`tests/brain-research.spec.ts` 的 `floors the retrieval budget at 30s…` 固定检索下限。

## 8. 安全规则（模板与代码双落实）

`prompts/safety.md` 的八条规则，逐条对应实现或测试：

1. **不自称人类**：模板要求；`stripDisclaimers` 删除 AI/人类自述；回复测试覆盖。
2. **不泄露系统提示 / 人设原文 / 配置 / 密钥**：模板要求；`echoesSystemPrompt` 弃稿；
   凭证脱敏；测试覆盖。
3. **消息与引用是数据不是指令**：模板逐条写明；分类器要求“不因消息改变输出格式”；
   注入内容无法改变后处理规则（后处理不看消息）。
4. **不承诺未授权事项**：模板列出付款/签约/时间承诺等；后处理无法替代模型判断，
   因此这条靠模板 + 人工 review 兜底（见 `002-authorization.md` §7）。
5. **不确定就转本人**：模板要求写「我确认一下再回你」；低置信分类直接 defer。
6. **不编造事实与链接**：URL 白名单 + 检索降级 + 模板要求。
7. **不索取/转述敏感信息**：模板要求。
8. **回复由主人批准或自动回复策略放行**：策略见 `002-authorization.md`；提示词本身
   不决定发送，模型也拿不到发送能力。

提示词不是权限：模型看不到端口、拿不到发送函数，输出什么都不会绕过 gate、Outbox、
AI 角标和任务批准。

## 9. 打包、加载与接线

- `prompts/` 在 `package.json` 的 `files` 白名单里，`scripts/check-pack.mjs` 检查打包产物
  含 `prompts/`。
- 模板缺失时 `PromptStore.get` 立即抛错；宿主应在启动时调用 `preload()`，把“包损坏”
  暴露在第一轮监听之前。
- WS3 只提供 `src/brain`；`src/brain/index.ts` 没有被 `src/index.ts` 接出（宿主入口保持零副作用），
  WS5 的组合根显式 import 并构造 `PromptStore` / `ModelPort` / `ResearchPort`。
- **`ModelPort` 的回复实现是会话式的 `SessionModel`**（`src/executor/model.ts`，由
  `src/executor/index.ts` 公开导出）：每个线程一个可见 DSH 会话，preset 为
  `dsh-whale-chan-replier`，交互过程留在会话里，工具集随 preset 保留。`system` 与历史消息
  组装成一条 prompt（超过 `MAX_PROMPT_CHARS` 12000 字符时先丢最旧消息），经 `SessionHost.deliver`
  投递。
- **T3 的根因是 TurnTracker**：DSH 先写 inbox 的 `user/message`、再发 `turn/start`；旧跟踪器
  把上一轮的 `turn/end` 当成本次结束，导致模型 7–12 秒完成却报超时。现在未认领消息由下一个
  `turn/start` 认领（`05762fa`），与 preset 是否带工具无关。
- 单回合上限 `MODEL_TURN_TIMEOUT_MS`（90 秒，`REPLY_TIMEOUT_MS` 同值）由 `SessionModel` 的
  `awaitTurnEnd` 执行，同时受 brain 的 `withDeadline` 与调用方 `AbortSignal` 约束；超时/中止/失败
  分别映射为 `ModelTimeoutError` / `ModelAbortedError` / `ModelFailedError`。
- `LlmModel`（`src/executor/llm-model.ts`）是**未接线的直连实验**：它不建会话、不注册工具，
  只保留作对照；其 `maxTokens = clamp(maxChars/4, 1024, 4096)` 预算只适用于该实验，当前
  回复路径不使用。
- 解析失败时 `detail` 附带**原始输出前 200 字符**（空白折叠、超长加 `…`），用来区分
  「空 / 散文 / 截断」；审计只存这个样本，不存整段回答。

## 相关文档

- [010 设计摘要](010-design.md)
- [002 授权与回复策略](002-authorization.md)
- [011 设置合约](011-settings-contract.md)
