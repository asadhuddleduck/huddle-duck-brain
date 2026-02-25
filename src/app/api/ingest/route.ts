import { runFullSync } from "@/lib/sync-engine";
import { verifyCronSecret, sanitizeErrorMessage } from "@/lib/retry";

export const maxDuration = 300;

export async function POST(req: Request) {
  // Auth: use the same verifyCronSecret as other protected endpoints
  const authHeader = req.headers.get("authorization");
  if (!verifyCronSecret(authHeader)) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = await req.json().catch(() => ({}));
    const source = body.source as "notion" | "turso" | undefined;

    if (source && source !== "notion" && source !== "turso") {
      return Response.json({ error: "Invalid source. Use 'notion' or 'turso'." }, { status: 400 });
    }

    const result = await runFullSync(source);
    return Response.json({
      success: true,
      ...result,
      message: result.partial
        ? "Partial sync completed (time budget exceeded). Call again to continue."
        : "Sync complete.",
      timestamp: new Date().toISOString(),
    });
  } catch (error: unknown) {
    console.error("Ingest error:", error);
    return Response.json(
      { error: sanitizeErrorMessage(error) },
      { status: 500 }
    );
  }
}
