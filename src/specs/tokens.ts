/// <reference types="@withfig/autocomplete-types" />

const RANGE_FLAGS = ["--last", "--from", "--to", "--today", "--yesterday", "--week", "--month", "--quarter"]
const exclusiveOnRange = (self: string) => RANGE_FLAGS.filter((f) => f !== self)

const offsetSuggestions: Fig.Suggestion[] = [
    { name: "this", insertValue: "0", description: "Current period" },
    { name: "last", insertValue: "-1", description: "Previous period" },
    { name: "-2", description: "2 periods ago" },
    { name: "-3", description: "3 periods ago" },
    { name: "-4", description: "4 periods ago" },
]

const quarterSuggestions: Fig.Suggestion[] = [
    ...offsetSuggestions,
    { name: "Q1", description: "Q1 (Jan-Mar) of this year" },
    { name: "Q2", description: "Q2 (Apr-Jun) of this year" },
    { name: "Q3", description: "Q3 (Jul-Sep) of this year" },
    { name: "Q4", description: "Q4 (Oct-Dec) of this year" },
]

const completionSpec: Fig.Spec = {
    name: "tokens",
    description: "Claude Code usage breakdown by date, project, and model",
    options: [
        {
            name: "--last",
            description: "Last N days (inclusive)",
            args: { name: "days", suggestions: ["1", "3", "7", "14", "30", "90"] },
            exclusiveOn: exclusiveOnRange("--last"),
        },
        {
            name: "--from",
            description: "Range start (YYYY-MM-DD)",
            args: { name: "date", description: "YYYY-MM-DD" },
            exclusiveOn: exclusiveOnRange("--from"),
        },
        {
            name: "--to",
            description: "Range end (YYYY-MM-DD, default today)",
            args: { name: "date", description: "YYYY-MM-DD" },
            exclusiveOn: exclusiveOnRange("--to"),
        },
        { name: "--today", description: "Today only", exclusiveOn: exclusiveOnRange("--today") },
        { name: "--yesterday", description: "Yesterday only", exclusiveOn: exclusiveOnRange("--yesterday") },
        {
            name: "--week",
            description: "Week (Mon-Sun); optional offset (0=this, -1=last, ...)",
            args: { name: "offset", isOptional: true, suggestions: offsetSuggestions },
            exclusiveOn: exclusiveOnRange("--week"),
        },
        {
            name: "--month",
            description: "Calendar month; optional offset (0=this, -1=last, ...)",
            args: { name: "offset", isOptional: true, suggestions: offsetSuggestions },
            exclusiveOn: exclusiveOnRange("--month"),
        },
        {
            name: "--quarter",
            description: "Quarter (3 months); optional offset (0=this, -1=last, ...) or Q1-Q4",
            args: { name: "offset", isOptional: true, suggestions: quarterSuggestions },
            exclusiveOn: exclusiveOnRange("--quarter"),
        },
        {
            name: "--project",
            description: "Group by project; optional substring filter",
            args: {
                name: "filter",
                isOptional: true,
                description: "Project name substring",
            },
        },
        {
            name: "--by-model",
            description: "Add a Model column; optional substring filter",
            args: {
                name: "filter",
                isOptional: true,
                suggestions: ["opus", "sonnet", "haiku", "opus-4-7", "sonnet-4-6", "haiku-4-5"],
            },
        },
        { name: "--detailed", description: "One row per (date, project, model)" },
        { name: "--blocks", description: "One row per Anthropic 5h session block" },
        { name: "--exact", description: "Show exact integer token counts (default: compact 1.2K)" },
        { name: "--json", description: "Emit JSON instead of a table" },
        { name: "--refresh-pricing", description: "Force refresh of cached pricing (TTL 7d)" },
        { name: ["--help", "-h"], description: "Show help" },
    ],
}

export default completionSpec
