#! /usr/bin/env bun

import { type Block, identifyBlocks, isActiveBlock } from "./blocks"
import { installSpecs } from "./install-specs"
import { collectUsage, projectLabel, type UsageRecord } from "./parser"
import { computeCost, findPricing, loadPricing, type ModelPricing } from "./pricing"
import { type DateRange, inRange, type RangeSpec, resolveRange } from "./ranges"
import { type Column, fmtInt, fmtTokens, fmtUsd, gray, type Row, renderTable } from "./table"

type Args = {
    range: RangeSpec
    byProject: boolean
    bySession: boolean
    byModel: boolean
    byBlock: boolean
    detailed: boolean
    modelFilter?: string
    projectFilter?: string
    sessionFilter?: string
    json: boolean
    exact: boolean
    refreshPricing: boolean
    help: boolean
}

const HELP = `tokens — Claude Code usage breakdown

USAGE
  tokens [options]
  tokens install-specs   Build & install Fig autocomplete spec to ~/.fig/autocomplete/build

RANGE (mutually exclusive, default: all time)
  --last <N>            Last N days (inclusive)
  --from <YYYY-MM-DD>   Range start
  --to <YYYY-MM-DD>     Range end (default: today)
  --today               Today only
  --yesterday           Yesterday only
  --week [offset]       Week (Mon-Sun); offset 0 = this, -1 = last, -2 = 2 ago...
  --month [offset]      Calendar month; offset 0 = this, -1 = last, -2 = 2 ago...

GROUPING
  (default)             One row per date, combined; shows Main Model
  --project [filter]    Group by project; optional substring filter
  --session [filter]    Group by session; optional substring filter on session ID
  --by-model [filter]   Add a Model column; optional substring filter
  --detailed            One row per (date, project, model)
  --blocks              One row per Anthropic 5h session block

OUTPUT
  --exact               Show exact integer token counts (default: compact 1.2K)
  --json                Emit JSON instead of a table
  --refresh-pricing     Force refresh of cached pricing (TTL 7d)
  -h, --help            Show this help
`

const parseArgs = (argv: string[]): Args => {
    const range: RangeSpec = {}
    const out: Args = {
        range,
        byProject: false,
        bySession: false,
        byModel: false,
        byBlock: false,
        detailed: false,
        json: false,
        exact: false,
        refreshPricing: false,
        help: false,
    }

    const need = (i: number, flag: string): string => {
        const v = argv[i + 1]
        if (v === undefined || v.startsWith("--")) throw new Error(`${flag} requires a value`)
        return v
    }

    for (let i = 0; i < argv.length; i++) {
        const a = argv[i]
        switch (a) {
            case "-h":
            case "--help":
                out.help = true
                break
            case "--last":
                range.last = Number.parseInt(need(i++, a), 10)
                break
            case "--from":
                range.from = need(i++, a)
                break
            case "--to":
                range.to = need(i++, a)
                break
            case "--today":
                range.today = true
                break
            case "--yesterday":
                range.yesterday = true
                break
            case "--week":
            case "--month": {
                const next = argv[i + 1]
                const offset = next !== undefined && /^-?\d+$/.test(next) ? Number.parseInt(next, 10) : 0
                if (next !== undefined && /^-?\d+$/.test(next)) i++
                if (a === "--week") range.weekOffset = offset
                else range.monthOffset = offset
                break
            }
            case "--project": {
                out.byProject = true
                const next = argv[i + 1]
                if (next !== undefined && !next.startsWith("-")) {
                    out.projectFilter = next
                    i++
                }
                break
            }
            case "--session": {
                out.bySession = true
                const next = argv[i + 1]
                if (next !== undefined && !next.startsWith("-")) {
                    out.sessionFilter = next
                    i++
                }
                break
            }
            case "--by-model": {
                out.byModel = true
                const next = argv[i + 1]
                if (next !== undefined && !next.startsWith("-")) {
                    out.modelFilter = next
                    i++
                }
                break
            }
            case "--detailed":
                out.detailed = true
                break
            case "--blocks":
                out.byBlock = true
                break
            case "--json":
                out.json = true
                break
            case "--exact":
                out.exact = true
                break
            case "--refresh-pricing":
                out.refreshPricing = true
                break
            default:
                throw new Error(`unknown arg: ${a}`)
        }
    }

    return out
}

type GroupAxes = { date: boolean; project: boolean; model: boolean; session: boolean }

const axesFromArgs = (args: Args): GroupAxes => {
    if (args.detailed) return { date: true, project: true, model: true, session: false }
    if (args.bySession) return { date: false, project: false, model: args.byModel, session: true }
    return { date: !args.byProject, project: args.byProject, model: args.byModel, session: false }
}

const prettyModel = (model: string): string => model.replace(/^claude-/, "").replace(/-\d{8}$/, "")

type Agg = {
    date?: string
    project?: string
    model?: string // present when axes.model
    session?: string // present when axes.session
    sessionStart?: string // earliest record timestamp in this session bucket (ISO)
    sessionProject?: string // resolved project label for the session bucket
    input: number
    output: number
    cacheWrite: number
    cacheRead: number
    cost: number
    missingPricing: boolean
    perModelCost: Map<string, number> // for Main Model when !axes.model
}

type AggregateResult = { rows: Agg[]; minDate?: string; maxDate?: string }

const aggregate = (
    records: UsageRecord[],
    axes: GroupAxes,
    range: DateRange,
    pricing: Record<string, ModelPricing>,
    modelFilter?: string,
    projectFilter?: string,
    sessionFilter?: string
): AggregateResult => {
    const buckets = new Map<string, Agg>()
    let minDate: string | undefined
    let maxDate: string | undefined

    for (const r of records) {
        if (!inRange(r.date, range)) continue
        if (modelFilter && !r.model.includes(modelFilter)) continue
        if (projectFilter && !projectLabel(r.project).includes(projectFilter)) continue
        if (sessionFilter && !(r.sessionId ?? "").includes(sessionFilter)) continue
        // In session mode, drop records lacking a session id rather than folding them into
        // an unlabeled "blank" row.
        if (axes.session && !r.sessionId) continue

        if (minDate === undefined || r.date < minDate) minDate = r.date
        if (maxDate === undefined || r.date > maxDate) maxDate = r.date

        const date = axes.date ? r.date : undefined
        const project = axes.project ? r.project : undefined
        const model = axes.model ? r.model : undefined
        const session = axes.session ? r.sessionId : undefined
        // Bucket project axis by projectLabel(cwd), not raw cwd, so agent-clone runs
        // (~/.baywatch/clones/<owner>--<repo>--…) merge with the user's main `<repo>` entry.
        const projectKey = axes.project ? projectLabel(r.project) : ""
        const sessionKey = axes.session ? (r.sessionId ?? "") : ""
        const key = `${date ?? ""}|${projectKey}|${model ?? ""}|${sessionKey}`

        let bucket = buckets.get(key)
        if (!bucket) {
            bucket = {
                date,
                project,
                model,
                session,
                sessionStart: axes.session ? r.timestamp : undefined,
                sessionProject: axes.session ? projectLabel(r.project) : undefined,
                input: 0,
                output: 0,
                cacheWrite: 0,
                cacheRead: 0,
                cost: 0,
                missingPricing: false,
                perModelCost: new Map(),
            }
            buckets.set(key, bucket)
        } else if (axes.session && bucket.sessionStart && r.timestamp < bucket.sessionStart) {
            bucket.sessionStart = r.timestamp
        }

        bucket.input += r.input
        bucket.output += r.output
        bucket.cacheWrite += r.cacheWrite
        bucket.cacheRead += r.cacheRead

        const p = findPricing(r.model, pricing)
        let cost = 0
        if (p) {
            cost = computeCost(p, {
                input: r.input,
                output: r.output,
                cacheWrite: r.cacheWrite,
                cacheRead: r.cacheRead,
            })
            bucket.cost += cost
        } else {
            bucket.missingPricing = true
        }

        if (!axes.model) {
            bucket.perModelCost.set(r.model, (bucket.perModelCost.get(r.model) ?? 0) + cost)
        }
    }

    const rows = [...buckets.values()]

    // Project axis sort key = the project's total cost across all rows (so all rows
    // for the heaviest project stick together at the top).
    const projectTotals = new Map<string, number>()
    if (axes.project) {
        for (const r of rows) projectTotals.set(r.project ?? "", (projectTotals.get(r.project ?? "") ?? 0) + r.cost)
    }
    const sessionTotals = new Map<string, number>()
    if (axes.session) {
        for (const r of rows) sessionTotals.set(r.session ?? "", (sessionTotals.get(r.session ?? "") ?? 0) + r.cost)
    }

    rows.sort((a, b) => {
        if (axes.date) {
            const d = (a.date ?? "").localeCompare(b.date ?? "")
            if (d !== 0) return d
        }
        if (axes.session) {
            const diff = (sessionTotals.get(b.session ?? "") ?? 0) - (sessionTotals.get(a.session ?? "") ?? 0)
            if (diff !== 0) return diff
            const tiebreak = (a.sessionStart ?? "").localeCompare(b.sessionStart ?? "")
            if (tiebreak !== 0) return tiebreak
        }
        if (axes.project) {
            const diff = (projectTotals.get(b.project ?? "") ?? 0) - (projectTotals.get(a.project ?? "") ?? 0)
            if (diff !== 0) return diff
            const tiebreak = (a.project ?? "").localeCompare(b.project ?? "")
            if (tiebreak !== 0) return tiebreak
        }
        if (axes.model) {
            if (a.cost !== b.cost) return b.cost - a.cost
            return (a.model ?? "").localeCompare(b.model ?? "")
        }
        return 0
    })
    return { rows, minDate, maxDate }
}

const humanizeAge = (ms: number): string => {
    const sec = Math.max(0, Math.floor(ms / 1000))
    if (sec < 60) return `${sec}s`
    const min = Math.floor(sec / 60)
    if (min < 60) return `${min}m`
    const hr = Math.floor(min / 60)
    if (hr < 24) return `${hr}h`
    const d = Math.floor(hr / 24)
    return `${d}d`
}

const splitMainModel = (perModelCost: Map<string, number>): { name: string; plus: string } => {
    if (perModelCost.size === 0) return { name: "", plus: "" }
    const entries = [...perModelCost.entries()].sort((a, b) => b[1] - a[1])
    const [top] = entries
    if (!top) return { name: "", plus: "" }
    return { name: prettyModel(top[0]), plus: entries.length > 1 ? `+${entries.length - 1}` : "" }
}

const mainModel = (perModelCost: Map<string, number>): string => {
    const s = splitMainModel(perModelCost)
    return s.plus ? `${s.name} ${s.plus}` : s.name
}

const renderTextTable = (
    rows: Agg[],
    axes: GroupAxes,
    range: DateRange,
    bounds: { minDate?: string; maxDate?: string },
    pricingFetchedAt: number,
    exact: boolean
): string => {
    if (rows.length === 0) return `No usage in range: ${range.label}`

    const fmtTok = exact ? fmtInt : fmtTokens

    const totals: Agg = {
        input: 0,
        output: 0,
        cacheWrite: 0,
        cacheRead: 0,
        cost: 0,
        missingPricing: false,
        perModelCost: new Map(),
    }
    for (const r of rows) {
        totals.input += r.input
        totals.output += r.output
        totals.cacheWrite += r.cacheWrite
        totals.cacheRead += r.cacheRead
        totals.cost += r.cost
        totals.missingPricing ||= r.missingPricing
        for (const [m, c] of r.perModelCost) {
            totals.perModelCost.set(m, (totals.perModelCost.get(m) ?? 0) + c)
        }
    }

    const columns: Column<Agg>[] = []
    if (axes.date) columns.push({ header: "Date", get: (r) => r.date ?? "" })
    if (axes.project) columns.push({ header: "Project", get: (r) => projectLabel(r.project ?? "") })
    const sessionCount = axes.session ? new Set(rows.map((r) => r.session ?? "")).size : 0
    if (axes.session) {
        columns.push({
            header: "Started",
            get: (r) => (r.sessionStart ? fmtSessionStart(r.sessionStart) : ""),
        })
        columns.push({ header: "Project", get: (r) => r.sessionProject ?? "" })
        columns.push({
            header: "Session",
            get: (r) => {
                const s = r.session ?? ""
                if (s === "TOTAL") return `TOTAL (${sessionCount})`
                return exact ? s : s.slice(0, 8)
            },
        })
    }
    if (axes.model) {
        columns.push({ header: "Model", get: (r) => prettyModel(r.model ?? "") })
    } else {
        // Right-align the "+N" suffix by padding name and plus portions to a shared width.
        const splits = [...rows, totals].map((r) => splitMainModel(r.perModelCost))
        const nameW = Math.max(0, ...splits.map((s) => s.name.length))
        const plusW = Math.max(0, ...splits.map((s) => s.plus.length))
        columns.push({
            header: "Main Model",
            get: (r) => {
                const s = splitMainModel(r.perModelCost)
                if (plusW === 0) return s.name
                return `${s.name.padEnd(nameW)} ${s.plus.padStart(plusW)}`
            },
        })
    }
    columns.push({ header: "Input", align: "right", get: (r) => fmtTok(r.input) })
    columns.push({ header: "Output", align: "right", get: (r) => fmtTok(r.output) })
    columns.push({ header: "Cache Wr", align: "right", get: (r) => fmtTok(r.cacheWrite) })
    columns.push({ header: "Cache Rd", align: "right", get: (r) => fmtTok(r.cacheRead) })
    columns.push({
        header: "Cost (USD)",
        align: "right",
        get: (r) => (r.missingPricing ? `${fmtUsd(r.cost)}*` : fmtUsd(r.cost)),
    })

    const totalsRow: Agg = {
        ...totals,
        date: axes.date ? "TOTAL" : undefined,
        project: axes.project && !axes.date ? "TOTAL" : undefined,
        session: axes.session ? "TOTAL" : undefined,
        model: axes.model ? "" : undefined,
    }

    const allRows: Row<Agg>[] = [...rows, "separator", { highlight: totalsRow }]
    const from = range.from ?? bounds.minDate
    const to = range.to ?? bounds.maxDate
    const isoStr = from && to ? (from === to ? from : `${from} → ${to}`) : (from ?? to)
    const rangeLine = `Range: ${range.label}${isoStr ? `  ${gray(`(${isoStr})`)}` : ""}`
    const pricingLine = gray(`Pricing cached ${humanizeAge(Date.now() - pricingFetchedAt)} ago`)
    const footer = rows.some((r) => r.missingPricing) ? "\n* cost incomplete: pricing missing for some model(s)" : ""

    return `${rangeLine}\n${pricingLine}\n${renderTable(allRows, columns)}${footer}`
}

type BlockAgg = {
    start: Date
    end: Date
    lastActivity: Date
    isActive: boolean
    input: number
    output: number
    cacheWrite: number
    cacheRead: number
    cost: number
    missingPricing: boolean
    perModelCost: Map<string, number>
}

const aggregateBlock = (block: Block, pricing: Record<string, ModelPricing>, now: Date): BlockAgg => {
    const agg: BlockAgg = {
        start: block.start,
        end: block.end,
        lastActivity: block.lastActivity,
        isActive: isActiveBlock(block, now),
        input: 0,
        output: 0,
        cacheWrite: 0,
        cacheRead: 0,
        cost: 0,
        missingPricing: false,
        perModelCost: new Map(),
    }
    for (const r of block.records) {
        agg.input += r.input
        agg.output += r.output
        agg.cacheWrite += r.cacheWrite
        agg.cacheRead += r.cacheRead
        const p = findPricing(r.model, pricing)
        let c = 0
        if (p) {
            c = computeCost(p, r)
            agg.cost += c
        } else {
            agg.missingPricing = true
        }
        agg.perModelCost.set(r.model, (agg.perModelCost.get(r.model) ?? 0) + c)
    }
    return agg
}

const fmtBlockStart = (d: Date): string => {
    const y = d.getFullYear()
    const m = String(d.getMonth() + 1).padStart(2, "0")
    const day = String(d.getDate()).padStart(2, "0")
    const h = String(d.getHours()).padStart(2, "0")
    return `${y}-${m}-${day} ${h}:00`
}

const fmtSessionStart = (iso: string): string => {
    const d = new Date(iso)
    const y = d.getFullYear()
    const m = String(d.getMonth() + 1).padStart(2, "0")
    const day = String(d.getDate()).padStart(2, "0")
    const h = String(d.getHours()).padStart(2, "0")
    const mn = String(d.getMinutes()).padStart(2, "0")
    return `${y}-${m}-${day} ${h}:${mn}`
}

const fmtDuration = (ms: number): string => {
    const total = Math.max(0, Math.round(ms / 60000))
    const h = Math.floor(total / 60)
    const m = total % 60
    if (h === 0) return `${m}m`
    return `${h}h ${String(m).padStart(2, "0")}m`
}

const renderBlocksTable = (
    blocks: BlockAgg[],
    range: DateRange,
    bounds: { minDate?: string; maxDate?: string },
    pricingFetchedAt: number,
    exact: boolean,
    now: Date
): string => {
    if (blocks.length === 0) return `No blocks in range: ${range.label}`

    const fmtTok = exact ? fmtInt : fmtTokens

    const totals: BlockAgg = {
        start: blocks[0]?.start ?? now,
        end: blocks[0]?.end ?? now,
        lastActivity: blocks[0]?.lastActivity ?? now,
        isActive: false,
        input: 0,
        output: 0,
        cacheWrite: 0,
        cacheRead: 0,
        cost: 0,
        missingPricing: false,
        perModelCost: new Map(),
    }
    for (const b of blocks) {
        totals.input += b.input
        totals.output += b.output
        totals.cacheWrite += b.cacheWrite
        totals.cacheRead += b.cacheRead
        totals.cost += b.cost
        totals.missingPricing ||= b.missingPricing
        for (const [m, c] of b.perModelCost) {
            totals.perModelCost.set(m, (totals.perModelCost.get(m) ?? 0) + c)
        }
    }

    const splits = [...blocks, totals].map((r) => splitMainModel(r.perModelCost))
    const nameW = Math.max(0, ...splits.map((s) => s.name.length))
    const plusW = Math.max(0, ...splits.map((s) => s.plus.length))

    const columns: Column<BlockAgg>[] = [
        {
            header: "Start",
            get: (b) => (b === totals ? "TOTAL" : fmtBlockStart(b.start)),
        },
        {
            header: "Duration",
            get: (b) => {
                if (b === totals) return ""
                const endMs = b.isActive ? now.getTime() : b.lastActivity.getTime()
                const dur = fmtDuration(endMs - b.start.getTime())
                return b.isActive ? `${dur} (active)` : dur
            },
        },
        {
            header: "Main Model",
            get: (b) => {
                const s = splitMainModel(b.perModelCost)
                if (plusW === 0) return s.name
                return `${s.name.padEnd(nameW)} ${s.plus.padStart(plusW)}`
            },
        },
        { header: "Input", align: "right", get: (b) => fmtTok(b.input) },
        { header: "Output", align: "right", get: (b) => fmtTok(b.output) },
        { header: "Cache Wr", align: "right", get: (b) => fmtTok(b.cacheWrite) },
        { header: "Cache Rd", align: "right", get: (b) => fmtTok(b.cacheRead) },
        {
            header: "Cost (USD)",
            align: "right",
            get: (b) => (b.missingPricing ? `${fmtUsd(b.cost)}*` : fmtUsd(b.cost)),
        },
    ]

    const dataRows: Row<BlockAgg>[] = blocks.map((b) => (b.isActive ? { highlight: b } : b))
    const allRows: Row<BlockAgg>[] = [...dataRows, "separator", { highlight: totals }]

    const from = range.from ?? bounds.minDate
    const to = range.to ?? bounds.maxDate
    const isoStr = from && to ? (from === to ? from : `${from} → ${to}`) : (from ?? to)
    const rangeLine = `Range: ${range.label}${isoStr ? `  ${gray(`(${isoStr})`)}` : ""}`
    const pricingLine = gray(`Pricing cached ${humanizeAge(Date.now() - pricingFetchedAt)} ago`)
    const footer = blocks.some((b) => b.missingPricing) ? "\n* cost incomplete: pricing missing for some model(s)" : ""
    const blockLine = gray(`Block: 5h rolling window, hour-aligned`)

    return `${rangeLine}\n${blockLine}\n${pricingLine}\n${renderTable(allRows, columns)}${footer}`
}

const main = async (): Promise<void> => {
    if (process.argv[2] === "install-specs") {
        await installSpecs()
        return
    }

    let args: Args
    try {
        args = parseArgs(process.argv.slice(2))
    } catch (err) {
        console.error(`error: ${(err as Error).message}\n`)
        console.error(HELP)
        process.exit(2)
    }

    if (args.help) {
        console.log(HELP)
        return
    }

    let range: DateRange
    try {
        range = resolveRange(args.range)
    } catch (err) {
        console.error(`error: ${(err as Error).message}`)
        process.exit(2)
    }

    const [pricing, records] = await Promise.all([loadPricing(args.refreshPricing), collectUsage()])

    if (args.byBlock) {
        const now = new Date()
        let filtered = records
        if (args.modelFilter) filtered = filtered.filter((r) => r.model.includes(args.modelFilter ?? ""))
        if (args.projectFilter)
            filtered = filtered.filter((r) => projectLabel(r.project).includes(args.projectFilter ?? ""))

        const allBlocks = identifyBlocks(filtered)
            .filter((b) => inRange(b.start.toISOString().slice(0, 10), range))
            .map((b) => aggregateBlock(b, pricing.models, now))

        let minDate: string | undefined
        let maxDate: string | undefined
        for (const b of allBlocks) {
            const d = b.start.toISOString().slice(0, 10)
            if (minDate === undefined || d < minDate) minDate = d
            if (maxDate === undefined || d > maxDate) maxDate = d
        }

        if (args.json) {
            const serialized = allBlocks.map((b) => ({
                start: b.start.toISOString(),
                end: b.end.toISOString(),
                lastActivity: b.lastActivity.toISOString(),
                isActive: b.isActive,
                input: b.input,
                output: b.output,
                cacheWrite: b.cacheWrite,
                cacheRead: b.cacheRead,
                cost: b.cost,
                missingPricing: b.missingPricing,
                mainModel: mainModel(b.perModelCost),
                perModelCost: Object.fromEntries(b.perModelCost),
            }))
            console.log(JSON.stringify({ range, minDate, maxDate, blocks: serialized }, null, 2))
            return
        }

        console.log(renderBlocksTable(allBlocks, range, { minDate, maxDate }, pricing.fetchedAt, args.exact, now))
        return
    }

    const axes = axesFromArgs(args)
    const result = aggregate(
        records,
        axes,
        range,
        pricing.models,
        args.modelFilter,
        args.projectFilter,
        args.sessionFilter
    )

    if (args.json) {
        const serialized = result.rows.map((r) => ({
            ...r,
            mainModel: axes.model ? undefined : mainModel(r.perModelCost),
            perModelCost: Object.fromEntries(r.perModelCost),
        }))
        const sessionCount = axes.session ? new Set(result.rows.map((r) => r.session ?? "")).size : undefined
        console.log(
            JSON.stringify(
                {
                    range,
                    minDate: result.minDate,
                    maxDate: result.maxDate,
                    ...(sessionCount !== undefined ? { sessionCount } : {}),
                    rows: serialized,
                },
                null,
                2
            )
        )
        return
    }

    console.log(
        renderTextTable(
            result.rows,
            axes,
            range,
            { minDate: result.minDate, maxDate: result.maxDate },
            pricing.fetchedAt,
            args.exact
        )
    )
}

await main()
