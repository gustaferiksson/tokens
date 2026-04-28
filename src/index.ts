#! /usr/bin/env bun

import { collectUsage, projectLabel, type UsageRecord } from "./parser"
import { computeCost, findPricing, loadPricing, type ModelPricing } from "./pricing"
import { type DateRange, inRange, type RangeSpec, resolveRange } from "./ranges"
import { type Column, fmtInt, fmtTokens, fmtUsd, gray, type Row, renderTable } from "./table"

type Args = {
    range: RangeSpec
    byProject: boolean
    byModel: boolean
    detailed: boolean
    modelFilter?: string
    projectFilter?: string
    json: boolean
    exact: boolean
    refreshPricing: boolean
    help: boolean
}

const HELP = `tokens — Claude Code usage breakdown

USAGE
  tokens [options]

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
  --by-model [filter]   Add a Model column; optional substring filter
  --detailed            One row per (date, project, model)

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
        byModel: false,
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

type GroupAxes = { date: boolean; project: boolean; model: boolean }

const axesFromArgs = (args: Args): GroupAxes => {
    if (args.detailed) return { date: true, project: true, model: true }
    return { date: !args.byProject, project: args.byProject, model: args.byModel }
}

const prettyModel = (model: string): string => model.replace(/^claude-/, "").replace(/-\d{8}$/, "")

type Agg = {
    date?: string
    project?: string
    model?: string // present when axes.model
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
    projectFilter?: string
): AggregateResult => {
    const buckets = new Map<string, Agg>()
    let minDate: string | undefined
    let maxDate: string | undefined

    for (const r of records) {
        if (!inRange(r.date, range)) continue
        if (modelFilter && !r.model.includes(modelFilter)) continue
        if (projectFilter && !projectLabel(r.project).includes(projectFilter)) continue

        if (minDate === undefined || r.date < minDate) minDate = r.date
        if (maxDate === undefined || r.date > maxDate) maxDate = r.date

        const date = axes.date ? r.date : undefined
        const project = axes.project ? r.project : undefined
        const model = axes.model ? r.model : undefined
        const key = `${date ?? ""}|${project ?? ""}|${model ?? ""}`

        let bucket = buckets.get(key)
        if (!bucket) {
            bucket = {
                date,
                project,
                model,
                input: 0,
                output: 0,
                cacheWrite: 0,
                cacheRead: 0,
                cost: 0,
                missingPricing: false,
                perModelCost: new Map(),
            }
            buckets.set(key, bucket)
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

    rows.sort((a, b) => {
        if (axes.date) {
            const d = (a.date ?? "").localeCompare(b.date ?? "")
            if (d !== 0) return d
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

const main = async (): Promise<void> => {
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

    const axes = axesFromArgs(args)
    const [pricing, records] = await Promise.all([loadPricing(args.refreshPricing), collectUsage()])
    const result = aggregate(records, axes, range, pricing.models, args.modelFilter, args.projectFilter)

    if (args.json) {
        const serialized = result.rows.map((r) => ({
            ...r,
            mainModel: axes.model ? undefined : mainModel(r.perModelCost),
            perModelCost: Object.fromEntries(r.perModelCost),
        }))
        console.log(
            JSON.stringify({ range, minDate: result.minDate, maxDate: result.maxDate, rows: serialized }, null, 2)
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
