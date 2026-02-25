import { embedPending } from "@/lib/sync-engine";
import { verifyCronSecret } from "@/lib/retry";

export const maxDuration = 300; // 5 minutes

export async function GET(req: Request) {
  const authHeader = req.headers.get("authorization");
  if (!verifyCronSecret(authHeader)) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const result = await embedPending();
    return Response.json({
      success: true,
      ...result,
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    console.error("Embed error:", error);
    return Response.json({ error: error.message }, { status: 500 });
  }
}

export async function POST(req: Request) {
  return GET(req);
}
