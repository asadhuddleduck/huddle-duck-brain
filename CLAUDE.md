# Huddle Duck Brain - Knowledge API

## What This Is
Standalone Knowledge API that indexes the entire Huddle Duck Notion workspace and all Turso databases. Any AI agent can semantically search the full business context via HTTP REST or MCP.

## Architecture
- **Sync Engine:** Cron crawls Notion (all pages + databases) and Turso (4 project databases) every 4 hours
- **Storage:** Turso with native vector search (F32_BLOB, voyage-4 1024-dim embeddings)
- **Query:** Vector similarity (vector_top_k) with source attribution
- **Interfaces:** HTTP REST (/api/query) for any AI + MCP (/api/mcp) for Claude Code

## Key Files
| File | Purpose |
|---|---|
| src/lib/db.ts | Turso connection + schema init |
| src/lib/notion-crawler.ts | Full Notion workspace crawl |
| src/lib/turso-sync.ts | Cross-project Turso data extraction |
| src/lib/chunker.ts | Smart text splitting |
| src/lib/embeddings.ts | Voyage AI embedding client |
| src/lib/query-engine.ts | Vector search + re-ranking |
| src/lib/sync-engine.ts | Full sync pipeline orchestrator |
| src/app/api/mcp/route.ts | MCP server (Claude Code tools) |
| src/app/api/query/route.ts | HTTP REST query endpoint |
| src/app/api/sync/route.ts | Cron sync trigger |

## Environment Variables
- TURSO_DATABASE_URL, TURSO_AUTH_TOKEN - Main brain database
- NOTION_TOKEN - Notion workspace access
- VOYAGE_API_KEY - Embedding generation (free tier: 200M tokens/month)
- TURSO_*_URL, TURSO_*_TOKEN - Read-only access to other project databases
- CRON_SECRET - Vercel cron authentication

## Conventions
- Lazy proxy pattern for all Turso connections (defer until first use)
- INSERT OR REPLACE for idempotent sync operations
- Content hashing (SHA-256) for delta sync (skip unchanged docs)
- Rate limiting: 3 req/s for Notion API, batch requests for Voyage AI
