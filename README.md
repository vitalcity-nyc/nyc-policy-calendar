# The New York City calendar

A live calendar of what is coming for New York City — the days the city will feel, the deadlines
that bind it, the anniversaries it is about to mark, and every hearing underneath. Events are sized
by public significance rather than by who filed the paperwork.

Rebuilt twice a day by GitHub Actions.

## How it works

`build.mjs` merges five sources, scores every event 0-100 for public significance and writes
`data/events.json` plus two subscribable calendar feeds. The score decides how large an event
appears on the page. See [methodology.html](methodology.html) for the full scoring rules.

| Source | Provides | Key needed |
|---|---|---|
| Legistar | Council hearings and stated meetings, with agendas | Public read token (bundled) |
| The City Record | Public hearings from every other agency | None |
| NY State Senate API | Albany session days | `NYSENATE_API_KEY` (optional) |
| `seed/history.json` | 282 sourced historical events → round-number anniversaries | None |
| `seed/curated.json` | Cultural, sporting and statutory events no API publishes | None |

Hearings are capped at a score of 62 by design, so a routine committee meeting can never outrank an
election or a World Cup final.

## Run it locally

```bash
node build.mjs                      # writes data/
python3 -m http.server 8733         # then open localhost:8733
```

`NYSENATE_API_KEY` is optional; without it Albany session days are absent and everything else still
works. If every live source fails, the build aborts rather than overwriting a good calendar with an
empty one.

## The files you'd actually edit

- `seed/curated.json` — add or re-score a cultural, sporting or statutory event
- `seed/importance.json` — argue with how much a historical event matters today (1-5)
- `build.mjs` — the scoring rules themselves
