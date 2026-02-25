import { runFullSync } from "@/lib/sync-engine";
import { verifyCronSecret, sanitizeErrorMessage } from "@/lib/retry";

export const maxDuration = 300; // 5 minutes

export async function GET(req: Request) {
  const authHeader = req.headers.get("authorization");
  if (!verifyCronSecret(authHeader)) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(req.url);
  const source = url.searchParams.get("source") as "notion" | "turso" | undefined;

  // Validate source parameter
  if (source && source !== "notion" && source !== "turso") {
    return Response.json({ error: "Invalid source. Use 'notion' or 'turso'." }, { status: 400 });
  }

  try {
    const result = await runFullSync(source || undefined);
    return Response.json({
      success: true,
      source: source || "all",
      ...result,
      message: result.partial
        ? "Partial sync completed (time budget exceeded). Next cron run will continue."
        : "Sync complete.",
      timestamp: new Date().toISOString(),
    });
  } catch (error: unknown) {
    console.error("Sync error:", error);
    return Response.json(
      { error: sanitizeErrorMessage(error) },
      { status: 500 }
    );
  }
}

// Also allow POST for manual triggers
export async function POST(req: Request) {
  return GET(req);
}
