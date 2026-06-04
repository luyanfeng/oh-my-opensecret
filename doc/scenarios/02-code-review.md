# 场景：代码审查（code_review）

## 用途

在 Opencode 中进行代码审查时，代码中可能包含硬编码的密钥、配置信息等。

## 脱敏策略

- **全面脱敏**：覆盖几乎所有敏感信息
- **目标**：确保审查过程中没有任何敏感信息暴露给 LLM

## 匹配规则

| 类型 | 覆盖范围 |
|------|---------|
| 内置规则 | email、china_phone、china_id、uuid、jwt、ipv4、mac、github_token、openai_key、aws_key |
| 正则 | GitHub token（完整覆盖内置规则的遗漏格式）|

## 覆盖说明

- **china_id**: 代码注释/示例中可能包含测试身份证号
- **jwt**: Token 可能出现在 Authorization header 示例中
- **ipv4/mac**: 配置文件中的 IP/端口/MAC 可能属于内部网络信息
- **api key 正则**: OpenAI / GitHub / AWS 的标准 key 格式

## 注意事项

- 对代码审查场景，内置规则已基本覆盖
- 如需额外自定义规则（如内部系统的 <org>-<env>-<数字> 格式），建议在 keywords 中追加
