import { getDb, initSchema, getMonthlyTokenUsage } from "@/lib/db";
import { verifyApiAuth, sanitizeErrorMessage } from "@/lib/retry";

export async function GET(req: Request) {
  // Auth: require bearer token (status reveals infrastructure details)
  if (!verifyApiAuth(req)) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    await initSchema();
    const db = getDb();

    const [syncStatus, docCount, chunkCount, tokenUsage] = await Promise.all([
      db.execute({ sql: "SELECT source, last_sync, last_sync_successful, documents_synced, chunks_created FROM sync_status ORDER BY last_sync DESC", args: [] }),
      db.execute({ sql: "SELECT source, doc_type, COUNT(*) as count FROM documents GROUP BY source, doc_type", args: [] }),
      db.execute({ sql: "SELECT COUNT(*) as count FROM chunks WHERE embedding IS NOT NULL", args: [] }),
      getMonthlyTokenUsage(),
    ]);

    // Note: error_message is intentionally excluded from the response
    // to avoid leaking internal error details. Check server logs instead.

    return Response.json({
      sync_status: syncStatus.rows,
      document_counts: docCount.rows,
      total_embedded_chunks: chunkCount.rows[0]?.count || 0,
      voyage_ai_usage: tokenUsage,
      timestamp: new Date().toISOString(),
    });
  } catch (error: unknown) {
    console.error("Status error:", error);
    return Response.json(
      { error: sanitizeErrorMessage(error) },
      { status: 500 }
    );
  }
}
