# Pull Request

## 目标

<!-- 这个 PR 解决什么问题？关联 issue / 工作流编号。 -->

## 方案

<!-- 关键设计、取舍、与已批准架构的关系。 -->

## 影响面

- [ ] 宿主 API / 权限
- [ ] 设置 schema / fields / i18n
- [ ] 管理 API 合约
- [ ] 客户端面板或打包
- [ ] 文档

## 测试证据

<!-- 粘贴命令与真实输出摘要；不要只写“测试通过”。 -->

```bash
pnpm typecheck
pnpm test
pnpm build
node scripts/check-pack.mjs
```

## 风险与回滚

<!-- 已知风险、未覆盖场景、回滚方式。 -->

## 文档同步

- [ ] 已更新受影响的 `docs/` 文件
- [ ] 已重新生成 `docs/011-settings-contract.md`（如设置字段变化）
- [ ] 未提交 token、clientSecret、真实消息或其他敏感数据
- [ ] 未在未授权情况下执行钉钉订阅或发送

## 检查清单

- [ ] 分支名符合 `feat/...`、`fix/...` 等约定
- [ ] Commit 符合 Conventional Commits
- [ ] `pnpm check` 通过
- [ ] `node scripts/check-pack.mjs` 通过
- [ ] 工作区干净
