import { createClient, type Client } from "@libsql/client";
import { SYNC_LOCK_TIMEOUT_SECONDS } from "./constants";
import type { HealthStatus } from "./types";

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
  get(_target, prop: string | symbol) {
    const client = getDb();
    const value = client[prop as keyof Client];
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
    // Sync lock: prevents concurrent sync jobs
    {
      sql: `CREATE TABLE IF NOT EXISTS sync_lock (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        locked_at TEXT,
        locked_by TEXT
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
    console.warn("[db] Vector index creation skipped (may already exist)");
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

// ---------------------------------------------------------------------------
// Sync Locking — prevents two sync jobs from running simultaneously
// ---------------------------------------------------------------------------

/**
 * Attempt to acquire the sync lock. Returns true if acquired, false if another
 * sync is already running (and the lock hasn't expired).
 */
export async function acquireSyncLock(lockId: string): Promise<boolean> {
  const db = getDb();

  // Insert the lock row if it doesn't exist (first time)
  await db.execute({
    sql: `INSERT OR IGNORE INTO sync_lock (id, locked_at, locked_by) VALUES (1, NULL, NULL)`,
    args: [],
  });

  // Try to acquire: only succeed if lock is NULL or expired
  const result = await db.execute({
    sql: `UPDATE sync_lock
          SET locked_at = datetime('now'), locked_by = ?
          WHERE id = 1
            AND (locked_at IS NULL
                 OR locked_at < datetime('now', '-' || ? || ' seconds'))`,
    args: [lockId, SYNC_LOCK_TIMEOUT_SECONDS],
  });

  return (result.rowsAffected ?? 0) > 0;
}

/**
 * Release the sync lock. Only releases if the lock is held by the given lockId.
 */
export async function releaseSyncLock(lockId: string): Promise<void> {
  const db = getDb();
  await db.execute({
    sql: `UPDATE sync_lock SET locked_at = NULL, locked_by = NULL WHERE id = 1 AND locked_by = ?`,
    args: [lockId],
  });
}

// ---------------------------------------------------------------------------
// Health / Status — comprehensive monitoring data
// ---------------------------------------------------------------------------

export async function getHealthStatus(): Promise<HealthStatus> {
  const db = getDb();

  const [
    syncStatusRows,
    docCountsBySource,
    docCountsByType,
    totalDocCount,
    totalChunkCount,
    embeddedChunkCount,
    unembeddedChunkCount,
    dbSizeEstimate,
  ] = await Promise.all([
    db.execute({
      sql: `SELECT source, last_sync, last_sync_successful, documents_synced, chunks_created
            FROM sync_status ORDER BY last_sync DESC`,
      args: [],
    }),
    db.execute({
      sql: `SELECT source, COUNT(*) as count FROM documents GROUP BY source`,
      args: [],
    }),
    db.execute({
      sql: `SELECT doc_type, COUNT(*) as count FROM documents GROUP BY doc_type`,
      args: [],
    }),
    db.execute({
      sql: `SELECT COUNT(*) as count FROM documents`,
      args: [],
    }),
    db.execute({
      sql: `SELECT COUNT(*) as count FROM chunks`,
      args: [],
    }),
    db.execute({
      sql: `SELECT COUNT(*) as count FROM chunks WHERE embedding IS NOT NULL`,
      args: [],
    }),
    db.execute({
      sql: `SELECT COUNT(*) as count FROM chunks WHERE embedding IS NULL`,
      args: [],
    }),
    // Estimate DB size: sum of content lengths (rough proxy since Turso doesn't expose file size via SQL)
    db.execute({
      sql: `SELECT
              COALESCE(SUM(LENGTH(content)), 0) as doc_bytes,
              (SELECT COALESCE(SUM(LENGTH(content)), 0) FROM chunks) as chunk_bytes
            FROM documents`,
      args: [],
    }),
  ]);

  const totalDocs = (totalDocCount.rows[0]?.count as number) || 0;
  const totalChunks = (totalChunkCount.rows[0]?.count as number) || 0;
  const withEmbeddings = (embeddedChunkCount.rows[0]?.count as number) || 0;
  const withoutEmbeddings = (unembeddedChunkCount.rows[0]?.count as number) || 0;

  const docBytes = (dbSizeEstimate.rows[0]?.doc_bytes as number) || 0;
  const chunkBytes = (dbSizeEstimate.rows[0]?.chunk_bytes as number) || 0;
  // Rough estimate: text content + ~4KB per embedding (1024 * 4 bytes) + overhead
  const embeddingBytes = withEmbeddings * 1024 * 4;
  const estimatedSizeMb = (docBytes + chunkBytes + embeddingBytes) / (1024 * 1024);

  const bySource: Record<string, number> = {};
  for (const row of docCountsBySource.rows) {
    bySource[row.source as string] = row.count as number;
  }

  const byDocType: Record<string, number> = {};
  for (const row of docCountsByType.rows) {
    byDocType[row.doc_type as string] = row.count as number;
  }

  interface SyncStatusRow {
    source: string;
    last_sync: string | null;
    last_sync_successful: number;
    documents_synced: number;
    chunks_created: number;
  }

  const syncSources = syncStatusRows.rows.map((row) => {
    const r = row as unknown as SyncStatusRow;
    return {
      source: r.source,
      last_sync: r.last_sync,
      successful: r.last_sync_successful === 1,
      documents_synced: r.documents_synced,
      chunks_created: r.chunks_created,
    };
  });

  const lastSuccessfulSync = syncSources
    .filter((s) => s.successful && s.last_sync)
    .sort((a, b) => (b.last_sync || "").localeCompare(a.last_sync || ""))[0]?.last_sync ?? null;

  // Determine overall health
  const allSourcesHealthy = syncSources.length > 0 && syncSources.every((s) => s.successful);
  const embeddingCoverage = totalChunks > 0 ? (withEmbeddings / totalChunks) * 100 : 0;
  let status: HealthStatus["status"] = "healthy";
  if (!allSourcesHealthy || embeddingCoverage < 50) {
    status = "degraded";
  }
  if (totalDocs === 0 || embeddingCoverage === 0) {
    status = "unhealthy";
  }

  return {
    status,
    timestamp: new Date().toISOString(),
    documents: {
      total: totalDocs,
      by_source: bySource,
      by_doc_type: byDocType,
    },
    chunks: {
      total: totalChunks,
      with_embeddings: withEmbeddings,
      without_embeddings: withoutEmbeddings,
      embedding_coverage_percent: Math.round(embeddingCoverage * 100) / 100,
      average_per_document: totalDocs > 0 ? Math.round((totalChunks / totalDocs) * 100) / 100 : 0,
    },
    sync: {
      sources: syncSources,
      last_successful_sync: lastSuccessfulSync,
    },
    database: {
      estimated_size_mb: Math.round(estimatedSizeMb * 100) / 100,
    },
  };
}
