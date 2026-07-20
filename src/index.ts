import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

const PROVIDER_ID = "parley"
const BASE_URL = "https://parley.api.mit.edu/v1"
const KEY_PREFIX = "sk-parley-v1-"
const DATA_DIR = path.join(process.env.XDG_DATA_HOME ?? path.join(os.homedir(), ".local", "share"), "opencode")
const COST_FILE = path.join(DATA_DIR, "parley-cost.json")
const LOGIN_HINT = "Run `opencode auth login` and select MIT Parley (or set PARLEY_API_KEY)."

// Per-million-token rates configured in Parley (USD). Used both for opencode's
// built-in per-message cost display and for local estimates.
const RATES: Record<string, { input: number; output: number; cache_read?: number; cache_write?: number }> = {
  "bedrock/claude-haiku-4-5": { input: 1.0, output: 5.0, cache_read: 0.1, cache_write: 2.0 },
  "bedrock/claude-sonnet-4-6": { input: 3.0, output: 15.0, cache_read: 0.3, cache_write: 6.0 },
  "bedrock/claude-sonnet-5": { input: 2.0, output: 10.0, cache_read: 0.2, cache_write: 4.0 },
  "bedrock/claude-opus-4-8": { input: 5.0, output: 25.0, cache_read: 0.5, cache_write: 10.0 },
  "bedrock/claude-opus-4-7": { input: 5.0, output: 25.0, cache_read: 0.5, cache_write: 10.0 },
  "openai/gpt-5.6-luna": { input: 1.0, output: 6.0 },
  "openai/gpt-5.6-terra": { input: 2.5, output: 15.0 },
  "openai/gpt-5.6-sol": { input: 5.0, output: 30.0 },
  "openai/gpt-5.4-nano": { input: 0.2, output: 1.25 },
  "openai/gpt-5.4-mini": { input: 0.75, output: 4.5 },
  "openai/gpt-5.4": { input: 2.5, output: 15.0 },
  "openai/gpt-5.5": { input: 5.0, output: 30.0 },
  "google/gemini-3.0-flash": { input: 0.5, output: 3.0 },
  "google/gemini-3.1-pro": { input: 4.0, output: 18.0 },
  "bedrock/llama-4-maverick-17b": { input: 0, output: 0 },
}

// Fallback chat-model catalog if /v1/models is unreachable at startup.
const FALLBACK_MODELS: Record<string, string> = {
  "bedrock/claude-haiku-4-5": "Claude Haiku 4.5",
  "bedrock/claude-sonnet-4-6": "Claude Sonnet 4.6",
  "bedrock/claude-sonnet-5": "Claude Sonnet 5",
  "bedrock/claude-opus-4-7": "Claude Opus 4.7",
  "bedrock/claude-opus-4-8": "Claude Opus 4.8",
  "bedrock/llama-4-maverick-17b": "Llama 4 Maverick 17B Instruct",
  "openai/gpt-5.4": "GPT-5.4",
  "openai/gpt-5.4-mini": "GPT-5.4 mini",
  "openai/gpt-5.4-nano": "GPT-5.4 nano",
  "openai/gpt-5.5": "GPT-5.5",
  "openai/gpt-5.6-luna": "GPT-5.6 Luna",
  "openai/gpt-5.6-sol": "GPT-5.6 Sol",
  "openai/gpt-5.6-terra": "GPT-5.6 Terra",
  "google/gemini-3.0-flash": "Gemini 3.0 Flash",
  "google/gemini-3.1-pro": "Gemini 3.1 Pro",
}

// Embedding / image models can't be used as chat models in opencode.
const NON_CHAT = /embed|image|titan-embed/i

const num = (n: unknown) => (typeof n === "number" ? n.toLocaleString("en-US") : "?")
const usd = (n: unknown) => (typeof n === "number" ? `$${n.toFixed(4)}` : "?")

function limitsFor(id: string) {
  if (id.startsWith("bedrock/claude")) return { context: 200_000, output: 64_000 }
  if (id.startsWith("google/")) return { context: 1_048_576, output: 65_536 }
  if (id.startsWith("openai/")) return { context: 272_000, output: 128_000 }
  return { context: 128_000, output: 16_384 }
}

function readDotEnvKey(dir: string, name: string): string | undefined {
  try {
    const raw = fs.readFileSync(path.join(dir, ".env"), "utf8")
    for (const line of raw.split("\n")) {
      const m = line.match(/^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*"?([^"\n]*)"?\s*$/)
      if (m && m[1] === name && m[2]) return m[2]
      // Tolerate a .env that contains just the bare key on its own line
      if (line.trim().startsWith(KEY_PREFIX) && name === "PARLEY_API_KEY") return line.trim()
    }
  } catch {}
  return undefined
}

// Credential stored by `opencode auth login`.
function readStoredAuthKey(): string | undefined {
  try {
    const auth = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "auth.json"), "utf8"))
    const entry = auth?.[PROVIDER_ID]
    if (entry?.type === "api" && typeof entry.key === "string") return entry.key
  } catch {}
  return undefined
}

type CostLog = {
  total: number
  requests: number
  byDay: Record<string, number>
  byModel: Record<string, number>
}

function readCostLog(): CostLog {
  try {
    return { total: 0, requests: 0, byDay: {}, byModel: {}, ...JSON.parse(fs.readFileSync(COST_FILE, "utf8")) }
  } catch {
    return { total: 0, requests: 0, byDay: {}, byModel: {} }
  }
}

function recordCost(amount: number, model: string) {
  if (!Number.isFinite(amount) || amount < 0) return
  try {
    fs.mkdirSync(path.dirname(COST_FILE), { recursive: true })
    const log = readCostLog()
    const day = new Date().toISOString().slice(0, 10)
    log.total += amount
    log.requests += 1
    log.byDay[day] = (log.byDay[day] ?? 0) + amount
    log.byModel[model] = (log.byModel[model] ?? 0) + amount
    fs.writeFileSync(COST_FILE, JSON.stringify(log, null, 2))
  } catch {}
}

export const ParleyPlugin: Plugin = async ({ client, directory }) => {
  // "unknown" until the startup /v1/models check resolves it. Network failures
  // keep it "unknown" so we don't nag people who are just offline.
  let keyState: "ok" | "missing" | "invalid" | "unknown" = "unknown"
  let warned = false

  const resolveKey = () =>
    process.env.PARLEY_API_KEY ?? readDotEnvKey(directory, "PARLEY_API_KEY") ?? readStoredAuthKey()

  async function validateKey(key: string): Promise<boolean> {
    const res = await globalThis.fetch(`${BASE_URL}/models`, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(5000),
    })
    if (res.status === 401 || res.status === 403) return false
    if (!res.ok) throw new Error(`Parley returned ${res.status}`)
    return true
  }

  async function warnKeyProblem() {
    if (warned || (keyState !== "missing" && keyState !== "invalid")) return
    warned = true
    const message =
      keyState === "missing"
        ? `No Parley API key found. ${LOGIN_HINT}`
        : `Your Parley API key was rejected. ${LOGIN_HINT}`
    await client.tui
      .showToast({ body: { title: "MIT Parley", message, variant: "error", duration: 10_000 } })
      .catch(() => {})
  }

  // Wraps fetch so every non-streaming Parley response's x-parley-v1-cost
  // header is accumulated into the local cost log, and auth failures at
  // request time surface as an error toast instead of a silent failure.
  const trackedFetch: typeof globalThis.fetch = async (input, init) => {
    const res = await globalThis.fetch(input as any, init)
    if (res.status === 401 || res.status === 403) {
      keyState = "invalid"
      warned = false
      void warnKeyProblem()
      return res
    }
    const cost = res.headers.get("x-parley-v1-cost")
    if (cost) {
      let model = "unknown"
      try {
        const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined
        if (body?.model) model = String(body.model)
      } catch {}
      recordCost(parseFloat(cost), model)
    }
    return res
  }

  // Authenticated request against the Parley API; parses JSON when possible.
  async function parleyFetch(
    pathname: string,
    init?: RequestInit,
  ): Promise<{ ok: boolean; status: number; body: any }> {
    const key = resolveKey()
    if (!key) return { ok: false, status: 0, body: `No Parley API key found. ${LOGIN_HINT}` }
    const isForm = init?.body instanceof FormData
    const res = await globalThis.fetch(`${BASE_URL}${pathname}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${key}`,
        ...(isForm ? {} : { "Content-Type": "application/json" }),
        ...(init?.headers as Record<string, string> | undefined),
      },
    })
    const text = await res.text()
    let body: any = text
    try {
      body = JSON.parse(text)
    } catch {}
    return { ok: res.ok, status: res.status, body }
  }

  const requireAccountId = (argId?: string) => argId ?? process.env.PARLEY_ACCOUNT_ID

  async function fetchModelCatalog(): Promise<Record<string, string>> {
    const key = resolveKey()
    if (!key) {
      keyState = "missing"
      return FALLBACK_MODELS
    }
    try {
      const res = await globalThis.fetch(`${BASE_URL}/models`, {
        headers: { Authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(4000),
      })
      if (res.status === 401 || res.status === 403) {
        keyState = "invalid"
        return FALLBACK_MODELS
      }
      if (!res.ok) return FALLBACK_MODELS
      const json: any = await res.json()
      const out: Record<string, string> = {}
      for (const m of json.data ?? []) {
        if (typeof m?.id === "string" && !NON_CHAT.test(m.id)) out[m.id] = m.name ?? m.id
      }
      keyState = "ok"
      return Object.keys(out).length ? out : FALLBACK_MODELS
    } catch {
      return FALLBACK_MODELS
    }
  }

  return {
    // Registers "parley" as a provider so it (and all its models) show up in
    // the model picker. Models are pulled live from /v1/models.
    config: async (config) => {
      const catalog = await fetchModelCatalog()
      const models: Record<string, any> = {}
      for (const [id, name] of Object.entries(catalog)) {
        const rate = RATES[id]
        models[id] = {
          name: `${name} (Parley)`,
          tool_call: true,
          limit: limitsFor(id),
          ...(rate
            ? {
                cost: {
                  input: rate.input,
                  output: rate.output,
                  ...(rate.cache_read !== undefined ? { cache_read: rate.cache_read } : {}),
                  ...(rate.cache_write !== undefined ? { cache_write: rate.cache_write } : {}),
                },
              }
            : {}),
        }
      }

      // Slash commands so usage/budget can be checked directly from the TUI
      // (/parley_usage, /parley_budget, /parley_cost). Commands are prompt
      // templates, so they instruct the agent to call the matching tool.
      config.command = {
        parley_usage: {
          description: "Show MIT Parley billed usage (args: [from] [to] as YYYY-MM-DD, optional)",
          template:
            "Call the parley_usage tool with breakdown set to true. If dates were provided in '$ARGUMENTS', pass the first as `from` and the second as `to` (YYYY-MM-DD); otherwise omit them for the current billing month. Then present the result exactly as returned, without commentary. If the tool reports a missing account ID or API key, relay its instructions.",
        },
        parley_budget: {
          description: "Show or update MIT Parley budget alert limits (no args = show)",
          template:
            "Manage MIT Parley budgets. Instructions: '$ARGUMENTS'. If the instructions are empty, call the parley_budget tool with action 'get' (scope 'account') and present the result. Otherwise interpret the instructions (e.g. 'set monthly limit 50 alert at 80', 'show api key budgets') and call parley_budget with the matching action, scope, limits, and thresholds — thresholds must be 0 or 50-95. Confirm what was changed. If the tool reports a missing account ID or API key, relay its instructions.",
        },
        parley_cost: {
          description: "Show locally tracked MIT Parley spend from cost headers",
          template:
            "Call the parley_cost tool and present the result exactly as returned, without commentary.",
        },
        ...config.command,
      }

      const existing = (config.provider ?? {})[PROVIDER_ID] as any
      const key = resolveKey()
      config.provider = {
        ...config.provider,
        [PROVIDER_ID]: {
          npm: "@ai-sdk/openai-compatible",
          name: "MIT Parley",
          ...existing,
          options: {
            baseURL: BASE_URL,
            ...(key ? { apiKey: key } : {}),
            ...existing?.options,
          },
          models: { ...models, ...existing?.models },
        },
      }
    },

    // Surfaces the missing/invalid-key error in the TUI once the user starts
    // interacting (an early toast would fire before the TUI is attached).
    event: async ({ event }) => {
      if (event.type.startsWith("session.") || event.type.startsWith("message.")) {
        await warnKeyProblem()
      }
    },

    // `opencode auth login` → MIT Parley → paste sk-parley-v1-... key.
    // The key is format-checked at the prompt and verified live against
    // /v1/models before it is accepted.
    auth: {
      provider: PROVIDER_ID,
      methods: [
        {
          type: "api",
          label: "Parley API key (sk-parley-v1-...)",
          prompts: [
            {
              type: "text",
              key: "key",
              message: "Paste your Parley API key (from your MIT IS&T administrator)",
              placeholder: `${KEY_PREFIX}...`,
              validate: (value: string) =>
                value.trim().startsWith(KEY_PREFIX) ? undefined : `Parley keys start with ${KEY_PREFIX}`,
            },
          ],
          authorize: async (inputs) => {
            const key = inputs?.key?.trim()
            if (!key) return { type: "failed" as const }
            const ok = await validateKey(key).catch(() => false)
            if (!ok) return { type: "failed" as const }
            keyState = "ok"
            warned = false
            return { type: "success" as const, key }
          },
        },
      ],
      loader: async (getAuth) => {
        const auth: any = await getAuth().catch(() => undefined)
        const key =
          process.env.PARLEY_API_KEY ??
          readDotEnvKey(directory, "PARLEY_API_KEY") ??
          (auth?.type === "api" ? auth.key : undefined)
        return {
          baseURL: BASE_URL,
          ...(key ? { apiKey: key } : {}),
          fetch: trackedFetch,
        }
      },
    },

    tool: {
      parley_cost: tool({
        description:
          "Show locally tracked MIT Parley spend, accumulated from x-parley-v1-cost response headers (non-streaming requests only). Streaming chat costs appear in opencode's own per-message cost display instead.",
        args: {},
        async execute() {
          const log = readCostLog()
          if (!log.requests) return "No Parley costs recorded locally yet."
          const days = Object.entries(log.byDay).sort().slice(-14)
          const models = Object.entries(log.byModel).sort((a, b) => b[1] - a[1])
          return [
            `Total tracked spend: $${log.total.toFixed(6)} across ${log.requests} requests`,
            "",
            "By model:",
            ...models.map(([m, c]) => `  ${m}: $${c.toFixed(6)}`),
            "",
            "Last days:",
            ...days.map(([d, c]) => `  ${d}: $${c.toFixed(6)}`),
            "",
            `Log file: ${COST_FILE}`,
          ].join("\n")
        },
      }),

      parley_usage: tool({
        description:
          "Query MIT Parley's aggregate usage API (authoritative billed spend) for an account and date range, optionally with a per-request breakdown aggregated by model. Requires an account ID (arg or PARLEY_ACCOUNT_ID env var).",
        args: {
          from: tool.schema.string().describe("Start date YYYY-MM-DD (default: current billing month)").optional(),
          to: tool.schema.string().describe("End date YYYY-MM-DD").optional(),
          breakdown: tool.schema.boolean().describe("Include per-request breakdown, summarized by model").optional(),
          accountId: tool.schema.string().describe("Parley account ID (default: PARLEY_ACCOUNT_ID env var)").optional(),
        },
        async execute(args) {
          const accountId = requireAccountId(args.accountId)
          if (!accountId)
            return "No account ID. Pass accountId or set PARLEY_ACCOUNT_ID (find it in the Parley dashboard)."
          const qs = new URLSearchParams()
          if (args.from) qs.set("from", args.from)
          if (args.to) qs.set("to", args.to)
          if (args.breakdown) qs.set("breakdown", "true")
          const q = qs.size ? `?${qs}` : ""
          const { ok, status, body } = await parleyFetch(`/accounts/${encodeURIComponent(accountId)}/usage${q}`)
          if (!ok) return `Usage API error ${status}: ${typeof body === "string" ? body : JSON.stringify(body)}`

          const inTok = body.totalPromptTokens ?? body.totalInputTokens
          const outTok = body.totalCompletionTokens ?? body.totalOutputTokens
          const lines = [
            `Parley usage ${String(body.periodStart).slice(0, 10)} → ${String(body.periodEnd).slice(0, 10)} (account ${accountId})`,
            `Cost: ${usd(body.costUsd)} | Requests: ${num(body.interactionsCount)}`,
            `Tokens: input ${num(inTok)} (cached ${num(body.totalCachePromptTokens ?? 0)}) | output ${num(outTok)} (cached ${num(body.totalCacheCompletionTokens ?? 0)})`,
          ]
          if (Array.isArray(body.breakdown)) {
            const byModel: Record<string, { cost: number; requests: number; tokens: number }> = {}
            for (const r of body.breakdown) {
              const m = (byModel[r.model ?? "unknown"] ??= { cost: 0, requests: 0, tokens: 0 })
              m.cost += r.costUsd ?? 0
              m.requests += 1
              m.tokens += r.totalTokens ?? 0
            }
            lines.push("", "By model:")
            for (const [model, m] of Object.entries(byModel).sort((a, b) => b[1].cost - a[1].cost)) {
              lines.push(`  ${model}: ${usd(m.cost)} across ${m.requests} requests (${num(m.tokens)} tokens)`)
            }
          }
          return lines.join("\n")
        },
      }),

      parley_budget: tool({
        description:
          "Get or set MIT Parley budget alert limits (soft limits: notification emails only, API calls are never blocked) at the account level or across the account's API keys. Thresholds are percentages (0 = no alert, otherwise 50-95). Note: these endpoints may require admin credentials; plain API keys can be rejected.",
        args: {
          action: tool.schema.enum(["get", "set"]).describe("Read current limits, or update them"),
          scope: tool.schema
            .enum(["account", "api-keys"])
            .describe("Account-level budget, or per-API-key budgets (default: account)")
            .optional(),
          accountId: tool.schema.string().describe("Parley account ID (default: PARLEY_ACCOUNT_ID env var)").optional(),
          monthlyBudgetLimit: tool.schema.number().describe("Monthly alert limit in USD (0 = no limit)").optional(),
          termBudgetLimit: tool.schema.number().describe("Term alert limit in USD (0 = no limit)").optional(),
          monthlyBudgetLimitAlertThreshold: tool.schema
            .number()
            .describe("Percent of monthly limit that triggers the alert email (0 or 50-95)")
            .optional(),
          termBudgetLimitAlertThreshold: tool.schema
            .number()
            .describe("Percent of term limit that triggers the alert email (0 or 50-95)")
            .optional(),
        },
        async execute(args) {
          const accountId = requireAccountId(args.accountId)
          if (!accountId)
            return "No account ID. Pass accountId or set PARLEY_ACCOUNT_ID (find it in the Parley dashboard)."
          const pathName = `/accounts/${encodeURIComponent(accountId)}/budget${args.scope === "api-keys" ? "/api-keys" : ""}`

          const fmt = (b: any, label?: string) =>
            [
              ...(label ? [label] : []),
              `  Monthly limit: ${b.monthlyBudgetLimit ? `$${b.monthlyBudgetLimit} (alert at ${b.monthlyBudgetLimitAlertThreshold || "none"}%)` : "none"}${b.monthlyBudgetReached ? " — REACHED" : ""}`,
              `  Term limit: ${b.termBudgetLimit ? `$${b.termBudgetLimit} (alert at ${b.termBudgetLimitAlertThreshold || "none"}%)` : "none"}${b.termBudgetReached ? " — REACHED" : ""}`,
            ].join("\n")

          if (args.action === "get") {
            const { ok, status, body } = await parleyFetch(pathName)
            if (!ok) return `Budget API error ${status}: ${typeof body === "string" ? body : JSON.stringify(body)}`
            if (Array.isArray(body))
              return body.length
                ? body.map((k: any) => fmt(k, `API key ${k.hashedApiKey ?? "?"}:`)).join("\n")
                : "No API-key budgets configured."
            return fmt(body, `Budget for account ${accountId}:`)
          }

          for (const t of [args.monthlyBudgetLimitAlertThreshold, args.termBudgetLimitAlertThreshold]) {
            if (t !== undefined && t !== 0 && (t < 50 || t > 95))
              return "Alert thresholds must be 0 (disabled) or between 50 and 95."
          }
          const payload: Record<string, number> = {}
          for (const f of [
            "monthlyBudgetLimit",
            "termBudgetLimit",
            "monthlyBudgetLimitAlertThreshold",
            "termBudgetLimitAlertThreshold",
          ] as const) {
            if (args[f] !== undefined) payload[f] = args[f]
          }
          if (!Object.keys(payload).length) return "Nothing to set — provide at least one limit or threshold."
          const { ok, status, body } = await parleyFetch(pathName, { method: "POST", body: JSON.stringify(payload) })
          if (!ok) return `Budget API error ${status}: ${typeof body === "string" ? body : JSON.stringify(body)}`
          return `Budget limits updated (${args.scope === "api-keys" ? "all API keys under" : "account"} ${accountId}): ${JSON.stringify(payload)}`
        },
      }),

      parley_count_tokens: tool({
        description:
          "Estimate input token usage for a prompt via Parley's /v1/messages/count_tokens endpoint, without sending it to a model (free).",
        args: {
          text: tool.schema.string().describe("The user message content to count"),
          model: tool.schema.string().describe("Model ID (default: bedrock/claude-sonnet-5)").optional(),
          system: tool.schema.string().describe("Optional system prompt to include in the count").optional(),
        },
        async execute(args) {
          const model = args.model ?? "bedrock/claude-sonnet-5"
          const { ok, status, body } = await parleyFetch("/messages/count_tokens", {
            method: "POST",
            body: JSON.stringify({
              model,
              messages: [{ role: "user", content: args.text }],
              ...(args.system ? { system: args.system } : {}),
            }),
          })
          if (!ok) return `count_tokens error ${status}: ${typeof body === "string" ? body : JSON.stringify(body)}`
          return `${num(body.input_tokens)} input tokens for ${model}`
        },
      }),

    },
  }
}

export default ParleyPlugin
