# oh-my-opensecret

**OpenCode 隐私脱敏插件** — 自动识别并替换敏感信息，保证 LLM 提供商看不见明文，同时本机工具执行不受影响。

> ⚠️ **要求 OpenCode 2.x（V2 运行时）**。从 `0.2.0` 起不再兼容 OpenCode 1.x 的 V1 插件 API。

## 功能

- **发送前脱敏** — LLM 请求发出前，自动将消息中的敏感信息替换为占位符
- **工具参数还原** — 工具执行前，参数中的占位符自动还原，本地工具拿到真实值
- **闭环安全** — Provider 永远看不到明文，本地工具不受影响

> ℹ️ **「脱敏单向」说明**：模型回复中若复述占位符，界面显示的仍是占位符形态（不会还原为原文）。
> V2 的 `http.response` hook 替换响应体后 server 不消费新 body，无法影响界面展示，
> 故本插件不注册该 hook。敏感信息本身绝不会泄露给 Provider，安全性不受影响。

## 工作原理

> 本插件基于 **OpenCode 2.x (V2) server 插件 API** 实现，不兼容 V1。

```
用户输入 "我的邮箱是 user@example.com"
       │
       ▼
  ┌─ session.hook("context") ────────────────┐
  │  脱敏: "user@example.com"                 │
  │      → "__OMOS_EMAIL_xxx__"               │
  └────────────────────────────────────────────┘
       │
       ▼
  ┌─ 发送给 LLM ──────────────────────────────┐
  │  看到的是: "我的邮箱是 __OMOS_EMAIL_xxx__" │
  │  Provider 无法获得真实邮箱                  │
  └────────────────────────────────────────────┘
       │
       ▼
  ┌─ tool.hook("execute.before") ─────────────┐
  │  还原: 工具参数中的占位符 → 真实值          │
  │  本地工具正常使用原始数据                    │
  └────────────────────────────────────────────┘
```

模型回复中出现的占位符将保持占位符形态展示（脱敏单向）。

## 安装

### 1. 安装插件

本插件需要 OpenCode 2.x（V2 运行时）。在 `opencode.json` / `opencode.jsonc` 的 `plugins` 数组中添加：

```jsonc
{
  "plugins": ["oh-my-opensecret"]
}
```

或者指向本地源码（开发调试用，V2 支持直接加载 `.js` 入口）：

```jsonc
{
  "plugins": ["./path/to/oh-my-opensecret/src/index.js"]
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

内置规则仅覆盖通用 PII，不包含任何平台 API Key。API Key 请在 YAML 配置的 `patterns.regex` 中自行添加。

| 规则 | 匹配内容 | 示例 |
|------|---------|------|
| `email` | 邮箱地址 | `user@example.com` |
| `china_phone` | 中国大陆手机号 | `13800138000` |
| `china_id` | 中国大陆身份证号 | `110101199001011234` |
| `uuid` | UUID v4 | `550e8400-e29b-41d4-...` |
| `ipv4` | IPv4 地址 | `192.168.1.1` |
| `ipv6` | IPv6 地址（全写） | `2001:db8::1` |
| `mac` | MAC 地址 | `aa:bb:cc:dd:ee:ff` |
| `jwt` | JWT Token | `eyJxxx.eyJxxx.xxx` |
| `db_connection` | 数据库连接串 | `mysql://user:pass@host` |

## 自动发现

`auto_discovery: true` 时，每次启动自动扫描 `opencode.json`，从中提取 `apiKey`、`token`、`secret` 等敏感字段值，生成对应的正则规则追加到配置文件中。

- 已存在的规则跳过，不覆盖用户手动配置
- 新发现的敏感值自动生成规则
- 每次启动幂等执行

## 项目结构

```
src/
├── index.js      # 插件入口（V2 Plugin.define + 注册 context/execute.before hook）
├── singleton.js   # 进程级单例（globalThis 夺权，保证一个 server 进程只有一个实例生效）
├── config.js     # 配置加载（级联查找 + YAML 解析 + auto-discovery）
├── patterns.js   # 匹配规则构建（关键词/正则/内置/排除）
├── engine.js     # 脱敏引擎（重叠命中处理）
├── session.js    # 占位符管理器（进程级共享 HMAC 密钥 + 映射表 + TTL 淘汰）
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
