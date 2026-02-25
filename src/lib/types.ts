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
  metadata: Record<string, unknown> | null;
}

export interface QueryRequest {
  query: string;
  top_k?: number;         // default 10
  source?: string;        // filter by source
  doc_type?: string;      // filter by doc_type
}
