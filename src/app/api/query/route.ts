import { queryKnowledge } from "@/lib/query-engine";
import { initSchema } from "@/lib/db";
import { verifyApiAuth, sanitizeErrorMessage } from "@/lib/retry";

// Max allowed values to prevent abuse
const MAX_TOP_K = 50;
const MAX_QUERY_LENGTH = 2000; // Characters — prevents excessive embedding token burn

export async function POST(req: Request) {
  // Auth: require bearer token
  if (!verifyApiAuth(req)) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    await initSchema();

    const body = await req.json();
    const { query, top_k, source, doc_type } = body;

    // Validate query
    if (!query || typeof query !== "string") {
      return Response.json({ error: "Missing 'query' field" }, { status: 400 });
    }

    const trimmedQuery = query.trim();
    if (trimmedQuery.length === 0) {
      return Response.json({ error: "Query cannot be empty" }, { status: 400 });
    }
    if (trimmedQuery.length > MAX_QUERY_LENGTH) {
      return Response.json(
        { error: `Query too long (max ${MAX_QUERY_LENGTH} characters)` },
        { status: 400 }
      );
    }

    // Validate top_k
    const validTopK = Math.min(
      Math.max(1, Math.floor(Number(top_k) || 10)),
      MAX_TOP_K
    );

    // Validate source filter (allowlist)
    const validSources = [
      "notion",
      "turso:client-dashboards",
      "turso:attribution-tracker",
      "turso:landing-page",
      "turso:finance",
    ];
    if (source && !validSources.includes(source)) {
      return Response.json(
        { error: `Invalid source. Valid options: ${validSources.join(", ")}` },
        { status: 400 }
      );
    }

    // Validate doc_type filter (allowlist)
    const validDocTypes = ["page", "database_row", "database_schema", "turso_record"];
    if (doc_type && !validDocTypes.includes(doc_type)) {
      return Response.json(
        { error: `Invalid doc_type. Valid options: ${validDocTypes.join(", ")}` },
        { status: 400 }
      );
    }

    const response = await queryKnowledge({
      query: trimmedQuery,
      top_k: validTopK,
      source,
      doc_type,
    });

    return Response.json(response);
  } catch (error: unknown) {
    console.error("Query error:", error);
    return Response.json(
      { error: sanitizeErrorMessage(error) },
      { status: 500 }
    );
  }
}
