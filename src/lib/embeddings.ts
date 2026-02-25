// src/lib/embeddings.ts
import { withRetry } from "./retry";
import {
  VOYAGE_API_URL,
  VOYAGE_MODEL,
  VOYAGE_BATCH_SIZE,
  EMBEDDING_DIMENSIONS,
} from "./constants";

interface VoyageResponse {
  data: Array<{ embedding: number[]; index: number }>;
  usage: { total_tokens: number };
}

interface VoyageApiError extends Error {
  status: number;
  headers: Record<string, string>;
}

/**
 * Custom error class for embedding failures.
 * Allows callers (e.g. query-engine) to detect embedding service issues
 * and fall back to keyword search.
 */
export class EmbeddingServiceError extends Error {
  public readonly isServiceError = true;
  public readonly status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = "EmbeddingServiceError";
    this.status = status;
  }
}

export async function generateEmbeddings(
  texts: string[],
  inputType: "document" | "query" = "document"
): Promise<number[][]> {
  const apiKey = process.env.VOYAGE_API_KEY?.trim();
  if (!apiKey) throw new EmbeddingServiceError("VOYAGE_API_KEY is not set");

  const allEmbeddings: number[][] = new Array(texts.length);
  let totalTokens = 0;

  // Process in batches
  for (let i = 0; i < texts.length; i += VOYAGE_BATCH_SIZE) {
    const batch = texts.slice(i, i + VOYAGE_BATCH_SIZE);

    const response = await withRetry(async () => {
      const res = await fetch(VOYAGE_API_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          input: batch,
          model: VOYAGE_MODEL,
          input_type: inputType,
          output_dimension: EMBEDDING_DIMENSIONS,
        }),
      });

      if (!res.ok) {
        const error = new EmbeddingServiceError(
          `Voyage API error: ${res.status}`,
          res.status
        ) as EmbeddingServiceError & VoyageApiError;
        error.headers = Object.fromEntries(res.headers.entries());
        throw error;
      }

      return res.json() as Promise<VoyageResponse>;
    });

    for (const item of response.data) {
      allEmbeddings[i + item.index] = item.embedding;
    }

    totalTokens += response.usage.total_tokens;
  }

  console.log(`[embeddings] Generated ${texts.length} embeddings (${totalTokens} tokens)`);
  return allEmbeddings;
}

/**
 * Generate a single query embedding.
 * Does NOT retry on failure — if Voyage is down, throws EmbeddingServiceError
 * so the query engine can fall back to keyword search immediately rather than
 * hanging the serverless function with exponential backoff.
 */
export async function generateQueryEmbedding(query: string): Promise<number[]> {
  const apiKey = process.env.VOYAGE_API_KEY?.trim();
  if (!apiKey) throw new EmbeddingServiceError("VOYAGE_API_KEY is not set");

  const res = await fetch(VOYAGE_API_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      input: [query],
      model: VOYAGE_MODEL,
      input_type: "query",
      output_dimension: EMBEDDING_DIMENSIONS,
    }),
  });

  if (!res.ok) {
    throw new EmbeddingServiceError(`Voyage API error: ${res.status}`, res.status);
  }

  const data = (await res.json()) as VoyageResponse;
  return data.data[0].embedding;
}

/** Convert embedding array to Turso vector format string */
export function embeddingToVector(embedding: number[]): string {
  return `[${embedding.join(",")}]`;
}

export { EMBEDDING_DIMENSIONS };
