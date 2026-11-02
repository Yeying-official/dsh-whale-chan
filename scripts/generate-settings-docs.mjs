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

> 状态：WS0 已冻结。生成来源：\`src/shared/fields.ts\`；默认值来源：\`src/shared/settings.ts\`。

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
- \`models.reply\` 与 \`models.worker\` 的 \`provider\`、\`model\`、\`effort\` 为空字符串时表示使用 DSH 默认值。
- 所有对象块均为 strict：未知键会被拒绝，而不是静默保留。

## 管理 API 变更（Review round 1–2）

- \`GET settings\` 返回 \`SettingsView\`（blocks + revision），不再是裸 \`Settings\`。
- \`PUT settings/:block\` 必须带非负整数 \`revision\`；缺失为 400 \`revision_required\`，过期 revision 为 409 \`settings_conflict\`。
- 块内 patch 采用递归深合并（仅当两侧都是普通对象）；数组、标量和 \`null\` 整体替换；未知键仍由 strict 拒绝。
- 人设唯一写入口是 \`PUT settings/persona\`；\`GET persona\` 只读；原 \`PUT persona\` 已删除。
- 所有管理请求要求 \`x-whale-chan-request: 1\`，缺失为 403 且不回传 \`stateDir\`。

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

## 相关文档

- [009 DWS 协议](009-dws-protocol.md)
- [010 设计摘要](010-design.md)
- [013 安全](013-security.md)
`

writeFileSync('docs/011-settings-contract.md', doc)
console.log(`wrote docs/011-settings-contract.md with ${FIELDS.length} fields`)
