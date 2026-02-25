// src/lib/embeddings.ts
import { withRetry } from "./retry";

const VOYAGE_API_URL = "https://api.voyageai.com/v1/embeddings";
const MODEL = "voyage-4";
const BATCH_SIZE = 100; // Voyage supports up to 1000, but keep batches manageable
const DIMENSIONS = 1024;

interface VoyageResponse {
  data: Array<{ embedding: number[]; index: number }>;
  usage: { total_tokens: number };
}

export async function generateEmbeddings(
  texts: string[],
  inputType: "document" | "query" = "document"
): Promise<number[][]> {
  const apiKey = process.env.VOYAGE_API_KEY?.trim();
  if (!apiKey) throw new Error("VOYAGE_API_KEY is not set");

  const allEmbeddings: number[][] = new Array(texts.length);
  let totalTokens = 0;

  // Process in batches
  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE);

    const response = await withRetry(async () => {
      const res = await fetch(VOYAGE_API_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          input: batch,
          model: MODEL,
          input_type: inputType,
          output_dimension: DIMENSIONS,
        }),
      });

      if (!res.ok) {
        const error: any = new Error(`Voyage API error: ${res.status}`);
        error.status = res.status;
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

  console.log(`Generated ${texts.length} embeddings (${totalTokens} tokens used)`);
  return allEmbeddings;
}

export async function generateQueryEmbedding(query: string): Promise<number[]> {
  const embeddings = await generateEmbeddings([query], "query");
  return embeddings[0];
}

// Convert embedding array to Turso vector format string
export function embeddingToVector(embedding: number[]): string {
  return `[${embedding.join(",")}]`;
}

export { DIMENSIONS };
