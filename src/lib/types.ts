export interface Document {
  id: string;
  source: string;           // 'notion' | 'turso:client-dashboards' | etc.
  source_url: string | null;
  title: string;
  doc_type: string;          // 'page' | 'database_row' | 'database_schema' | 'turso_record'
  content: string;
  content_hash: string;
  metadata: string | null;   // JSON
  last_edited: string | null;
  synced_at: string;
}

export interface Chunk {
  id: number;
  document_id: string;
  chunk_index: number;
  content: string;
  content_hash: string;
  heading: string | null;     // Current heading context
  metadata: string | null;    // JSON
  created_at: string;
}

export interface SyncStatus {
  source: string;
  last_sync: string | null;
  last_sync_successful: number;
  documents_synced: number;
  chunks_created: number;
  error_message: string | null;
}

export interface QueryResult {
  chunk_content: string;
  document_title: string;
  document_source: string;
  source_url: string | null;
  doc_type: string;
  similarity: number;
  heading: string | null;
  metadata: Record<string, unknown> | null;
}

export interface QueryRequest {
  query: string;
  top_k?: number;         // default 10
  source?: string;        // filter by source
  doc_type?: string;      // filter by doc_type
}

// ---------------------------------------------------------------------------
// Enhanced query response with deduplication and source summary
// ---------------------------------------------------------------------------

export interface QueryResponse {
  results: QueryResult[];
  sources: SourceSummary[];
  count: number;
  search_method: "vector" | "keyword_fallback";
}

export interface SourceSummary {
  source: string;
  doc_type: string;
  result_count: number;
}

// ---------------------------------------------------------------------------
// Error types for distinguishing error categories
// ---------------------------------------------------------------------------

export type QueryErrorCode =
  | "NO_RESULTS"
  | "EMBEDDING_SERVICE_ERROR"
  | "DATABASE_ERROR"
  | "INVALID_REQUEST";

export class QueryError extends Error {
  public readonly code: QueryErrorCode;
  public readonly statusCode: number;

  constructor(message: string, code: QueryErrorCode, statusCode: number = 500) {
    super(message);
    this.name = "QueryError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

// ---------------------------------------------------------------------------
// Health / Status types
// ---------------------------------------------------------------------------

export interface HealthStatus {
  status: "healthy" | "degraded" | "unhealthy";
  timestamp: string;
  documents: {
    total: number;
    by_source: Record<string, number>;
    by_doc_type: Record<string, number>;
  };
  chunks: {
    total: number;
    with_embeddings: number;
    without_embeddings: number;
    embedding_coverage_percent: number;
    average_per_document: number;
  };
  sync: {
    sources: Array<{
      source: string;
      last_sync: string | null;
      successful: boolean;
      documents_synced: number;
      chunks_created: number;
    }>;
    last_successful_sync: string | null;
  };
  database: {
    estimated_size_mb: number;
  };
}
