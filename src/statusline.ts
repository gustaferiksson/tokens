#! /usr/bin/env bun

import { execFileSync } from "node:child_process"
import { readdir, stat } from "node:fs/promises"
import { homedir } from "node:os"
import { basename, join } from "node:path"

type StatuslineInput = {
    cwd?: string
    workspace?: { current_dir?: string }
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

const PROJECTS_DIR = join(homedir(), ".claude", "projects")
const SESSION_BLOCK_MS = 5 * 60 * 60 * 1000
const HISTORICAL_CACHE_PATH = join(homedir(), ".cache", "tokens", "block-max.json")
const HISTORICAL_CACHE_TTL_MS = 24 * 60 * 60 * 1000

const ESC = String.fromCharCode(27)
const useColor = process.env.NO_COLOR === undefined
const wrap = (code: string, s: string) => (useColor ? `${ESC}[${code}m${s}${ESC}[0m` : s)
const dim = (s: string) => wrap("2", s)
const cyan = (s: string) => wrap("36", s)
const yellow = (s: string) => wrap("33", s)
const red = (s: string) => wrap("31", s)
const green = (s: string) => wrap("32", s)

const pctColor = (pct: number, s: string): string => {
    if (pct >= 85) return red(s)
    if (pct >= 65) return yellow(s)
    return green(s)
}

const homeRel = (path: string): string => {
    const home = homedir()
    return path === home ? "~" : path.startsWith(`${home}/`) ? `~/${path.slice(home.length + 1)}` : path
}

// Anthropic's rolling 5-hour usage window. A block starts at the hour-floor
// of the first message; a new block begins after a >5h gap or once the
// previous block's 5h are up. We mirror ccusage's identification logic.
const floorToHourMs = (ms: number): number => {
    const d = new Date(ms)
    d.setMinutes(0, 0, 0)
    return d.getTime()
}

type RecordEntry = { ts: number; tokens: number; dedupeKey?: string }

const extractRecord = (line: string): RecordEntry | undefined => {
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
    // Cache reads are excluded — they're billed/rate-limited at a small fraction
    // and would otherwise inflate the totals 10-100x in long-context sessions,
    // dwarfing actual generation activity.
    const tokens = (u.input_tokens ?? 0) + (u.output_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0)
    const dedupeKey =
        payload.message?.id && payload.requestId ? `${payload.message.id}:${payload.requestId}` : undefined
    return { ts, tokens, dedupeKey }
}

const walkJsonl = async (dir: string, sinceMs?: number): Promise<string[]> => {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => null)
    if (!entries) return []
    const out: string[] = []
    for (const e of entries) {
        const full = join(dir, e.name)
        if (e.isDirectory()) {
            out.push(...(await walkJsonl(full, sinceMs)))
        } else if (e.isFile() && e.name.endsWith(".jsonl")) {
            if (sinceMs === undefined) {
                out.push(full)
            } else {
                const s = await stat(full).catch(() => null)
                if (s && s.mtimeMs >= sinceMs) out.push(full)
            }
        }
    }
    return out
}

const collectRecords = async (sinceMs?: number): Promise<RecordEntry[]> => {
    const projects = await readdir(PROJECTS_DIR, { withFileTypes: true }).catch(() => null)
    if (!projects) return []
    const records: RecordEntry[] = []
    const seen = new Set<string>()
    for (const p of projects) {
        if (!p.isDirectory()) continue
        const files = await walkJsonl(join(PROJECTS_DIR, p.name), sinceMs)
        for (const file of files) {
            const text = await Bun.file(file)
                .text()
                .catch(() => "")
            for (const line of text.split("\n")) {
                const rec = extractRecord(line)
                if (!rec) continue
                if (sinceMs !== undefined && rec.ts < sinceMs) continue
                if (rec.dedupeKey) {
                    if (seen.has(rec.dedupeKey)) continue
                    seen.add(rec.dedupeKey)
                }
                records.push(rec)
            }
        }
    }
    return records
}

type ActiveBlock = { start: number; tokens: number }

const findActiveBlock = async (now: number): Promise<ActiveBlock | undefined> => {
    const sinceMs = now - SESSION_BLOCK_MS - 60 * 60 * 1000 // 6h lookback covers the active block
    const records = await collectRecords(sinceMs)
    if (records.length === 0) return undefined
    records.sort((a, b) => a.ts - b.ts)

    let blockFloor: number | undefined
    let lastTs = 0
    let blockTokens = 0
    for (const r of records) {
        if (blockFloor === undefined || r.ts >= blockFloor + SESSION_BLOCK_MS || r.ts - lastTs > SESSION_BLOCK_MS) {
            blockFloor = floorToHourMs(r.ts)
            blockTokens = 0
        }
        blockTokens += r.tokens
        lastTs = r.ts
    }

    if (blockFloor === undefined || now > blockFloor + SESSION_BLOCK_MS) return undefined
    return { start: blockFloor, tokens: blockTokens }
}

type HistoricalCache = { maxBlockTokens: number; computedAt: number }

const readHistoricalCache = async (): Promise<HistoricalCache | undefined> => {
    const file = Bun.file(HISTORICAL_CACHE_PATH)
    if (!(await file.exists())) return undefined
    try {
        return (await file.json()) as HistoricalCache
    } catch {
        return undefined
    }
}

const writeHistoricalCache = async (data: HistoricalCache): Promise<void> => {
    await Bun.write(HISTORICAL_CACHE_PATH, JSON.stringify(data))
}

// Max tokens across all *completed* blocks (anything that started >5h ago).
// The active block is excluded so the percentage is a comparison, not a tautology.
const computeHistoricalMaxBlockTokens = async (now: number): Promise<number> => {
    const records = await collectRecords()
    if (records.length === 0) return 0
    records.sort((a, b) => a.ts - b.ts)

    let max = 0
    let blockFloor: number | undefined
    let lastTs = 0
    let blockTokens = 0
    const flush = () => {
        if (blockFloor !== undefined && now > blockFloor + SESSION_BLOCK_MS && blockTokens > max) {
            max = blockTokens
        }
    }
    for (const r of records) {
        if (blockFloor === undefined || r.ts >= blockFloor + SESSION_BLOCK_MS || r.ts - lastTs > SESSION_BLOCK_MS) {
            flush()
            blockFloor = floorToHourMs(r.ts)
            blockTokens = 0
        }
        blockTokens += r.tokens
        lastTs = r.ts
    }
    flush()
    return max
}

const getHistoricalMaxBlockTokens = async (now: number): Promise<number> => {
    const cached = await readHistoricalCache()
    if (cached && now - cached.computedAt < HISTORICAL_CACHE_TTL_MS) return cached.maxBlockTokens
    const max = await computeHistoricalMaxBlockTokens(now)
    await writeHistoricalCache({ maxBlockTokens: max, computedAt: now }).catch(() => {})
    return max
}

type GitInfo = {
    repo: string
    subpath: string
    branch?: string
    staged: number
    modified: number
    untracked: number
    ahead: number
    behind: number
}

const runGit = (args: string[], cwd: string): string | undefined => {
    try {
        return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim()
    } catch {
        return undefined
    }
}

const tryGit = (cwd: string): GitInfo | undefined => {
    const root = runGit(["rev-parse", "--show-toplevel"], cwd)
    if (!root) return undefined
    const repo = basename(root)
    const subpath = cwd === root ? "" : cwd.startsWith(`${root}/`) ? cwd.slice(root.length + 1) : ""

    const status = runGit(["status", "--porcelain=v2", "--branch"], cwd) ?? ""
    let branch: string | undefined
    let staged = 0
    let modified = 0
    let untracked = 0
    let ahead = 0
    let behind = 0
    for (const line of status.split("\n")) {
        if (line.startsWith("# branch.head ")) {
            const v = line.slice("# branch.head ".length).trim()
            if (v && v !== "(detached)") branch = v
        } else if (line.startsWith("# branch.ab ")) {
            const m = line.match(/\+(\d+) -(\d+)/)
            if (m) {
                ahead = Number.parseInt(m[1] ?? "0", 10)
                behind = Number.parseInt(m[2] ?? "0", 10)
            }
        } else if (line.startsWith("1 ") || line.startsWith("2 ")) {
            const xy = line.slice(2, 4)
            if (xy[0] !== ".") staged++
            if (xy[1] !== ".") modified++
        } else if (line.startsWith("? ")) {
            untracked++
        }
    }
    if (!branch) {
        const sha = runGit(["rev-parse", "--short", "HEAD"], cwd)
        if (sha) branch = sha
    }
    return { repo, subpath, branch, staged, modified, untracked, ahead, behind }
}

const renderBar = (pct: number, width = 10): string => {
    const filled = Math.max(0, Math.min(width, Math.floor((pct * width) / 100)))
    return pctColor(pct, "▓".repeat(filled)) + dim("░".repeat(width - filled))
}

const fmtRemaining = (ms: number): string => {
    const total = Math.max(0, Math.round(ms / 60000))
    const h = Math.floor(total / 60)
    const m = total % 60
    if (h === 0) return `${m}m`
    return `${h}h ${String(m).padStart(2, "0")}m`
}

const fmtTokens = (n: number): string => {
    if (n < 1000) return `${n}`
    if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}K`
    return `${(n / 1_000_000).toFixed(n < 10_000_000 ? 2 : 1)}M`
}

const readStdin = async (): Promise<string> => {
    if (process.stdin.isTTY) return ""
    const chunks: Buffer[] = []
    for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
    return Buffer.concat(chunks).toString("utf8")
}

const main = async (): Promise<void> => {
    const raw = await readStdin()
    let input: StatuslineInput = {}
    if (raw.trim()) {
        try {
            input = JSON.parse(raw) as StatuslineInput
        } catch {
            // ignore — fall through with empty input
        }
    }

    const cwd = input.workspace?.current_dir ?? input.cwd ?? process.cwd()
    const now = Date.now()

    const activeP = findActiveBlock(now)
    const maxP = getHistoricalMaxBlockTokens(now)
    const git = tryGit(cwd)
    const [active, historicalMax] = await Promise.all([activeP, maxP])

    const repoName = git?.repo ?? (basename(cwd) || homeRel(cwd))
    let header = cyan(repoName)
    if (git?.subpath) header += ` ${git.subpath}`

    const parts: string[] = [header]

    if (git?.branch) {
        const flags: string[] = []
        if (git.ahead > 0) flags.push(cyan(`↑${git.ahead}`))
        if (git.behind > 0) flags.push(cyan(`↓${git.behind}`))
        if (git.staged > 0) flags.push(green(`+${git.staged}`))
        if (git.modified > 0) flags.push(yellow(`~${git.modified}`))
        if (git.untracked > 0) flags.push(dim(`?${git.untracked}`))
        parts.push(flags.length ? `${git.branch}${dim(" : ")}${flags.join(" ")}` : git.branch)
    }

    if (active !== undefined) {
        const remaining = fmtRemaining(active.start + SESSION_BLOCK_MS - now)
        const usageText = fmtTokens(active.tokens)
        if (historicalMax > 0) {
            const rawPct = (active.tokens / historicalMax) * 100
            const pct = Math.min(100, Math.round(rawPct))
            parts.push(`${renderBar(pct)} ${pctColor(pct, `${pct}%`)} ${dim(`${usageText} · ${remaining} left`)}`)
        } else {
            parts.push(dim(`${usageText} · ${remaining} left`))
        }
    }

    process.stdout.write(parts.join(dim(" │ ")))
}

main().catch((err) => {
    process.stderr.write(`tokens-statusline: ${(err as Error).message}\n`)
    process.exit(0) // never fail the statusline
})
