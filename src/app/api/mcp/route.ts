import { z } from "zod";
import { createMcpHandler } from "mcp-handler";
import { queryKnowledge, searchByKeyword } from "@/lib/query-engine";
import { getDb, initSchema } from "@/lib/db";
import { verifyApiAuth } from "@/lib/retry";

// Max allowed values
const MAX_TOP_K = 50;
const MAX_QUERY_LENGTH = 2000;
const MAX_KEYWORD_LENGTH = 500;

const handler = createMcpHandler(
  (server) => {
    // Primary tool: semantic search across all knowledge
    server.tool(
      "query_knowledge",
      "Search Huddle Duck's entire knowledge base (Notion pages, databases, client data, finances, attribution). Returns the most relevant chunks with source attribution. Use this for any question about the business.",
      {
        query: z.string().min(1).max(MAX_QUERY_LENGTH).describe("Natural language search query"),
        top_k: z.number().int().min(1).max(MAX_TOP_K).optional().describe("Number of results (default 10)"),
        source: z.string().optional().describe("Filter by source: 'notion', 'turso:client-dashboards', 'turso:attribution-tracker', 'turso:landing-page', 'turso:finance'"),
        doc_type: z.string().optional().describe("Filter by type: 'page', 'database_row', 'database_schema', 'turso_record'"),
      },
      async ({ query, top_k, source, doc_type }) => {
        await initSchema();
        const response = await queryKnowledge({ query, top_k, source, doc_type });

        if (response.results.length === 0) {
          return {
            content: [{ type: "text" as const, text: "No relevant results found." }],
          };
        }

        const formatted = response.results
          .map(
            (r, i) =>
              `### Result ${i + 1}: ${r.document_title}\n**Source:** ${r.document_source} (${r.doc_type})${r.source_url ? `\n**URL:** ${r.source_url}` : ""}\n\n${r.chunk_content}`
          )
          .join("\n\n---\n\n");

        const methodNote = response.search_method === "keyword_fallback"
          ? "\n\n_Note: Used keyword fallback (vector search unavailable)._"
          : "";

        return {
          content: [{ type: "text" as const, text: formatted + methodNote }],
        };
      }
    );

    // Keyword search tool (fallback for exact matches)
    server.tool(
      "search_keyword",
      "Search for exact keyword matches across the knowledge base. Use when you need to find specific names, IDs, or exact phrases.",
      {
        keyword: z.string().min(1).max(MAX_KEYWORD_LENGTH).describe("Exact keyword or phrase to search for"),
        limit: z.number().int().min(1).max(MAX_TOP_K).optional().describe("Max results (default 10)"),
      },
      async ({ keyword, limit }) => {
        await initSchema();
        const results = await searchByKeyword(keyword, limit);

        if (results.length === 0) {
          return {
            content: [{ type: "text" as const, text: `No results found for "${keyword}".` }],
          };
        }

        const formatted = results
          .map(
            (r, i) =>
              `### Result ${i + 1}: ${r.document_title}\n**Source:** ${r.document_source}\n\n${r.chunk_content}`
          )
          .join("\n\n---\n\n");

        return {
          content: [{ type: "text" as const, text: formatted }],
        };
      }
    );

    // Status tool
    server.tool(
      "brain_status",
      "Check the sync status of the knowledge base - when it was last updated, how many documents and chunks are indexed.",
      {},
      async () => {
        await initSchema();
        const db = getDb();

        const [syncStatus, docCount, chunkCount] = await Promise.all([
          db.execute({ sql: "SELECT source, last_sync, last_sync_successful, documents_synced, chunks_created FROM sync_status ORDER BY last_sync DESC", args: [] }),
          db.execute({ sql: "SELECT source, doc_type, COUNT(*) as count FROM documents GROUP BY source, doc_type", args: [] }),
          db.execute({ sql: "SELECT COUNT(*) as count FROM chunks WHERE embedding IS NOT NULL", args: [] }),
        ]);

        interface SyncRow { source: string; last_sync: string | null; last_sync_successful: number; documents_synced: number; chunks_created: number }
        interface DocCountRow { source: string; doc_type: string; count: number }

        const statusText = [
          "## Knowledge Base Status",
          "",
          "### Sync Status",
          ...syncStatus.rows.map((row) => {
            const r = row as unknown as SyncRow;
            return `- **${r.source}**: Last sync ${r.last_sync || "never"} (${r.last_sync_successful ? "success" : "failed"})`;
          }),
          "",
          "### Document Counts",
          ...docCount.rows.map((row) => {
            const r = row as unknown as DocCountRow;
            return `- ${r.source} / ${r.doc_type}: ${r.count}`;
          }),
          "",
          `**Total embedded chunks:** ${chunkCount.rows[0]?.count || 0}`,
        ].join("\n");

        return {
          content: [{ type: "text" as const, text: statusText }],
        };
      }
    );
  },
  {},
  { basePath: "/api", maxDuration: 60 }
);

// Wrap MCP handler with auth check
async function withAuth(req: Request, handlerFn: (req: Request) => Promise<Response>): Promise<Response> {
  // MCP uses SSE transport — the initial GET establishes the SSE stream.
  // Auth is checked on every request (GET for SSE connect, POST for messages, DELETE for disconnect).
  if (!verifyApiAuth(req)) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  return handlerFn(req);
}

export async function GET(req: Request) {
  return withAuth(req, handler as (req: Request) => Promise<Response>);
}

export async function POST(req: Request) {
  return withAuth(req, handler as (req: Request) => Promise<Response>);
}

export async function DELETE(req: Request) {
  return withAuth(req, handler as (req: Request) => Promise<Response>);
}
