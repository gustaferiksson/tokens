import { readdir } from "node:fs/promises"
import { homedir } from "node:os"
import { basename, join } from "node:path"

export type UsageRecord = {
    project: string
    date: string // YYYY-MM-DD
    model: string
    input: number
    output: number
    cacheWrite: number
    cacheRead: number
    requestId?: string
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
        }
    }
}

// Top-level shape: regular assistant turns have the payload inline; sub-agent
// (type: "progress") events nest it under data.message — same fields, deeper.
type RawLine = AssistantPayload & {
    type?: string
    timestamp?: string
    cwd?: string | null
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

export const projectLabel = (cwd: string): string => basename(cwd) || cwd

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

const parseLine = (line: string, project: string, seenIds: Set<string>): UsageRecord | undefined => {
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

    // Dedupe by message id + request id (same message can appear in multiple sessions
    // when sessions are forked / resumed).
    const dedupeKey =
        payload.message?.id && payload.requestId ? `${payload.message.id}:${payload.requestId}` : undefined
    if (dedupeKey) {
        if (seenIds.has(dedupeKey)) return undefined
        seenIds.add(dedupeKey)
    }

    return {
        project,
        date: timestamp.slice(0, 10),
        model,
        input: usage.input_tokens ?? 0,
        output: usage.output_tokens ?? 0,
        cacheWrite: usage.cache_creation_input_tokens ?? 0,
        cacheRead: usage.cache_read_input_tokens ?? 0,
        requestId: payload.requestId,
    }
}

const walkJsonl = async (dir: string): Promise<string[]> => {
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
    const records: UsageRecord[] = []
    const seenIds = new Set<string>()

    for (const project of projects) {
        const files = await walkJsonl(project.path)
        for (const file of files) {
            const content = await Bun.file(file).text()
            for (const line of content.split("\n")) {
                const rec = parseLine(line, project.cwd, seenIds)
                if (rec) records.push(rec)
            }
        }
    }

    return records
}
