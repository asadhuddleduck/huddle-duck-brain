// Canonical copy: turso-ops/templates/database-fetch.ts. No SQL is retried.
export const DATABASE_CLEANUP_MS = 5_000;
const cleanupDeadlines = new Map<string, number>();

// Hrana v2 sends rollback and stream close in one pipeline. Inspect the whole
// wire request: a mixed batch, cached SQL or a commit never earns extra time.
export function cleanupOnly(body: string): boolean {
  try {
    const value = JSON.parse(body);
    return Array.isArray(value.requests) && value.requests.length > 0 && value.requests.every((request: {
      type?: string; stmt?: { sql?: string; sql_id?: number; args?: unknown[]; named_args?: unknown[] };
    }) => request.type === "close" || (request.type === "execute"
      && request.stmt?.sql === "ROLLBACK" && request.stmt.sql_id === undefined
      && !request.stmt.args?.length && !request.stmt.named_args?.length));
  } catch { return false; }
}

/** Cleanup gets its own bounded transport signal, never business authority. */
export async function databaseFetch(input: Request): Promise<Response> {
  const body = /^(GET|HEAD)$/i.test(input.method) ? undefined : await input.text();
  const init: RequestInit = { method: input.method, headers: new Headers(input.headers), body };
  const cleanup = (cleanupInit: RequestInit) => {
    const baton = JSON.parse(String(cleanupInit.body ?? "{}")).baton;
    const key = typeof baton === "string" ? `${input.url}:${baton}` : null;
    // Keep a failed stream's exhausted budget across nested execution scopes.
    // Batonless requests have no known shared stream, so are independent.
    for(const [old,end] of cleanupDeadlines)if(end<Date.now()-600_000)cleanupDeadlines.delete(old);
    const deadline = (key && cleanupDeadlines.get(key)) || Date.now() + DATABASE_CLEANUP_MS;
    if(key)cleanupDeadlines.set(key,deadline);
    if (Date.now() >= deadline) throw new Error("Database cleanup deadline reached");
    return globalThis.fetch(input.url, { ...cleanupInit, signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())) });
  };
  if (body && cleanupOnly(body)) return cleanup(init);
  const closeUncertainStream = async () => {
    // libsql can mark close as queued before transport starts, then stop after
    // an abort without sending it. Never replay SQL, only close a known baton.
    try {
      const wire = body ? JSON.parse(body) : null;
      if (typeof wire?.baton === "string" && wire.baton && new URL(input.url).pathname.endsWith("/v2/pipeline")) {
        const response = await cleanup({ ...init, body: JSON.stringify({ baton: wire.baton, requests: [{ type: "close" }] }) });
        await response.arrayBuffer();
      }
    } catch { /* Preserve the original uncertain outcome. */ }
  };
  try {
    const response=await globalThis.fetch(input.url, { ...init, signal: AbortSignal.any([input.signal, AbortSignal.timeout(10_000)]) });
    if(!response.body)return response;
    const reader=response.body.getReader();
    return new Response(new ReadableStream<Uint8Array>({
      async pull(controller){
        try {const next=await reader.read();if(next.done)controller.close();else controller.enqueue(next.value);}
        catch(error){await closeUncertainStream();controller.error(error);}
      },
      async cancel(reason){await reader.cancel(reason);await closeUncertainStream();},
    }),{status:response.status,statusText:response.statusText,headers:response.headers});
  } catch(error) {await closeUncertainStream();throw error;}
}
