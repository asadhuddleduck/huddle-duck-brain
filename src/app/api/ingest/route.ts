import { runFullSync } from "@/lib/sync-engine";

export const maxDuration = 300;

export async function POST(req: Request) {
  // Simple bearer token auth
  const authHeader = req.headers.get("authorization");
  const token = process.env.CRON_SECRET;
  if (token && authHeader !== `Bearer ${token}`) {
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
    return Response.json({ error: error.message }, { status: 500 });
  }
}
