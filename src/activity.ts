import { listProjects, walkJsonl } from "./parser"

// What Claude did in a session, as opposed to what it was billed for. Counted at the
// finest granularity the CLI can group by: one record per (date, project, session).
export type ActivityRecord = {
    project: string // resolved cwd, same key space as UsageRecord.project
    date: string // YYYY-MM-DD
    timestamp: string // earliest ISO timestamp seen in this bucket
    sessionId: string
    edits: number
    linesAdded: number
    linesRemoved: number
    commits: number
}

type ToolUse = { type?: string; id?: string; name?: string; input?: Record<string, unknown> }
type ToolResult = { type?: string; tool_use_id?: string; is_error?: boolean | null }
type ContentBlock = ToolUse & ToolResult

type ToolUseResult = { structuredPatch?: { lines?: string[] }[]; originalFile?: string }

type RawLine = {
    timestamp?: string
    sessionId?: string
    message?: { content?: ContentBlock[] }
    toolUseResult?: ToolUseResult
}

const EDIT_TOOLS = new Set(["Edit", "Write", "NotebookEdit"])

// A shell-run `git commit`, allowing leading global flags (`git -C <dir> commit`).
const GIT_COMMIT = /\bgit\s+(?:-\S+(?:\s+\S+)?\s+)*commit\b/
// The same invocation carrying --amend or --dry-run, which adds no new commit. Bounded to
// one command segment so a heredoc commit message can't trip it.
const NON_COMMITTING = /\bgit\s+(?:-\S+(?:\s+\S+)?\s+)*commit[^\n&|;]*--(?:amend|dry-run)\b/

// Scratch files are throwaway, not work product.
const TEMP_PATH = /^(?:\/private)?\/(?:tmp|var\/folders)\//

const countLines = (value: unknown): number => {
    if (typeof value !== "string" || value.length === 0) return 0
    const body = value.endsWith("\n") ? value.slice(0, -1) : value
    return body.split("\n").length
}

type Delta = { added: number; removed: number }

type Pending = { bucket: ActivityRecord; edits: number; linesAdded: number; linesRemoved: number; commits: number }

// The diff Claude Code recorded for the accepted edit, so unchanged context lines never count.
// No hunks and no original file means a newly created file, whose size only the call itself knows.
const patchDelta = (result: ToolUseResult | undefined): Delta | undefined => {
    const hunks = result?.structuredPatch
    if (!Array.isArray(hunks)) return undefined
    if (hunks.length === 0) return result?.originalFile === undefined ? undefined : { added: 0, removed: 0 }
    let added = 0
    let removed = 0
    for (const hunk of hunks) {
        for (const line of hunk.lines ?? []) {
            if (line.startsWith("+")) added += 1
            else if (line.startsWith("-")) removed += 1
        }
    }
    return { added, removed }
}

// Fallback for a call whose result carries no diff: a new file, or a notebook edit.
const editDelta = (tool: ToolUse): Delta | undefined => {
    const path = tool.input?.file_path
    if (typeof path !== "string" || TEMP_PATH.test(path)) return undefined
    if (tool.name === "Write") return { added: countLines(tool.input?.content), removed: 0 }
    return {
        added: countLines(tool.input?.new_string ?? tool.input?.new_source),
        removed: countLines(tool.input?.old_string ?? tool.input?.old_source),
    }
}

export const collectActivity = async (): Promise<ActivityRecord[]> => {
    const projects = await listProjects()
    const buckets = new Map<string, ActivityRecord>()
    // A tool call and its result can land in different files after a fork or resume, so the
    // call → outcome join has to happen globally, once every file is read.
    const pending = new Map<string, Pending>()
    const errored = new Map<string, boolean>()
    const patches = new Map<string, Delta>()

    const bucketFor = (project: string, sessionId: string, timestamp: string): ActivityRecord => {
        const date = timestamp.slice(0, 10)
        const key = `${date}|${project}|${sessionId}`
        const existing = buckets.get(key)
        if (existing) {
            if (timestamp < existing.timestamp) existing.timestamp = timestamp
            return existing
        }
        const created: ActivityRecord = {
            project,
            date,
            timestamp,
            sessionId,
            edits: 0,
            linesAdded: 0,
            linesRemoved: 0,
            commits: 0,
        }
        buckets.set(key, created)
        return created
    }

    for (const project of projects) {
        for (const file of await walkJsonl(project.path)) {
            const content = await Bun.file(file).text()
            for (const line of content.split("\n")) {
                if (!line) continue
                let obj: RawLine
                try {
                    obj = JSON.parse(line) as RawLine
                } catch {
                    continue
                }
                const { timestamp, sessionId } = obj
                if (!timestamp || !sessionId) continue
                // Register the bucket for every line, so a session with no edits still counts.
                const bucket = bucketFor(project.cwd, sessionId, timestamp)

                const blocks = obj.message?.content
                if (!Array.isArray(blocks)) continue
                for (const block of blocks) {
                    if (block.type === "tool_result" && block.tool_use_id) {
                        const seen = errored.get(block.tool_use_id)
                        errored.set(block.tool_use_id, seen === false ? false : block.is_error === true)
                        const delta = patchDelta(obj.toolUseResult)
                        if (delta) patches.set(block.tool_use_id, delta)
                        continue
                    }
                    if (block.type !== "tool_use" || !block.id) continue
                    if (block.name && EDIT_TOOLS.has(block.name)) {
                        const delta = editDelta(block)
                        if (!delta) continue
                        pending.set(block.id, {
                            bucket,
                            edits: 1,
                            linesAdded: delta.added,
                            linesRemoved: delta.removed,
                            commits: 0,
                        })
                        continue
                    }
                    if (block.name !== "Bash") continue
                    const command = block.input?.command
                    if (typeof command !== "string") continue
                    if (!GIT_COMMIT.test(command) || NON_COMMITTING.test(command)) continue
                    pending.set(block.id, { bucket, edits: 0, linesAdded: 0, linesRemoved: 0, commits: 1 })
                }
            }
        }
    }

    // Only calls with a non-error result did the work they claim. A call with no result at all
    // never completed, so it is dropped too.
    for (const [id, p] of pending) {
        if (errored.get(id) !== false) continue
        const delta = patches.get(id)
        p.bucket.edits += p.edits
        p.bucket.linesAdded += delta?.added ?? p.linesAdded
        p.bucket.linesRemoved += delta?.removed ?? p.linesRemoved
        p.bucket.commits += p.commits
    }

    return [...buckets.values()]
}
