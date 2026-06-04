# oh-my-opensecret

**OpenCode 隐私脱敏插件** — 自动识别并替换敏感信息，保证 LLM 提供商看不见明文，同时本机工具执行不受影响。

## 功能

- **发送前脱敏** — LLM 请求发出前，自动将消息中的敏感信息替换为占位符
- **响应后还原** — LLM 返回的文本中，占位符自动还原为原文
- **工具参数还原** — 工具执行前，参数中的占位符自动还原，本地工具拿到真实值
- **闭环安全** — Provider 永远看不到明文，本地工具不受影响

## 工作原理

```
用户输入 "我的邮箱是 user@example.com"
       │
       ▼
  ┌─ messages.transform hook ─────────────────┐
  │  脱敏: "user@example.com"                  │
  │      → "user@example.com"       │
  └────────────────────────────────────────────┘
       │
       ▼
  ┌─ 发送给 LLM ──────────────────────────────┐
  │  看到的是: "我的邮箱是 __OMOS_EMAIL_xxx__" │
  └────────────────────────────────────────────┘
       │
       ▼
  ┌─ text.complete hook ──────────────────────┐
  │  还原: "user@example.com"       │
  │      → "user@example.com"                  │
  └────────────────────────────────────────────┘
       │
       ▼
  用户看到原文
```

## 安装

### 1. 安装插件

在 `opencode.json` 的 `plugin` 数组中添加：

```json
{
  "plugin": ["oh-my-opensecret"]
}
```

或者指向本地源码（开发调试用）：

```json
{
  "plugin": ["file:///path/to/oh-my-opensecret/src/index.js"]
}
```

### 2. 配置（可选）

首次启动会自动生成默认配置到 `~/.config/opencode/oh-my-opensecret.yaml`，开箱即用。

你也可以手动创建配置文件，查找优先级：

1. `$OPENCODE_SECRET_CONFIG` 环境变量指向的文件
2. 项目根目录 `./oh-my-opensecret.yaml`
3. 项目 `.opencode/oh-my-opensecret.yaml`
4. `~/.config/opencode/oh-my-opensecret.yaml`

## 内置规则

| 规则 | 匹配内容 | 示例 |
|------|---------|------|
| `email` | 邮箱地址 | `user@example.com` |
| `china_phone` | 中国大陆手机号 | `13800138000` |
| `china_id` | 中国大陆身份证号 | `110101199001011234` |
| `uuid` | UUID v4 | `550e8400-e29b-41d4-...` |
| `ipv4` | IPv4 地址 | `192.168.1.1` |
| `mac` | MAC 地址 | `aa:bb:cc:dd:ee:ff` |
| `jwt` | JWT Token | `eyJxxx.eyJxxx.xxx` |
| `db_connection` | 数据库连接串 | `mysql://user:pass@host` |
| `openai_key` | OpenAI API Key | `sk-...` / `sk-proj-...` |
| `openai_org_id` | OpenAI 组织 ID | `org-...` |
| `github_token` | GitHub 令牌 | `ghp_...` / `github_pat_...` |
| `aws_key` | AWS Access Key | `AKIA...` |
| `anthropic_key` | Anthropic API Key | `sk-ant-...` |
| `google_key` | Google API Key | `AIza...` |
| `stripe_key` | Stripe API Key | `sk_live_...` / `sk_test_...` |
| `hf_token` | HuggingFace Token | `hf_...` |
| `pplx_key` | Perplexity API Key | `pplx-...` |
| `groq_key` | Groq API Key | `gsk_...` |
| `gitlab_token` | GitLab PAT | `glpat-...` |
| `replicate_key` | Replicate Token | `r8_...` |

## 场景 Profile

通过 `profile` 字段切换不同脱敏策略：

- **`daily`** — 轻量脱敏，只处理常见 PII（邮箱、手机号、UUID），适合日常对话
- **`code_review`** — 全面脱敏，覆盖所有内置规则，适合分享代码片段
- **`ci_cd`** — 重点保护密钥和令牌，适合 CI/CD 环境

## 自动发现

`auto_discovery: true` 时，每次启动自动扫描 `opencode.json`，从中提取 `apiKey`、`token`、`secret` 等敏感字段值，生成对应的正则规则追加到配置文件中。

- 已存在的规则跳过，不覆盖用户手动配置
- 新发现的敏感值自动生成规则
- 每次启动幂等执行

## 项目结构

```
src/
├── index.js      # 插件入口，注册 hook
├── config.js     # 配置加载（级联查找 + YAML 解析 + auto-discovery）
├── patterns.js   # 匹配规则构建（关键词/正则/内置/排除）
├── engine.js     # 脱敏引擎（重叠命中处理）
├── session.js    # 会话占位符管理器（HMAC 映射、TTL 淘汰）
├── restore.js    # 占位符还原
├── deep.js       # 深度遍历工具（递归脱敏/还原）
└── logger.js     # 分级日志系统
```

## 开发

```bash
# 安装依赖
npm install

# 运行测试
npm test
```

## 许可

MIT

## 免责声明

1. 本项目以**个人自用**为主要目的开发，非商业产品
2. **使用前请三思**——脱敏规则无法覆盖所有场景，不保证 100% 识别所有敏感信息
3. 作者不对因使用本项目导致的任何**数据泄露、损失或法律责任**承担责任
4. 请确保使用方式符合当地法律法规，**合法使用**
