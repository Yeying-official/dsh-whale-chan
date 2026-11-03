/**
 * Generate docs/011-settings-contract.md from the frozen field registry.
 *
 * Run with `pnpm docs:settings` (Node 24 strips the TypeScript types). The test
 * suite verifies that every field still appears in the generated document.
 */
import { writeFileSync } from 'node:fs'
import { FIELDS } from '../src/shared/fields.ts'
import { SETTINGS_BLOCKS } from '../src/shared/settings.ts'

function formatDefault(field) {
  const value = field.defaultValue
  if (typeof value === 'string') return value === '' ? '`""`' : `\`${value}\``
  return `\`${JSON.stringify(value)}\``
}

function formatRange(field) {
  if (field.options) return field.options.map((option) => `\`${option}\``).join(' / ')
  if (field.min !== undefined && field.max !== undefined) {
    return `${field.min}–${field.max}${field.unit ? ` ${field.unit}` : ''}`
  }
  if (field.type === 'rows') return '数组（行结构见下）'
  if (field.type === 'string-list') return '字符串数组'
  return '—'
}

const rows = FIELDS.map(
  (field) => `| \`${field.block}.${field.path}\` | ${field.type} | ${formatDefault(field)} | ${formatRange(field)} |`,
)

const doc = `# 011 设置合约

> 状态：WS0 冻结字段，WS5a 起持久化（schema v2）。生成来源：\`src/shared/fields.ts\`；默认值来源：\`src/shared/settings.ts\`；持久化实现：\`src/app/settings.ts\`。

本文件是设置字段的唯一人读表格，由 \`scripts/generate-settings-docs.mjs\` 生成。机器可读的唯一真源是：

- \`src/shared/settings.ts\`：Zod schema、默认值、边界与未知字段拒绝；
- \`src/shared/fields.ts\`：字段路径、类型、默认值、范围与 i18n key；
- \`locale/zh.json\`、\`locale/en.json\`：字段 label/hint 文案。

修改任一文件后重新运行：

\`\`\`bash
pnpm docs:settings
\`\`\`

## 字段表

按设置 block 的冻结顺序排列，共 ${FIELDS.length} 个叶子字段，覆盖 ${SETTINGS_BLOCKS.length} 个 block。

| Key | 类型 | 默认值 | 范围 / 选项 |
| --- | --- | --- | --- |
${rows.join('\n')}

## 结构补充

- \`targets.rows\` 的每个元素包含 \`kind\`（\`at-me\` / \`group\` / \`dm\`）、非空 \`id\`、\`label\`、\`mentionOnly\`、\`replyMode\`（\`auto\` / \`review\` / \`off\`）与 \`enabled\`；行对象同样拒绝未知字段。
- \`tasks.workspaceRoot\` 是**回复器与任务共用的会话工作区根**：非空时使用它（\`~\` 展开，必须是绝对路径），为空时使用 \`<stateDir>/workspaces\`；每个会话在其下拥有 \`conversation-<sha256(threadKey) 前 16 位>\`。它不再表示「每个任务一个子目录」，字段名与默认值保持不变；相对路径会被记录 warning 并回退默认根。
- \`models.reply\` 与 \`models.worker\` 的 \`provider\`、\`model\`、\`effort\` 为空字符串时表示使用 DSH 默认值。
- 所有对象块均为 strict：未知键会被拒绝，而不是静默保留。

## 管理 API 变更（Review round 1–2）

- \`GET settings\` 返回 \`SettingsView\`（blocks + revision），不再是裸 \`Settings\`。
- \`PUT settings/:block\` 必须带非负整数 \`revision\`；缺失为 400 \`revision_required\`，过期 revision 为 409 \`settings_conflict\`。
- 块内 patch 采用递归深合并（仅当两侧都是普通对象）；数组、标量和 \`null\` 整体替换；未知键仍由 strict 拒绝。
- 人设唯一写入口是 \`PUT settings/persona\`；\`GET persona\` 只读；原 \`PUT persona\` 已删除。
- 所有管理请求要求 \`x-whale-chan-request: 1\`，缺失为 403 且不回传 \`stateDir\`。

## 持久化、revision 与 history（WS5a）

设置自 schema v2 起持久化在 \`<stateDir>/state.db\`，不再是内存 canary。表结构：

| 表                | 列                                                                          | 说明                                        |
| ----------------- | --------------------------------------------------------------------------- | ------------------------------------------- |
| \`settings\`        | \`block\` PK、\`value_json\`、\`revision\`、\`updated_at\`                          | 每个 block 一行，JSON 是该 block 的唯一真源 |
| \`settings_history\` | \`id\` 自增 PK、\`block\`、\`value_json\`、\`revision\`、\`source\`、\`saved_at\`        | 每次成功写入追加一行，永不改写              |
| \`settings_meta\`    | \`id\`（固定 1）、\`revision\`、\`updated_at\`                                     | 全局 revision；迁移时插入初始行             |

语义：

- **启动加载**：每个 block 从表读取 JSON 并用 \`SettingsSchema\` 校验。缺失的 block 用默认值；损坏、不可读或不再匹配 schema 的行回退默认值并记录健康警告（\`SettingsService.warnings()\`），启动不失败。\`SettingsView.blocks\` 永远包含全部 9 个 block。
- **单事务写入**：\`SettingsService.update(block, patch, expectedRevision)\` 在 \`BEGIN IMMEDIATE\` 中同时 upsert \`settings\`、追加 \`settings_history\`、把 \`settings_meta.revision\` 加一；任一步失败整体回滚，内存状态不变。
- **block revision**：每个 block 独立递增，是 \`PUT settings/:block\` 的乐观并发令牌。\`expectedRevision\` 与当前值不同即 409 \`settings_conflict\`，并回传 \`actualRevision\`。
- **全局 revision**：\`settings_meta.revision\` 每次成功写入加一；缺失或低于任一 block revision 时启动会向上修复（健康视图记为 \`meta\` 警告），不会回退。
- **history**：\`SettingsService.history(block?)\` 按写入顺序倒序返回 \`{ block, value, revision, source, savedAt }\`；\`source\` 为 \`panel\`（面板写入）或 \`internal\`（宿主系统写入，如 \`POST monitor/pause\`）。
- **系统写入**：\`patchInternal(block, patch, source = 'internal')\` 不要求 expected revision，但仍做 strict 校验、仍递增 revision、仍写 history。
- **变更通知**：\`onChange(listener)\` 在每次成功写入后同步通知；监听器抛错不会回滚已提交的写入。
- **任务状态映射**：领域 \`approved\` 在 wire 上是 \`queued\`（面板语义：已批准、等待执行）；\`GET tasks?status=queued\` 反向过滤 \`approved\`。

## 错误码

| HTTP | code                          | 触发                                                                    |
| ---- | ----------------------------- | ----------------------------------------------------------------------- |
| 400  | \`invalid_settings\`            | 合并后的 block 不满足 \`SettingsSchema\`；响应带 \`issues[]\`                 |
| 400  | \`revision_required\`           | \`PUT settings/:block\` 缺少非负整数 \`revision\`                             |
| 409  | \`settings_conflict\`           | block revision 已变化；响应带 \`actualRevision\`                             |
| 404  | \`unknown_block\`               | 路径中的 block 不在 9 个冻结 block 内                                     |
| 404  | \`unknown_task\` / \`unknown_thread\` | 记录不存在                                                              |
| 404  | \`missing\` 类（如 \`unknownTask\`） | 记录不存在；响应带 \`code\` / \`values\`                                      |
| 400  | \`invalid\` 类（如 \`invalidWorkspace\`、\`missingWorkspace\`、\`invalidTime\`） | 调用方可纠正的输入；响应带 \`code\` / \`values\` |
| 409  | \`refused\` 类（如 \`notFailed\`、\`notAwaitingApproval\`、\`alreadyDecided\`） | 记录存在但当前状态不允许；响应带 \`code\` / \`values\` |
| 400  | \`channel_error\`               | 通道一次性调用失败（消息已脱敏）                                          |
| 503  | \`channel_unavailable\`         | WS5a 未接入通道时的 \`targets/discover\` / \`targets/validate\`               |
| 503  | \`state_unavailable\`           | 运行时尚未就绪或启动失败                                                  |
| 403  | \`forbidden\`                   | 缺少 \`x-whale-chan-request: 1\`                                          |

\`UserError.category\` 决定状态：\`missing\` → 404、\`invalid\` → 400、\`refused\` → 409。分类表由 \`tests/core-invariants.spec.ts\` 钉住，HTTP 映射由 \`tests/api-routes.spec.ts\` 钉住。

## 契约测试

\`tests/contract.spec.ts\` 证明：

1. schema 的全部叶子路径与 field registry 一一对应，没有遗漏或多余字段；
2. 每个字段声明的默认值与 \`SettingsSchema.parse({})\` 的结果一致；
3. 每个 block 至少有一个字段，且不存在未知 block；
4. 19 个管理 API 端点唯一，方法/路径符合冻结前缀，URL 编码和必填路径参数正确；
5. 所有 labelKey/hintKey 在中文和英文字典中都存在且非空，两个字典 key 集合一致；
6. package 版本、engines、manifest、files 白名单与共享常量一致；
7. 本文档包含每一个字段路径；
8. 分层不变量：core 无 import，shared 无 Node 内置模块，client 不导入宿主实现层。

\`tests/settings.spec.ts\` 证明：

1. 默认值快照；
2. 根级和 block 内未知字段被拒绝；
3. 每个数值字段的 min/max 可解析、越界与小数被拒绝；
4. 枚举只接受声明值，错误标量类型和非法时间格式被拒绝；
5. 目标行缺少 ID、未知字段或非法枚举被拒绝。

\`tests/settings-service.spec.ts\` 证明持久化语义：默认值、重开数据库后不丢、block/全局 revision、409 冲突、深合并与数组替换、损坏行降级、v1→v2 迁移幂等、history 与变更通知。

\`tests/api-routes.spec.ts\` 与 \`tests/task-actions.spec.ts\` 证明 19 条路由、分页边界、错误码、审批/拒绝/取消/重试与 launch effect。

## 相关文档

- [009 DWS 协议](009-dws-protocol.md)
- [010 设计摘要](010-design.md)
- [013 安全](013-security.md)
`

writeFileSync('docs/011-settings-contract.md', doc)
console.log(`wrote docs/011-settings-contract.md with ${FIELDS.length} fields`)
