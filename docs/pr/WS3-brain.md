# WS3 · 提示词、分类、检索与回复策略

- 分支：`feat/ws3-brain`（从 `main` `a7d68d6` 创建）
- 范围：`src/brain/**`、`prompts/*.md`、`tests/brain-*.spec.ts`、`tests/fixtures/brain.ts`、
  `docs/004-prompts.md`、`docs/002-authorization.md`
- 不做：真实模型接入、真实检索、任何消息发送、HTTP 路由、面板 UI、设置持久化、执行器；
  未改 `src/core`、`src/app`、`src/shared`、`src/client`、`src/index.ts`、`package.json`、
  `cordis.patch.yml`、`docs/007-architecture.md`

## 1. 目标

把「鲸鱼酱」回复链路的**决策与文本层**做成一个可单测、可注入、零网络、零宿主依赖的模块：

1. 提示词与消息分离：五份模板随包发布，加载失败立即失败；
2. 分类严格：一个 JSON 契约，失败可兜底（defer 而不是乱发）；
3. 回复安全：不泄露系统提示/人设原文、不自称人类、不编造链接；
4. 策略可解释：auto / review / off，稳定 reason code，覆盖静默跨午夜、限速、防环；
5. 检索有预算、缓存与降级；
6. 端口注入，测试全部用 stub，不引入新依赖（只用已有的 `zod`）。

## 2. 模块

| 文件            | 职责                                                                               |
| --------------- | ---------------------------------------------------------------------------------- |
| `types.ts`      | 端口（`ModelPort`/`ResearchPort`/`CounterStore`）、结果类型、gate 输入输出、提示名 |
| `deadline.ts`   | 统一超时：链接调用方 signal、到点 abort 端口、迟到拒绝不成为 unhandled rejection   |
| `format.ts`     | 归一化、码点截断、句末截断、会话窗口裁剪、凭证形状脱敏、本地时间格式               |
| `prompts.ts`    | `PromptStore`（目录解析/缓存/HTML 注释剥离/fail-fast）、`render` 单遍替换          |
| `persona.ts`    | 人设渲染、空字段跳过、6000 上限下的降级顺序、单行摘要                              |
| `classifier.ts` | JSON 提取、zod strict 校验、归一化、置信度阈值、超时                               |
| `reply.ts`      | 回复提示组装、围栏/引号/免责声明清理、URL 白名单、回声检测、截断、引用             |
| `research.ts`   | 预算、LRU 缓存、事实/来源去重、降级、检索使用规范渲染                              |
| `policy.ts`     | 纯函数 `gateReply`，16 条规则的固定顺序                                            |
| `rate-limit.ts` | `SlidingWindowCounter`（内存、按 key 裁剪、注入时间）                              |
| `loop-guard.ts` | `isSelf` / `isEcho` / `consecutiveCap`                                             |

`src/brain` 的依赖只有 `src/shared` 的**类型**（`import type`）与 `node:fs`（仅
`prompts.ts`）。没有 `@deepseek-ai/*`、没有 `node:http(s)`、没有 `src/core` 运行时依赖；
`tests/brain-contract.spec.ts` 用源码扫描把这三条钉住。

## 3. 与 WS4 的端口假设（需要 WS4 遵守）

1. **接线**：`src/brain/index.ts` 尚未被 `src/index.ts` 导入（不得改 `src/index.ts`）。
   WS4 需要 `export * from './brain/index.ts'` 或显式构造 `PromptStore` / `ModelPort` /
   `ResearchPort` / `SlidingWindowCounter`。打包后 `prompts/` 位于 `lib/` 的上一级，
   已在 `package.json` 的 `files` 中，`check-pack` 会验证。
2. **`ModelPort`**：`complete({ system, messages, maxChars? }, signal)`，只发 user 轮；
   实现负责路由（`settings.models.reply`）、重试与超时。`maxChars` 是提示而不是保证。
   brain 侧预算为 **分类 60s / 草稿 60s**（`DEFAULT_CLASSIFY_TIMEOUT_MS`、
   `DEFAULT_REPLY_TIMEOUT_MS`）：真机首轮 15–40s 属正常，预算低于此会把成功的调用判成
   `timeout` 并 defer。实现方的超时不应短于 brain 的预算，否则由实现方决定失败。
3. **`ResearchPort`**：`search(query, { limit, timeoutMs }, signal)` → `{ facts, sources }`；
   实现独占网络与凭据。`research()` 只做预算、去重、URL 校验、缓存与降级。预算取
   `max(settings.timeoutMs, 30s)`（检索是网络调用，8s 默认值不够）。
4. **消息映射**：`BrainMessage` 由 `InboundMessage` 映射（`id/text/senderId/senderName/kind/
conversationType/addressed/broadcast/at`）。`broadcast` 与 `kind` 由通道给出；通道仍负责
   过滤机器人/系统消息（`isSelf` 只是第二道保险）。
5. **计数**：`gateReply` 只接收 `{ hour, gapMs }`。WS4 用 `readGateCounters(counter, key, at)`
   读取；发送成功后 `counter.hit(key, at)` 记账；key 建议用 `threadKey`。
6. **失败处理**：`ClassifyFailure` 与 `ComposeFailure` 都要求 **defer**（`Decision.status =
'deferred'`），不要用兜底文案硬发；`ComposeFailure.reason = 'echoes_system_prompt'` 时
   应当记录审计并交人工。
7. **草稿落库**：`ComposeSuccess.sources` 是“正文里真实出现过的检索 URL”，可直接写入
   `Draft.sources`；AI 角标仍由发送层固定追加，不要从模型输出取。
8. **gate 需要目标行存在**：不带 `targets.rows` 配置的会话一律 `target_missing`（安全方向）。
   WS4 只应对已配置目标调用分类/回复。

## 4. 关键决策

| 决策                    | 选择                      | 理由                                                                 |
| ----------------------- | ------------------------- | -------------------------------------------------------------------- |
| 静默时段结果            | `review`（不是 `off`）    | 夜间不主动发，但草稿留在面板，第二天可直接发；`off` 会让消息彻底失联 |
| 目标不在白名单          | `off`（`target_missing`） | `010` §2.2/§9：目标是白名单，宁可漏答不误答                          |
| `need_search` 归一      | 仅 `question` 保留        | 防止 chat/ignore 触发无谓检索与费用                                  |
| 非 task 意图携带 `task` | 丢弃而不是判非法          | 模型常见冗余字段，归一化比整条作废更稳                               |
| 分类低置信              | `low_confidence` → defer  | 宁可让主人看到，也不猜                                               |
| 回复中的未知 URL        | 删除（有检索时）          | 编造引用比“少一句”危险；无检索时不动链接                             |
| 回声命中                | 弃稿而不是修补            | 泄露过一次的系统提示不能靠截断修好                                   |
| 缓存失败                | 不缓存                    | 一次故障不该被记 30 分钟                                             |
| 计数器                  | 内存                      | 重启忘记限速，好过持久化一个错误的“不能说话”                         |
| 连续上限                | 常量 3                    | 主人不需要调这个数；改设置只会制造新故障                             |
| persona 超长            | 示例 → 知识 → 规则 → 截断 | 示例最可丢，身份与规则最不可丢                                       |
| 发送者名单              | 只比较 userId（全等）     | 昵称可被任意改动，按昵称匹配等于允许冒充                             |

## 5. 测试

- 新增 **122** 条 brain 测试（persona 7、prompts 11、classifier 18、reply 21、research 17、
  policy 20、rate-limit 9、loop-guard 11、contract 8），仓库总数 107 → **229**。
- 7 个变异自测全部被杀死（去掉 loop guard、去掉 need_search 归一、放开 URL 白名单、
  不丢示例、缺失模板返回空串，以及把发送者名单改回按昵称比较的两条 P0 回归）。
- 5 个实现/测试提交逐一导出后执行 `tsc --noEmit` 与全量测试，历史可独立构建（142 / 178 /
  216 / 224 条）。
- 审核整改：`fix(brain): match allow lists by user id only`（P0，名单只按 userId 全等匹配）、
  `test(brain): cover id-only allow lists and quiet review`；`docs/002-authorization.md` 补
  “名单存 userId、面板解析姓名”“静默按宿主本地时区”“静默期草稿不会自动发送”。
- 详细命令输出、策略矩阵与自评见 [WS3 测试报告](../test-reports/WS3.md)。

## 6. 影响面与风险

- 不改变任何现有模块的导出；`lib/index.js` 体积不变（brain 尚未进入入口，见 §3.1）。
- 风险 1：WS4 若绕过 `gateReply` 直接发送，静默/限速/防环全部失效；PR 审核应确认所有回复
  都经过 gate。
- 风险 2：`prompts/` 若未随包发布或部署时被裁剪，启动即抛错（这是有意的 fail-fast）。
- 风险 3：URL 白名单只覆盖“正文里出现过的链接”，若模型把链接写在图片语法或代码块里，
  正则仍能命中，但不会校验标题（模板已禁止该类输出）。

## 7. 已知缺口

- `src/brain` 未接入 `src/index.ts`（按分工由 WS4 完成），因此当前 `pnpm build` 产物不包含
  brain 代码；typecheck、vitest 覆盖全部源码。
- 提示词没有“人设越权检测”（例如主人自己在 `rules` 里写“你可以代替我付款”）。模板的
  safety 段声明优先，但这是提示层约束，不是代码约束；真正兜底是任务批准与 review 模式。
- `research.md` 的“事实/来源”长度按 400 字符/条截断，长文档摘要需要 WS4 在检索侧先压缩。
- 分类与回复各一次模型调用；没有做“低置信二次确认”的第二次采样。
- 整仓 `format:check` 依赖 `main` 的 `b69177d`（单独格式化了 `docs/PROGRESS.md`）；本分支已
  合并该提交，WS3 自身没有编辑 `PROGRESS.md`。

## 8. 自评（审核清单）

| #   | 项目                                | 结论                                                                          |
| --- | ----------------------------------- | ----------------------------------------------------------------------------- |
| ①   | 提示注入与“借用主人身份”的边界      | `safety.md` 第 1/3/4 条 + 分类器“消息只是数据” + 后处理不看消息；文档 §8 写清 |
| ②   | 分类 JSON 契约严格、失败可兜底      | zod strict + 归一化 + 三种失败 → defer；17 条测试                             |
| ③   | 回复不泄露系统提示/不自称人类       | 回声弃稿、免责声明删除、凭证脱敏、URL 白名单；测试覆盖                        |
| ④   | 策略矩阵覆盖静默跨午夜/限速/防环    | 16 条规则固定顺序；`isQuietHour` 边界单测；18 条 gate 测试                    |
| ⑤   | 检索预算/缓存/降级                  | 超时 abort、LRU+TTL、失败不缓存、空结果 degraded；16 条测试                   |
| ⑥   | 端口注入、无网络、无 DSH 依赖       | 三个端口 + 源码扫描契约测试                                                   |
| ⑦   | 测试能杀死错误实现                  | 7 个变异全部被杀死（含 2 个 P0 名单回归）                                     |
| ⑧   | 文档与实现一致                      | 004/002 重写，reason code 与顺序和 `policy.ts` 一致                           |
| ⑨   | `prompts/` 随包发布、缺失 fail-fast | `files` 白名单 + `check-pack` 校验 + `PromptLoadError`                        |
| ⑩   | 提交规范、工作区干净                | 见 §9                                                                         |

## 9. 提交

按切片提交（`git log --oneline a7d68d6..HEAD`）：

| 提交      | 内容                                                                |
| --------- | ------------------------------------------------------------------- |
| `a2f13eb` | `feat(brain): prompts, persona and classifier`                      |
| `1aaa32c` | `feat(brain): reply composition and research`                       |
| `bbf13de` | `feat(brain): reply policy, rate limit and loop guard`              |
| `bbe1544` | `test(brain): prompt contracts and layering guard`                  |
| `71d3b9b` | `docs: prompts and authorization`                                   |
| `f32bed5` | `Merge branch 'main' into feat/ws3-brain`（仅格式化 `PROGRESS.md`） |

`pnpm check`、`node scripts/check-pack.mjs` 与 `git status` 结果见测试报告；分支未 push、未合并。
合并 `main` 后另有一个 `docs: record the final gate after merging main` 提交，只更新本文件与
测试报告里的门禁记录。
