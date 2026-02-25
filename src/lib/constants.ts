// src/lib/constants.ts — Centralized configuration constants
// All tunable parameters in one place. Change values here without touching logic code.

// ---------------------------------------------------------------------------
// Sync Engine
// ---------------------------------------------------------------------------

/** Max documents to chunk + embed per invocation (avoids Vercel 300s timeout) */
export const MAX_DOCS_PER_BATCH = 50;

/** Sync lock timeout in seconds — if a lock is older than this, consider it stale */
export const SYNC_LOCK_TIMEOUT_SECONDS = 600; // 10 minutes

// ---------------------------------------------------------------------------
// Voyage AI Embeddings
// ---------------------------------------------------------------------------

/** Voyage AI embedding model */
export const VOYAGE_MODEL = "voyage-4";

/** Voyage AI embedding dimensions */
export const EMBEDDING_DIMENSIONS = 1024;

/** Voyage API batch size (supports up to 1000, keep manageable) */
export const VOYAGE_BATCH_SIZE = 100;

/** Voyage API base URL */
export const VOYAGE_API_URL = "https://api.voyageai.com/v1/embeddings";

// ---------------------------------------------------------------------------
// Chunker
// ---------------------------------------------------------------------------

/** Chunker: max characters per chunk (~250 tokens for voyage-4) */
export const MAX_CHUNK_SIZE = 1000;

/** Chunker: minimum viable chunk size */
export const MIN_CHUNK_SIZE = 100;

/** Chunker: character overlap between consecutive chunks */
export const CHUNK_OVERLAP = 100;

// ---------------------------------------------------------------------------
// Notion API
// ---------------------------------------------------------------------------

/** Notion API: max concurrent requests per second */
export const NOTION_RATE_LIMIT = 3;

/** Notion API: max recursion depth for nested blocks */
export const NOTION_MAX_BLOCK_DEPTH = 10;

// ---------------------------------------------------------------------------
// Query Engine
// ---------------------------------------------------------------------------

/** Default similarity score for vector search results (ranked, not scored) */
export const VECTOR_SEARCH_SIMILARITY = 1;

/** Default similarity score for keyword search results (no scoring) */
export const KEYWORD_SEARCH_SIMILARITY = 0.5;

/** Default top_k for query results */
export const DEFAULT_TOP_K = 10;

/** Oversample factor for vector search (fetch more, then slice to top_k) */
export const VECTOR_OVERSAMPLE_FACTOR = 2;

/** Minimum similarity threshold — results below this are filtered out */
export const MIN_SIMILARITY_THRESHOLD = 0.0;

/** Max keyword search results for fallback when vector search is unavailable */
export const KEYWORD_FALLBACK_LIMIT = 20;

// ---------------------------------------------------------------------------
// Retry
// ---------------------------------------------------------------------------

/** Default max retry attempts for API calls */
export const DEFAULT_MAX_RETRY_ATTEMPTS = 3;

/** Default base delay in ms for exponential backoff */
export const DEFAULT_RETRY_BASE_DELAY_MS = 1000;
