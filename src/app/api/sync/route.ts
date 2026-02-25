import { runFullSync } from "@/lib/sync-engine";
import { verifyCronSecret } from "@/lib/retry";

export const maxDuration = 300; // 5 minutes for full sync

export async function GET(req: Request) {
  const authHeader = req.headers.get("authorization");
  if (!verifyCronSecret(authHeader)) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const result = await runFullSync();
    return Response.json({
      success: true,
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
