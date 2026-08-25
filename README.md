# tokens

CLI tool that breaks down [Claude Code](https://claude.com/claude-code) usage from local session logs (`~/.claude/projects/`) by date, project, and model — with cost computed from live Anthropic pricing. `--activity` reports the other side of the same logs: sessions run, lines written, commits made.

## Install

Requires [Bun](https://bun.sh) (the binaries use `Bun.file` / `Bun.write` — `npx` from a pure-Node setup won't work).

**One-shot via bunx** (no install):

```bash
bunx @gustaferiksson/tokens --week
bunx @gustaferiksson/tokens --blocks --today
```

**Global install** (recommended for the statusline binaries — repeated `bunx` invocations would be too slow):

```bash
bun install -g @gustaferiksson/tokens
# exposes `tokens`, `tokens-statusline`, `tokens-subagent-status` on $PATH
```

**From source**:

```bash
git clone https://github.com/gustaferiksson/tokens.git
cd tokens
bun install
bun link
```

Optional shell autocomplete spec (Amazon Q / Fig-format, installed to `~/.q/specs`):

```bash
bunx @gustaferiksson/tokens install-specs   # one-shot, no install needed
# or, if you cloned the repo
bun run install:specs
```

## Usage

```
tokens [options]
```

### Date range (mutually exclusive, default: all time)

| flag | behavior |
| --- | --- |
| `--last <N>` | Last N days (inclusive) |
| `--from <YYYY-MM-DD>` | Range start |
| `--to <YYYY-MM-DD>` | Range end (default: today) |
| `--today` | Today only |
| `--yesterday` | Yesterday only |
| `--week [offset]` | Week (Mon–Sun); `0` = this, `-1` = last, `-2` = two ago, … |
| `--month [offset]` | Calendar month; same offset semantics as `--week` |

`--week` and `--month` cap their upper bound at today, so a current week shows `Mon → today`, not `Mon → Sun`.

### Grouping

| flag | rows |
| --- | --- |
| _(default)_ | one per date, combined; `Main Model` column shows the dominant model by cost (`+N` if other models also contributed) |
| `--project [filter]` | one per project; optional substring filter |
| `--session [filter]` | one per session; optional substring filter on the session UUID |
| `--by-model [filter]` | adds a `Model` column; optional substring filter |
| `--detailed` | one per (date, project, model) |
| `--blocks` | one per Anthropic 5h session block; the active block is highlighted and its duration shows `(active)` |
| `--activity` | swaps tokens and cost for sessions, edits, lines and commits — see [Activity](#activity) |

Project and session rows sort by total cost (descending). Date rows stay chronological.

Identical messages that appear in multiple session files (resume / fork) are counted once, so cost stays accurate. Where copies of the same message disagree on token counts — a streaming-intermediate copy can carry partial `output_tokens` while the completed copy carries the full, billed count — the most-complete copy (max total tokens) is kept, so output isn't under-counted. As a side effect, the session count can be lower than the Claude Code Analytics for Teams dashboard's session count when sessions have been resumed.

### Activity

`--activity` answers "what did Claude do?" rather than "what did it cost?". It swaps the token and cost columns for `Sessions`, `Edits`, `Lines +`, `Lines -` and `Commits`, and honors the same date range, `--project` / `--session` grouping, and filters. It reads no pricing, so it never touches the network.

```
$ tokens --activity --project

┌──────────┬──────────┬───────┬─────────┬─────────┬─────────┐
│ Project  │ Sessions │ Edits │ Lines + │ Lines - │ Commits │
├──────────┼──────────┼───────┼─────────┼─────────┼─────────┤
│ plug-hub │       60 │ 1,960 │  48,186 │  11,034 │     227 │
│ tine     │       20 │ 1,807 │  23,568 │  10,309 │     196 │
└──────────┴──────────┴───────┴─────────┴─────────┴─────────┘
```

How each number is derived, and what it does *not* mean:

| column | derived from | caveats |
| --- | --- | --- |
| `Sessions` | distinct `sessionId` | A resumed session and its sub-agents share the parent's `sessionId`, so they stay one session — unlike the file count in `~/.claude/projects/`, which is several times higher. A session spanning midnight appears on both dates, but the `TOTAL` row counts it once (it unions the IDs rather than summing the rows). |
| `Edits` / `Lines +` / `Lines -` | successful `Edit`, `Write` and `NotebookEdit` tool calls | Lines come from the diff Claude Code recorded for the accepted edit (`toolUseResult.structuredPatch`), so unchanged context lines never count. A newly created file records no diff, so its whole `content` counts as added; a rewrite that changes nothing counts as zero. Older logs that carry no recorded diff fall back to counting `new_string` as added and `old_string` as removed, which overstates both. **Files written by shell are not counted** — heredocs, `sed`, code generators, package managers. So this measures what Claude changed through the edit tools, not how much your repo grew: over one week here it read 435 lines against 6.9K `git log` additions, because most writes went through the shell. Paths under `/tmp` or `/var/folders` are excluded as scratch. A `replace_all` edit counts its replacement once, not per occurrence. |
| `Commits` | successful shell `git commit` calls | One per command, so the rare command chaining two commits counts once. `--amend` and `--dry-run` invocations are skipped, since neither adds a commit. A commit inside a failed chain (`git commit && git push` where the push fails) is missed, because the tool result is an error. Spot-checking a sample of matches plus every command the heuristic flagged as suspicious (a `git commit` string preceded by `echo`, `grep` or `printf`) found 1–2 false positives in 594. |

All three come from the local logs only, so pruned or machine-local logs undercount — the same limitation as the cost figures.

#### Comparing with the Claude Code analytics dashboard

The numbers here will not equal the [analytics dashboard](https://code.claude.com/docs/en/analytics), because the definitions differ. Ranked by how much they matter:

- **Lines is one combined figure there, two columns here.** The dashboard's `Lines this month` / `Lines of code accepted` comes from `claude_code.lines_of_code.count`, documented as "count of lines of code modified" with a `type` of `added` or `removed`. The dashboard reports a single number spanning both, so compare it against `Lines +` **plus** `Lines -`, not against `Lines +` alone. Both sides count the same accepted-edit diff, so the definitions do line up.
- **The dashboard sees your whole account, this tool sees one machine.** It aggregates every surface you authenticate from — other machines, the web app, cloud sessions — while this reads only the local `~/.claude/projects/`. Expect the dashboard to be higher.
- **Commits are counted from opposite ends.** Claude Code increments `claude_code.commit.count` itself "when creating git commits"; this tool infers commits from the shell commands in the log. The two therefore disagree on `--amend` (skipped here) and on a commit inside a chain that later fails, e.g. `git commit && git push` where the push fails (counted there, dropped here because the tool result is an error).
- **Rejected suggestions are excluded on both sides.** The dashboard excludes them by definition; here a rejected edit's tool result is an error, which is already filtered out.
- **Dates are UTC.** Every log timestamp ends in `Z` and is bucketed as-is, so a late-evening session east of UTC lands on the next day.

One dashboard metric is *not* comparable at all: the Teams/Enterprise contribution metric `Lines of code with CC` counts only merged-PR lines that survive a much stricter filter — "effective lines" over 3 characters, no empty or bracket-only lines, and no lock files, generated code, `dist/`, `build/` or test fixtures. Anthropic calls it a deliberate underestimate. It will be far below the `Lines +` here.

### Output

| flag | behavior |
| --- | --- |
| `--exact` | exact integer token counts (default: compact `1.2K` / `3.4M`); in `--activity` also shows full session UUIDs |
| `--json` | emit JSON instead of a table |
| `--refresh-pricing` | force refresh of the pricing cache (TTL 7d) |

## Pricing

Pricing comes from [BerriAI/litellm's `model_prices_and_context_window.json`](https://github.com/BerriAI/litellm/blob/main/model_prices_and_context_window.json) — the same source `ccusage` uses. Anthropic does not publish a JSON pricing API, and LiteLLM's data tracks input / output / cache-write / cache-read rates per model.

Cached at `~/.cache/tokens/pricing.json` for 7 days. If a refresh fails, the stale cache is reused.

### Cache-write TTL

Anthropic charges two different rates for prompt-cache *writes*: `1.25×` the base input rate for the 5-minute TTL and `2×` for the 1-hour TTL. LiteLLM only publishes the 5-minute rate. Claude Code writes a large share of its cache with the 1-hour TTL, so pricing every cache write at the 5-minute rate materially under-reports cost (in practice the bulk of a ~20% gap against the Claude Code Analytics dashboard).

To correct for this, the parser reads the per-TTL split from each log line's `usage.cache_creation` (`ephemeral_5m_input_tokens` / `ephemeral_1h_input_tokens`) and charges the 1-hour bucket at `2×` the base input rate, with the remainder at LiteLLM's 5-minute rate. The `Cache Wr` column still shows the combined token count. Logs predating the per-TTL breakdown fall back to the 5-minute rate for the whole amount.

> Some residual gap against the dashboard is still expected: it aggregates usage across every machine and surface on your account, whereas this tool only sees the session logs in the local `~/.claude/projects/`.

## Examples

```bash
tokens --week                    # this week, combined
tokens --week -1                 # last week
tokens --month -2                # two months ago
tokens --last 7 --by-model       # last 7 days, model breakdown
tokens --project --last 30       # last 30 days, by project
tokens --project hub             # group by project + filter to "hub"
tokens --session --today         # one row per session for today
tokens --session 78448b53        # filter to a specific session by ID prefix
tokens --by-model haiku          # group by model + filter to haiku
tokens --detailed --month        # full (date, project, model) for this month
tokens --json --month            # JSON output
tokens --blocks --today          # today's 5h session blocks
tokens --blocks --week -1        # last week's blocks
tokens --activity --month        # sessions, lines and commits this month
tokens --activity --project      # all-time activity per project
tokens --activity --session      # per-session activity, biggest writes first
```

## Statusline

`tokens-statusline` is a Claude Code [statusline](https://docs.claude.com/en/docs/claude-code/statusline) command. Add to `~/.claude/settings.json`:

```json
{
  "statusLine": {
    "type": "command",
    "command": "tokens-statusline",
    "refreshInterval": 30
  }
}
```

`refreshInterval` (seconds) re-runs the command on a wall-clock timer in addition to event-driven updates, so the bar ticks up and the time-left counts down even when the session is idle. Omit it to update only on assistant turns.

It prints one line, e.g.:

```
tokens │ main : ↑1 ~2 ?1 │ ctx 46K │ ▓▓▓░░░░░░░ 33% 1.2M · 3h 21m left
```

- **repo** — git repo name (cyan), with the relative subpath when you're inside a subdirectory. Falls back to the cwd basename if not in a git repo.
- **branch + flags** — `<branch> : ↑ahead ↓behind +staged ~modified ?untracked`. Each flag is omitted when zero (and the `:` separator with them). From a single `git status --porcelain=v2 --branch` call.
- **context** — current context-window occupancy for this session, read from the last assistant usage entry in `transcript_path` (all input incl. cache reads, plus output). Shows `—` before the first response or when the transcript isn't available.
- **session block** — Anthropic's rolling 5-hour usage window. `▓░` bar + percent + time until reset. Green / yellow / red at 65 / 85%.
  - **Pro/Max subscribers** (after the first API response in the session): Claude Code passes `rate_limits.five_hour.used_percentage` and `resets_at` on stdin. We use those directly, so the bar matches the `/usage` console exactly. No JSONL scan needed on this path.
  - **API users / first render before any response**: fall back to a local heuristic that scans `~/.claude/projects/*/**.jsonl`. Bar = `current_block_tokens / max_completed_block_tokens`, with cache reads excluded (they're rate-limited at a small fraction and would inflate totals 10–100×). Block detection mirrors ccusage's rules (hour-floored start, breaks on >5h gap or 5h cap). Historical max is cached at `~/.cache/tokens/block-max.json` for 24h.

## Releasing

CI publishes to npm on tag push (`.github/workflows/publish.yml`) using [npm Trusted Publishing](https://docs.npmjs.com/trusted-publishers) — no `NPM_TOKEN` secret. To cut a release:

```bash
npm version patch -m "Release v%s"   # bumps package.json, commits, tags v<x.y.z>
git push --follow-tags               # pushes commit + new tag, kicking off the workflow
```

Use `minor` or `major` instead of `patch` for non-patch releases. The workflow guards against tag/version drift before it publishes.

## Notes

- Sub-agent (Haiku) calls live in `<session>/subagents/*.jsonl` and are picked up via a recursive walk.
- The same message can appear in multiple sessions when forked/resumed; entries are deduped on `messageId:requestId`.
- Project names are resolved from the `cwd` field in the JSONL (the encoded directory name `-Users-foo-bar` isn't decodable for paths containing dashes).
