# Talk2Data — Agent Instructions

## Project Overview
Local data investigation workbench built with **Next.js + Vercel AI Elements** and a **FastAPI** adapter for the Python engine. Connects SQL databases or uploaded files, runs bounded read-only queries, and produces evidence-backed analyses (visualizations, forecasts, anomalies, change investigations). Stores config, uploads, and history in `~/.talk2data/` (override with `TALK2DATA_HOME`).

## Key Commands

### Setup & Run
```bash
python -m venv .venv
source .venv/bin/activate  # Windows: .venv\Scripts\activate
pip install -r requirements.txt
npm install
# Create .env from .env.example if absent.
npm run api  # terminal 1, Python environment activated
npm run dev  # terminal 2, http://localhost:3000
```
- Install Python and npm dependencies once. The API loads .env; keys stay server-side.
- Frontend port: 3000, Backend port: 8000. Both bind to loopback. Next.js proxies /api.

### Test
```bash
python -m unittest discover -s tests -v
npm run test:agents
npm run typecheck
npm run build
```
- Tests use isolated `TALK2DATA_HOME` temp dirs; no external services needed

### Environment Variables
| Variable | Purpose |
|----------|---------|
| `TALK2DATA_HOME` | Workspace root (default `~/.talk2data/`) |
| `TALK2DATA_LLM_URL` | OpenAI-compatible chat completions endpoint |
| `TALK2DATA_LLM_MODEL` | Model ID for LLM SQL generation |
| `TALK2DATA_LLM_KEY` | Optional auth key for remote provider |
| `TALK2DATA_FORECAST_PROVIDER` | `timesfm3` or `baseline` (default) |
| `TALK2DATA_TIMESFM_NONCOMMERCIAL` | Must be `1` for TimesFM 3 (license) |
| `TALK2DATA_TIMESFM_DEVICE` | `cpu` or `cuda` |

## Architecture
- **Engine** (`talk2data/engine.py`): Core logic — source management, SQL validation, query execution, analysis methods (forecast, anomaly, profile). Uses SQLite for local workspace, SQLAlchemy for external sources.
- **Change Investigation** (`talk2data/change.py`): Deterministic, reproducible metric change analysis with evidence board (completeness, volume vs value, segment contributions, earlier windows, freshness).
- **Extensions** (`talk2data/extensions.py`): User-defined skills (prompt templates) and MCP server integration (explicit per-call approval).
- **API** (`talk2data/api.py`): FastAPI adapter with local Origin/Host checks and explicit MCP approval.
- **Dashboards** (`talk2data/dashboards.py`): Validate all catalog components and SQL before execution. Saved dashboards contain source/request/answers only; reruns regenerate against fresh data. `addUserQuestions` responses must preserve prior answers. The client uses json-render and Zod for the allowlisted spec.
- **UI** (`src/app/page.tsx`): Next.js workbench; AI Elements chat/prompt, shadcn controls, Recharts results.
- **Agents** (`src/lib/agents.ts`): Server-side AI SDK ToolLoopAgent for analysis and dashboards. Schema inspection comes first; source is pinned outside tool arguments. Limits: six model steps, twelve tool calls, sixty seconds. Render engine results, never model prose or invented values. Explicit slash commands preserve deterministic engine semantics. Invalid calls must mark the trace for review to prevent stale results.
- **Demo** (`brag-output/`): Brag/Hyperframes composition, rendered video and poster using only seeded retail data. Keep local tools, caches and installed skill folders out of Git.

## Critical Conventions

### SQL Safety
- `engine.validate_sql()` allows **only a single read-only SELECT** (no CTEs with DML, no multiple statements)
- Always use read-only DB accounts; credentials stored in local SQLite (no OS keyring yet)

### Source Handling
- SQL sources: SQLAlchemy URL, validated on connect
- File uploads: CSV/TSV/Excel/Parquet/JSON/JSONL → imported to local SQLite as `file_{name}` tables (30 MB / 150 col limit)
- Demo source auto-created on first launch: `retail_orders` in workspace SQLite

### Change Investigation Rules
- Compares two equal-length windows (7/14/28 days) ending at latest date
- Skips dimensions with >40 distinct values (avoids silent truncation)
- Evidence items include: SQL with parameters, finding, interpretation, limitation, status (`checked`/`review`)
- Segment contributions labeled as arithmetic, **not causal**
- Saved investigations store **settings only** (never model-generated SQL); rerun on fresh data via `/check_{id}`

### MCP & Skills
- Agent tools never call MCP automatically; its existing per-call UI approval remains required.
- A remote model receives schema, questions, recent context, summaries and up to ten preview rows per analysis query. Keep credentials server-side.
- Skills: custom prompt instructions invoked by `/command` prefix; guide model, no new permissions
- MCP: streamable HTTP only; tools listed, each call requires explicit UI approval with exact args shown
- Localhost or HTTPS URLs only for MCP servers

## Testing Notes
- Tests patch `engine.ROOT`, `STORE`, `FILES` to temp dir in `setUpClass`
- Run single test: `python -m unittest tests.test_engine.EngineTests.test_demo_and_investigation`
- No fixtures beyond seeded demo data

## Common Gotchas
- **Windows**: Use `source .venv/Scripts/activate` not `source .venv/bin/activate`
- **Frontend**: Run `npm run typecheck` and `npm run build`; Python tests include the API adapter.
- **TimesFM 3**: Requires 2 GB free disk, 3 GB RAM, and explicit noncommercial consent
- **Large remote tables**: Query time/cost can be high; prefer indexed date columns and read-only roles
- **Uploaded files**: Re-importing same filename replaces the table; schema may change

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
