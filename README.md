# tokens

CLI tool that breaks down [Claude Code](https://claude.com/claude-code) usage from local session logs (`~/.claude/projects/`) by date, project, and model — with cost computed from live Anthropic pricing.

## Install

```bash
git clone https://github.com/gustaferiksson/tokens.git
cd tokens
bun install
bun link        # exposes `tokens` and `tokens-statusline` on $PATH
```

Optional Fig autocomplete spec:

```bash
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
| `--by-model [filter]` | adds a `Model` column; optional substring filter |
| `--detailed` | one per (date, project, model) |

Project rows sort by total cost (descending). Date rows stay chronological.

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
tokens --by-model haiku          # group by model + filter to haiku
tokens --detailed --month        # full (date, project, model) for this month
tokens --json --month            # JSON output
```

## Statusline

`tokens-statusline` is a Claude Code [statusline](https://docs.claude.com/en/docs/claude-code/statusline) command. Add to `~/.claude/settings.json`:

```json
{
  "statusLine": {
    "type": "command",
    "command": "tokens-statusline"
  }
}
```

It prints one line, e.g.:

```
tokens │ main : ↑1 ~2 ?1 │ ▓▓▓░░░░░░░ 33% 3h 21m left
```

- **repo** — git repo name (cyan), with the relative subpath when you're inside a subdirectory. Falls back to the cwd basename if not in a git repo.
- **branch + flags** — `<branch> : ↑ahead ↓behind +staged ~modified ?untracked`. Each flag is omitted when zero (and the `:` separator with them). From a single `git status --porcelain=v2 --branch` call.
- **session block** — Anthropic's rolling 5-hour usage window. `▓░` bar + percent of elapsed time + time until reset. Green / yellow / red at 65 / 85%. Block detection scans the last ~6h of `~/.claude/projects/*/**.jsonl` and follows ccusage's identification rules (hour-floored start, breaks on >5h gap or 5h cap).

## Notes

- Sub-agent (Haiku) calls live in `<session>/subagents/*.jsonl` and are picked up via a recursive walk.
- The same message can appear in multiple sessions when forked/resumed; entries are deduped on `messageId:requestId`.
- Project names are resolved from the `cwd` field in the JSONL (the encoded directory name `-Users-foo-bar` isn't decodable for paths containing dashes).
