// src/lib/query-engine.ts
import { getDb } from "./db";
import { generateQueryEmbedding, embeddingToVector } from "./embeddings";
import type { QueryRequest, QueryResult } from "./types";

export async function queryKnowledge(request: QueryRequest): Promise<QueryResult[]> {
  const { query, top_k = 10, source, doc_type } = request;
  const db = getDb();

  // Generate query embedding
  const embedding = await generateQueryEmbedding(query);
  const vectorStr = embeddingToVector(embedding);

  // Build WHERE clause for filters
  const conditions: string[] = [];
  const args: any[] = [vectorStr, top_k * 2];

  if (source) {
    conditions.push("d.source = ?");
    args.push(source);
  }
  if (doc_type) {
    conditions.push("d.doc_type = ?");
    args.push(doc_type);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  // Vector similarity search
  const vecResults = await db.execute({
    sql: `SELECT c.id, c.content, c.heading, c.metadata as chunk_metadata,
                 d.title, d.source, d.source_url, d.doc_type, d.metadata as doc_metadata
          FROM vector_top_k('chunks_vec_idx', vector32(?), ?) AS v
          JOIN chunks c ON c.rowid = v.id
          JOIN documents d ON d.id = c.document_id AND d.source = c.document_source
          ${whereClause}`,
    args,
  });

  const results: QueryResult[] = vecResults.rows.slice(0, top_k).map((row: any) => ({
    chunk_content: row.content,
    document_title: row.title,
    document_source: row.source,
    source_url: row.source_url,
    doc_type: row.doc_type,
    similarity: 1, // vector_top_k doesn't return distance directly; ranked by relevance
    metadata: row.doc_metadata ? JSON.parse(row.doc_metadata) : null,
  }));

  return results;
}

// Simple text search fallback (no FTS5 - just LIKE for v1)
export async function searchByKeyword(
  keyword: string,
  limit: number = 10
): Promise<QueryResult[]> {
  const db = getDb();

  const results = await db.execute({
    sql: `SELECT c.content, d.title, d.source, d.source_url, d.doc_type, d.metadata
          FROM chunks c
          JOIN documents d ON d.id = c.document_id AND d.source = c.document_source
          WHERE c.content LIKE ?
          LIMIT ?`,
    args: [`%${keyword}%`, limit],
  });

  return results.rows.map((row: any) => ({
    chunk_content: row.content,
    document_title: row.title,
    document_source: row.source,
    source_url: row.source_url,
    doc_type: row.doc_type,
    similarity: 0.5, // Keyword match, no scoring
    metadata: row.metadata ? JSON.parse(row.metadata) : null,
  }));
}
