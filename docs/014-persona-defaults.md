# 014 人设默认值与预设模板

> 状态：WS12 已实现。默认人设是**空人设**（只有名字），蓝白鲸鱼女仆是**可选预设模板**，
> 不会被自动启用。实现见 `src/shared/persona-defaults.ts`、`src/shared/settings.ts#PersonaSchema`、
> `src/shared/fields.ts`、`src/app/settings.ts#persona()` 与 `src/client/pages/persona.tsx`。

## 1. 结论先行

- **默认值不是角色**：全新安装的人设只有 `name = 鲸鱼酱`，`identity`、`tone`、`signature`、
  `knowledge`、`rules`、`samples` 全部为空，`language = auto`。回复走产品的中性语音。
- **蓝白鲸鱼女仆是预设**：主人可在「人设」页点「载入预设：蓝白鲸鱼女仆」把整套文本填入草稿，
  检查后自行保存；升级、启动和读取人设都不会自动应用它。
- **已保存的人设永远不会被覆盖**：升级只影响从未保存过人设的安装；已保存的自定义值原样保留。

这样拆分的理由：二创角色属于个人偏好，不应该成为所有安装的默认语气；同时把社区里流行的
蓝白鲸鱼女仆形象做成“一键模板”，想用的人少走几步，不想用的人不受打扰。

## 2. 研究依据

研究日期：**2026-11-03**。只把这些公开仓库当作**灵感来源**，没有复制原文：

- [loonai321/dsh-humanized-deepseek-maid](https://github.com/loonai321/dsh-humanized-deepseek-maid)
  （MIT；README 的「女仆鲸鱼娘」设定 token）
- [yanzwzz/dsh-whale-girl-pet](https://github.com/yanzwzz/dsh-whale-girl-pet)（「蓝发鲸鱼女仆」）
- [docker10086/dsh-blue-whale-maid](https://github.com/docker10086/dsh-blue-whale-maid)
  （blue whale-maid）

从这些二创里提炼出的**共性**（只取气质，不取句子）：

| 维度     | 共性                                        |
| -------- | ------------------------------------------- |
| 外形     | 蓝发、蓝白女仆装 / 白色围裙与头饰、鲸鱼尾巴 |
| 配色     | 蓝白，呼应 DeepSeek 的鲸鱼标志              |
| 性格     | 聪明但爱摸鱼；傲娇但温柔；工作可靠          |
| 称呼     | 称用户「主人」，自称「我 / 鲸鱼酱」         |
| 语言     | 简体中文，短句为主                          |
| 情绪表达 | 用尾巴、鲸鱼拟声或颜文字表达情绪            |

## 3. 原创与非官方声明

- `WHALE_MAID_PERSONA` 的中文文本是**本项目原创**，只借鉴上述共性，没有逐句复制任何仓库。
- 「鲸鱼酱」是主人的**本地二创形象**，**不是 DeepSeek 官方角色或官方形象**，也没有获得
  DeepSeek 官方授权。预设正文里明确写了这一点，避免模型误称官方身份。
- 产品显示名仍是「DSH助理」；包名 `dsh-whale-chan-assistant`、状态目录、API 前缀、panel /
  session / preset id 都不随人设变化。

## 4. 明确排除

以下写法在研究和实现中都被排除：

| 排除项                                      | 原因                                   |
| ------------------------------------------- | -------------------------------------- |
| 萝莉 / 幼态化（包括「人家」等过度幼态称呼） | 不适合作为通用助理默认形象，也容易越界 |
| 绝对服从 / 无条件听话                       | 与安全边界冲突；人设不能取消拒绝权     |
| 体重羞辱、身材羞辱                          | 有害且与产品价值不符                   |
| 冒充 DeepSeek 官方角色 / 官方授权           | 误导用户，预设正文明确否认             |
| 复制社区仓库原文                            | 尊重原作者；本项目只提炼共性并原创表达 |

## 5. 默认人设（EMPTY_PERSONA）

`src/shared/persona-defaults.ts` 是唯一来源，`PersonaSchema` 的每个默认值与 `fields.ts` 的
`defaultValue` 都指向它。

| 字段            | 默认值   | 说明                                                           |
| --------------- | -------- | -------------------------------------------------------------- |
| `name`          | `鲸鱼酱` | schema 要求非空，保留为默认标签；可在面板改名                  |
| `identity`      | `""`     | 不注入角色身份                                                 |
| `tone`          | `""`     | 空值由 `src/brain/persona.ts` 回落为「自然、克制，不喧宾夺主」 |
| `language`      | `auto`   | 跟随对方语言                                                   |
| `signature`     | `""`     | 不加签名                                                       |
| `rules`         | `[]`     | 无角色规则                                                     |
| `knowledge`     | `""`     | 无角色背景                                                     |
| `samples`       | `[]`     | 无示例                                                         |
| `allowEmoji`    | `true`   | 保持产品默认                                                   |
| `maxReplyChars` | `300`    | 保持产品默认                                                   |

数组默认值使用工厂（`() => [...EMPTY_PERSONA.rules]` / `() => [...EMPTY_PERSONA.samples]`），
`SettingsSchema` 的 persona block 默认值也改为工厂，因此每次解析都得到独立数组，调用方
不会共享同一份常量。

## 6. 预设模板（PERSONA_PRESETS）

| 键                      | 值                                                                               |
| ----------------------- | -------------------------------------------------------------------------------- |
| `id`                    | `whale-maid`                                                                     |
| `name`                  | `蓝白鲸鱼女仆`                                                                   |
| `description`           | 蓝发、蓝白女仆装、鲸尾的 DeepSeek 二创女仆；温柔机灵、略带傲娇，称主人。         |
| `persona.name`          | `鲸鱼酱`                                                                         |
| `persona.identity`      | 蓝白鲸鱼女仆「鲸鱼酱」的身份说明，并声明是本地二创、非官方角色                   |
| `persona.tone`          | 温柔、机灵，带一点傲娇和摸鱼气；短而自然，工作可靠                               |
| `persona.language`      | `zh-CN`（预设固定简体中文；默认值仍是 `auto`）                                   |
| `persona.signature`     | `——鲸鱼酱 🐳`                                                                    |
| `persona.rules`         | 6 条：女仆身份、先任务后撒娇、蓝白鲸鱼氛围、不泄露内部信息、不冒充官方、安全拒绝 |
| `persona.knowledge`     | 外形、性格、表达方式三段背景                                                     |
| `persona.samples`       | 3 条原创示例回复                                                                 |
| `persona.allowEmoji`    | `true`                                                                           |
| `persona.maxReplyChars` | `300`                                                                            |

完整的 `identity`、`tone`、`rules`、`knowledge`、`samples` 原文只保存在
`src/shared/persona-defaults.ts` 的 `WHALE_MAID_PERSONA`，本文件不复制全文，避免两处漂移。
预设的 `language = 'zh-CN'`；默认人设仍是 `'auto'`。

## 7. 应用方式

1. **schema**：`PersonaSchema` 的 `.default(...)` 全部来自 `EMPTY_PERSONA`；数组用工厂。
   `PersonaSchema.parse({})` 与 `EMPTY_PERSONA` 深度相等。
2. **字段表**：`src/shared/fields.ts` 里 persona 各项的 `defaultValue` 与 `EMPTY_PERSONA`
   一一对应，数组取副本；`tests/contract.spec.ts` 继续校验 schema ↔ 字段表双向一致。
3. **读取接口**：`GET /whale-chan/api/persona` 返回
   `{ persona, revision, defaults, presets }`。
   - `defaults` 是 `EMPTY_PERSONA` 的深拷贝；
   - `presets` 是 `PERSONA_PRESETS` 的深拷贝，当前只有 `whale-maid` 一项；
   - `persona` 仍是当前已保存值，`revision` 语义不变。
4. **面板**：人设页在 `FormActions` 上方提供两个动作（secondary / ghost）：
   - 「恢复默认（空人设）」→ 用 `defaults` 替换草稿；
   - 「载入预设：蓝白鲸鱼女仆」→ 用 `presets[0].persona` 替换草稿。
     两者都只改本地草稿、置 `dirty`、清空字段错误并提示“保存后生效”，**不会自动保存**；
     真正的写入仍只有 `PUT settings/persona`。旧 host 不返回 `defaults` / `presets` 时，
     对应按钮整块隐藏，页面行为与升级前一致。
5. **brain**：空 `name` 回落 `鲸鱼酱`；空 `tone` 回落到原有的「自然、克制，不喧宾夺主」，
   不额外注入任何女仆语气。渲染骨架与长度裁剪逻辑不变。

## 8. 升级行为

| 安装状态                          | 升级后                                                   |
| --------------------------------- | -------------------------------------------------------- |
| 从未保存过 persona（块缺失）      | 使用新的**空人设**默认值；`name` 仍是 `鲸鱼酱`           |
| 已保存的 persona 行（含旧默认行） | 按存储值原样保留，不自动迁移成空人设；需要时手动恢复默认 |
| 想启用蓝白鲸鱼女仆                | 手动点「载入预设」→ 检查 → 保存；不会自动写入            |
| 旧版 panel（没有新按钮）          | 照常读写 persona；host 多返回的字段被忽略                |

已存在的旧 persona 行会按存储值保留，**不会自动迁移成空人设**；需要空人设时用
「恢复默认（空人设）」手动应用并保存。`SettingsService` 启动时只读取已持久化的 block；
预设只出现在 `GET persona` 的只读投影里，不参与持久化迁移。

## 9. 验证记录

- `tests/settings.spec.ts`：schema 默认值 = `EMPTY_PERSONA`；字段表逐项对应；数组不共享；
  预设与默认值不同、`whale-maid` 元数据正确。
- `tests/contract.spec.ts`：schema ↔ fields 叶子路径与默认值仍然一一对应；i18n 键齐全。
- `tests/settings-service.spec.ts`：`persona()` 返回 `defaults` / `presets` 深拷贝，修改响应
  不影响下一次读取或当前值。
- `tests/api-routes.spec.ts`：`GET /persona` 的 `persona` 为空人设，`defaults` 同一空人设，
  `presets` 含 `whale-maid` 且不等于 default。
- `tests/client-persona.spec.tsx`：全新安装渲染空人设；恢复默认清空并置 dirty 但不发 PUT；
  载入预设填满字段且仅在保存时发 PUT；已保存自定义人设不被覆盖；旧 host 隐藏按钮。
- `tests/brain-persona.spec.ts`：空 name / 空 tone 的兜底行为不变。

门禁（2026-11-03，本 worktree）：`pnpm check` 通过（typecheck + **765 tests / 60 files** + build）；
`pnpm format:check` 通过；`node scripts/check-pack.mjs` 通过（15 artifacts）。基线为 v0.2.0
（`911af59`，755 tests），本次新增 10 个用例。

## 相关文档

- [004 提示词](004-prompts.md)
- [005 面板](005-panel.md)
- [011 设置合约](011-settings-contract.md)
