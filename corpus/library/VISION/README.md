# VISION

**V**erified **I**ntelligence on **S**ectors, **I**nstruments, **O**pportunities & **N**arratives.

A multi-agent finance research system. Through a simple chat UI you can ask things like *"How are sectors performing?"*, *"What are some precious metals opportunities?"*, *"Deep dive on NVDA — fundamentals, technicals, recent news"*, or *"Why is energy moving today?"* — VISION delegates to four specialist sub-agents that pull live data, compute indicators, render charts, and synthesize one cited answer.

The north star: an opinionated, agent-driven finance research surface that's fast to interrogate and honest about what it doesn't know.

---

## Table of contents

- [What VISION can answer](#what-vision-can-answer)
- [Architecture](#architecture)
- [Data sources](#data-sources)
- [Project layout](#project-layout)
- [Setup](#setup)
- [Running it](#running-it)
- [Surfaces](#surfaces)
- [How the agent layer works](#how-the-agent-layer-works)
- [Error handling philosophy](#error-handling-philosophy)
- [API reference](#api-reference)
- [CLI](#cli)
- [Caching strategy](#caching-strategy)
- [Configuration](#configuration)
- [Limitations](#limitations)
- [Roadmap](#roadmap)
- [Development notes](#development-notes)

---

## What VISION can answer

| Query shape | What happens |
|---|---|
| "How are sectors performing this week?" | Sector specialist → 1 batch FMP call → 1d/50d/200d returns for 11 SPDR ETFs + benchmarks |
| "Sector rotation right now?" | Sector specialist + news specialist (parallel) → returns + narrative |
| "Find S&P 500 tech with P/E < 30" | Screener specialist → FMP server-side `/company-screener` → ranked list |
| "What are some precious metals opportunities?" | Screener specialist with `industry="Gold"` → list; FMP free tier may gate, agent surfaces honestly |
| "Deep dive on NVDA" | Stock specialist + news specialist (parallel) → quote + fundamentals + technicals + chart vision pass + recent news |
| "Is AAPL overbought?" | Stock specialist → `compute_indicators` → RSI/MACD/Bollinger reading |
| "Show me the NVDA chart with RSI and MACD" | Chart endpoint → Plotly subplot rendering |
| "Why is XLE up today?" | News specialist → GDELT search → `fetch_url` on top 1-2 articles |
| "Who reports earnings next week?" | Stock specialist → `get_earnings` → forward earnings via FMP |
| "What's the price of NEM?" | Stock specialist tries FMP → `tier_gated` → falls back to `lookup_ticker_via_web` (GPT-5-mini + web_search) |

---

## Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│  Frontend (Next.js 15 / React 19 / Tailwind / react-plotly)      │
│  - / (chat with SSE streaming, tool chips, error chips)          │
│  - /screener (saveable filter sets, source badges)               │
│  - /heatmap (sector + S&P 500, click-to-load expensive view)     │
│  - /chart/{ticker} (candlesticks + indicators)                   │
│  - inline charts in chat answers via [chart:TICKER] markers      │
└──────────────────────────────┬───────────────────────────────────┘
                               │ HTTP / SSE
┌──────────────────────────────▼───────────────────────────────────┐
│  FastAPI backend (vision/api.py)                                 │
│  - /api/chat[/stream]    - /api/screen                           │
│  - /api/chart/{ticker}   - /api/heatmap/{sector,sp500}           │
│  - /api/sessions[...]    - /api/webhooks/{inbound,outbound}      │
│  - SQLite cache (WAL) + sessions store                           │
└──────────────────────────────┬───────────────────────────────────┘
                               ▼
                  ┌─────────────────────────┐
                  │  Orchestrator (gpt-5)   │   effort: medium by default
                  │  output_type: prose     │
                  └────────────┬────────────┘
                               │  agent.as_tool() — runs in PARALLEL
            ┌──────────┬───────┴──────┬────────────┐
            ▼          ▼              ▼            ▼
      sector_      stock_         screener_     news_
      specialist   specialist     specialist    specialist
      (gpt-5-mini, output_type=SpecialistResponse — structured)
            │          │              │            │
            └──────────┴──┬───────────┴────────────┘
                          ▼
        ┌──────────────────────────────────────────────────────┐
        │  FMP /stable/ — primary data source                  │
        │   • /company-screener (server-side filter)           │
        │   • /quote (batch up to 100)                         │
        │   • /historical-price-eod                            │
        │   • /income-statement, /balance-sheet, /cash-flow    │
        │   • /key-metrics, /ratios, /profile                  │
        │   • /earnings-calendar (forward + history)           │
        │   • /sp500-constituent, /nasdaq-, /dowjones-         │
        │   • /historical-sector-performance                   │
        │   • /treasury-rates                                  │
        │                                                      │
        │  Web-search fallback (Responses API + web_search)    │
        │   • lookup_ticker_via_web(ticker) when FMP returns   │
        │     tier_gated — covers mining, commodities, intl    │
        │                                                      │
        │  GDELT + RSS (news, no key)                          │
        │  trafilatura (article body extraction)               │
        │  pandas + ta (technical indicators, computed locally)│
        │  matplotlib + mplfinance (PNG render for vision pass)│
        └──────────────────────────────────────────────────────┘
```

---

## Data sources

VISION leans on a small set of carefully chosen sources rather than a multi-source aggregator. The trade is more responsibility on us to handle each source's quirks, less abstraction overhead.

| Source | What it gives | Auth | Free tier | Notes |
|---|---|---|---|---|
| **Financial Modeling Prep (FMP)** | Prices, fundamentals, sector + industry filters, screener, earnings calendar, constituents, treasury rates | API key | 250 req/day | Tier-gated for some tickers (mining, commodities, many international); see [Limitations](#limitations). |
| **OpenAI Responses API** | Vision pass on chart PNGs + `lookup_ticker_via_web` for FMP-gated tickers (web_search built-in tool) | API key | Pay-as-you-go | We default to `gpt-5-mini` for vision/web-search to keep costs reasonable. |
| **GDELT 2.0 DOC API** | Global news search, no key | None | Unlimited | Used by news specialist for "why is X moving" queries. |
| **RSS feeds** | Reuters/FT/MarketWatch/CNBC/Yahoo | None | Unlimited | Used for "market headlines" snapshot queries. |
| **trafilatura** | Article body extraction | — | — | Local lib — pulls clean text from URLs the news specialist surfaces. |

**Tiingo and yfinance were considered and dropped** — Tiingo's free tier limited fundamentals to Dow 30, and yfinance had Yahoo's anti-bot ("crumb") issues breaking bulk operations. FMP gives us a server-side screener that one of those would never have, and the web-search fallback handles the per-ticker coverage gaps.

---

## Project layout

```
~/Documents/VISION/
├── vision/                     # Python backend
│   ├── agents/
│   │   ├── orchestrator.py     # top-level — routes queries to specialists
│   │   ├── specialists.py      # 4 specialists (sector/stock/screener/news)
│   │   ├── sub_tool.py         # custom agent.as_tool() w/ configurable max_turns
│   │   └── types.py            # SpecialistResponse Pydantic schema
│   ├── data/
│   │   └── fmp.py              # the only data client (FMP /stable/ wrapper)
│   ├── tools/
│   │   ├── prices.py           # get_quote, get_price_history
│   │   ├── stocks.py           # get_fundamentals, get_earnings (forward + back)
│   │   ├── indicators.py       # compute_indicators, screen_universe
│   │   ├── screener.py         # screen_stocks (FMP server-side, industry-aware)
│   │   ├── sectors.py          # get_sector_performance (1 batch call)
│   │   ├── universes.py        # FMP-backed constituent lists
│   │   ├── news.py             # GDELT + RSS
│   │   ├── web.py              # article fetch (trafilatura)
│   │   ├── vision.py           # analyze_chart_visually — render PNG → GPT-5 vision
│   │   └── web_lookup.py       # lookup_ticker_via_web — FMP-gated fallback
│   ├── api.py                  # FastAPI app (chat stream, screen, chart, heatmap, webhooks)
│   ├── store.py                # SQLite — sessions + webhooks + KV cache
│   ├── heatmap.py              # sector + S&P 500 heat-map data builders
│   ├── charts.py               # /api/chart/{ticker} data builder (Plotly-shaped)
│   ├── chart_render.py         # mplfinance PNG renderer for vision pass
│   ├── cache.py                # SQLite KV cache (WAL)
│   ├── config.py               # SECTOR_ETFS, BENCHMARK_ETFS, RSS_FEEDS, paths
│   └── agent.py                # CLI entry (Runner.run_sync wrapper)
├── frontend/                   # Next.js 15 (App Router)
│   ├── app/
│   │   ├── layout.tsx          # nav + global styles
│   │   ├── page.tsx            # / — chat
│   │   ├── screener/page.tsx
│   │   ├── heatmap/page.tsx
│   │   └── chart/[ticker]/page.tsx
│   ├── components/
│   │   ├── Chat.tsx            # SSE streaming, AbortController, inline charts
│   │   ├── Screener.tsx        # filter form + saveable filter sets
│   │   ├── Heatmap.tsx         # Plotly treemap, sector + sp500
│   │   ├── Chart.tsx           # candlesticks + indicators (subplots)
│   │   └── Nav.tsx             # nav + ticker quick-search
│   ├── lib/api.ts              # typed API client
│   └── package.json, tsconfig.json, tailwind.config.ts, etc.
├── Makefile                    # make backend / frontend / dev / stop / install
├── run.py                      # CLI entry point
├── requirements.txt
├── .env.example
└── cache/                      # SQLite caches (gitignored)
```

---

## Setup

### Prerequisites

- **Python 3.14** (we tested against this; 3.11+ should work)
- **Node 20+** for the frontend
- An **OpenAI API key** (the agent + vision pass + web-search fallback all use it)
- An **FMP API key** ([free signup](https://site.financialmodelingprep.com/developer/docs), 250 req/day)

### One-time install

```bash
cd ~/Documents/VISION
python3 -m venv .venv             # if not already
cp .env.example .env              # then fill in OPENAI_API_KEY + FMP_API_KEY
brew install node                 # if not already
make install                      # installs Python + frontend deps
```

Edit `.env`:

```bash
OPENAI_API_KEY=sk-...
FMP_API_KEY=...

# Optional — sensible defaults
# VISION_MODEL=gpt-5             # orchestrator
# VISION_SUB_MODEL=gpt-5-mini    # specialists
# VISION_ORCH_EFFORT=medium      # orchestrator reasoning effort
# VISION_VISION_MODEL=gpt-5-mini # chart vision pass
# VISION_WEB_LOOKUP_MODEL=gpt-5-mini  # web-search fallback
```

---

## Running it

### Day-to-day

```bash
make dev
```

Starts the FastAPI backend on `:8000` (in background, log → `/tmp/vision_api.log`) and Next.js dev server on `:3000` (foreground). Ctrl+C stops both. Open http://localhost:3000.

### Other Make targets

```bash
make backend     # FastAPI auto-reload only (foreground)
make frontend    # Next.js dev only (foreground)
make stop        # kill any lingering uvicorn / next dev
make log         # tail backend log
make install     # (re)install Python + frontend deps
make clean       # drop SQLite caches, .next, __pycache__
```

---

## Surfaces

### `/` — Chat

Streaming multi-agent chat. As the agent works you see:

- **Routing chips** — which specialist was called (`📊 Sector specialist`, `📈 Stock specialist`, etc.)
- **Tool-call chips** — each underlying tool invocation, color-coded (running spinner → ✓ done → red ✗ if errored)
- **Error chips** — when a tool errors (rate limit, tier gating, no data), the chip turns red and shows the message inline. Errors are NEVER silently swallowed.
- **Inline charts** — when the agent emits `[chart:TICKER]`, a compact Plotly chart renders right in the message stream
- **Stop button** — abort an in-flight run cleanly via AbortController; backend handles `CancelledError`
- **Session persistence** — `session_id` in localStorage; navigate to `/screener` and back, your conversation is still there
- **"New chat ↻"** — clears the session client-side and best-effort deletes server-side

### `/screener` — Stock screener

- Universe: `sp500`, `nasdaq100`, `dow30`, or arbitrary `tickers` list
- Filters: sector, **industry** (theme-driven — Gold, Semiconductors, Biotechnology, etc.), market cap min/max, P/E min/max, RSI min/max, above 50d/200d SMA
- Sort: market cap / P/E / RSI
- **Saveable filter sets** — name a combo of filters, click the chip later to re-apply
- **Source badges** — small `via fmp` indicator showing which data sources backed the run
- **Notices** — yellow bar when the run hit a coverage gap (e.g., FMP tier-gated industries)

### `/heatmap` — Heat map

- Sector heat map auto-loads (cheap — 11 ETFs in 1 batch FMP call)
- S&P 500 heat map gated behind a Load button (heavier — pulls top N by market cap; ~5 cold calls vs ~600 in the old per-ticker design)
- Toggle 1d / 1w / 1m return colorings
- Plotly treemap; sized by market cap (sp500) or equal-weight (sector)

### `/chart/{ticker}` — Standalone chart

- Candlesticks + SMA(20/50/200) overlay + EMA(20)
- Bollinger Bands(20, 2)
- RSI(14) subpanel with 30/70 reference lines
- MACD(12, 26, 9) subpanel with histogram
- Toggle individual indicators on/off
- Lookback: 365d default, query param `?lookback_days=N&indicators=sma,rsi,macd`

---

## How the agent layer works

VISION uses the OpenAI Agents SDK with a hierarchical pattern.

### Orchestrator

- Lives in `vision/agents/orchestrator.py`
- Model: `gpt-5` by default (override via `VISION_MODEL`)
- Reasoning effort: `medium` by default (override via `VISION_ORCH_EFFORT`)
- Job: route to the minimum set of specialists, then synthesize their structured outputs into one prose answer
- Tools: 4 sub-agent wrappers (`ask_sector_specialist`, `ask_stock_specialist`, `ask_screener_specialist`, `ask_news_specialist`)
- Doesn't call data tools directly — strictly routes

### Specialists

- Each specialist is its own `Agent` with focused tools and a tight system prompt
- Model: `gpt-5-mini` by default (override via `VISION_SUB_MODEL`) — much faster than full gpt-5 for routine tool orchestration
- `output_type=SpecialistResponse` — Pydantic schema with `summary`, `key_metrics`, `citations`, `errors`
- Wrapped via `make_specialist_tool()` in `vision/agents/sub_tool.py` — gives us configurable `max_turns` (default 25) so deep specialists don't hit the SDK's default of 10

### Parallel delegation

When a query spans domains (e.g., "deep dive on NVDA"), the orchestrator emits multiple `as_tool` calls in one turn. The OpenAI Agents SDK runs them concurrently — stock specialist and news specialist run in parallel, not sequentially.

### `SpecialistResponse` schema

Every specialist returns:

```python
{
    "summary": "...",  # 100-300 words, prose findings
    "key_metrics": {...},  # structured numbers (price, RSI, market cap, etc.)
    "citations": [  # tool calls + source URLs
        {"source": "get_quote", "detail": "ticker=NVDA"},
        {"source": "https://reuters.com/...", "detail": "earnings beat"},
    ],
    "errors": ["..."],  # any tool errors / data gaps — populated honestly
}
```

The orchestrator parses these and writes one cohesive answer. Specialists own data; the orchestrator owns prose.

---

## Error handling philosophy

VISION never silently swallows tool errors. Three layers enforce this:

### Tool layer (`vision/tools/*.py`)

Each tool returns a typed error code when something fails:

| Error code | Meaning | What the agent does |
|---|---|---|
| `tier_gated` | FMP free tier doesn't cover this ticker | Stock specialist falls back to `lookup_ticker_via_web` |
| `rate_limited` | FMP daily quota hit (250/day) | Surface honestly; do NOT call web fallback (it has its own cost) |
| `no_data` | FMP returned an empty payload | Surface; explain what's missing |
| `fmp_error` | Other FMP error | Surface raw message |
| `no_key` | `FMP_API_KEY` not set | Surface; user fixes `.env` |
| `web_lookup_failed` | Web-search fallback errored | Surface |

### Specialist prompt layer

Each specialist's system prompt includes an explicit error-handling table — the model is told exactly what to do for each error code. The stock specialist's prompt has it most rigorously since it has the most tools and the web fallback. Specialists are required to populate `errors[]` in their `SpecialistResponse` for every error encountered.

### Orchestrator layer

When the orchestrator receives specialist responses with non-empty `errors[]`, it includes a "## Data limitations" or "## Caveats" section in the user-facing answer. Errors stay visible all the way to the user — the agent never glosses over a data gap.

### Frontend layer

The chat UI renders tool errors as red chips with the error message inline. The screener shows a yellow notice when a thematic filter returned 0 (likely tier gating). Charts render a clear notice instead of crashing.

---

## API reference

### Chat

```bash
# Streaming (SSE)
curl -N -X POST http://localhost:8000/api/chat/stream \
  -H "Content-Type: application/json" \
  -d '{"message":"Deep dive on NVDA","session_id":null}'

# Non-streaming
curl -X POST http://localhost:8000/api/chat \
  -H "Content-Type: application/json" \
  -d '{"message":"Brief on NVDA"}'

# Sessions
curl http://localhost:8000/api/sessions
curl http://localhost:8000/api/sessions/sess_abc123
curl -X DELETE http://localhost:8000/api/sessions/sess_abc123
```

SSE event types from `/api/chat/stream`:

| Event | Payload | Meaning |
|---|---|---|
| `session` | `{"session_id":"..."}` | Sent immediately on connection |
| `tool_call` | `{"id":"...","name":"...","args":{...}}` | A tool started running |
| `tool_done` | `{"id":"..."}` | Tool finished |
| `tool_error` | `{"id":"...","error":"..."}` | Tool returned an error payload |
| `token` | `{"delta":"..."}` | Response token streaming in |
| `done` | `{"session_id":"...","output":"..."}` | Stream complete |
| `error` | `{"error":"..."}` | Backend error |

### Screener

```bash
# Sector + market cap filter
curl -X POST http://localhost:8000/api/screen \
  -H "Content-Type: application/json" \
  -d '{
    "universe":"sp500",
    "sector":"Technology",
    "market_cap_min":100000000000,
    "pe_max":40,
    "rsi_max":70,
    "limit":20
  }'

# Industry filter (thematic) — note: skip universe so we don't intersect with S&P 500
curl -X POST http://localhost:8000/api/screen \
  -H "Content-Type: application/json" \
  -d '{
    "industry":"Semiconductors",
    "market_cap_min":50000000000,
    "limit":20
  }'
```

### Chart

```bash
curl 'http://localhost:8000/api/chart/NVDA?lookback_days=180&indicators=sma,rsi,macd'
```

Indicators are comma-separated; valid values: `sma`, `ema`, `bb`, `rsi`, `macd`.

### Heat map

```bash
curl http://localhost:8000/api/heatmap/sector
curl 'http://localhost:8000/api/heatmap/sp500?top_n=100'
```

### Webhooks

**Inbound** — register a token, external systems POST to it to trigger an agent run:

```bash
curl -X POST http://localhost:8000/api/webhooks/inbound \
  -H "Content-Type: application/json" \
  -d '{"name":"ticker-brief","template":"Brief on {ticker}"}'
# → { "id":"wh_in_...", "token":"...", ... }

curl -X POST http://localhost:8000/api/webhooks/inbound/trigger/<token> \
  -H "Content-Type: application/json" \
  -d '{"ticker":"TSLA"}'
```

**Outbound** — register an alert (storage only currently; channel firing not yet wired):

```bash
curl -X POST http://localhost:8000/api/webhooks/outbound \
  -H "Content-Type: application/json" \
  -d '{
    "name":"AAPL above 200d",
    "trigger_query":"Is AAPL above its 200d SMA? Answer YES or NO with the price.",
    "schedule_cron":"0 22 * * 1-5",
    "target_url":"https://hooks.slack.com/...",
    "channel":"slack"
  }'
```

---

## CLI

```bash
python run.py "Deep dive on NVDA"
python run.py -v "What are some precious metals opportunities?"   # -v shows tool calls
```

Useful for scripting, testing, or running the agent without the frontend.

---

## Caching strategy

VISION caches aggressively to stay under FMP's 250/day free quota. All caches use SQLite with WAL mode (`vision/cache.py`).

| Data | TTL | Rationale |
|---|---|---|
| FMP screener results | 6h | Same filter combos hit repeatedly during a session |
| FMP batch quotes | 4h | Prices move during the day; 4h is fresh enough |
| FMP historical prices | 24h | EOD only — refresh once a day max |
| FMP fundamentals (statements, key metrics) | 24h | Reported quarterly; daily cache is plenty |
| FMP profile | 7 days | Company metadata barely moves |
| FMP constituents (S&P 500 / NDX / Dow) | 7 days | Index reconstitutions are slow |
| Heat-map (sector / S&P 500) | 4h | Aligned with quote cache |
| Chart data | 24h | EOD prices |
| Chart PNG (vision pass) | 12h | Re-render only when underlying chart changes |
| Web lookup (FMP fallback) | 24h | Each call costs an OpenAI web_search invocation |
| Vision analysis | 12h | Same as PNG cache, since it depends on it |

Normal usage lands at 50-100 FMP calls/day with these TTLs.

---

## Configuration

All via `.env`. See `.env.example` for the full template.

| Var | Default | Purpose |
|---|---|---|
| `OPENAI_API_KEY` | required | Agent + vision pass + web search |
| `FMP_API_KEY` | required | Primary data source |
| `VISION_MODEL` | `gpt-5` | Orchestrator |
| `VISION_SUB_MODEL` | `gpt-5-mini` | Specialists |
| `VISION_ORCH_EFFORT` | `medium` | Orchestrator reasoning effort (low/medium/high) |
| `VISION_VISION_MODEL` | `gpt-5-mini` | Chart vision pass |
| `VISION_WEB_LOOKUP_MODEL` | `gpt-5-mini` | Web-search fallback |
| `VISION_SUB_MAX_TURNS` | `25` | Max turns per specialist run (deep specialists need this) |

---

## Limitations

These are real and worth being upfront about:

- **EOD only.** All prices and indicators are end-of-day. No intraday data anywhere.
- **FMP free tier ticker gating.** FMP's free tier has an opaque "premium tickers" list that excludes most mining, commodities, and many international names — even some S&P 500 members like NEM (Newmont). The agent detects this (`error: "tier_gated"`) and falls back to web search for individual ticker queries. The screener can't fall back the same way (it returns 0 matches with a clear notice). Industries like `Gold`, `Silver`, `Solar`, and `Other Precious Metals` are mostly tier-gated on free.
- **FMP daily quota.** 250 requests/day. Heavy testing can blow through it. The screener and individual tools surface this honestly when hit.
- **Outbound webhook channel firing not yet implemented.** Outbound alert subscriptions are stored and listable, but we haven't wired the scheduler + Slack/Discord/email POSTs yet.
- **No auth on the API.** Local dev only. Add auth before exposing beyond localhost.
- **Web-search fallback costs more.** Each call to `lookup_ticker_via_web` invokes the Responses API with web_search — meaningfully more expensive than an FMP call. Cached 24h to mitigate, but heavy use of FMP-gated tickers will run up the OpenAI bill.
- **No backtesting.** Considered and deliberately deferred.

---

## Roadmap

### v0.6 — Trust + observability + visual reasoning

- [ ] **Auth on the API** — bearer token or OAuth before exposing beyond localhost
- [ ] **Citation-as-link in chat** — clickable references back to tool outputs / source URLs
- [ ] **Confidence badges** — when data is sparse (rate-limited, tier-gated, web-sourced), the agent flags low confidence instead of glossing
- [ ] **Re-run / pin / share a query** — bookmark a question with its result for follow-ups
- [ ] **Cross-session memory** — durable facts: "remember that I follow energy and AI semis"
- [ ] **Agent steerability** — user-level prompt preferences (terse vs detailed, US-only vs global)

### v0.7 — Coverage gaps

- [ ] **Macro dashboard** — Fed rates, CPI, employment, yield curve via FMP `/treasury-rates` + FRED
- [ ] **Crypto specialist** — reuse the architecture; CoinGecko or Crypto.com MCP server
- [ ] **Options chains** — needs an options-aware data source
- [ ] **International tickers (proper)** — handle FMP gating better; consider a paid Finnhub fallback for non-US
- [ ] **News deduplication** — collapse the 12 articles about the same story into one cited theme

### v0.8 — Polish + sharing

- [ ] **Mobile-responsive layout** — chat + heat map work on phones
- [ ] **Theme toggle** — light mode, system mode
- [ ] **Export answers as markdown / PDF** — for sharing research
- [ ] **Comparison views** — diff two tickers side-by-side
- [ ] **Daily/weekly automated reports** — schedule a query, email the result

### v1.0 — Production posture

- [ ] **Multi-user** — per-user sessions, watchlists, alerts
- [ ] **Docker compose** — one-command spin up
- [ ] **Multi-source fallback** — FMP → Finnhub → Polygon as resilience layer
- [ ] **CI/CD** — GitHub Actions: tests on PR, build on tag
- [ ] **Observability** — structured logging, OpenTelemetry traces beyond OpenAI's tracing dashboard
- [ ] **Rate-limit-aware caching** — automatic backoff with user-visible status when upstream limits hit

### Open architectural questions

- **Should specialists be hot-swappable?** Today they're built into the orchestrator at startup. A registry pattern would let us add/remove specialists per-user (e.g., enable crypto only for users who care).
- **MCP re-introduction.** We've considered re-adding maverick-mcp or mcp_massive for backtesting and richer screening. Currently deferred.
- **Streaming sub-agents.** Sub-agents currently run to completion before returning. Streaming partials would let the UI show "stock specialist is fetching fundamentals…" not just "stock specialist is running."

---

## Development notes

### Adding a new specialist

1. Add a builder in `vision/agents/specialists.py` (mirror the existing four)
2. Add tools to `vision/tools/`
3. Wire it into `vision/agents/orchestrator.py` via `make_specialist_tool(...)`
4. Update the orchestrator's routing rules in its system prompt

### Adding a new data source

1. New module in `vision/data/` with a clean client (mirror `fmp.py`)
2. Define typed exceptions (rate limit, auth, etc.)
3. Wrap calls with the cache helper
4. Decide where it slots in: replace an FMP call, fallback, or new domain entirely

### Tracing

OpenAI's tracing dashboard (https://platform.openai.com/logs) shows every agent run end-to-end. You can disable it with `from agents import set_tracing_disabled; set_tracing_disabled(True)` in `vision/api.py` if you'd rather not upload trace data.

### Tests

None yet. Adding light pytest coverage is on the v0.6 roadmap.

---

## License

(Choose your own — recommend MIT for a personal project, or Apache 2.0 if you anticipate contributions.)
