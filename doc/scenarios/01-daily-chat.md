# 场景：日常对话（daily）

> [!WARNING]
> **存档文档，配置方式已失效。**
> - 本文描述的 **profile（场景预设）功能已从代码中完全移除**（`src/` 中零命中），`patterns` 不再按 profile 合并；文中「推荐作为默认 profile」的说法已无对应实现。
> - 文中提到的 `github_token` / `openai_key` / `aws_key` **不是内置规则**。实际内置规则只有 9 条：`email`、`china_phone`、`china_id`、`uuid`、`ipv4`、`ipv6`、`mac`、`jwt`、`db_connection`。
> - 平台 API Key 一律要在 `patterns.regex` 中自行添加。
> - 保留原因：场景划分的思路与取舍理由仍可参考。
> - 当前有效文档：`oh-my-opensecret.yaml.example`、`doc/01-design-reference.md`。

## 用途

日常与 LLM 的对话场景，用户可能无意中粘贴了邮箱、手机号等 PII 信息。

## 脱敏策略

- **轻量脱敏**：只覆盖最常见的个人信息
- **目标**：不影响对话流畅度和可读性，只保护基本隐私

## 匹配规则

| 类型 | 覆盖范围 |
|------|---------|
| 内置规则 | email、china_phone、uuid |
| 排除 | example.com、localhost（避免测试数据被误脱敏） |

## 不覆盖的规则

- china_id — 对话中极少出现，且可能是有意引用
- ipv4/mac — 开发者讨论网络配置时需要原文可见
- jwt/github_token/openai_key/aws_key — 日常对话中不应出现，出现时可能是示例代码

## 建议

- 推荐给大部分用户作为默认 profile
- 基本不产生误脱敏
