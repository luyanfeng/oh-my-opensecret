# 场景：CI/CD 环境（ci_cd）

> [!WARNING]
> **存档文档，配置方式已失效。**
> - 本文描述的 **profile（场景预设）功能已从代码中完全移除**（`src/` 中零命中），`patterns` 不再按 profile 合并。
> - 文中提到的 `aws_key` / `github_token` / `openai_key` **不是内置规则**。实际内置规则只有 9 条：`email`、`china_phone`、`china_id`、`uuid`、`ipv4`、`ipv6`、`mac`、`jwt`、`db_connection`。
> - 平台 API Key 一律要在 `patterns.regex` 中自行添加，或依赖 `auto_discovery` 自动生成。
> - 保留原因：场景划分的思路与取舍理由仍可参考。
> - 当前有效文档：`oh-my-opensecret.yaml.example`、`doc/01-design-reference.md`。

## 用途

在 CI/CD 流水线中运行 Opencode，环境变量中包含大量部署密钥和服务令牌。

## 脱敏策略

- **密钥优先**：聚焦 API Key、Token、密钥类信息
- **目标**：防止 CI/CD 日志或自动化对话中泄漏凭据

## 匹配规则

| 类型 | 覆盖范围 |
|------|---------|
| 内置规则 | aws_key、github_token、openai_key、email |
| 正则 | AWS Access Key（精确格式）|

## 覆盖说明

- CI/CD 环境最常泄漏的是各类服务密钥
- email 保留是因为 CI 通知配置中可能包含邮箱
- 去掉了 china_id / ipv4 / mac 等 CI 场景不常见的类型

## 建议

- CI/CD 场景中 auto-discovery 尤其有用——能自动捕捉 opencode.json 中配置的各 provider key
- 如需在 CI 中禁用自动发现，设置 `auto_discovery: false`
