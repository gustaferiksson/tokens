import { execFileSync } from "node:child_process"
import { readdir } from "node:fs/promises"
import { homedir } from "node:os"
import { basename, join } from "node:path"

export type UsageRecord = {
    project: string
    date: string // YYYY-MM-DD
    timestamp: string // full ISO timestamp from the source line
    model: string
    input: number
    output: number
    cacheWrite: number // total cache-creation tokens (5-minute + 1-hour TTL)
    cacheWrite1h: number // subset of cacheWrite written with a 1-hour TTL (billed at 2x input)
    cacheRead: number
    requestId?: string
    sessionId?: string
}

type AssistantPayload = {
    timestamp?: string
    requestId?: string
    message?: {
        id?: string
        model?: string
        usage?: {
            input_tokens?: number
            output_tokens?: number
            cache_creation_input_tokens?: number
            cache_read_input_tokens?: number
            // Per-TTL breakdown of cache_creation_input_tokens. Anthropic bills the
            // 1-hour bucket at 2x base input, vs 1.25x for the 5-minute bucket.
            cache_creation?: {
                ephemeral_5m_input_tokens?: number
                ephemeral_1h_input_tokens?: number
            }
        }
    }
}

// Top-level shape: regular assistant turns have the payload inline; sub-agent
// (type: "progress") events nest it under data.message — same fields, deeper.
type RawLine = AssistantPayload & {
    type?: string
    timestamp?: string
    cwd?: string | null
    sessionId?: string
    data?: { message?: AssistantPayload }
}

const PROJECTS_DIR = join(homedir(), ".claude", "projects")

// Encoded dir name uses '-' as both path-separator and literal-dash escape, so it
// can't be decoded reliably. Use it as a stable opaque key, and resolve a real cwd
// from the JSONL contents for display.
const findCwd = async (projectPath: string): Promise<string | undefined> => {
    const files = await walkJsonl(projectPath)
    for (const file of files) {
        const content = await Bun.file(file).text()
        for (const line of content.split("\n")) {
            if (!line.includes('"cwd":"/')) continue
            try {
                const obj = JSON.parse(line) as RawLine
                if (typeof obj.cwd === "string" && obj.cwd.startsWith("/")) return obj.cwd
            } catch {
                // skip malformed line
            }
        }
    }
    return undefined
}

// Cache the (cwd → repo name) resolution per cwd so we only spawn `git` once per project.
const repoNameCache = new Map<string, string | null>()

const gitRemoteRepoName = (cwd: string): string | null => {
    const cached = repoNameCache.get(cwd)
    if (cached !== undefined) return cached
    let result: string | null = null
    try {
        const url = execFileSync("git", ["-C", cwd, "config", "remote.origin.url"], {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
        }).trim()
        // git@host:owner/repo.git, https://host/owner/repo.git, /local/path/repo, file:///...
        // → take the last path segment, strip a trailing .git
        const m = url.match(/[/:]([^/]+?)(?:\.git)?\/?$/)
        if (m?.[1]) result = m[1]
    } catch {
        // not a git repo, dir gone, no origin set — fall back to basename
    }
    repoNameCache.set(cwd, result)
    return result
}

// Display label for a project's cwd. Prefers the repo name from `git config remote.origin.url`
// so clones, worktrees, forks, and tools that work in cloned-off directories (e.g. baywatch's
// agent clones at ~/.baywatch/clones/<owner>--<repo>--…) all fold into the same row as the
// user's main checkout. Falls back to the directory's basename when git can't resolve.
export const projectLabel = (cwd: string): string => gitRemoteRepoName(cwd) ?? basename(cwd) ?? cwd

export const listProjects = async (): Promise<{ id: string; cwd: string; path: string }[]> => {
    const entries = await readdir(PROJECTS_DIR, { withFileTypes: true })
    const dirs = entries.filter((e) => e.isDirectory())
    return await Promise.all(
        dirs.map(async (e) => {
            const path = join(PROJECTS_DIR, e.name)
            const cwd = (await findCwd(path)) ?? e.name
            return { id: e.name, cwd, path }
        })
    )
}

// Dedupe key for a record: the same message appears in multiple session files after a
// fork / resume. message id + request id together identify one billed API response.
type ParsedLine = { record: UsageRecord; dedupeKey: string | undefined }

const parseLine = (line: string, project: string): ParsedLine | undefined => {
    if (!line) return undefined
    let obj: RawLine
    try {
        obj = JSON.parse(line) as RawLine
    } catch {
        return undefined
    }

    // Sub-agent progress events nest the assistant payload under data.message.
    const payload: AssistantPayload = obj.data?.message?.message ? obj.data.message : obj
    const usage = payload.message?.usage
    if (!usage) return undefined
    const timestamp = payload.timestamp ?? obj.timestamp
    if (!timestamp) return undefined
    const model = payload.message?.model
    if (!model || model === "<synthetic>") return undefined

    const dedupeKey =
        payload.message?.id && payload.requestId ? `${payload.message.id}:${payload.requestId}` : undefined

    const record: UsageRecord = {
        project,
        date: timestamp.slice(0, 10),
        timestamp,
        model,
        input: usage.input_tokens ?? 0,
        output: usage.output_tokens ?? 0,
        cacheWrite: usage.cache_creation_input_tokens ?? 0,
        cacheWrite1h: usage.cache_creation?.ephemeral_1h_input_tokens ?? 0,
        cacheRead: usage.cache_read_input_tokens ?? 0,
        requestId: payload.requestId,
        sessionId: obj.sessionId,
    }
    return { record, dedupeKey }
}

const totalTokens = (r: UsageRecord): number => r.input + r.output + r.cacheWrite + r.cacheRead

export const walkJsonl = async (dir: string): Promise<string[]> => {
    const out: string[] = []
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
        const full = join(dir, entry.name)
        if (entry.isDirectory()) {
            const nested = await walkJsonl(full)
            out.push(...nested)
        } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
            out.push(full)
        }
    }
    return out
}

export const collectUsage = async (): Promise<UsageRecord[]> => {
    const projects = await listProjects()
    // Forked / resumed sessions copy a message into multiple files, and the copies can
    // differ: a streaming-intermediate copy carries partial output_tokens while the
    // completed copy carries the full (billed) count. Keep the most-complete copy per
    // dedupe key (max total tokens) rather than the first seen, so cost isn't under-reported.
    const byKey = new Map<string, UsageRecord>()
    const unkeyed: UsageRecord[] = []

    for (const project of projects) {
        const files = await walkJsonl(project.path)
        for (const file of files) {
            const content = await Bun.file(file).text()
            for (const line of content.split("\n")) {
                const parsed = parseLine(line, project.cwd)
                if (!parsed) continue
                const { record, dedupeKey } = parsed
                if (!dedupeKey) {
                    unkeyed.push(record)
                    continue
                }
                const existing = byKey.get(dedupeKey)
                if (!existing || totalTokens(record) > totalTokens(existing)) byKey.set(dedupeKey, record)
            }
        }
    }

    return [...byKey.values(), ...unkeyed]
}
