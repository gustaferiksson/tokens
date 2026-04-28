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
    message?: { usage?: Record<string, number> }
}

type RawLine = AssistantPayload & {
    timestamp?: string
    data?: { message?: AssistantPayload }
}

const PROJECTS_DIR = join(homedir(), ".claude", "projects")
const SESSION_BLOCK_MS = 5 * 60 * 60 * 1000

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

const extractTimestamp = (line: string): number | undefined => {
    if (!line || !line.includes('"usage"')) return undefined
    let obj: RawLine
    try {
        obj = JSON.parse(line) as RawLine
    } catch {
        return undefined
    }
    const payload: AssistantPayload = obj.data?.message?.message ? obj.data.message : obj
    if (!payload.message?.usage) return undefined
    const ts = Date.parse(payload.timestamp ?? obj.timestamp ?? "")
    return Number.isFinite(ts) ? ts : undefined
}

const walkJsonl = async (dir: string, sinceMs: number): Promise<string[]> => {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => null)
    if (!entries) return []
    const out: string[] = []
    for (const e of entries) {
        const full = join(dir, e.name)
        if (e.isDirectory()) {
            out.push(...(await walkJsonl(full, sinceMs)))
        } else if (e.isFile() && e.name.endsWith(".jsonl")) {
            const s = await stat(full).catch(() => null)
            if (s && s.mtimeMs >= sinceMs) out.push(full)
        }
    }
    return out
}

const findActiveBlockStart = async (now: number): Promise<number | undefined> => {
    const sinceMs = now - SESSION_BLOCK_MS - 60 * 60 * 1000 // 6h lookback covers the active block
    const projects = await readdir(PROJECTS_DIR, { withFileTypes: true }).catch(() => null)
    if (!projects) return undefined

    const timestamps: number[] = []
    for (const p of projects) {
        if (!p.isDirectory()) continue
        const files = await walkJsonl(join(PROJECTS_DIR, p.name), sinceMs)
        for (const file of files) {
            const text = await Bun.file(file)
                .text()
                .catch(() => "")
            for (const line of text.split("\n")) {
                const ts = extractTimestamp(line)
                if (ts !== undefined && ts >= sinceMs) timestamps.push(ts)
            }
        }
    }

    if (timestamps.length === 0) return undefined
    timestamps.sort((a, b) => a - b)

    let blockFloor = floorToHourMs(timestamps[0] ?? 0)
    let lastTs = timestamps[0] ?? 0
    for (let i = 1; i < timestamps.length; i++) {
        const t = timestamps[i] ?? 0
        if (t >= blockFloor + SESSION_BLOCK_MS || t - lastTs > SESSION_BLOCK_MS) {
            blockFloor = floorToHourMs(t)
        }
        lastTs = t
    }

    if (now > blockFloor + SESSION_BLOCK_MS) return undefined
    return blockFloor
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

    const blockStartP = findActiveBlockStart(now)
    const git = tryGit(cwd)
    const blockStart = await blockStartP

    const repoName = git?.repo ?? (basename(cwd) || homeRel(cwd))
    const parts: string[] = []
    let header = `[${cyan(repoName)}]`
    if (git?.subpath) header += ` ${git.subpath}`
    parts.push(header)

    if (git?.branch) {
        const flags: string[] = []
        if (git.ahead > 0) flags.push(cyan(`↑${git.ahead}`))
        if (git.behind > 0) flags.push(cyan(`↓${git.behind}`))
        if (git.staged > 0) flags.push(green(`+${git.staged}`))
        if (git.modified > 0) flags.push(yellow(`~${git.modified}`))
        if (git.untracked > 0) flags.push(dim(`?${git.untracked}`))
        parts.push(flags.length ? `${git.branch} ${flags.join(" ")}` : git.branch)
    }

    if (blockStart !== undefined) {
        const pct = Math.min(100, Math.round(((now - blockStart) / SESSION_BLOCK_MS) * 100))
        const remaining = fmtRemaining(blockStart + SESSION_BLOCK_MS - now)
        parts.push(`${renderBar(pct)} ${pctColor(pct, `${pct}%`)} ${dim(`${remaining} left`)}`)
    }

    process.stdout.write(parts.join(dim(" │ ")))
}

main().catch((err) => {
    process.stderr.write(`tokens-statusline: ${(err as Error).message}\n`)
    process.exit(0) // never fail the statusline
})
