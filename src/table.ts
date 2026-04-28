type Align = "left" | "right"

export type Column<T> = {
    header: string
    align?: Align
    get: (row: T) => string
}

export type Row<T> = T | "separator" | { highlight: T }

const ESC = String.fromCharCode(27)
const ANSI_RE = new RegExp(`${ESC}\\[[0-9;]*m`, "g")
const visibleLength = (s: string): number => s.replace(ANSI_RE, "").length

const useColor = process.stdout.isTTY && process.env.NO_COLOR === undefined
const wrap = (code: string, s: string) => (useColor ? `${ESC}[${code}m${s}${ESC}[0m` : s)
const dim = (s: string) => wrap("2", s)
const cyan = (s: string) => wrap("36", s)
const yellow = (s: string) => wrap("33", s)
export const gray = (s: string) => wrap("90", s)

const BOX = {
    tl: "┌",
    tr: "┐",
    bl: "└",
    br: "┘",
    h: "─",
    v: "│",
    cross: "┼",
    teeT: "┬",
    teeB: "┴",
    teeL: "├",
    teeR: "┤",
}

const padCell = (text: string, width: number, align: Align): string => {
    const pad = width - visibleLength(text)
    if (pad <= 0) return text
    return align === "right" ? " ".repeat(pad) + text : text + " ".repeat(pad)
}

const buildSep = (widths: number[], left: string, mid: string, right: string): string =>
    dim(`${left}${widths.map((w) => BOX.h.repeat(w + 2)).join(mid)}${right}`)

const isHighlight = <T>(r: Row<T>): r is { highlight: T } =>
    typeof r === "object" && r !== null && "highlight" in (r as object)

export const renderTable = <T>(rows: Row<T>[], columns: Column<T>[]): string => {
    const dataRows = rows.filter((r): r is T | { highlight: T } => r !== "separator")
    const cells = dataRows.map((row) => {
        const data = isHighlight(row) ? row.highlight : row
        return { raw: columns.map((c) => c.get(data)), highlight: isHighlight(row) }
    })
    const widths = columns.map((c, i) => Math.max(c.header.length, ...cells.map((r) => visibleLength(r.raw[i] ?? ""))))

    const top = buildSep(widths, BOX.tl, BOX.teeT, BOX.tr)
    const mid = buildSep(widths, BOX.teeL, BOX.cross, BOX.teeR)
    const bot = buildSep(widths, BOX.bl, BOX.teeB, BOX.br)
    const v = dim(BOX.v)

    const headerLine = `${v} ${columns
        .map((c, i) => cyan(padCell(c.header, widths[i] ?? 0, c.align ?? "left")))
        .join(` ${v} `)} ${v}`

    let dataIdx = 0
    const bodyLines = rows.map((row) => {
        if (row === "separator") return mid
        const cell = cells[dataIdx++]
        if (!cell) return ""
        const padded = cell.raw.map((c, i) => padCell(c ?? "", widths[i] ?? 0, columns[i]?.align ?? "left"))
        const colored = cell.highlight ? padded.map(yellow) : padded
        return `${v} ${colored.join(` ${v} `)} ${v}`
    })

    return [top, headerLine, mid, ...bodyLines, bot].join("\n")
}

const compactFmt = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 2 })
const intFmt = new Intl.NumberFormat("en-US")
const usdFmt = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" })
const usdPreciseFmt = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 4,
    maximumFractionDigits: 4,
})

export const fmtInt = (n: number): string => intFmt.format(n)
export const fmtTokens = (n: number): string => compactFmt.format(n)
export const fmtUsd = (n: number): string => (n > 0 && n < 0.01 ? usdPreciseFmt.format(n) : usdFmt.format(n))
