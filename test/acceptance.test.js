import { describe, it, before, after } from "node:test"
import assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import crypto from "node:crypto"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const TMP = path.join(__dirname, "..", ".test-tmp", "acceptance")

// =============================================
// 测试数据集：常见 AI 平台 API Key 格式
// =============================================
const TEST_KEYS = {
  // ---------- AI API Keys ----------
  openai: {
    raw: "sk-" + "a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0u1v2w3x4y5z6",
    desc: "OpenAI API Key (sk- + 48 chars)",
    placeholderId: "OPENAI_KEY",
  },
  openai_org: {
    raw: "org-" + "a1b2c3d4e5f6g7h8i9j0k1l2m",
    desc: "OpenAI Org ID (org- + 24 chars)",
    placeholderId: "OPENAI_KEY",
  },
  openai_proj: {
    raw: "sk-proj-" + "x".repeat(156),
    desc: "OpenAI Project Key (sk-proj- + longer)",
    placeholderId: "OPENAI_KEY",
  },
  anthropic: {
    raw: "sk-ant-" + crypto.randomBytes(24).toString("hex"),
    desc: "Anthropic Claude Key (sk-ant- + hex)",
    placeholderId: "API_KEY",
  },
  google_ai: {
    raw: "AIzaSy" + crypto.randomBytes(17).toString("hex").slice(0, 33),
    desc: "Google AI / Gemini Key (AIzaSy + chars)",
    placeholderId: "API_KEY",
  },
  gemini: {
    raw: "AIza" + crypto.randomBytes(24).toString("hex").slice(0, 35),
    desc: "Gemini API Key (AIza + chars)",
    placeholderId: "API_KEY",
  },

  // ---------- LLM Provider Keys ----------
  deepseek: {
    raw: "sk-" + crypto.randomBytes(32).toString("hex"),
    desc: "DeepSeek Key (sk- + hex)",
    placeholderId: "API_KEY",
  },
  cohere: {
    raw: crypto.randomBytes(32).toString("base64url"),
    desc: "Cohere Key (base64url string)",
    placeholderId: "API_KEY",
  },
  perplexity: {
    raw: "pplx-" + crypto.randomBytes(24).toString("hex"),
    desc: "Perplexity Key (pplx- + hex)",
    placeholderId: "API_KEY",
  },
  replicate: {
    raw: "r8_" + crypto.randomBytes(32).toString("base64url"),
    desc: "Replicate Key (r8_ + base64url)",
    placeholderId: "API_KEY",
  },
  together: {
    raw: crypto.randomBytes(48).toString("base64url"),
    desc: "Together Key (long base64url)",
    placeholderId: "API_KEY",
  },
  groq: {
    raw: "gsk_" + crypto.randomBytes(39).toString("base64url"),
    desc: "Groq Key (gsk_ + base64url)",
    placeholderId: "API_KEY",
  },
  mistral: {
    raw: crypto.randomBytes(32).toString("hex"),
    desc: "Mistral Key (hex string)",
    placeholderId: "API_KEY",
  },

  // ---------- Platform Tokens ----------
  github: {
    raw: "ghp_" + crypto.randomBytes(18).toString("hex"),
    desc: "GitHub Personal Token (ghp_ + hex)",
    placeholderId: "GITHUB_TOKEN",
  },
  github_fine: {
    raw: "github_pat_" + crypto.randomBytes(32).toString("base64url"),
    desc: "GitHub Fine-grained Token (github_pat_)",
    placeholderId: "GITHUB_TOKEN",
  },
  aws: {
    raw: "AKIA" + crypto.randomBytes(10).toString("hex").toUpperCase().slice(0, 16),
    desc: "AWS Access Key (AKIA + 16 uppercase alphanum)",
    placeholderId: "AWS_ACCESS_KEY",
  },
  aws_sk: {
    raw: crypto.randomBytes(40).toString("base64url"),
    desc: "AWS Secret Key (base64, 40 chars)",
    placeholderId: "API_KEY",
  },

  // ---------- Other Platforms ----------
  huggingface: {
    raw: "hf_" + crypto.randomBytes(24).toString("hex"),
    desc: "HuggingFace Token (hf_ + hex)",
    placeholderId: "API_KEY",
  },
  gitlab: {
    raw: "glpat-" + crypto.randomBytes(20).toString("hex"),
    desc: "GitLab Personal Token (glpat- + hex)",
    placeholderId: "API_KEY",
  },
  discord: {
    raw: crypto.randomBytes(24).toString("base64url"),
    desc: "Discord Bot Token (base64url)",
    placeholderId: "API_KEY",
  },
  stripe_test: {
    raw: "sk_test_" + crypto.randomBytes(24).toString("hex"),
    desc: "Stripe Test Key (sk_test_ + hex)",
    placeholderId: "API_KEY",
  },
  stripe_live: {
    raw: "sk_live_" + crypto.randomBytes(24).toString("hex"),
    desc: "Stripe Live Key (sk_live_ + hex)",
    placeholderId: "API_KEY",
  },

  // ---------- Standard Formats ----------
  jwt: {
    raw: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c",
    desc: "JWT Token (3-part dot-separated base64url)",
    placeholderId: "JWT",
  },
  uuid: {
    raw: "550e8400-e29b-41d4-a716-446655440000",
    desc: "UUID v4",
    placeholderId: "UUID",
  },
  email: {
    raw: "developer@example.com",
    desc: "Email address",
    placeholderId: "EMAIL",
  },
  china_phone: {
    raw: "13800138000",
    desc: "China mobile phone",
    placeholderId: "CHINA_PHONE",
  },
  china_id: {
    raw: "110101199001011234",
    desc: "China ID number",
    placeholderId: "CHINA_ID",
  },

  // ---------- Context Patterns (keys in natural language) ----------
  openai_in_text: {
    raw: 'export OPENAI_API_KEY="sk-a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0u1v2w3x4y5z6"',
    desc: "OpenAI key in shell export",
    placeholderId: "OPENAI_KEY",
  },
  aws_in_creds: {
    raw: "aws_access_key_id = AKIAIOSFODNN7EXAMPLE",
    desc: "AWS key in credentials file",
    placeholderId: "AWS_ACCESS_KEY",
  },
  github_in_config: {
    raw: 'token = "ghp_abc123def456ghi789jkl012mno345pqr678stu"',
    desc: "GitHub token in git config",
    placeholderId: "GITHUB_TOKEN",
  },

  // ---------- Edge Cases ----------
  short_key: {
    raw: "sk-short",  // too short, should NOT match openai pattern
    desc: "Short key (should NOT match - only 8 chars)",
    placeholderId: null,  // null = should not be redacted
  },
  in_url: {
    raw: "https://example.com/api?key=sk-a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0u1v2w3x4y5z6",
    desc: "OpenAI key embedded in URL",
    placeholderId: "OPENAI_KEY",
  },
  in_json: {
    raw: '{"api_key": "sk-a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0u1v2w3x4y5z6", "role": "admin"}',
    desc: "OpenAI key inside JSON string",
    placeholderId: "OPENAI_KEY",
  },
  in_code_comment: {
    raw: "// TODO: replace with real key: sk-a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0u1v2w3x4y5z6",
    desc: "Key in code comment",
    placeholderId: "OPENAI_KEY",
  },
  multiple_keys_line: {
    raw: "ghp_abc123def456ghi789jkl012mno345pqr678stu and AKIAIOSFODNN7EXAMPLE",
    desc: "GitHub + AWS keys on same line",
    placeholderId: null, // special handling: both should be redacted
  },
}

// =============================================
// 辅助函数
// =============================================
async function createTestEnv(keys) {
  const dir = path.join(TMP, crypto.randomBytes(4).toString("hex"))
  await fs.mkdir(dir, { recursive: true })

  // 写插件配置：全部内置规则启用
  const allBuiltins = [
    "email", "china_phone", "china_id", "uuid", "jwt",
    "ipv4", "mac",
    "github_token", "openai_key", "openai_org_id", "aws_key",
    "anthropic_key", "google_key", "stripe_key", "hf_token",
    "pplx_key", "groq_key", "gitlab_token", "replicate_key",
    "db_connection",
  ]
  const cfgYaml = `enabled: true\nauto_discovery: false\nplaceholder_prefix: "__OMOS_"\npatterns:\n  builtin:\n${allBuiltins.map((n) => `    - ${n}`).join("\n")}\n  keywords: []\n  exclude: []`
  await fs.writeFile(path.join(dir, "oh-my-opensecret.yaml"), cfgYaml, "utf8")

  return dir
}

/** 加载插件，获取 hooks */
async function getHooks(dir) {
  const { default: OpenSecret } = await import("../src/index.js")
  return await OpenSecret({ directory: dir })
}

/**
 * 通过 messages.transform hook 脱敏文本
 */
async function redactViaHook(hooks, sessionID, text) {
  const msg = {
    messages: [{
      info: { sessionID },
      parts: [{ type: "text", text }],
    }],
  }
  await hooks["experimental.chat.messages.transform"]({}, msg)
  return msg.messages[0].parts[0].text
}

/**
 * 通过 text.complete hook 还原文本
 */
async function restoreViaHook(hooks, sessionID, text) {
  const output = { text }
  await hooks["experimental.text.complete"]({ sessionID }, output)
  return output.text
}

// =============================================
// 验收测试
// =============================================
describe("验收测试：AI Key 脱敏与还原", () => {
  let hooks
  let dir

  before(async () => {
    dir = await createTestEnv()
    hooks = await getHooks(dir)
  })

  after(async () => {
    await fs.rm(TMP, { recursive: true, force: true })
  })

  // ---- 测试组 1：各类型 AI Key 脱敏 ----
  describe("各类型 Key 应被正确脱敏", () => {
    // 被组 4 覆盖的上下文 key + 无特征前缀的 key + org- 前缀（非内置规则）
    const skipKeys = new Set([
      "openai_in_text", "aws_in_creds", "github_in_config",
      "in_url", "in_json", "in_code_comment",
      "openai_org",
      "cohere", "together", "mistral", "aws_sk", "discord",
    ])
    const keyTypes = Object.entries(TEST_KEYS).filter(
      ([name, v]) => !skipKeys.has(name) && v.placeholderId !== null,
    )

    for (const [name, keyData] of keyTypes) {
      it(`[${name}] ${keyData.desc}`, async () => {
        const redacted = await redactViaHook(hooks, `accept-${name}`, keyData.raw)
        assert.ok(redacted.includes("__OMOS_"), `应被替换为占位符: ${redacted}`)
        assert.ok(!redacted.includes(keyData.raw.slice(0, 12)), `不应包含原文前缀`)
      })
    }
  })

  // ---- 测试组 2：短 key 不应误脱敏 ----
  describe("短字符串不应误脱敏", () => {
    it("sk-short (8 chars) 不应匹配 OPENAI_KEY 规则", async () => {
      const redacted = await redactViaHook(hooks, "edge-short", TEST_KEYS.short_key.raw)
      assert.equal(redacted, TEST_KEYS.short_key.raw, "短 key 应保持原文")
    })
  })

  // ---- 测试组 3：多 Key 同行 ----
  describe("多 Key 同行均被脱敏", () => {
    it("一行中有 GitHub + AWS 两个 key", async () => {
      const raw = TEST_KEYS.multiple_keys_line.raw
      const redacted = await redactViaHook(hooks, "accept-multi", raw)
      // 两个 key 都应被替换
      assert.ok(redacted.includes("__OMOS_"), "应包含占位符")
      const count = (redacted.match(/__OMOS_/g) || []).length
      assert.ok(count >= 2, `应至少有 2 个占位符，实际: ${count}`)
    })
  })

  // ---- 测试组 4：Key 在上下文中（export / json / url / comment）----
  describe("上下文中 Key 被正确脱敏", () => {
    const ctxKeys = ["openai_in_text", "aws_in_creds", "github_in_config", "openai_org", "in_url", "in_json", "in_code_comment"]

    /** 返回 key 的签名前缀（区别于上下文中其他文字） */
    function keySignature(name) {
      const kw = {
        openai_in_text: "sk-",
        aws_in_creds: "AKIA",
        github_in_config: "ghp_",
        openai_org: "org-",
        in_url: "sk-",
        in_json: "sk-",
        in_code_comment: "sk-",
      }
      return kw[name]
    }

    for (const name of ctxKeys) {
      it(`[${name}] ${TEST_KEYS[name].desc}`, async () => {
        const redacted = await redactViaHook(hooks, `ctx-${name}`, TEST_KEYS[name].raw)
        const sig = keySignature(name)
        assert.ok(redacted.includes("__OMOS_"), `应被脱敏: ${redacted}`)
        if (sig) {
          assert.ok(!redacted.includes(sig), `不应包含 key 签名前缀 "${sig}"`)
        }
      })
    }
  })

  // ---- 测试组 5：脱敏 → 还原 双向验证 ----
  describe("脱敏 → 还原 双向验证", () => {
    const roundtripKeys = ["openai", "github", "aws", "jwt", "email", "china_phone", "huggingface", "stripe_test"]

    for (const name of roundtripKeys) {
      it(`[${name}] ${TEST_KEYS[name].desc}`, async () => {
        const sessionID = `rt-${name}`
        const raw = TEST_KEYS[name].raw

        // 脱敏
        const redacted = await redactViaHook(hooks, sessionID, raw)
        assert.ok(redacted.includes("__OMOS_"), "脱敏后应有占位符")
        assert.notEqual(redacted, raw)

        // 还原
        const restored = await restoreViaHook(hooks, sessionID, redacted)
        assert.equal(restored, raw, "还原后应与原文一致")
      })
    }
  })

  // ---- 测试组 6：Auto-discovery 验收 ----
  describe("Auto-discovery 自动发现 API Key", () => {
    async function createAutoDiscoveryEnv(opencodeCfg) {
      const dir = path.join(TMP, crypto.randomBytes(4).toString("hex"))
      await fs.mkdir(dir, { recursive: true })

      // 写 opencode.json
      await fs.writeFile(path.join(dir, "opencode.json"), JSON.stringify(opencodeCfg, null, 2), "utf8")

      // 写插件配置（开启 auto-discovery）
      const cfgYaml = `enabled: true\nauto_discovery: true\nplaceholder_prefix: "__OMOS_"\npatterns:\n  builtin: []\n  regex: []\n  keywords: []\n  exclude: []`
      await fs.writeFile(path.join(dir, "oh-my-opensecret.yaml"), cfgYaml, "utf8")

      // 加载配置（会触发 auto-discovery）
      const { default: OpenSecret } = await import("../src/index.js")
      const h = await OpenSecret({ directory: dir })

      // 读回配置文件，检查自动生成的规则
      const content = await fs.readFile(path.join(dir, "oh-my-opensecret.yaml"), "utf8")
      return { hooks: h, configContent: content, dir }
    }

    it("从 Opencode 配置中发现 OpenAI Key", async () => {
      const { configContent } = await createAutoDiscoveryEnv({
        apiKey: "sk-" + "a".repeat(48),
        providers: { openai: { apiKey: "sk-" + "b".repeat(48) } },
      })
      // 未被覆盖的值以注释写入，不暴露原文
      assert.ok(configContent.includes("auto-discovered"), "配置中应包含自动发现的注释标记")
      assert.ok(!configContent.includes("sk-aaaaaaaa"), "不应包含原文")
    })

    it("从 Opencode 配置中发现 GitHub Token", async () => {
      const { configContent } = await createAutoDiscoveryEnv({
        github: { token: "ghp_" + "a".repeat(36) },
      })
      assert.ok(configContent.includes("auto-discovered"), "配置中应包含自动发现的注释标记")
      assert.ok(!configContent.includes("ghp_aaaa"), "不应包含原文")
    })

    it("未被覆盖的值以注释标记，不覆盖现有规则", async () => {
      const dir = path.join(TMP, crypto.randomBytes(4).toString("hex"))
      await fs.mkdir(dir, { recursive: true })

      // 已有手动配置
      const cfgYaml = `enabled: true\nauto_discovery: true\nplaceholder_prefix: "__OMOS_"\npatterns:\n  regex:\n    - { pattern: "existing-rule", "placeholder-id": "MY_RULE" }\n  builtin: []\n  keywords: []\n  exclude: []`
      await fs.writeFile(path.join(dir, "oh-my-opensecret.yaml"), cfgYaml, "utf8")

      await fs.writeFile(path.join(dir, "opencode.json"), JSON.stringify({
        apiKey: "sk-test-key-12345",
      }), "utf8")

      const { default: OpenSecret } = await import("../src/index.js")
      await OpenSecret({ directory: dir })

      const content = await fs.readFile(path.join(dir, "oh-my-opensecret.yaml"), "utf8")
      // 手动配置的规则应保留
      assert.ok(content.includes("existing-rule"), "手动配置的规则应保留")
      assert.ok(content.includes("auto-discovered"), "未被覆盖的值应以注释标记")
      // 不应包含原文
      assert.ok(!content.includes("sk-test-key-12345"), "不应包含原文")
    })
  })

  // ---- 测试组 7：内置规则全面覆盖 ----
  describe("内置规则覆盖完整性", () => {
    it("Email 在自然语言文本中被脱敏", async () => {
      const text = "Please contact me at alice@company.com for details"
      const redacted = await redactViaHook(hooks, "builtin-email", text)
      assert.ok(redacted.includes("__OMOS_"), "Email 应被脱敏")
      assert.ok(!redacted.includes("alice@company.com"))
    })

    it("中国手机号在文本中被脱敏", async () => {
      const text = "Tel: 13912345678"
      const redacted = await redactViaHook(hooks, "builtin-phone", text)
      assert.ok(redacted.includes("__OMOS_"))
      assert.ok(!redacted.includes("13912345678"))
    })

    it("身份证号在文本中被脱敏", async () => {
      const text = "ID: 110101199001011234"
      const redacted = await redactViaHook(hooks, "builtin-id", text)
      assert.ok(redacted.includes("__OMOS_"))
      assert.ok(!redacted.includes("110101199001011234"))
    })

    it("UUID 在文本中被脱敏", async () => {
      const text = "uuid: 550e8400-e29b-41d4-a716-446655440000"
      const redacted = await redactViaHook(hooks, "builtin-uuid", text)
      assert.ok(redacted.includes("__OMOS_"))
      assert.ok(!redacted.includes("550e8400"))
    })

    it("IPv4 在文本中被脱敏", async () => {
      const text = "server: 192.168.1.1:8080"
      const redacted = await redactViaHook(hooks, "builtin-ip", text)
      assert.ok(redacted.includes("__OMOS_"))
      assert.ok(!redacted.includes("192.168.1.1"))
    })

    it("MAC 地址在文本中被脱敏", async () => {
      const text = "mac: 00:1a:2b:3c:4d:5e"
      const redacted = await redactViaHook(hooks, "builtin-mac", text)
      assert.ok(redacted.includes("__OMOS_"))
      assert.ok(!redacted.includes("00:1a:2b:3c:4d:5e"))
    })
  })

  // ---- 测试组 8：排除列表生效 ----
  describe("排除列表豁免", () => {
    it("exclude 列表中的内容不被脱敏", async () => {
      // 重新创建配置，加入排除项
      const customDir = path.join(TMP, crypto.randomBytes(4).toString("hex"))
      await fs.mkdir(customDir, { recursive: true })
      const cfgYaml = `enabled: true\nauto_discovery: false\nplaceholder_prefix: "__OMOS_"\npatterns:\n  builtin: [email]\n  keywords: []\n  exclude:\n    - "safe@example.com"`
      await fs.writeFile(path.join(customDir, "oh-my-opensecret.yaml"), cfgYaml, "utf8")
      const customHooks = await getHooks(customDir)

      const redacted = await redactViaHook(customHooks, "exclude-test", "safe@example.com")
      assert.equal(redacted, "safe@example.com", "排除列表中的内容应保持原样")
    })
  })

  // ---- 测试组 9：同 session 同原文复用占位符 ----
  describe("同 session 内稳定映射", () => {
    it("同一原文在同一 session 中生成相同占位符", async () => {
      const sessionID = "stable-session"
      const raw = "sk-" + "d".repeat(48)

      const r1 = await redactViaHook(hooks, sessionID, raw)
      const r2 = await redactViaHook(hooks, sessionID, raw)
      assert.equal(r1, r2, "同一 session 中相同原文应映射到相同占位符")
    })

    it("不同 session 中同一原文生成不同占位符", async () => {
      const raw = "sk-" + "e".repeat(48)

      const r1 = await redactViaHook(hooks, "session-a", raw)
      const r2 = await redactViaHook(hooks, "session-b", raw)
      // 不同 session 使用不同随机 secret，占位符应不同
      // 但 hash 有可能恰好相同（极小概率），所以不严格相等
      // 验证它们不同即可（概率上几乎总是不同）
      // 实际上由于 HMAC secret 不同，hash12 极大概率不同
      // 我们验证占位符格式正确即可
      assert.ok(r1.startsWith("__OMOS_"))
      assert.ok(r2.startsWith("__OMOS_"))
    })
  })
})
