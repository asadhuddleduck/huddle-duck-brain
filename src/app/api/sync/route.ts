import { runFullSync } from "@/lib/sync-engine";
import { verifyCronSecret } from "@/lib/retry";

export const maxDuration = 300; // 5 minutes

export async function GET(req: Request) {
  const authHeader = req.headers.get("authorization");
  if (!verifyCronSecret(authHeader)) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(req.url);
  const source = url.searchParams.get("source") as "notion" | "turso" | undefined;

  try {
    const result = await runFullSync(source || undefined);
    return Response.json({
      success: true,
      source: source || "all",
      ...result,
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    console.error("Sync error:", error);
    return Response.json({ error: error.message }, { status: 500 });
  }
}

// Also allow POST for manual triggers
export async function POST(req: Request) {
  return GET(req);
}
