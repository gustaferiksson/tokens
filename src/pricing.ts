import { homedir } from "node:os"
import { join } from "node:path"

const PRICING_URL = "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json"
const CACHE_PATH = join(homedir(), ".cache", "tokens", "pricing.json")
const TTL_MS = 7 * 24 * 60 * 60 * 1000

export type ModelPricing = {
    input: number
    output: number
    cacheWrite: number
    cacheRead: number
}

type CacheFile = {
    fetchedAt: number
    source: string
    models: Record<string, ModelPricing>
}

type LiteLLMEntry = {
    litellm_provider?: string
    input_cost_per_token?: number
    output_cost_per_token?: number
    cache_creation_input_token_cost?: number
    cache_read_input_token_cost?: number
}

const num = (x: unknown): number => (typeof x === "number" && Number.isFinite(x) ? x : 0)

const extractAnthropic = (raw: Record<string, LiteLLMEntry>): Record<string, ModelPricing> => {
    const out: Record<string, ModelPricing> = {}
    for (const [name, entry] of Object.entries(raw)) {
        if (entry?.litellm_provider !== "anthropic") continue
        out[name] = {
            input: num(entry.input_cost_per_token),
            output: num(entry.output_cost_per_token),
            cacheWrite: num(entry.cache_creation_input_token_cost),
            cacheRead: num(entry.cache_read_input_token_cost),
        }
    }
    return out
}

const readCache = async (): Promise<CacheFile | undefined> => {
    const file = Bun.file(CACHE_PATH)
    if (!(await file.exists())) return undefined
    try {
        return (await file.json()) as CacheFile
    } catch {
        return undefined
    }
}

const writeCache = async (data: CacheFile): Promise<void> => {
    await Bun.write(CACHE_PATH, JSON.stringify(data, null, 2))
}

const fetchFresh = async (): Promise<CacheFile> => {
    const res = await fetch(PRICING_URL)
    if (!res.ok) throw new Error(`pricing fetch failed: ${res.status}`)
    const raw = (await res.json()) as Record<string, LiteLLMEntry>
    return { fetchedAt: Date.now(), source: PRICING_URL, models: extractAnthropic(raw) }
}

export const loadPricing = async (forceRefresh = false): Promise<CacheFile> => {
    const cached = await readCache()
    const fresh = cached && !forceRefresh && Date.now() - cached.fetchedAt < TTL_MS
    if (fresh && cached) return cached

    try {
        const data = await fetchFresh()
        await writeCache(data)
        return data
    } catch (err) {
        if (cached) {
            console.error(`warning: pricing refresh failed, using stale cache (${err})`)
            return cached
        }
        throw err
    }
}

// Match a logged model id against the pricing table. LiteLLM keys are like
// "claude-opus-4-5-20250101", "claude-sonnet-4-5", etc. Logged ids are
// "claude-opus-4-7", "claude-haiku-4-5-20251001". Try exact, then prefix.
export const findPricing = (model: string, table: Record<string, ModelPricing>): ModelPricing | undefined => {
    if (table[model]) return table[model]

    // Strip date suffix: claude-haiku-4-5-20251001 -> claude-haiku-4-5
    const stripped = model.replace(/-\d{8}$/, "")
    if (table[stripped]) return table[stripped]

    // Prefix match — pick the longest matching key (most specific)
    const candidates = Object.keys(table).filter((k) => stripped.startsWith(k) || k.startsWith(stripped))
    candidates.sort((a, b) => b.length - a.length)
    return candidates[0] ? table[candidates[0]] : undefined
}

export const computeCost = (
    p: ModelPricing,
    tokens: { input: number; output: number; cacheWrite: number; cacheRead: number }
): number => {
    return (
        tokens.input * p.input +
        tokens.output * p.output +
        tokens.cacheWrite * p.cacheWrite +
        tokens.cacheRead * p.cacheRead
    )
}
