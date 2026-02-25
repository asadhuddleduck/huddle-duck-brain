import { queryKnowledge } from "@/lib/query-engine";
import { initSchema } from "@/lib/db";

export async function POST(req: Request) {
  try {
    await initSchema();

    const body = await req.json();
    const { query, top_k, source, doc_type } = body;

    if (!query || typeof query !== "string") {
      return Response.json({ error: "Missing 'query' field" }, { status: 400 });
    }

    const results = await queryKnowledge({
      query,
      top_k: top_k || 10,
      source,
      doc_type,
    });

    return Response.json({ results, count: results.length });
  } catch (error: any) {
    console.error("Query error:", error);
    return Response.json({ error: error.message }, { status: 500 });
  }
}
