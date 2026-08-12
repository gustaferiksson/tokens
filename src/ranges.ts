export type DateRange = { from?: string; to?: string; label: string }

const pad = (n: number) => String(n).padStart(2, "0")
const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`

const startOfWeek = (d: Date): Date => {
    const out = new Date(d)
    const day = (out.getDay() + 6) % 7 // 0=Mon..6=Sun
    out.setDate(out.getDate() - day)
    out.setHours(0, 0, 0, 0)
    return out
}

const addDays = (d: Date, n: number): Date => {
    const out = new Date(d)
    out.setDate(out.getDate() + n)
    return out
}

const isoDate = (s: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(s)

export type QuarterLabel = "Q1" | "Q2" | "Q3" | "Q4"

export type RangeSpec = {
    last?: number
    from?: string
    to?: string
    weekOffset?: number // 0 = this week, -1 = last, -2 = two weeks ago
    monthOffset?: number
    quarter?: number | QuarterLabel // number = offset (0 = this), "Q1"-"Q4" = labelled quarter of current year
    today?: boolean
    yesterday?: boolean
}

const weekLabel = (offset: number): string => {
    if (offset === 0) return "this week"
    if (offset === -1) return "last week"
    if (offset < -1) return `${-offset} weeks ago`
    return `${offset} week${offset === 1 ? "" : "s"} ahead`
}

const monthLabel = (offset: number): string => {
    if (offset === 0) return "this month"
    if (offset === -1) return "last month"
    if (offset < -1) return `${-offset} months ago`
    return `${offset} month${offset === 1 ? "" : "s"} ahead`
}

const quarterOffsetLabel = (offset: number): string => {
    if (offset === 0) return "this quarter"
    if (offset === -1) return "last quarter"
    if (offset < -1) return `${-offset} quarters ago`
    return `${offset} quarter${offset === 1 ? "" : "s"} ahead`
}

export const resolveRange = (spec: RangeSpec, now = new Date()): DateRange => {
    const flagsSet = [
        spec.last !== undefined,
        spec.from !== undefined || spec.to !== undefined,
        spec.weekOffset !== undefined,
        spec.monthOffset !== undefined,
        spec.quarter !== undefined,
        spec.today,
        spec.yesterday,
    ].filter(Boolean).length

    if (flagsSet === 0) return { label: "all time" }
    if (flagsSet > 1) throw new Error("range flags are mutually exclusive")

    if (spec.today) {
        const d = ymd(now)
        return { from: d, to: d, label: "today" }
    }
    if (spec.yesterday) {
        const d = ymd(addDays(now, -1))
        return { from: d, to: d, label: "yesterday" }
    }
    if (spec.last !== undefined) {
        if (!Number.isInteger(spec.last) || spec.last <= 0) throw new Error(`invalid --last: ${spec.last}`)
        const from = ymd(addDays(now, -(spec.last - 1)))
        const to = ymd(now)
        return { from, to, label: `last ${spec.last} day${spec.last === 1 ? "" : "s"}` }
    }
    const today = ymd(now)
    const capToToday = (d: string): string => (d > today ? today : d)

    if (spec.weekOffset !== undefined) {
        const start = addDays(startOfWeek(now), spec.weekOffset * 7)
        const to = capToToday(ymd(addDays(start, 6)))
        return { from: ymd(start), to, label: weekLabel(spec.weekOffset) }
    }
    if (spec.monthOffset !== undefined) {
        const m = new Date(now.getFullYear(), now.getMonth() + spec.monthOffset, 1)
        const end = new Date(m.getFullYear(), m.getMonth() + 1, 0)
        const to = capToToday(ymd(end))
        return { from: ymd(m), to, label: monthLabel(spec.monthOffset) }
    }

    if (spec.quarter !== undefined) {
        const currentQ = Math.floor(now.getMonth() / 3)
        let targetYear: number
        let targetQ: number
        let label: string
        if (typeof spec.quarter === "number") {
            const totalIdx = now.getFullYear() * 4 + currentQ + spec.quarter
            targetYear = Math.floor(totalIdx / 4)
            targetQ = ((totalIdx % 4) + 4) % 4
            label = quarterOffsetLabel(spec.quarter)
        } else {
            targetYear = now.getFullYear()
            targetQ = Number.parseInt(spec.quarter.slice(1), 10) - 1
            label = `${spec.quarter} ${targetYear}`
        }
        const start = new Date(targetYear, targetQ * 3, 1)
        const end = new Date(targetYear, targetQ * 3 + 3, 0)
        const to = capToToday(ymd(end))
        return { from: ymd(start), to, label }
    }

    if (spec.from && !isoDate(spec.from)) throw new Error(`--from must be YYYY-MM-DD, got ${spec.from}`)
    if (spec.to && !isoDate(spec.to)) throw new Error(`--to must be YYYY-MM-DD, got ${spec.to}`)
    const from = spec.from
    const to = capToToday(spec.to ?? today)
    return { from, to, label: from ? `${from} → ${to}` : `until ${to}` }
}

export const inRange = (date: string, range: DateRange): boolean => {
    if (range.from && date < range.from) return false
    if (range.to && date > range.to) return false
    return true
}
