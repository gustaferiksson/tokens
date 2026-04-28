#! /usr/bin/env bun

// Per-subagent status line. Wired into Claude Code via the
// `subagentStatusLine` setting; CC invokes this command once per row in
// the subagent panel and pipes per-row JSON on stdin. The exact schema
// is not formally documented, so we read defensively from a few
// plausible field locations.

type SubagentInput = {
    transcript_path?: string
    transcript?: string
    log_path?: string
    cwd?: string
    model?: { id?: string; display_name?: string } | string
    agent?: { name?: string; id?: string } | string
    subagent?: { name?: string; id?: string }
    name?: string
    start_time?: string
    started_at?: string
    createdAt?: string
}

type AssistantPayload = {
    timestamp?: string
    requestId?: string
    message?: {
        id?: string
        usage?: {
            input_tokens?: number
            output_tokens?: number
            cache_creation_input_tokens?: number
            cache_read_input_tokens?: number
        }
    }
}

type RawLine = AssistantPayload & {
    timestamp?: string
    data?: { message?: AssistantPayload }
}

type Totals = { input: number; output: number; cacheWrite: number; cacheRead: number }

const ESC = String.fromCharCode(27)
const useColor = process.env.NO_COLOR === undefined
const wrap = (code: string, s: string) => (useColor ? `${ESC}[${code}m${s}${ESC}[0m` : s)
const dim = (s: string) => wrap("2", s)
const cyan = (s: string) => wrap("36", s)
const gray = (s: string) => wrap("90", s)

const fmtTokens = (n: number): string => {
    if (n < 1000) return `${n}`
    if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}K`
    return `${(n / 1_000_000).toFixed(2)}M`
}

const fmtElapsed = (ms: number): string => {
    const sec = Math.max(0, Math.floor(ms / 1000))
    if (sec < 60) return `${sec}s`
    const min = Math.floor(sec / 60)
    const s = sec % 60
    if (min < 60) return s ? `${min}m ${s}s` : `${min}m`
    const h = Math.floor(min / 60)
    const m = min % 60
    return `${h}h ${String(m).padStart(2, "0")}m`
}

const prettyModel = (s: string): string => s.replace(/^claude-/, "").replace(/-\d{8}$/, "")

const parseLine = (line: string): { ts: number; usage: Totals; dedupeKey?: string } | undefined => {
    if (!line || !line.includes('"usage"')) return undefined
    let obj: RawLine
    try {
        obj = JSON.parse(line) as RawLine
    } catch {
        return undefined
    }
    const payload: AssistantPayload = obj.data?.message?.message ? obj.data.message : obj
    const u = payload.message?.usage
    if (!u) return undefined
    const ts = Date.parse(payload.timestamp ?? obj.timestamp ?? "")
    if (!Number.isFinite(ts)) return undefined
    return {
        ts,
        usage: {
            input: u.input_tokens ?? 0,
            output: u.output_tokens ?? 0,
            cacheWrite: u.cache_creation_input_tokens ?? 0,
            cacheRead: u.cache_read_input_tokens ?? 0,
        },
        dedupeKey: payload.message?.id && payload.requestId ? `${payload.message.id}:${payload.requestId}` : undefined,
    }
}

const readTranscript = async (path: string): Promise<{ totals: Totals; firstTs?: number }> => {
    const totals: Totals = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 }
    let firstTs: number | undefined
    const file = Bun.file(path)
    if (!(await file.exists())) return { totals }
    const text = await file.text()
    const seen = new Set<string>()
    for (const line of text.split("\n")) {
        const e = parseLine(line)
        if (!e) continue
        if (e.dedupeKey) {
            if (seen.has(e.dedupeKey)) continue
            seen.add(e.dedupeKey)
        }
        if (firstTs === undefined || e.ts < firstTs) firstTs = e.ts
        totals.input += e.usage.input
        totals.output += e.usage.output
        totals.cacheWrite += e.usage.cacheWrite
        totals.cacheRead += e.usage.cacheRead
    }
    return { totals, firstTs }
}

const readStdin = async (): Promise<string> => {
    if (process.stdin.isTTY) return ""
    const chunks: Buffer[] = []
    for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
    return Buffer.concat(chunks).toString("utf8")
}

const pickModel = (input: SubagentInput): string | undefined => {
    if (typeof input.model === "string") return input.model
    return input.model?.display_name ?? input.model?.id
}

const pickName = (input: SubagentInput): string | undefined => {
    if (typeof input.agent === "string") return input.agent
    return input.subagent?.name ?? input.agent?.name ?? input.name
}

const pickStart = (input: SubagentInput): number | undefined => {
    const raw = input.start_time ?? input.started_at ?? input.createdAt
    if (!raw) return undefined
    const t = Date.parse(raw)
    return Number.isFinite(t) ? t : undefined
}

const main = async (): Promise<void> => {
    const raw = await readStdin()
    let input: SubagentInput = {}
    if (raw.trim()) {
        try {
            input = JSON.parse(raw) as SubagentInput
        } catch {
            // ignore — fall through with empty input
        }
    }

    const transcriptPath = input.transcript_path ?? input.transcript ?? input.log_path
    const transcript = transcriptPath ? await readTranscript(transcriptPath) : { totals: undefined, firstTs: undefined }
    const totals = transcript.totals

    const startTs = pickStart(input) ?? transcript.firstTs
    const elapsed = startTs !== undefined ? fmtElapsed(Date.now() - startTs) : undefined

    const model = pickModel(input)
    const name = pickName(input)

    const parts: string[] = []
    if (name) parts.push(cyan(name))
    if (model) parts.push(dim(prettyModel(model)))
    if (elapsed) parts.push(elapsed)
    if (totals && totals.input + totals.output + totals.cacheRead + totals.cacheWrite > 0) {
        const sent = totals.input + totals.cacheRead + totals.cacheWrite
        parts.push(`${fmtTokens(sent)}${gray("↑")} ${fmtTokens(totals.output)}${gray("↓")}`)
    }

    process.stdout.write(parts.join(dim(" · ")))
}

main().catch((err) => {
    process.stderr.write(`tokens-subagent-status: ${(err as Error).message}\n`)
    process.exit(0)
})
