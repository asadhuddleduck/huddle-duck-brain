import { getDb, initSchema, updateSyncStatus, acquireSyncLock, releaseSyncLock } from "./db";
import { crawlNotionWorkspace, type CrawlOptions } from "./notion-crawler";
import { crawlTursoDatabases } from "./turso-sync";
import { chunkDocument } from "./chunker";
import { hashContent } from "./hash";
import { generateEmbeddings, embeddingToVector } from "./embeddings";
import { MAX_DOCS_PER_BATCH, CHUNK_BATCH_SIZE } from "./constants";
import type { Document } from "./types";
import type { Client, InStatement } from "@libsql/client";

/** Prepared chunk data ready for embedding and storage */
interface PreparedChunk {
  documentId: string;
  documentSource: string;
  index: number;
  content: string;
  heading: string | null;
  metadata: string;
}

/** Chunk a document and return prepared chunks ready for embedding */
function prepareChunks(doc: { id: string; source: string; title: string; content: string }): PreparedChunk[] {
  const chunks = chunkDocument(doc.content, doc.title);
  return chunks.map((chunk) => ({
    documentId: doc.id,
    documentSource: doc.source,
    index: chunk.index,
    content: chunk.content,
    heading: chunk.heading,
    metadata: JSON.stringify(chunk.metadata),
  }));
}

/** Generate embeddings and store chunks in batches, returning count of successes and errors */
async function embedAndStoreChunks(
  db: Client,
  allChunks: PreparedChunk[]
): Promise<{ chunksCreated: number; errors: string[] }> {
  const errors: string[] = [];
  let chunksCreated = 0;

  if (allChunks.length === 0) {
    return { chunksCreated, errors };
  }

  const chunkTexts = allChunks.map((c) => c.content);
  let embeddings: number[][];

  try {
    embeddings = await generateEmbeddings(chunkTexts, "document");
  } catch (error: unknown) {
    const msg = `Embedding generation failed: ${error instanceof Error ? error.message : String(error)}`;
    console.error(`[sync] ${msg}`);
    errors.push(msg);
    return { chunksCreated, errors };
  }

  // Store chunks in batches of CHUNK_BATCH_SIZE using db.batch()
  for (let i = 0; i < allChunks.length; i += CHUNK_BATCH_SIZE) {
    const batchChunks = allChunks.slice(i, i + CHUNK_BATCH_SIZE);
    const batchEmbeddings = embeddings.slice(i, i + CHUNK_BATCH_SIZE);

    // Build batch statements with pre-resolved embeddings
    const statements: InStatement[] = batchChunks.map((chunk, j) => ({
      sql: `INSERT INTO chunks (document_id, document_source, chunk_index, content, content_hash, heading, metadata, embedding)
            VALUES (?, ?, ?, ?, ?, ?, ?, vector32(?))
            ON CONFLICT(document_source, document_id, chunk_index) DO UPDATE SET
              content = excluded.content,
              content_hash = excluded.content_hash,
              heading = excluded.heading,
              metadata = excluded.metadata,
              embedding = excluded.embedding`,
      args: [
        chunk.documentId, chunk.documentSource, chunk.index,
        chunk.content, hashContent(chunk.content), chunk.heading,
        chunk.metadata, embeddingToVector(batchEmbeddings[j]),
      ],
    }));

    try {
      await db.batch(statements);
      chunksCreated += batchChunks.length;
    } catch (error: unknown) {
      // If batch fails, fall back to individual inserts to salvage what we can
      console.warn(`[sync] Batch insert failed (chunk ${i}-${i + batchChunks.length}), falling back to individual inserts`);
      for (let j = 0; j < statements.length; j++) {
        try {
          await db.execute(statements[j]);
          chunksCreated++;
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          errors.push(`Chunk storage failed for doc ${batchChunks[j].documentId}: ${msg}`);
        }
      }
    }
  }

  return { chunksCreated, errors };
}

/** Generate a unique lock ID for this invocation */
function generateLockId(): string {
  return `sync_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

// --- Embed pending documents (called by /api/embed) ---

export async function embedPending(): Promise<{
  chunksCreated: number;
  remaining: number;
  errors: string[];
}> {
  const db = getDb();
  await initSchema();

  // Acquire lock to prevent concurrent embed jobs from processing the same docs
  // (wastes Voyage API tokens even though upsert prevents duplicate data)
  const lockId = `embed_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const lockAcquired = await acquireSyncLock(lockId);
  if (!lockAcquired) {
    console.warn("[embed] Another embed/sync job is already running, skipping");
    return { chunksCreated: 0, remaining: 0, errors: ["Embed skipped: another job is already running"] };
  }

  try {
    return await _embedPendingInternal(db);
  } finally {
    await releaseSyncLock(lockId);
  }
}

// ---------------------------------------------------------------------------
// MEMORY PRESSURE ANALYSIS for embedPending():
// ---------------------------------------------------------------------------
// Peak memory with MAX_DOCS_PER_BATCH=50:
// - 50 docs' full content in DB result rows: ~50 * 5KB = 250KB
// - allChunks array (50 docs * ~4 chunks): ~200 PreparedChunk objects = ~1MB
// - Embeddings array (200 * 1024 floats * 8 bytes): ~1.6MB
// - Total peak: ~3MB. Well within Vercel's 1GB limit.
//
// At MAX_DOCS_PER_BATCH=50 with worst-case 20KB docs and 20 chunks each:
// - 50 * 20KB content = 1MB
// - 1000 chunks * ~1KB each = 1MB
// - 1000 embeddings * 8KB = 8MB
// - Total peak: ~10MB. Still safe.
//
// TODO: If MAX_DOCS_PER_BATCH ever exceeds ~500 with large documents,
// consider streaming: process docs in sub-batches (chunk + embed + store
// one sub-batch before loading the next) to avoid holding all content
// and embeddings in memory simultaneously.
// ---------------------------------------------------------------------------

async function _embedPendingInternal(db: ReturnType<typeof getDb>): Promise<{
  chunksCreated: number;
  remaining: number;
  errors: string[];
}> {
  // Find documents with no embedded chunks
  const unembedded = await db.execute({
    sql: `SELECT d.id, d.source, d.title, d.content
          FROM documents d
          WHERE NOT EXISTS (
            SELECT 1 FROM chunks c
            WHERE c.document_id = d.id AND c.document_source = d.source AND c.embedding IS NOT NULL
          )
          LIMIT ?`,
    args: [MAX_DOCS_PER_BATCH],
  });

  const totalUnembedded = await db.execute({
    sql: `SELECT COUNT(*) as count FROM documents d
          WHERE NOT EXISTS (
            SELECT 1 FROM chunks c
            WHERE c.document_id = d.id AND c.document_source = d.source AND c.embedding IS NOT NULL
          )`,
    args: [],
  });

  const total = totalUnembedded.rows[0]?.count as number;
  const rows = unembedded.rows;

  if (rows.length === 0) {
    return { chunksCreated: 0, remaining: 0, errors: [] };
  }

  console.log(`[embed] Processing ${rows.length} of ${total} unembedded documents`);

  // Chunk all documents (upsert strategy: no pre-delete)
  const allChunks: PreparedChunk[] = [];
  const chunkCountByDoc = new Map<string, { docId: string; docSource: string; count: number }>();

  for (const row of rows) {
    const docId = row.id as string;
    const docSource = row.source as string;
    const title = (row.title as string) || "Untitled";
    const content = (row.content as string) || "";

    if (!content.trim()) {
      console.warn(`[embed] Skipping doc ${docId} (${docSource}): empty content`);
      continue;
    }

    const prepared = prepareChunks({ id: docId, source: docSource, title, content });
    allChunks.push(...prepared);
    chunkCountByDoc.set(`${docSource}::${docId}`, { docId, docSource, count: prepared.length });
  }

  console.log(`[embed] Generated ${allChunks.length} chunks`);

  // Generate embeddings and store chunks using shared helper (upsert via ON CONFLICT)
  const result = await embedAndStoreChunks(db, allChunks);

  // Clean up stale chunks beyond new chunk counts — batched (crash-safe:
  // extra chunks are harmless, missing chunks are not)
  if (result.chunksCreated > 0) {
    const cleanupEntries = Array.from(chunkCountByDoc.values());
    for (let i = 0; i < cleanupEntries.length; i += CHUNK_BATCH_SIZE) {
      const batch = cleanupEntries.slice(i, i + CHUNK_BATCH_SIZE);
      const stmts: InStatement[] = batch.map(({ docId, docSource, count }) => ({
        sql: "DELETE FROM chunks WHERE document_id = ? AND document_source = ? AND chunk_index >= ?",
        args: [docId, docSource, count],
      }));
      await db.batch(stmts);
    }
  }

  const remaining = total - rows.length;
  console.log(`[embed] Stored ${result.chunksCreated} chunks, ${remaining} documents remaining`);
  return { chunksCreated: result.chunksCreated, remaining, errors: result.errors };
}

// --- Get last successful Notion sync time ---

async function getLastNotionSync(): Promise<string | null> {
  const db = getDb();
  try {
    const result = await db.execute({
      sql: "SELECT last_sync FROM sync_status WHERE source = 'notion' AND last_sync_successful = 1",
      args: [],
    });
    return (result.rows[0]?.last_sync as string) ?? null;
  } catch {
    return null;
  }
}

// --- Notion crawl-only mode ---
// Crawls Notion, stores documents in DB (no embedding).
// Embedding is handled separately by /api/embed.

export async function syncNotionCrawlOnly(): Promise<{
  documentsStored: number;
  documentsUnchanged: number;
  partial: boolean;
  errors: string[];
}> {
  const db = getDb();
  await initSchema();

  const errors: string[] = [];
  let documentsStored = 0;
  let documentsUnchanged = 0;

  // Get last successful sync time for incremental crawl
  const lastSync = await getLastNotionSync();

  // Build crawl options: incremental if we have a previous sync,
  // full crawl on first run or if last sync was >24h ago (safety net)
  const crawlOptions: CrawlOptions = {};

  if (lastSync) {
    const lastSyncDate = new Date(lastSync);
    const hoursSinceSync = (Date.now() - lastSyncDate.getTime()) / (1000 * 60 * 60);

    if (hoursSinceSync < 24) {
      // Incremental: only fetch pages edited since last sync
      // Subtract 5 min buffer to avoid missing pages edited during previous sync
      const sinceDate = new Date(lastSyncDate.getTime() - 5 * 60 * 1000);
      crawlOptions.since = sinceDate.toISOString();
      console.log(`[sync] Incremental: fetching pages edited since ${crawlOptions.since}`);
    } else {
      console.log(`[sync] Full sync: last sync was ${hoursSinceSync.toFixed(1)}h ago (>24h threshold)`);
    }
  } else {
    console.log("[sync] Full sync: no previous successful sync found");
  }

  // Crawl Notion with time budget
  let crawlResult;
  try {
    crawlResult = await crawlNotionWorkspace(crawlOptions);
  } catch (error: unknown) {
    const msg = `Notion crawl failed: ${error instanceof Error ? error.message : String(error)}`;
    console.error(`[sync] ${msg}`);
    errors.push(msg);
    await updateSyncStatus("notion", false, 0, 0, msg);
    return { documentsStored: 0, documentsUnchanged: 0, partial: true, errors };
  }

  const { documents, partial } = crawlResult;
  console.log(`[sync] Crawl returned ${documents.length} documents (partial: ${partial})`);

  // -------------------------------------------------------------------------
  // SCALABILITY FIX: Batch hash lookups (N+1 query elimination)
  // -------------------------------------------------------------------------
  // Previously: N individual SELECT queries to check each document's hash.
  // At 5,000 docs, that was 5,000 round trips just for hash comparison.
  // Now: One query loads ALL existing hashes for Notion into a Map,
  // then we compare in-memory. Reduces N queries to 1.
  // -------------------------------------------------------------------------
  const existingHashes = new Map<string, string>();
  try {
    const hashResult = await db.execute({
      sql: "SELECT id, content_hash FROM documents WHERE source = 'notion'",
      args: [],
    });
    for (const row of hashResult.rows) {
      existingHashes.set(row.id as string, row.content_hash as string);
    }
  } catch {
    console.warn("[sync] Failed to load existing hashes, will treat all as new");
  }

  // Separate changed from unchanged using in-memory comparison
  const changedNotionDocs: Document[] = [];
  for (const doc of documents) {
    if (existingHashes.get(doc.id) === doc.content_hash) {
      documentsUnchanged++;
    } else {
      changedNotionDocs.push(doc);
    }
  }

  // -------------------------------------------------------------------------
  // SCALABILITY FIX: Batch document upserts + chunk deletes
  // -------------------------------------------------------------------------
  // Previously: N individual INSERT + N individual DELETE per changed doc.
  // At 500 changed docs, that was 1,000 sequential round trips.
  // Now: Batch in groups of CHUNK_BATCH_SIZE.
  // -------------------------------------------------------------------------
  for (let i = 0; i < changedNotionDocs.length; i += CHUNK_BATCH_SIZE) {
    const batch = changedNotionDocs.slice(i, i + CHUNK_BATCH_SIZE);
    const statements: InStatement[] = [];
    for (const doc of batch) {
      statements.push({
        sql: `INSERT INTO documents (id, source, source_url, title, doc_type, content, content_hash, metadata, last_edited, synced_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
              ON CONFLICT(source, id) DO UPDATE SET
                source_url = excluded.source_url,
                title = excluded.title,
                content = excluded.content,
                content_hash = excluded.content_hash,
                metadata = excluded.metadata,
                last_edited = excluded.last_edited,
                synced_at = datetime('now')`,
        args: [
          doc.id, doc.source, doc.source_url, doc.title, doc.doc_type,
          doc.content, doc.content_hash, doc.metadata, doc.last_edited,
        ],
      });
      statements.push({
        sql: "DELETE FROM chunks WHERE document_id = ? AND document_source = ?",
        args: [doc.id, doc.source],
      });
    }

    try {
      await db.batch(statements);
      documentsStored += batch.length;
    } catch {
      console.warn("[sync] Batch upsert failed, falling back to individual inserts");
      for (let j = 0; j < batch.length; j++) {
        try {
          await db.execute(statements[j * 2]);     // upsert
          await db.execute(statements[j * 2 + 1]); // chunk delete
          documentsStored++;
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          errors.push(`Failed to store doc ${batch[j].id}: ${msg}`);
        }
      }
    }
  }

  // Only do orphan cleanup on full (non-partial, non-incremental) syncs
  if (!partial && !crawlOptions.since) {
    console.log("[sync] Full sync complete -- running orphan cleanup for Notion documents");
    const crawledIds = new Set(documents.map((d) => d.id));
    try {
      const storedDocs = await db.execute({
        sql: "SELECT id FROM documents WHERE source = 'notion'",
        args: [],
      });

      // Collect orphans, then batch delete (was 2 round trips per orphan)
      const orphanIds: string[] = [];
      for (const row of storedDocs.rows) {
        const docId = row.id as string;
        if (!crawledIds.has(docId)) orphanIds.push(docId);
      }

      if (orphanIds.length > 0) {
        for (let i = 0; i < orphanIds.length; i += CHUNK_BATCH_SIZE) {
          const batchIds = orphanIds.slice(i, i + CHUNK_BATCH_SIZE);
          const batchDeletes: InStatement[] = [];
          for (const docId of batchIds) {
            batchDeletes.push({ sql: "DELETE FROM chunks WHERE document_id = ? AND document_source = 'notion'", args: [docId] });
            batchDeletes.push({ sql: "DELETE FROM documents WHERE id = ? AND source = 'notion'", args: [docId] });
          }
          await db.batch(batchDeletes);
        }
        console.log(`[sync] Removed ${orphanIds.length} orphaned Notion documents`);
      }
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      errors.push(`Orphan cleanup failed: ${msg}`);
    }
  }

  // Update sync status (only mark successful if not partial)
  await updateSyncStatus(
    "notion",
    !partial,
    documentsStored,
    0, // chunks are created later by /api/embed
    partial ? "Partial crawl (time budget exceeded)" : undefined
  );

  console.log(
    `[sync] Notion: ${documentsStored} stored, ${documentsUnchanged} unchanged, ` +
    `partial: ${partial}, errors: ${errors.length}`
  );

  return { documentsStored, documentsUnchanged, partial, errors };
}

// --- Full sync with locking (prevents concurrent sync jobs) ---

export async function runFullSync(sourceFilter?: "notion" | "turso"): Promise<{
  documentsProcessed: number;
  chunksCreated: number;
  chunksSkipped: number;
  remaining: number;
  partial: boolean;
  errors: string[];
}> {
  await initSchema();

  // Acquire sync lock to prevent concurrent sync jobs
  const lockId = generateLockId();
  const lockAcquired = await acquireSyncLock(lockId);

  if (!lockAcquired) {
    console.warn("[sync] Another sync job is already running, skipping");
    return {
      documentsProcessed: 0,
      chunksCreated: 0,
      chunksSkipped: 0,
      remaining: 0,
      partial: false,
      errors: ["Sync skipped: another sync job is already running"],
    };
  }

  try {
    return await runFullSyncInternal(sourceFilter);
  } finally {
    // Always release the lock, even on error
    await releaseSyncLock(lockId);
  }
}

/** Internal sync logic, runs with the sync lock held. */
async function runFullSyncInternal(sourceFilter?: "notion" | "turso"): Promise<{
  documentsProcessed: number;
  chunksCreated: number;
  chunksSkipped: number;
  remaining: number;
  partial: boolean;
  errors: string[];
}> {
  const db = getDb();

  const errors: string[] = [];
  let documentsProcessed = 0;
  let chunksCreated = 0;
  let chunksSkipped = 0;
  let partial = false;

  console.log(`[sync] Starting${sourceFilter ? ` (${sourceFilter} only)` : ""}...`);

  // --- Notion: crawl-only mode (store docs, skip embedding) ---
  if (!sourceFilter || sourceFilter === "notion") {
    const notionResult = await syncNotionCrawlOnly();
    documentsProcessed += notionResult.documentsStored;
    chunksSkipped += notionResult.documentsUnchanged;
    partial = notionResult.partial;
    errors.push(...notionResult.errors);

    // Count how many Notion docs still need embedding
    const unembeddedCount = await db.execute({
      sql: `SELECT COUNT(*) as count FROM documents d
            WHERE d.source = 'notion'
            AND NOT EXISTS (
              SELECT 1 FROM chunks c
              WHERE c.document_id = d.id AND c.document_source = d.source AND c.embedding IS NOT NULL
            )`,
      args: [],
    });
    const remaining = unembeddedCount.rows[0]?.count as number;

    if (sourceFilter === "notion") {
      console.log(
        `[sync] Notion complete: ${documentsProcessed} updated, ` +
        `${chunksSkipped} unchanged, ${remaining} awaiting embedding`
      );
      return { documentsProcessed, chunksCreated, chunksSkipped, remaining, partial, errors };
    }
  }

  // --- Turso: original full pipeline (crawl + embed in same invocation) ---
  if (!sourceFilter || sourceFilter === "turso") {
    let tursoDocs: Document[] = [];
    try {
      tursoDocs = await crawlTursoDatabases();
      await updateSyncStatus("turso", true, tursoDocs.length, 0);
    } catch (error: unknown) {
      const msg = `Turso sync failed: ${error instanceof Error ? error.message : String(error)}`;
      console.error(`[sync] ${msg}`);
      errors.push(msg);
      await updateSyncStatus("turso", false, 0, 0, msg);
    }

    // -----------------------------------------------------------------------
    // SCALABILITY FIX: Batch hash + embedding lookups for Turso (N+1 elimination)
    // -----------------------------------------------------------------------
    // Previously: 2 queries per doc (hash check + embedding check) = 2N round trips.
    // At 1,274 Turso docs, that was 2,548 round trips.
    // Now: 2 bulk queries load all hashes + embedded doc IDs, then compare in-memory.
    // -----------------------------------------------------------------------
    const tursoHashes = new Map<string, string>();
    const tursoEmbeddedDocs = new Set<string>();
    try {
      const [hashRows, embeddedRows] = await Promise.all([
        db.execute({
          sql: "SELECT source, id, content_hash FROM documents WHERE source LIKE 'turso:%'",
          args: [],
        }),
        db.execute({
          sql: `SELECT DISTINCT document_source, document_id FROM chunks
                WHERE document_source LIKE 'turso:%' AND embedding IS NOT NULL`,
          args: [],
        }),
      ]);
      for (const row of hashRows.rows) {
        tursoHashes.set(`${row.source}:${row.id}`, row.content_hash as string);
      }
      for (const row of embeddedRows.rows) {
        tursoEmbeddedDocs.add(`${row.document_source}:${row.document_id}`);
      }
    } catch {
      console.warn("[sync] Failed to load Turso hashes/embeddings, will treat all as changed");
    }

    // Classify docs using in-memory lookups
    const changedDocs: Document[] = [];
    for (const doc of tursoDocs) {
      const key = `${doc.source}:${doc.id}`;
      const existingHash = tursoHashes.get(key);
      if (existingHash === doc.content_hash && tursoEmbeddedDocs.has(key)) {
        chunksSkipped++;
        continue;
      }
      changedDocs.push(doc);
      documentsProcessed++;
    }

    // Batch upsert changed Turso documents
    for (let i = 0; i < changedDocs.length; i += CHUNK_BATCH_SIZE) {
      const batch = changedDocs.slice(i, i + CHUNK_BATCH_SIZE);
      const statements: InStatement[] = batch.map((doc) => ({
        sql: `INSERT INTO documents (id, source, source_url, title, doc_type, content, content_hash, metadata, last_edited, synced_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
              ON CONFLICT(source, id) DO UPDATE SET
                source_url = excluded.source_url,
                title = excluded.title,
                content = excluded.content,
                content_hash = excluded.content_hash,
                metadata = excluded.metadata,
                last_edited = excluded.last_edited,
                synced_at = datetime('now')`,
        args: [
          doc.id, doc.source, doc.source_url, doc.title, doc.doc_type,
          doc.content, doc.content_hash, doc.metadata, doc.last_edited,
        ],
      }));
      try {
        await db.batch(statements);
      } catch {
        console.warn("[sync] Batch Turso upsert failed, falling back to individual inserts");
        for (const stmt of statements) {
          try { await db.execute(stmt); } catch { /* individual errors logged below */ }
        }
      }
    }

    console.log(`[sync] Turso: ${changedDocs.length} changed, ${chunksSkipped} unchanged`);

    if (changedDocs.length > 0) {
      const docsToProcess = changedDocs.slice(0, MAX_DOCS_PER_BATCH);
      const tursoRemaining = changedDocs.length - docsToProcess.length;

      // Chunk changed documents using shared helper (upsert strategy: no pre-delete)
      const allChunks: PreparedChunk[] = [];
      const tursoChunkCounts = new Map<string, { docId: string; docSource: string; count: number }>();

      for (const doc of docsToProcess) {
        const prepared = prepareChunks(doc);
        allChunks.push(...prepared);
        tursoChunkCounts.set(`${doc.source}::${doc.id}`, {
          docId: doc.id, docSource: doc.source, count: prepared.length,
        });
      }

      // Embed and store using shared helper (upsert via ON CONFLICT)
      const embedResult = await embedAndStoreChunks(db, allChunks);
      chunksCreated += embedResult.chunksCreated;
      errors.push(...embedResult.errors);

      // Clean up stale chunks beyond new chunk counts — batched (crash-safe)
      if (embedResult.chunksCreated > 0) {
        const cleanupEntries = Array.from(tursoChunkCounts.values());
        for (let ci = 0; ci < cleanupEntries.length; ci += CHUNK_BATCH_SIZE) {
          const batch = cleanupEntries.slice(ci, ci + CHUNK_BATCH_SIZE);
          const stmts: InStatement[] = batch.map(({ docId, docSource, count }) => ({
            sql: "DELETE FROM chunks WHERE document_id = ? AND document_source = ? AND chunk_index >= ?",
            args: [docId, docSource, count],
          }));
          await db.batch(stmts);
        }
      }

      // If embedding failed entirely, return early
      if (embedResult.chunksCreated === 0 && allChunks.length > 0 && embedResult.errors.length > 0) {
        return {
          documentsProcessed, chunksCreated, chunksSkipped,
          remaining: tursoRemaining, partial, errors,
        };
      }

      // Turso orphan cleanup — batched (only when not partial)
      if (tursoRemaining === 0) {
        const tursoDocIds = new Set(tursoDocs.map((d) => `${d.source}:${d.id}`));
        const storedTursoDocs = await db.execute({
          sql: "SELECT source, id FROM documents WHERE source LIKE 'turso:%'",
          args: [],
        });
        const orphanRows = storedTursoDocs.rows.filter(
          (row) => !tursoDocIds.has(`${row.source}:${row.id}`)
        );
        if (orphanRows.length > 0) {
          for (let oi = 0; oi < orphanRows.length; oi += CHUNK_BATCH_SIZE) {
            const batch = orphanRows.slice(oi, oi + CHUNK_BATCH_SIZE);
            const stmts: InStatement[] = [];
            for (const row of batch) {
              stmts.push({ sql: "DELETE FROM chunks WHERE document_id = ? AND document_source = ?", args: [row.id as string, row.source as string] });
              stmts.push({ sql: "DELETE FROM documents WHERE id = ? AND source = ?", args: [row.id as string, row.source as string] });
            }
            await db.batch(stmts);
          }
          console.log(`[sync] Removed ${orphanRows.length} orphaned Turso documents`);
        }
      }
    }
  }

  // Calculate total remaining (unembedded docs across all sources)
  const totalRemaining = await db.execute({
    sql: `SELECT COUNT(*) as count FROM documents d
          WHERE NOT EXISTS (
            SELECT 1 FROM chunks c
            WHERE c.document_id = d.id AND c.document_source = d.source AND c.embedding IS NOT NULL
          )`,
    args: [],
  });
  const remaining = totalRemaining.rows[0]?.count as number;

  console.log(
    `[sync] Complete: ${documentsProcessed} docs processed, ${chunksCreated} chunks created, ` +
    `${chunksSkipped} unchanged, ${remaining} awaiting embedding, partial: ${partial}`
  );

  return { documentsProcessed, chunksCreated, chunksSkipped, remaining, partial, errors };
}
