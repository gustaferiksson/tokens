# tokens

CLI tool that breaks down [Claude Code](https://claude.com/claude-code) usage from local session logs (`~/.claude/projects/`) by date, project, and model — with cost computed from live Anthropic pricing.

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

Optional Fig autocomplete spec:

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

Project and session rows sort by total cost (descending). Date rows stay chronological.

Identical messages that appear in multiple session files (resume / fork) are counted once, so cost stays accurate. As a side effect, the session count can be lower than the Claude Code Analytics for Teams dashboard's session count when sessions have been resumed.

### Output

| flag | behavior |
| --- | --- |
| `--exact` | exact integer token counts (default: compact `1.2K` / `3.4M`) |
| `--json` | emit JSON instead of a table |
| `--refresh-pricing` | force refresh of the pricing cache (TTL 7d) |

## Pricing

Pricing comes from [BerriAI/litellm's `model_prices_and_context_window.json`](https://github.com/BerriAI/litellm/blob/main/model_prices_and_context_window.json) — the same source `ccusage` uses. Anthropic does not publish a JSON pricing API, and LiteLLM's data tracks input / output / cache-write / cache-read rates per model.

Cached at `~/.cache/tokens/pricing.json` for 7 days. If a refresh fails, the stale cache is reused.

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
tokens │ main : ↑1 ~2 ?1 │ ▓▓▓░░░░░░░ 33% 1.2M · 3h 21m left
```

- **repo** — git repo name (cyan), with the relative subpath when you're inside a subdirectory. Falls back to the cwd basename if not in a git repo.
- **branch + flags** — `<branch> : ↑ahead ↓behind +staged ~modified ?untracked`. Each flag is omitted when zero (and the `:` separator with them). From a single `git status --porcelain=v2 --branch` call.
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
