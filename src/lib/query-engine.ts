// src/lib/query-engine.ts
import { getDb } from "./db";
import { generateQueryEmbedding, embeddingToVector, EmbeddingServiceError } from "./embeddings";
import {
  DEFAULT_TOP_K,
  VECTOR_OVERSAMPLE_FACTOR,
  KEYWORD_SEARCH_SIMILARITY,
  KEYWORD_FALLBACK_LIMIT,
} from "./constants";
import type { QueryRequest, QueryResult, QueryResponse, SourceSummary } from "./types";
import { QueryError } from "./types";
import type { Value } from "@libsql/client";

// ---------------------------------------------------------------------------
// Row shapes returned by SQL queries
// ---------------------------------------------------------------------------

interface VectorSearchRow {
  id: number;
  distance: number;
  content: string;
  heading: string | null;
  chunk_metadata: string | null;
  doc_id: string;
  title: string;
  source: string;
  source_url: string | null;
  doc_type: string;
  doc_metadata: string | null;
}

interface KeywordSearchRow {
  content: string;
  heading: string | null;
  title: string;
  source: string;
  source_url: string | null;
  doc_type: string;
  metadata: string | null;
}

// ---------------------------------------------------------------------------
// Main entry point — vector search with automatic keyword fallback
// ---------------------------------------------------------------------------

export async function queryKnowledge(request: QueryRequest): Promise<QueryResponse> {
  const { query, source, doc_type } = request;
  const top_k = Math.min(Math.max(1, Math.floor(request.top_k || DEFAULT_TOP_K)), 50);

  // Try vector search first
  try {
    const results = await vectorSearch(query, top_k, source, doc_type);
    const deduplicated = deduplicateByDocument(results, top_k);
    return {
      results: deduplicated,
      sources: buildSourceSummary(deduplicated),
      count: deduplicated.length,
      search_method: "vector",
    };
  } catch (error: unknown) {
    // If embedding service is down, gracefully fall back to keyword search
    if (error instanceof EmbeddingServiceError) {
      console.warn(
        `[query-engine] Voyage AI unavailable (${error.message}), falling back to keyword search`
      );
      const fallbackLimit = Math.min(top_k, KEYWORD_FALLBACK_LIMIT);
      const fallbackResults = await searchByKeyword(query, fallbackLimit, source, doc_type);
      const deduplicated = deduplicateByDocument(fallbackResults, top_k);
      return {
        results: deduplicated,
        sources: buildSourceSummary(deduplicated),
        count: deduplicated.length,
        search_method: "keyword_fallback",
      };
    }

    // Re-throw non-embedding errors (database errors, etc.)
    throw new QueryError(
      error instanceof Error ? error.message : "Unknown query error",
      "DATABASE_ERROR",
      500
    );
  }
}

// ---------------------------------------------------------------------------
// Vector similarity search
// ---------------------------------------------------------------------------

async function vectorSearch(
  query: string,
  topK: number,
  source?: string,
  docType?: string
): Promise<QueryResult[]> {
  const db = getDb();

  // Generate query embedding — throws EmbeddingServiceError if Voyage is down
  const embedding = await generateQueryEmbedding(query);
  const vectorStr = embeddingToVector(embedding);

  // Oversample to allow for post-query filtering by source/docType.
  // Adding WHERE clauses on joined tables alongside vector_top_k() causes
  // the query planner to hang, so we fetch more results and filter in JS.
  const fetchCount = (source || docType)
    ? topK * VECTOR_OVERSAMPLE_FACTOR * 2
    : topK * VECTOR_OVERSAMPLE_FACTOR;

  const vecResults = await db.execute({
    sql: `SELECT c.id, vector_distance_cos(c.embedding, vector32(?)) as distance,
                 c.content, c.heading, c.metadata as chunk_metadata,
                 d.id as doc_id, d.title, d.source, d.source_url, d.doc_type, d.metadata as doc_metadata
          FROM vector_top_k('chunks_vec_idx', vector32(?), ?) AS v
          JOIN chunks c ON c.rowid = v.id
          JOIN documents d ON d.id = c.document_id AND d.source = c.document_source`,
    args: [vectorStr, vectorStr, fetchCount],
  });

  // Post-query filtering: apply source/docType filters in application code
  // to avoid the vector_top_k + WHERE hang issue
  let rows = vecResults.rows.map((row) => row as unknown as VectorSearchRow);

  if (source) {
    rows = rows.filter((r) => r.source === source);
  }
  if (docType) {
    rows = rows.filter((r) => r.doc_type === docType);
  }

  return rows.map((r) => {
    // Turso cosine distance: 0 = identical, 2 = opposite (for cosine metric)
    // Similarity = 1 - distance (clamped to 0-1 range)
    const similarity = Math.max(0, Math.min(1, 1 - (r.distance ?? 0)));

    return {
      chunk_content: r.content,
      document_title: r.title,
      document_source: r.source,
      source_url: r.source_url,
      doc_type: r.doc_type,
      heading: r.heading ?? null,
      similarity,
      metadata: r.doc_metadata ? JSON.parse(r.doc_metadata) as Record<string, unknown> : null,
    };
  });
}

// ---------------------------------------------------------------------------
// Keyword search fallback (LIKE-based, no FTS5)
// ---------------------------------------------------------------------------

export async function searchByKeyword(
  keyword: string,
  limit: number = DEFAULT_TOP_K,
  source?: string,
  docType?: string
): Promise<QueryResult[]> {
  const db = getDb();

  const safeLimit = Math.min(Math.max(1, Math.floor(limit)), 50);

  // Escape SQL LIKE wildcards to prevent wildcard injection
  const escapedKeyword = keyword
    .replace(/\\/g, "\\\\")
    .replace(/%/g, "\\%")
    .replace(/_/g, "\\_");

  // Build WHERE clause
  const conditions: string[] = ["c.content LIKE ? ESCAPE '\\'"];
  const args: Value[] = [`%${escapedKeyword}%`];

  if (source) {
    conditions.push("d.source = ?");
    args.push(source);
  }
  if (docType) {
    conditions.push("d.doc_type = ?");
    args.push(docType);
  }

  args.push(safeLimit);

  const results = await db.execute({
    sql: `SELECT c.content, c.heading, d.title, d.source, d.source_url, d.doc_type, d.metadata
          FROM chunks c
          JOIN documents d ON d.id = c.document_id AND d.source = c.document_source
          WHERE ${conditions.join(" AND ")}
          LIMIT ?`,
    args,
  });

  return results.rows.map((row) => {
    const r = row as unknown as KeywordSearchRow;
    return {
      chunk_content: r.content,
      document_title: r.title,
      document_source: r.source,
      source_url: r.source_url,
      doc_type: r.doc_type,
      heading: r.heading ?? null,
      similarity: KEYWORD_SEARCH_SIMILARITY,
      metadata: r.metadata ? JSON.parse(r.metadata) as Record<string, unknown> : null,
    };
  });
}

// ---------------------------------------------------------------------------
// Deduplication — keep only the best chunk per document
// ---------------------------------------------------------------------------

function deduplicateByDocument(results: QueryResult[], topK: number): QueryResult[] {
  const seen = new Map<string, QueryResult>();

  for (const result of results) {
    // Unique key per document (source + title combination)
    const docKey = `${result.document_source}::${result.document_title}`;

    const existing = seen.get(docKey);
    if (!existing || result.similarity > existing.similarity) {
      seen.set(docKey, result);
    }
  }

  return Array.from(seen.values())
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, topK);
}

// ---------------------------------------------------------------------------
// Source summary — unique sources found in results
// ---------------------------------------------------------------------------

function buildSourceSummary(results: QueryResult[]): SourceSummary[] {
  const sourceMap = new Map<string, SourceSummary>();

  for (const result of results) {
    const key = `${result.document_source}::${result.doc_type}`;
    const existing = sourceMap.get(key);
    if (existing) {
      existing.result_count++;
    } else {
      sourceMap.set(key, {
        source: result.document_source,
        doc_type: result.doc_type,
        result_count: 1,
      });
    }
  }

  return Array.from(sourceMap.values()).sort((a, b) => b.result_count - a.result_count);
}
