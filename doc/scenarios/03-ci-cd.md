# 场景：CI/CD 环境（ci_cd）

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
