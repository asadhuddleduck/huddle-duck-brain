import { getDb, initSchema } from "@/lib/db";

export async function GET() {
  try {
    await initSchema();
    const db = getDb();

    const [syncStatus, docCount, chunkCount] = await Promise.all([
      db.execute({ sql: "SELECT * FROM sync_status ORDER BY last_sync DESC", args: [] }),
      db.execute({ sql: "SELECT source, doc_type, COUNT(*) as count FROM documents GROUP BY source, doc_type", args: [] }),
      db.execute({ sql: "SELECT COUNT(*) as count FROM chunks WHERE embedding IS NOT NULL", args: [] }),
    ]);

    return Response.json({
      sync_status: syncStatus.rows,
      document_counts: docCount.rows,
      total_embedded_chunks: chunkCount.rows[0]?.count || 0,
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}
