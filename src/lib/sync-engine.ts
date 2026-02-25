import { getDb, initSchema, updateSyncStatus } from "./db";
import { crawlNotionWorkspace } from "./notion-crawler";
import { crawlTursoDatabases } from "./turso-sync";
import { chunkDocument, hashChunk } from "./chunker";
import { generateEmbeddings, embeddingToVector } from "./embeddings";
import type { Document } from "./types";

// Max documents to chunk+embed per invocation (avoids 300s timeout)
const MAX_DOCS_PER_BATCH = 50;

// Embed documents that are stored but have no embedded chunks
export async function embedPending(): Promise<{
  chunksCreated: number;
  remaining: number;
  errors: string[];
}> {
  const db = getDb();
  await initSchema();

  const errors: string[] = [];
  let chunksCreated = 0;

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

  console.log(`Embedding ${rows.length} of ${total} unembedded documents...`);

  // Chunk all documents
  const allChunks: Array<{
    documentId: string;
    documentSource: string;
    index: number;
    content: string;
    heading: string | null;
    metadata: string;
  }> = [];

  for (const row of rows) {
    const docId = row.id as string;
    const docSource = row.source as string;
    const title = row.title as string;
    const content = row.content as string;

    // Delete old chunks
    await db.execute({
      sql: "DELETE FROM chunks WHERE document_id = ? AND document_source = ?",
      args: [docId, docSource],
    });

    const chunks = chunkDocument(content, title);
    for (const chunk of chunks) {
      allChunks.push({
        documentId: docId,
        documentSource: docSource,
        index: chunk.index,
        content: chunk.content,
        heading: chunk.heading,
        metadata: JSON.stringify(chunk.metadata),
      });
    }
  }

  console.log(`Generated ${allChunks.length} chunks`);

  // Generate embeddings
  const chunkTexts = allChunks.map((c) => c.content);
  let embeddings: number[][];

  try {
    embeddings = await generateEmbeddings(chunkTexts, "document");
  } catch (error: any) {
    const msg = `Embedding failed: ${error.message}`;
    console.error(msg);
    errors.push(msg);
    return { chunksCreated, remaining: total, errors };
  }

  // Store chunks
  for (let i = 0; i < allChunks.length; i++) {
    const chunk = allChunks[i];
    const embedding = embeddings[i];

    try {
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
          chunk.content, hashChunk(chunk.content), chunk.heading,
          chunk.metadata, embeddingToVector(embedding),
        ],
      });
      chunksCreated++;
    } catch (error: any) {
      errors.push(`Chunk store failed: ${error.message}`);
    }
  }

  const remaining = total - rows.length;
  console.log(`Embedded ${chunksCreated} chunks, ${remaining} documents remaining`);
  return { chunksCreated, remaining, errors };
}

export async function runFullSync(sourceFilter?: "notion" | "turso"): Promise<{
  documentsProcessed: number;
  chunksCreated: number;
  chunksSkipped: number;
  remaining: number;
  errors: string[];
}> {
  const db = getDb();
  await initSchema();

  const errors: string[] = [];
  let documentsProcessed = 0;
  let chunksCreated = 0;
  let chunksSkipped = 0;

  // 1. Crawl sources (filtered if specified)
  console.log(`Starting sync${sourceFilter ? ` (${sourceFilter} only)` : ""}...`);

  let notionDocs: Document[] = [];
  if (!sourceFilter || sourceFilter === "notion") {
    try {
      notionDocs = await crawlNotionWorkspace();
      await updateSyncStatus("notion", true, notionDocs.length, 0);
    } catch (error: any) {
      const msg = `Notion crawl failed: ${error.message}`;
      console.error(msg);
      errors.push(msg);
      await updateSyncStatus("notion", false, 0, 0, msg);
    }
  }

  let tursoDocs: Document[] = [];
  if (!sourceFilter || sourceFilter === "turso") {
    try {
      tursoDocs = await crawlTursoDatabases();
      await updateSyncStatus("turso", true, tursoDocs.length, 0);
    } catch (error: any) {
      const msg = `Turso sync failed: ${error.message}`;
      console.error(msg);
      errors.push(msg);
      await updateSyncStatus("turso", false, 0, 0, msg);
    }
  }

  const allDocs = [...notionDocs, ...tursoDocs];
  console.log(`Total documents to process: ${allDocs.length}`);

  // 2. Upsert documents and check for changes
  const changedDocs: Document[] = [];

  for (const doc of allDocs) {
    // Check if content has changed
    const existing = await db.execute({
      sql: "SELECT content_hash FROM documents WHERE source = ? AND id = ?",
      args: [doc.source, doc.id],
    });

    const existingHash = existing.rows[0]?.content_hash as string | undefined;

    if (existingHash === doc.content_hash) {
      // Check if chunks exist for this document (may have been stored but not embedded)
      const chunkCheck = await db.execute({
        sql: "SELECT COUNT(*) as count FROM chunks WHERE document_id = ? AND document_source = ? AND embedding IS NOT NULL",
        args: [doc.id, doc.source],
      });
      const hasEmbeddedChunks = (chunkCheck.rows[0]?.count as number) > 0;

      if (hasEmbeddedChunks) {
        chunksSkipped++;
        continue;
      }
      // Document exists but has no embedded chunks — needs re-processing
    }

    // Upsert document
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

  console.log(`${changedDocs.length} documents need processing, ${chunksSkipped} unchanged`);

  if (changedDocs.length === 0) {
    console.log("No changes detected. Sync complete.");
    return { documentsProcessed, chunksCreated, chunksSkipped, remaining: 0, errors };
  }

  // Limit batch size to avoid timeout
  const docsToProcess = changedDocs.slice(0, MAX_DOCS_PER_BATCH);
  const remaining = changedDocs.length - docsToProcess.length;
  if (remaining > 0) {
    console.log(`Processing ${docsToProcess.length} of ${changedDocs.length} docs (${remaining} remaining for next run)`);
  }

  // 3. Chunk changed documents
  const allChunks: Array<{
    documentId: string;
    documentSource: string;
    index: number;
    content: string;
    heading: string | null;
    metadata: string;
  }> = [];

  for (const doc of docsToProcess) {
    // Delete old chunks for this document
    await db.execute({
      sql: "DELETE FROM chunks WHERE document_id = ? AND document_source = ?",
      args: [doc.id, doc.source],
    });

    const chunks = chunkDocument(doc.content, doc.title);
    for (const chunk of chunks) {
      allChunks.push({
        documentId: doc.id,
        documentSource: doc.source,
        index: chunk.index,
        content: chunk.content,
        heading: chunk.heading,
        metadata: JSON.stringify(chunk.metadata),
      });
    }
  }

  console.log(`Generated ${allChunks.length} chunks from ${docsToProcess.length} documents`);

  // 4. Generate embeddings in batch
  const chunkTexts = allChunks.map((c) => c.content);
  let embeddings: number[][];

  try {
    embeddings = await generateEmbeddings(chunkTexts, "document");
  } catch (error: any) {
    const msg = `Embedding generation failed: ${error.message}`;
    console.error(msg);
    errors.push(msg);
    return { documentsProcessed, chunksCreated, chunksSkipped, remaining, errors };
  }

  // 5. Store chunks with embeddings
  for (let i = 0; i < allChunks.length; i++) {
    const chunk = allChunks[i];
    const embedding = embeddings[i];

    try {
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
          chunk.documentId,
          chunk.documentSource,
          chunk.index,
          chunk.content,
          hashChunk(chunk.content),
          chunk.heading,
          chunk.metadata,
          embeddingToVector(embedding),
        ],
      });
      chunksCreated++;
    } catch (error: any) {
      console.error(`Failed to store chunk ${i}:`, error.message);
      errors.push(`Chunk storage failed for doc ${chunk.documentId}: ${error.message}`);
    }
  }

  // 6. Clean up orphaned documents (only when fully synced, not partial batch)
  if (remaining > 0) {
    console.log("Skipping orphan cleanup (partial batch)");
    console.log(`Sync complete: ${documentsProcessed} docs processed, ${chunksCreated} chunks created, ${remaining} remaining`);
    return { documentsProcessed, chunksCreated, chunksSkipped, remaining, errors };
  }

  const allDocIds = new Set(allDocs.map((d) => `${d.source}:${d.id}`));
  const storedDocs = await db.execute({
    sql: "SELECT source, id FROM documents",
    args: [],
  });

  for (const row of storedDocs.rows) {
    const key = `${row.source}:${row.id}`;
    if (!allDocIds.has(key)) {
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

  console.log(`Sync complete: ${documentsProcessed} docs processed, ${chunksCreated} chunks created, ${remaining} remaining`);
  return { documentsProcessed, chunksCreated, chunksSkipped, remaining, errors };
}
