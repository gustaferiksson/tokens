import type { UsageRecord } from "./parser"

export const SESSION_BLOCK_MS = 5 * 60 * 60 * 1000

const floorToHour = (d: Date): Date => {
    const out = new Date(d)
    out.setMinutes(0, 0, 0)
    return out
}

export type Block = {
    start: Date // hour-floored start of the block
    end: Date // start + 5h (when the block expires)
    lastActivity: Date // timestamp of the latest record in the block
    records: UsageRecord[]
}

// Identify Anthropic's rolling 5h session blocks. A block begins at the
// hour-floor of the first record; a new block starts after a >5h gap or
// once the previous block's 5h window expires.
export const identifyBlocks = (records: UsageRecord[]): Block[] => {
    if (records.length === 0) return []
    const sorted = [...records].sort((a, b) => a.timestamp.localeCompare(b.timestamp))
    const blocks: Block[] = []
    let current: Block | undefined

    for (const r of sorted) {
        const ts = new Date(r.timestamp)
        if (Number.isNaN(ts.getTime())) continue
        if (
            !current ||
            ts.getTime() >= current.end.getTime() ||
            ts.getTime() - current.lastActivity.getTime() > SESSION_BLOCK_MS
        ) {
            if (current) blocks.push(current)
            const start = floorToHour(ts)
            current = {
                start,
                end: new Date(start.getTime() + SESSION_BLOCK_MS),
                lastActivity: ts,
                records: [r],
            }
        } else {
            current.records.push(r)
            current.lastActivity = ts
        }
    }
    if (current) blocks.push(current)
    return blocks
}

export const isActiveBlock = (block: Block, now = new Date()): boolean => block.end.getTime() > now.getTime()
