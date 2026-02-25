import { getDb, initSchema, updateSyncStatus, acquireSyncLock, releaseSyncLock } from "./db";
import { crawlNotionWorkspace, type CrawlOptions } from "./notion-crawler";
import { crawlTursoDatabases } from "./turso-sync";
import { chunkDocument } from "./chunker";
import { hashContent } from "./hash";
import { generateEmbeddings, embeddingToVector } from "./embeddings";
import { MAX_DOCS_PER_BATCH } from "./constants";
import type { Document } from "./types";
import type { Client } from "@libsql/client";

/** Prepared chunk data ready for embedding and storage */
interface PreparedChunk {
  documentId: string;
  documentSource: string;
  index: number;
  content: string;
  heading: string | null;
  metadata: string;
}

/** Upsert a single chunk with its embedding into the database */
async function storeChunkWithEmbedding(
  db: Client,
  chunk: PreparedChunk,
  embedding: number[]
): Promise<void> {
  await db.execute({
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
      chunk.metadata, embeddingToVector(embedding),
    ],
  });
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

/** Generate embeddings and store chunks, returning count of successes and errors */
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

  for (let i = 0; i < allChunks.length; i++) {
    try {
      await storeChunkWithEmbedding(db, allChunks[i], embeddings[i]);
      chunksCreated++;
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      errors.push(`Chunk storage failed for doc ${allChunks[i].documentId}: ${msg}`);
    }
  }

  return { chunksCreated, errors };
}

/** Generate a unique lock ID for this invocation */
function generateLockId(): string {
  return `sync_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Clean up stale chunks for a document after upsert.
 *
 * Instead of DELETE-all + INSERT (which loses data on crash between the two),
 * we upsert new chunks via ON CONFLICT, then delete any old chunk indices
 * beyond the new chunk count. This is crash-safe: if we crash between upsert
 * and cleanup, we just have extra stale chunks, not missing data.
 */
async function cleanupStaleChunks(
  db: Client,
  docId: string,
  docSource: string,
  newChunkCount: number
): Promise<void> {
  await db.execute({
    sql: `DELETE FROM chunks
          WHERE document_id = ? AND document_source = ? AND chunk_index >= ?`,
    args: [docId, docSource, newChunkCount],
  });
}

// --- Embed pending documents (called by /api/embed) ---

export async function embedPending(): Promise<{
  chunksCreated: number;
  remaining: number;
  errors: string[];
}> {
  const db = getDb();
  await initSchema();

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
    const title = row.title as string;
    const content = row.content as string;

    const prepared = prepareChunks({ id: docId, source: docSource, title, content });
    allChunks.push(...prepared);
    chunkCountByDoc.set(`${docSource}::${docId}`, { docId, docSource, count: prepared.length });
  }

  console.log(`[embed] Generated ${allChunks.length} chunks`);

  // Generate embeddings and store chunks using shared helper (upsert via ON CONFLICT)
  const result = await embedAndStoreChunks(db, allChunks);

  // Clean up stale chunks beyond new chunk counts (crash-safe: extra chunks
  // are harmless, missing chunks are not)
  if (result.chunksCreated > 0) {
    for (const { docId, docSource, count } of chunkCountByDoc.values()) {
      await cleanupStaleChunks(db, docId, docSource, count);
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

  // Upsert documents into DB (no chunking, no embedding)
  for (const doc of documents) {
    try {
      // Check if content has changed
      const existing = await db.execute({
        sql: "SELECT content_hash FROM documents WHERE source = ? AND id = ?",
        args: [doc.source, doc.id],
      });

      const existingHash = existing.rows[0]?.content_hash as string | undefined;
      if (existingHash === doc.content_hash) {
        documentsUnchanged++;
        continue;
      }

      // Upsert document — content changed or new doc
      await db.execute({
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

      // Delete old chunks so /api/embed knows to re-embed this doc
      await db.execute({
        sql: "DELETE FROM chunks WHERE document_id = ? AND document_source = ?",
        args: [doc.id, doc.source],
      });

      documentsStored++;
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      errors.push(`Failed to store doc ${doc.id}: ${msg}`);
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
      let orphansRemoved = 0;
      for (const row of storedDocs.rows) {
        const docId = row.id as string;
        if (!crawledIds.has(docId)) {
          await db.execute({
            sql: "DELETE FROM chunks WHERE document_id = ? AND document_source = 'notion'",
            args: [docId],
          });
          await db.execute({
            sql: "DELETE FROM documents WHERE id = ? AND source = 'notion'",
            args: [docId],
          });
          orphansRemoved++;
        }
      }
      if (orphansRemoved > 0) {
        console.log(`[sync] Removed ${orphansRemoved} orphaned Notion documents`);
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

    // Upsert Turso documents and find changed ones
    const changedDocs: Document[] = [];
    for (const doc of tursoDocs) {
      const existing = await db.execute({
        sql: "SELECT content_hash FROM documents WHERE source = ? AND id = ?",
        args: [doc.source, doc.id],
      });

      const existingHash = existing.rows[0]?.content_hash as string | undefined;
      if (existingHash === doc.content_hash) {
        const chunkCheck = await db.execute({
          sql: "SELECT COUNT(*) as count FROM chunks WHERE document_id = ? AND document_source = ? AND embedding IS NOT NULL",
          args: [doc.id, doc.source],
        });
        const hasEmbeddedChunks = (chunkCheck.rows[0]?.count as number) > 0;
        if (hasEmbeddedChunks) {
          chunksSkipped++;
          continue;
        }
      }

      await db.execute({
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

      changedDocs.push(doc);
      documentsProcessed++;
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

      // Clean up stale chunks beyond new chunk counts (crash-safe)
      if (embedResult.chunksCreated > 0) {
        for (const { docId, docSource, count } of tursoChunkCounts.values()) {
          await cleanupStaleChunks(db, docId, docSource, count);
        }
      }

      // If embedding failed entirely, return early
      if (embedResult.chunksCreated === 0 && allChunks.length > 0 && embedResult.errors.length > 0) {
        return {
          documentsProcessed, chunksCreated, chunksSkipped,
          remaining: tursoRemaining, partial, errors,
        };
      }

      // Turso orphan cleanup (only when not partial)
      if (tursoRemaining === 0) {
        const tursoDocIds = new Set(tursoDocs.map((d) => `${d.source}:${d.id}`));
        const storedTursoDocs = await db.execute({
          sql: "SELECT source, id FROM documents WHERE source LIKE 'turso:%'",
          args: [],
        });
        for (const row of storedTursoDocs.rows) {
          const key = `${row.source}:${row.id}`;
          if (!tursoDocIds.has(key)) {
            await db.execute({
              sql: "DELETE FROM chunks WHERE document_id = ? AND document_source = ?",
              args: [row.id as string, row.source as string],
            });
            await db.execute({
              sql: "DELETE FROM documents WHERE id = ? AND source = ?",
              args: [row.id as string, row.source as string],
            });
          }
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
