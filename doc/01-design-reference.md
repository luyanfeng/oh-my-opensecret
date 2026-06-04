# 插件设计参考

> 整理日期：2026-06-04
> 用途：oh-my-opensecret 插件设计时参考的架构模式与设计决策

## 架构模块划分

```
src/
├── index.js          # 插件入口，注册 hook
├── config.js         # 配置加载（级联查找 + YAML 解析）
├── patterns.js       # 匹配规则构建（关键词/正则/内置/排除）
├── engine.js         # 脱敏引擎（重叠命中处理、增量替换）
├── session.js        # 会话占位符管理器（HMAC 映射、TTL 淘汰）
├── restore.js        # 占位符还原（正则替换）
├── deep.js           # 深度遍历工具（递归脱敏/还原，防循环引用）
└── logger.js         # 分级日志系统
```

## 核心设计模式

### 1. 占位符格式

```
#{PREFIX}_{CATEGORY}_{hash12}__
或
#{PREFIX}_{CATEGORY}_{hash12}_{N}__   (hash 冲突时)
```

- `hash12` = HMAC-SHA256(会话随机 secret, 原文) 的 12 位十六进制小写截断
- 同一会话内同一原文 → 同一占位符（稳定可逆）
- 对上游 provider 不可逆

### 2. 配置查找优先级

1. 环境变量 `OPENCODE_SECRET_CONFIG` 指定路径
2. 项目根目录 `./oh-my-opensecret.yaml`
3. 项目 `.opencode/` 目录下 `oh-my-opensecret.yaml`
4. 全局配置 `~/.config/opencode/oh-my-opensecret.yaml`

### 3. 脱敏引擎策略

- **关键词匹配**：`indexOf` 线性扫描
- **正则匹配**：`matchAll` 全局扫描
- **重叠处理**：右侧优先排序 → subtractCovered 分割 → insertCovered 合并
- **排除列表**：命中后在 exclude set 中的原文跳过
- **配置自举**：无配置时自动生成默认配置（`enabled: true, auto-discovery: true`）
- **安全关闭**：`enabled: false` 时整个插件为 no-op

### 4. 生命周期 Hook

| Hook | 时机 | 作用 |
|------|------|------|
| `experimental.chat.messages.transform` | 消息列表构建后 | 脱敏所有消息中的敏感信息 |
| `experimental.text.complete` | 文本输出完成时 | 还原占位符为原文 |
| `tool.execute.before` | 工具执行前 | 还原工具参数中的占位符 |

### 5. 会话管理器

- 双向映射：placeholder ↔ original
- TTL 过期淘汰（默认 1h）
- max_mappings 上限淘汰（默认 100000）
- 极低概率 hash 冲突时追加 `_N` 后缀

### 6. 深度遍历工具

- 只遍历 Array / PlainObject
- 使用 WeakSet 避免循环引用爆栈
- 原地修改（mutate）设计

## 自动发现机制

- 配置项 `auto-discovery: true` 控制开关（仅在 `enabled: true` 时生效）
- 每次启动时扫描 Opencode 配置（搜索路径：项目根 → `.opencode/`）
- 提取 `apiKey`、`secret`、`token` 等敏感字段值，生成正则规则
- **幂等设计**：已存在规则跳过，冲突项以注释写入，绝不覆盖用户配置

## 合理性原则

| 原则 | 说明 |
|------|------|
| 脱敏→传输→还原 闭环 | Provider 永远看不到明文，本地工具拿到真实值 |
| 配置自举 | 无配置时自动生成默认配置，开箱即用 |
| enabled:false 安全降级 | 用户明确关闭时变为 no-op |
| 环境/配置/全局 三通道 | 灵活控制，CI/CD 可通过环境变量设置 |
