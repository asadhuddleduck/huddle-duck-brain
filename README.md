# Huddle Duck Brain

**Internal knowledge API that indexes the entire Huddle Duck business into a semantic search layer.** Crawls the Notion workspace and four Turso project databases on a 4-hour cron cycle, chunks and embeds everything with Voyage AI, stores it in Turso's native vector search, and exposes the full business context to any AI agent via HTTP REST and MCP (Model Context Protocol).

Deployed at: `https://huddle-duck-brain.vercel.app`

| Metric | Value |
|---|---|
| Documents indexed | ~1,274 (Turso sources) |
| Embedded chunks | ~1,274 |
| Data sources | 4 Turso databases + 1 Notion workspace |
| Sync frequency | Every 4 hours (staggered: Turso, Notion, Embed) |
| Embedding model | Voyage AI voyage-4 (1024 dimensions) |
| Query latency | 1.4 -- 3.6s (vector search, unfiltered) |

---

## What This Is

Huddle Duck Brain is a standalone knowledge API purpose-built for Huddle Duck's internal AI operations. It solves a fundamental problem: AI agents working across the business (Claude Code, MCP tools, automation scripts) need instant access to the full business context -- client data, campaign performance, financial records, project documentation, task databases -- without querying each source system individually.

The system crawls every page and database in the Notion workspace, plus all four Turso project databases (client-dashboards, attribution-tracker, landing-page, and huddle-duck-finance), converts everything into text documents, splits them into semantically meaningful chunks, generates vector embeddings via Voyage AI, and stores everything in a single Turso database with native vector search. Any AI agent can then issue a natural language query and receive the most relevant chunks with full source attribution.

This is an internal tool, not a customer-facing product. It is designed for a single Notion workspace and a fixed set of project databases. The entire system runs on Vercel serverless functions with a three-phase cron pipeline and stays within free tier limits for all services.

---

## Architecture Overview

```
  DATA SOURCES                    SYNC ENGINE                     STORAGE                    QUERY LAYER
  ============                    ===========                     =======                    ===========

  +------------------+
  | Notion Workspace |---+
  | - Pages          |   |    +------------------+         +-------------------+        +----------------+
  | - Database rows  |   +--->| /api/sync        |-------->|                   |        |                |
  | - DB schemas     |   |    | ?source=notion   |         |   Turso DB        |        | /api/query     |
  +------------------+   |    +------------------+         |   (Brain)         |  HTTP  | POST           |
                         |           |                     |                   |<-------| JSON in/out    |
  +------------------+   |    +------------------+         | +- documents -+   |        +----------------+
  | Turso: client-   |---+--->| /api/sync        |-------->| | id, source  |   |
  |   dashboards     |   |    | ?source=turso    |         | | content     |   |        +----------------+
  +------------------+   |    +------------------+         | | hash, meta  |   |        |                |
                         |           |                     | +-------------+   |  MCP   | /api/mcp       |
  +------------------+   |    +------------------+         |                   |<-------| JSON-RPC       |
  | Turso:           |---+--->| /api/embed       |-------->| +- chunks ----+   |        | 3 tools        |
  |   attribution-   |   |    | (embed pending)  | Voyage  | | content     |   |        +----------------+
  |   tracker        |   |    +------------------+  AI     | | embedding   |   |
  +------------------+   |                                 | | F32_BLOB    |   |        CONSUMERS
                         |                                 | +-------------+   |        =========
  +------------------+   |                                 |                   |
  | Turso:           |---+                                 | +- sync_status +  |        - Claude Code
  |   landing-page   |   |                                 | | source, time |  |        - MCP clients
  +------------------+   |                                 | +-------------+   |        - HTTP clients
                         |                                 |                   |        - Cron jobs
  +------------------+   |                                 | +- sync_lock -+   |
  | Turso:           |---+                                 | | mutex       |   |
  |   finance        |                                     | +-------------+   |
  +------------------+                                     +-------------------+
```

### Cron Pipeline Flow

Every 4 hours, three cron jobs fire in sequence:

```
:00  /api/sync?source=turso    -- Crawl 4 Turso databases, upsert docs, chunk + embed changed docs
:30  /api/sync?source=notion   -- Crawl Notion workspace, upsert docs (no embedding)
:45  /api/embed                -- Embed any docs that were stored but not yet embedded (50 per batch)
```

Turso data is crawled and embedded in the same invocation. Notion data is crawled-only at :30 (storing documents without embeddings), then the :45 embed job generates embeddings for all pending documents across all sources. This separation exists because Notion crawls are slow (block-by-block API calls at 3 req/s) and would exhaust the 300-second timeout if embedding was included.

---

## Tech Stack

| Technology | Version | Purpose |
|---|---|---|
| Next.js | 16.1.6 | Application framework, API routes, serverless functions |
| React | 19.2.3 | Frontend (minimal -- this is an API-first project) |
| TypeScript | 5.x | Type safety across all source files |
| Tailwind CSS | 4.x | Styling (minimal usage, default template page) |
| Turso (LibSQL) | @libsql/client 0.17.0 | Brain database with native vector search (F32_BLOB) |
| Voyage AI | voyage-4 model | Embedding generation (1024 dimensions) |
| Notion SDK | @notionhq/client 5.9.0 | Notion workspace crawling |
| MCP SDK | @modelcontextprotocol/sdk 1.25.2 | Model Context Protocol server |
| mcp-handler | 1.0.7 | MCP-over-HTTP adapter for Vercel |
| Zod | 4.3.6 | MCP tool input validation |
| Vercel | Serverless | Hosting, cron scheduling, deployment |

---

## Data Sources

### Notion Workspace

The Notion crawler discovers and indexes three types of content:

| Doc Type | What Gets Extracted | Details |
|---|---|---|
| `page` | Standalone pages (not inside a database) | Full block content: paragraphs, headings, lists, to-dos, toggles, quotes, callouts, code blocks, tables, images (as captions), bookmarks. Recursive child block extraction up to 10 levels deep. Synced blocks followed to their source. |
| `database_schema` | Database structure definitions | Database title, all property names with types, select/multi-select/status option values. One document per database. |
| `database_row` | Individual database entries | Row title, all non-empty property values (title, rich_text, number, select, multi_select, status, date, people, checkbox, url, email, phone, formula, relation, timestamps), plus full page body content of the row. |

**Incremental sync:** If the last successful Notion sync was less than 24 hours ago, only pages and database rows edited since that timestamp are crawled. A 5-minute buffer is subtracted to avoid missing pages edited during the previous sync window. If no previous successful sync exists, or the last sync is older than 24 hours, a full crawl runs.

**Time budget:** The Notion crawl has a 240-second time budget (leaving 60 seconds for database writes within the 300-second Vercel limit). If the budget is exceeded, the crawl terminates with a `partial: true` flag and orphan cleanup is skipped.

### Turso Databases

Four project databases are read with specific queries:

#### turso:client-dashboards

| Table | Query | Data |
|---|---|---|
| `clients` | Active clients only (`is_active = 1`) | name, meta_ad_account_id, currency, client_since |
| `campaigns` | Active + paused campaigns, joined with client name | name, client_name, status, objective, daily_budget, lifetime_budget |
| `recent_stats` | Last 7 days of daily stats, joined with client and campaign | client_name, campaign_name, date, spend, impressions, clicks, actions, cpc, cpm, ctr |

#### turso:attribution-tracker

| Table | Query | Data |
|---|---|---|
| `contacts` | Most recent 500 contacts | email, status, utm_source, utm_medium, utm_campaign, country, first_seen_at |
| `recent_events` | Events from last 30 days (limit 500), joined with contact email | email, event_type, event_source, page_url, campaign_name, created_at |

#### turso:landing-page

| Table | Query | Data |
|---|---|---|
| `purchases` | All purchases ordered by date | email, name, phone, amount_total, currency, utm_source, utm_medium, utm_campaign, created_at |

#### turso:finance

| Table | Query | Data |
|---|---|---|
| `invoices` | Non-deleted invoices (limit 200) | invoice_number, contact_name, status, total, amount_paid, amount_due, currency, date, due_date |
| `monthly_snapshots` | All monthly financial snapshots | month, revenue, expenses, net_profit, mrr, closing_balance |
| `subscriptions` | Active subscriptions only | customer_name, amount, currency, interval_unit, status, next_charge_date |

All Turso records are stored with `doc_type: "turso_record"` and `source: "turso:<project-name>"`. Each row becomes one document. The content format is:

```
# {title}
Source: turso:{project} / {table}

field1: value1
field2: value2
...
```

### Document Counts (from test report, 2026-02-25)

| Source | Documents |
|---|---|
| turso:attribution-tracker | 630 |
| turso:client-dashboards | 418 |
| turso:finance | 226 |
| turso:landing-page | 0 (connection configured but no data at time of test) |
| notion | 0 (sync bug at time of test -- see Known Limitations) |
| **Total** | **1,274** |

---

## API Reference

All endpoints are deployed at `https://huddle-duck-brain.vercel.app`.

### Authentication

All endpoints require a bearer token (`CRON_SECRET`) in the `Authorization` header:

```
Authorization: Bearer $CRON_SECRET
```

In local development with `NODE_ENV !== "production"` and no `VERCEL` env var, auth is bypassed if `CRON_SECRET` is not set.

### POST /api/query

Semantic search across all indexed knowledge. Falls back to keyword search if Voyage AI is unavailable.

**Request body:**

| Field | Type | Required | Default | Description |
|---|---|---|---|---|
| `query` | string | Yes | -- | Natural language search query (max 2,000 characters) |
| `top_k` | number | No | 10 | Number of results to return (1-50) |
| `source` | string | No | -- | Filter by source. Valid: `notion`, `turso:client-dashboards`, `turso:attribution-tracker`, `turso:landing-page`, `turso:finance` |
| `doc_type` | string | No | -- | Filter by document type. Valid: `page`, `database_row`, `database_schema`, `turso_record` |

**Response (200):**

```json
{
  "results": [
    {
      "chunk_content": "# PHAT Buns\nSource: turso:client-dashboards / campaigns\n\nname: PHAT Buns Summer Campaign\nstatus: ACTIVE\nobjective: CONVERSIONS\ndaily_budget: 25.00",
      "document_title": "PHAT Buns Summer Campaign",
      "document_source": "turso:client-dashboards",
      "source_url": null,
      "doc_type": "turso_record",
      "similarity": 0.82,
      "heading": null,
      "metadata": { "table": "campaigns", "raw": { "...": "..." } }
    }
  ],
  "sources": [
    { "source": "turso:client-dashboards", "doc_type": "turso_record", "result_count": 5 }
  ],
  "count": 5,
  "search_method": "vector"
}
```

**Error responses:**

| Status | Body | Cause |
|---|---|---|
| 400 | `{"error": "Missing 'query' field"}` | Missing or non-string query |
| 400 | `{"error": "Query cannot be empty"}` | Empty string after trimming |
| 400 | `{"error": "Query too long (max 2000 characters)"}` | Exceeds character limit |
| 400 | `{"error": "Invalid source. Valid options: ..."}` | Source not in allowlist |
| 400 | `{"error": "Invalid doc_type. Valid options: ..."}` | Doc type not in allowlist |
| 401 | `{"error": "Unauthorized"}` | Missing or invalid bearer token |
| 500 | `{"error": "..."}` | Server error (sanitized message) |

**Example:**

```bash
curl -s -X POST "https://huddle-duck-brain.vercel.app/api/query" \
  -H "Authorization: Bearer $CRON_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"query": "Meta ads campaign performance this week", "top_k": 5}'
```

### GET /api/status

Returns sync status, document counts by source, and total embedded chunks.

**Response (200):**

```json
{
  "sync_status": [
    {
      "source": "turso",
      "last_sync": "2026-02-25 12:00:51",
      "last_sync_successful": 1,
      "documents_synced": 1273,
      "chunks_created": 0
    },
    {
      "source": "notion",
      "last_sync": "2026-02-25 11:04:47",
      "last_sync_successful": 0,
      "documents_synced": 0,
      "chunks_created": 0
    }
  ],
  "document_counts": [
    { "source": "turso:attribution-tracker", "doc_type": "turso_record", "count": 630 },
    { "source": "turso:client-dashboards", "doc_type": "turso_record", "count": 418 },
    { "source": "turso:finance", "doc_type": "turso_record", "count": 226 }
  ],
  "total_embedded_chunks": 1274,
  "timestamp": "2026-02-25T12:38:38.700Z"
}
```

Note: `error_message` is intentionally excluded from the response to avoid leaking internal details. Check Vercel server logs for error diagnostics.

**Example:**

```bash
curl -s "https://huddle-duck-brain.vercel.app/api/status" \
  -H "Authorization: Bearer $CRON_SECRET"
```

### GET /api/embed

Processes documents that have been stored but not yet embedded. Runs as a cron job at :45 past every 4th hour. Processes up to 50 documents per invocation.

**Response (200):**

```json
{
  "success": true,
  "chunksCreated": 47,
  "remaining": 153,
  "errors": [],
  "timestamp": "2026-02-25T12:45:30.000Z"
}
```

**Example:**

```bash
curl -s "https://huddle-duck-brain.vercel.app/api/embed" \
  -H "Authorization: Bearer $CRON_SECRET"
```

### GET /api/sync?source=

Triggers a sync for the specified source. Used by Vercel cron jobs.

**Query parameters:**

| Parameter | Values | Description |
|---|---|---|
| `source` | `turso`, `notion` | Which data source to sync. If omitted, syncs all sources. |

**Response (200):**

```json
{
  "success": true,
  "source": "turso",
  "documentsProcessed": 42,
  "chunksCreated": 42,
  "chunksSkipped": 1231,
  "remaining": 0,
  "partial": false,
  "errors": [],
  "message": "Sync complete.",
  "timestamp": "2026-02-25T12:00:51.000Z"
}
```

The `partial` flag indicates whether the sync was cut short by the time budget. When `partial: true`, the message indicates the next cron run will continue processing.

**Example:**

```bash
curl -s "https://huddle-duck-brain.vercel.app/api/sync?source=turso" \
  -H "Authorization: Bearer $CRON_SECRET"
```

### POST /api/ingest

Manual sync trigger. Identical to `/api/sync` but accepts POST with a JSON body. Accepts an optional `source` field in the body (`"notion"` or `"turso"`).

**Example:**

```bash
curl -s -X POST "https://huddle-duck-brain.vercel.app/api/ingest" \
  -H "Authorization: Bearer $CRON_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"source": "turso"}'
```

### POST /api/mcp

Model Context Protocol endpoint. Implements the MCP JSON-RPC protocol over HTTP with SSE transport. Requires the `Accept: application/json, text/event-stream` header.

**Available tools:**

| Tool | Description | Parameters |
|---|---|---|
| `query_knowledge` | Semantic search across all knowledge. Primary tool for any question about the business. | `query` (required, string), `top_k` (optional, 1-50), `source` (optional), `doc_type` (optional) |
| `search_keyword` | Exact keyword/phrase match via LIKE search. Use for specific names, IDs, or exact phrases. | `keyword` (required, string, max 500 chars), `limit` (optional, 1-50) |
| `brain_status` | Sync status, document counts, and embedded chunk totals. | None |

Results from `query_knowledge` and `search_keyword` are returned as formatted markdown with headers, source attribution, and content per result.

---

## MCP Integration

### Connecting Claude Code

Add the brain as an MCP server for Claude Code:

```bash
claude mcp add --transport http huddle-duck-brain \
  https://huddle-duck-brain.vercel.app/api/mcp \
  -h "Authorization: Bearer $CRON_SECRET"
```

Once connected, Claude Code gains three tools:

- **query_knowledge** -- "What campaigns are running for PHAT Buns?", "Show me this month's revenue", "Which contacts came from Facebook ads?"
- **search_keyword** -- "Find all mentions of GoCardless", "Search for invoice INV-0042"
- **brain_status** -- "Is the knowledge base up to date?", "When was the last sync?"

### Example MCP interaction

```bash
# Initialize the MCP session
curl -s -X POST "https://huddle-duck-brain.vercel.app/api/mcp" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "Authorization: Bearer $CRON_SECRET" \
  -d '{
    "jsonrpc": "2.0",
    "method": "initialize",
    "params": {
      "protocolVersion": "2024-11-05",
      "capabilities": {},
      "clientInfo": {"name": "test-client", "version": "1.0.0"}
    },
    "id": 1
  }'

# Call the query_knowledge tool
curl -s -X POST "https://huddle-duck-brain.vercel.app/api/mcp" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "Authorization: Bearer $CRON_SECRET" \
  -d '{
    "jsonrpc": "2.0",
    "method": "tools/call",
    "params": {
      "name": "query_knowledge",
      "arguments": {"query": "monthly revenue and profit", "top_k": 3}
    },
    "id": 2
  }'
```

---

## Sync Pipeline

### Three-Phase Cron Schedule

Defined in `vercel.json`:

| Phase | Path | Schedule | Duration |
|---|---|---|---|
| 1. Turso sync | `/api/sync?source=turso` | `0 */4 * * *` (every 4h at :00) | Up to 300s |
| 2. Notion sync | `/api/sync?source=notion` | `30 */4 * * *` (every 4h at :30) | Up to 300s |
| 3. Embed pending | `/api/embed` | `45 */4 * * *` (every 4h at :45) | Up to 300s |

This fires at 00:00, 04:00, 08:00, 12:00, 16:00, 20:00 UTC, totaling 18 cron invocations per day.

### Turso Sync (Phase 1)

1. Connect to each of the 4 project databases using per-source environment variables.
2. Execute predefined SQL queries (active clients, campaigns, recent stats, contacts, events, purchases, invoices, snapshots, subscriptions).
3. Convert each row into a text document with structured `field: value` content.
4. Compare content hashes against existing documents in the brain database.
5. Skip unchanged documents (same SHA-256 hash) that already have embedded chunks.
6. Upsert changed documents via `INSERT OR REPLACE`.
7. Chunk changed documents using heading-aware text splitting.
8. Generate embeddings for all chunks via Voyage AI (batches of 100).
9. Store chunks with embeddings using crash-safe upsert (ON CONFLICT).
10. Clean up stale chunks beyond the new chunk count for each document.
11. Run orphan cleanup: remove documents from the brain that no longer exist in the source databases.

### Notion Sync (Phase 2) -- Crawl-Only Mode

1. Determine if this is an incremental or full sync based on the last successful sync timestamp.
2. Discover all pages via `notion.search()` sorted by `last_edited_time` descending.
3. For incremental syncs, stop paginating once pages older than the `since` threshold are reached.
4. Discover all databases via `notion.search()` with `value: "data_source"`.
5. Filter pages and databases by `last_edited_time >= since` for incremental syncs.
6. Extract page content: recursively walk block children, convert each block type to markdown text.
7. Extract database schemas: property names, types, and option values.
8. Extract database rows: all non-empty property values plus full page body content.
9. Compare content hashes and upsert only changed documents.
10. Delete old chunks for changed documents (so the embed phase knows to re-process them).
11. Run orphan cleanup only on full (non-partial, non-incremental) syncs.
12. Documents are stored WITHOUT embeddings. The :45 embed cron handles embedding.

### Embed Phase (Phase 3)

1. Find all documents that have no embedded chunks (using `NOT EXISTS` subquery).
2. Process up to 50 documents per invocation (`MAX_DOCS_PER_BATCH`).
3. Chunk each document using the heading-aware text splitter.
4. Generate embeddings for all chunks in a single Voyage AI call (batched by 100).
5. Store each chunk with its embedding using `INSERT ON CONFLICT DO UPDATE` (crash-safe upsert).
6. Clean up stale chunk indices beyond the new chunk count.
7. Report how many documents remain unembedded for subsequent cron runs.

### Content Hashing for Delta Detection

Every document's content is hashed with SHA-256. On each sync:

- If a document's content hash matches the stored hash AND it has at least one embedded chunk, it is skipped entirely.
- If the hash matches but there are no embedded chunks (crash recovery), the document is re-processed.
- If the hash differs, the document is upserted and its old chunks are deleted to trigger re-embedding.

### Crash-Safe Chunk Replacement

Instead of `DELETE all + INSERT` (which loses data if the function crashes between the two), the system uses:

1. **Upsert new chunks** via `ON CONFLICT(document_source, document_id, chunk_index) DO UPDATE` -- this overwrites existing chunks in-place.
2. **Delete stale chunks** by removing any chunk with `chunk_index >= newChunkCount` -- this only removes excess chunks if the document shrank.

If the function crashes between step 1 and step 2, the worst case is extra stale chunks (harmless), not missing chunks (data loss).

### Sync Locking

A `sync_lock` table with a single row acts as a distributed mutex. Before starting a sync, the lock is acquired with a unique lock ID and timestamp. If another sync is already running (lock exists and is less than 10 minutes old), the new sync is skipped. The lock is always released in a `finally` block, even on error.

### Time Budget System

The Notion crawler has a configurable time budget (default 240 seconds, leaving 60 seconds for database writes). The `TimeBudget` class tracks elapsed time and the crawler checks `timer.expired()` before each page extraction, database retrieval, and row iteration. When the budget is exhausted, the crawl terminates with `partial: true` and orphan cleanup is skipped.

### Chunking Strategy

Documents are split into chunks using a three-tier approach:

1. **Heading split:** Text is divided at markdown headings (`#`, `##`, `###`), preserving heading context.
2. **Paragraph split:** Large sections are further split at double newlines with configurable overlap.
3. **Force split:** If no natural boundaries are found, text is split at fixed character intervals.

Configuration (from `constants.ts`):

| Parameter | Value | Description |
|---|---|---|
| `MAX_CHUNK_SIZE` | 1,000 chars | Maximum characters per chunk (~250 tokens) |
| `MIN_CHUNK_SIZE` | 100 chars | Minimum viable chunk size |
| `CHUNK_OVERLAP` | 100 chars | Character overlap between consecutive chunks |

The document title is prepended to the first chunk for context.

---

## Security

### Authentication Model

All endpoints are protected with bearer token authentication using `CRON_SECRET`:

| Endpoint | Auth Method | Who Calls It |
|---|---|---|
| `POST /api/query` | `Authorization: Bearer $CRON_SECRET` | AI agents, HTTP clients |
| `GET /api/status` | `Authorization: Bearer $CRON_SECRET` | Monitoring, health checks |
| `GET /api/sync` | `Authorization: Bearer $CRON_SECRET` | Vercel cron scheduler |
| `GET /api/embed` | `Authorization: Bearer $CRON_SECRET` | Vercel cron scheduler |
| `POST /api/ingest` | `Authorization: Bearer $CRON_SECRET` | Manual triggers |
| `* /api/mcp` | `Authorization: Bearer $CRON_SECRET` | Claude Code MCP clients |

### Input Validation

- Query strings are trimmed and limited to 2,000 characters.
- `top_k` is clamped to 1-50.
- `source` and `doc_type` are validated against hardcoded allowlists.
- Keywords for LIKE search have SQL wildcards (`%`, `_`) escaped to prevent wildcard injection.
- MCP tool inputs are validated with Zod schemas.

### Error Sanitization

The `sanitizeErrorMessage()` utility strips file paths, stack traces, and internal details from error messages before they are returned to clients. Error messages are truncated to 200 characters.

### Design Notes

- Source database credentials (per-project Turso tokens) are read-only connections configured via environment variables. The brain never writes to source databases.
- The Notion integration token is a long-lived token (not OAuth), configured at the workspace level.
- In local development (`NODE_ENV !== "production"` and no `VERCEL` env var), auth is bypassed when `CRON_SECRET` is not set.

---

## Configuration

### Environment Variables

All secrets are stored in Vercel environment variables and mirrored to `.env.local` for local development. Never commit actual values to source control.

| Variable | Required | Description |
|---|---|---|
| `TURSO_DATABASE_URL` | Yes | Brain database URL (the main knowledge store) |
| `TURSO_AUTH_TOKEN` | Yes | Brain database auth token |
| `NOTION_TOKEN` | Yes | Notion integration token (workspace-level) |
| `VOYAGE_API_KEY` | Yes | Voyage AI API key for embedding generation |
| `CRON_SECRET` | Yes | Bearer token for all endpoint authentication |
| `TURSO_CLIENT_DASHBOARDS_URL` | No | Read-only URL for client-dashboards Turso DB |
| `TURSO_CLIENT_DASHBOARDS_TOKEN` | No | Read-only token for client-dashboards Turso DB |
| `TURSO_ATTRIBUTION_TRACKER_URL` | No | Read-only URL for attribution-tracker Turso DB |
| `TURSO_ATTRIBUTION_TRACKER_TOKEN` | No | Read-only token for attribution-tracker Turso DB |
| `TURSO_LANDING_PAGE_URL` | No | Read-only URL for landing-page Turso DB |
| `TURSO_LANDING_PAGE_TOKEN` | No | Read-only token for landing-page Turso DB |
| `TURSO_FINANCE_URL` | No | Read-only URL for huddle-duck-finance Turso DB |
| `TURSO_FINANCE_TOKEN` | No | Read-only token for huddle-duck-finance Turso DB |

The per-project Turso variables are optional -- if a pair (URL + token) is missing, that source is skipped during sync with a console warning.

### Tunable Constants

All tunable parameters are centralized in `src/lib/constants.ts`:

| Constant | Value | Description |
|---|---|---|
| `MAX_DOCS_PER_BATCH` | 50 | Max documents to embed per invocation |
| `SYNC_LOCK_TIMEOUT_SECONDS` | 600 | Stale lock threshold (10 minutes) |
| `VOYAGE_MODEL` | `"voyage-4"` | Voyage AI embedding model |
| `EMBEDDING_DIMENSIONS` | 1024 | Vector dimensions |
| `VOYAGE_BATCH_SIZE` | 100 | Max texts per Voyage API call |
| `MAX_CHUNK_SIZE` | 1000 | Max characters per chunk |
| `MIN_CHUNK_SIZE` | 100 | Minimum viable chunk |
| `CHUNK_OVERLAP` | 100 | Character overlap between chunks |
| `NOTION_RATE_LIMIT` | 3 | Max Notion API requests per second |
| `NOTION_MAX_BLOCK_DEPTH` | 10 | Max recursion depth for nested blocks |
| `DEFAULT_TOP_K` | 10 | Default number of query results |
| `VECTOR_OVERSAMPLE_FACTOR` | 2 | Fetch N*factor results for post-filtering |
| `MIN_SIMILARITY_THRESHOLD` | 0.0 | Minimum similarity score (0 = no threshold) |
| `KEYWORD_FALLBACK_LIMIT` | 20 | Max keyword search results |
| `DEFAULT_MAX_RETRY_ATTEMPTS` | 3 | Retry count for API calls |
| `DEFAULT_RETRY_BASE_DELAY_MS` | 1000 | Base delay for exponential backoff |

---

## Project Structure

```
huddle-duck-brain/
  CLAUDE.md                         # Project-level instructions for Claude Code
  vercel.json                       # Cron job definitions (3 jobs, every 4 hours)
  package.json                      # Dependencies and scripts
  tsconfig.json                     # TypeScript config (strict, bundler resolution)
  next.config.ts                    # Next.js config (default)
  docs/
    architecture-review.md          # Detailed architecture critique and risk analysis
    test-report.md                  # Integration test results (23 tests)
  src/
    app/
      page.tsx                      # Default landing page (template, not customized)
      layout.tsx                    # Root layout
      globals.css                   # Tailwind CSS base
      favicon.ico                   # Favicon
      api/
        query/route.ts              # POST - Semantic search endpoint
        status/route.ts             # GET  - Sync status and document counts
        sync/route.ts               # GET/POST - Cron sync trigger (source=turso|notion)
        embed/route.ts              # GET/POST - Embed pending documents
        ingest/route.ts             # POST - Manual sync trigger (duplicate of /sync)
        mcp/route.ts                # GET/POST/DELETE - MCP server (3 tools)
    lib/
      types.ts                      # TypeScript interfaces: Document, Chunk, QueryResult, etc.
      constants.ts                  # All tunable parameters in one file
      db.ts                         # Turso connection (lazy proxy), schema init, sync status, locking, health
      hash.ts                       # SHA-256 content hashing for delta sync
      retry.ts                      # withRetry (exponential backoff), RateLimiter, auth helpers, error sanitizer
      chunker.ts                    # Heading-aware text splitting with overlap
      embeddings.ts                 # Voyage AI client: batch embeddings, query embeddings, vector format
      notion-crawler.ts             # Full Notion workspace crawl: pages, databases, rows, block extraction
      turso-sync.ts                 # Cross-project Turso database reader (4 sources, 9 queries)
      query-engine.ts               # Vector search, keyword fallback, deduplication, source summary
      sync-engine.ts                # Full sync orchestrator: crawl, hash, chunk, embed, orphan cleanup
```

---

## Key Design Decisions

### Why Turso native vector search instead of Pinecone/Weaviate

Turso added native vector search via `F32_BLOB` columns and `vector_top_k()` SQL functions. For a single-business knowledge base with ~1,000-10,000 chunks, brute-force vector scan (not ANN) is fast enough (sub-100ms at current scale). Using Turso means the entire system -- documents, chunks, embeddings, sync state, and locking -- lives in a single database with a single client library. No additional infrastructure, no separate vector database to manage, no cross-service consistency issues. The tradeoff is that Turso's vector search is brute-force O(n) and will degrade at scale (50K+ chunks would need a dedicated vector database).

### Why Voyage AI instead of OpenAI embeddings

Voyage AI's `voyage-4` model is purpose-built for retrieval and consistently outperforms OpenAI `text-embedding-3-small` on retrieval benchmarks. The free tier provides 200 million tokens per month, which is more than sufficient for a single-business knowledge base (estimated 2-3M tokens/month for incremental syncs). The 1024-dimension output provides high-quality embeddings. The API is simple (single endpoint, same interface as OpenAI).

### Why crawl-only mode for Notion

Notion's block-by-block content extraction is slow (3 requests/second rate limit, recursive child blocks). A Notion workspace with 200+ pages can take 20+ minutes to fully crawl, far exceeding Vercel's 300-second timeout. By separating crawl (store documents) from embed (generate vectors), the system can:

1. Crawl as many pages as the time budget allows in one invocation.
2. Embed in a separate invocation without re-crawling.
3. Spread large workspaces across multiple cron cycles.

This is why `/api/sync?source=notion` stores documents without embeddings, and `/api/embed` processes them 50 at a time.

### Why application-level source filtering instead of SQL WHERE

Adding `WHERE d.source = ?` to the SQL query alongside `vector_top_k()` causes Turso's query planner to hang (observed in testing -- consistent timeouts with source filter, fine without). The workaround is to oversample from the vector index (fetch `top_k * oversample_factor * 2` results), then filter by source/doc_type in JavaScript. This means the system may fetch more data than needed, but it avoids the query planner issue entirely. The `VECTOR_OVERSAMPLE_FACTOR` constant (default 2) controls how aggressively to oversample.

---

## Known Limitations

1. **Notion sync can be partial on large workspaces.** The 240-second time budget means workspaces with hundreds of pages may require multiple cron cycles to fully index. The system handles this gracefully (partial flag, orphan cleanup skipped), but data freshness suffers during the catchup period.

2. **Source filter uses over-fetching.** Because SQL-level filtering after `vector_top_k()` causes timeouts, source and doc_type filters are applied in application code after fetching an oversampled result set. If only a small fraction of documents match the filter, you may get fewer results than requested.

3. **No real-time sync.** Data is refreshed on a 4-hour cron cycle. In the worst case, content is 4 hours and 45 minutes stale (changed right after a sync, embedded at the next cycle's :45 phase). There is no webhook-based or on-demand single-page refresh.

4. **Free tier limits.** All services (Turso, Voyage AI, Vercel) are on free/included tiers. Turso free tier: 9 GB storage, 1B row reads/month. Voyage AI free tier: 200M tokens/month. Vercel: 1M invocations/month. Current usage is well within all limits (estimated <5% of each), but aggressive growth in document count or query volume could require paid tiers.

5. **No similarity threshold.** `MIN_SIMILARITY_THRESHOLD` is set to `0.0`, meaning queries always return results even when nothing is semantically relevant. Queries about topics not in the knowledge base (e.g., "quantum physics") will return the least-irrelevant documents rather than an empty result set.

6. **No FTS5 full-text search.** The keyword fallback uses `LIKE '%keyword%'`, which is a full table scan. At scale (100K+ chunks), this will be slow. An FTS5 index would provide fast, ranked full-text search.

7. **No alerting or metrics.** Sync failures are logged to Vercel's server logs (retained 1 hour on free, 3 days on Pro) and recorded in the `sync_status` table, but there are no Slack webhooks, email alerts, or external monitoring for failures.

8. **`/api/ingest` is a duplicate.** It provides the same functionality as `POST /api/sync` and exists for historical reasons.

9. **`initSchema()` runs on every request.** All query and status endpoints call `initSchema()` which runs 7+ `CREATE TABLE/INDEX IF NOT EXISTS` statements. This is unnecessary overhead after the first run but ensures the schema always exists.

---

## Development

### Prerequisites

- Node.js 20+
- npm
- A Turso database for the brain (create with `turso db create huddle-duck-brain --group default`)
- A Voyage AI API key (free tier at https://www.voyageai.com/)
- A Notion integration token (https://www.notion.so/my-integrations)

### Local Setup

```bash
# Clone and install
cd "/Users/asadshah/Claude Code Folder/huddle-duck-brain"
NPM_CONFIG_CACHE=/tmp/npm-cache npm install

# Create .env.local with all required variables
# (see Configuration section above for the full list)

# Run the dev server
npm run dev

# In dev mode, CRON_SECRET auth is bypassed if the variable is not set.
# You can query without auth headers locally.
```

### Build

```bash
NPM_CONFIG_CACHE=/tmp/npm-cache npm run build
```

### Manual Sync (local)

```bash
# Trigger a Turso sync
curl -s "http://localhost:3000/api/sync?source=turso"

# Trigger a Notion sync
curl -s "http://localhost:3000/api/sync?source=notion"

# Embed pending documents
curl -s "http://localhost:3000/api/embed"

# Check status
curl -s "http://localhost:3000/api/status"

# Query
curl -s -X POST "http://localhost:3000/api/query" \
  -H "Content-Type: application/json" \
  -d '{"query": "monthly revenue", "top_k": 3}'
```

### Deploying

The project is deployed to Vercel via Git push (auto-deploys via GitHub integration) or manually:

```bash
# Build locally first
NPM_CONFIG_CACHE=/tmp/npm-cache npm run build

# Deploy
npx vercel --prod
```

Ensure all environment variables are set in Vercel before deploying. The `CRON_SECRET` must be set for cron jobs and API authentication to work in production.

### Scripts

| Script | Command | Description |
|---|---|---|
| `dev` | `npm run dev` | Start Next.js development server |
| `build` | `npm run build` | Production build |
| `start` | `npm run start` | Start production server |
| `lint` | `npm run lint` | Run ESLint |
