import { createClient, type Client } from "@libsql/client";

let _db: Client | null = null;

export function getDb(): Client {
  if (!_db) {
    const url = process.env.TURSO_DATABASE_URL?.trim();
    const authToken = process.env.TURSO_AUTH_TOKEN?.trim();
    if (!url) throw new Error("TURSO_DATABASE_URL is not set");
    if (!authToken) throw new Error("TURSO_AUTH_TOKEN is not set");
    _db = createClient({ url, authToken });
  }
  return _db;
}

// Lazy proxy - defers client creation until first method call
export const db = new Proxy({} as Client, {
  get(_target, prop) {
    const client = getDb();
    const value = (client as any)[prop];
    if (typeof value === "function") return value.bind(client);
    return value;
  },
});

export async function initSchema(): Promise<void> {
  const db = getDb();

  await db.batch([
    // Documents: source pages and records
    {
      sql: `CREATE TABLE IF NOT EXISTS documents (
        id TEXT NOT NULL,
        source TEXT NOT NULL,
        source_url TEXT,
        title TEXT NOT NULL,
        doc_type TEXT NOT NULL,
        content TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        metadata TEXT,
        last_edited TEXT,
        synced_at TEXT DEFAULT (datetime('now')),
        PRIMARY KEY (source, id)
      )`,
      args: [],
    },
    // Chunks: split documents for embedding
    {
      sql: `CREATE TABLE IF NOT EXISTS chunks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        document_id TEXT NOT NULL,
        document_source TEXT NOT NULL,
        chunk_index INTEGER NOT NULL,
        content TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        heading TEXT,
        metadata TEXT,
        embedding F32_BLOB(1024),
        created_at TEXT DEFAULT (datetime('now')),
        UNIQUE(document_source, document_id, chunk_index)
      )`,
      args: [],
    },
    // Sync status tracking
    {
      sql: `CREATE TABLE IF NOT EXISTS sync_status (
        source TEXT PRIMARY KEY,
        last_sync TEXT,
        last_sync_successful INTEGER DEFAULT 0,
        documents_synced INTEGER DEFAULT 0,
        chunks_created INTEGER DEFAULT 0,
        error_message TEXT
      )`,
      args: [],
    },
    // Indexes
    {
      sql: `CREATE INDEX IF NOT EXISTS idx_documents_source ON documents(source)`,
      args: [],
    },
    {
      sql: `CREATE INDEX IF NOT EXISTS idx_documents_hash ON documents(content_hash)`,
      args: [],
    },
    {
      sql: `CREATE INDEX IF NOT EXISTS idx_chunks_document ON chunks(document_source, document_id)`,
      args: [],
    },
  ]);

  // Vector index (separate because CREATE INDEX with function may not work in batch)
  try {
    await db.execute({
      sql: `CREATE INDEX IF NOT EXISTS chunks_vec_idx ON chunks (libsql_vector_idx(embedding, 'metric=cosine'))`,
      args: [],
    });
  } catch {
    // Index may already exist or vector extension syntax differs
    console.warn("Vector index creation skipped (may already exist)");
  }
}

export async function updateSyncStatus(
  source: string,
  successful: boolean,
  documentsSynced: number,
  chunksCreated: number,
  errorMessage?: string
): Promise<void> {
  const db = getDb();
  await db.execute({
    sql: `INSERT INTO sync_status (source, last_sync, last_sync_successful, documents_synced, chunks_created, error_message)
          VALUES (?, datetime('now'), ?, ?, ?, ?)
          ON CONFLICT(source) DO UPDATE SET
            last_sync = datetime('now'),
            last_sync_successful = ?,
            documents_synced = ?,
            chunks_created = ?,
            error_message = ?`,
    args: [
      source,
      successful ? 1 : 0,
      documentsSynced,
      chunksCreated,
      errorMessage ?? null,
      successful ? 1 : 0,
      documentsSynced,
      chunksCreated,
      errorMessage ?? null,
    ],
  });
}
