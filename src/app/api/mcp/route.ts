import { z } from "zod";
import { createMcpHandler } from "mcp-handler";
import { queryKnowledge, searchByKeyword } from "@/lib/query-engine";
import { getDb, initSchema } from "@/lib/db";

const handler = createMcpHandler(
  (server) => {
    // Primary tool: semantic search across all knowledge
    server.tool(
      "query_knowledge",
      "Search Huddle Duck's entire knowledge base (Notion pages, databases, client data, finances, attribution). Returns the most relevant chunks with source attribution. Use this for any question about the business.",
      {
        query: z.string().describe("Natural language search query"),
        top_k: z.number().int().min(1).max(50).optional().describe("Number of results (default 10)"),
        source: z.string().optional().describe("Filter by source: 'notion', 'turso:client-dashboards', 'turso:attribution-tracker', 'turso:landing-page', 'turso:finance'"),
        doc_type: z.string().optional().describe("Filter by type: 'page', 'database_row', 'database_schema', 'turso_record'"),
      },
      async ({ query, top_k, source, doc_type }) => {
        await initSchema();
        const results = await queryKnowledge({ query, top_k, source, doc_type });

        if (results.length === 0) {
          return {
            content: [{ type: "text" as const, text: "No relevant results found." }],
          };
        }

        const formatted = results
          .map(
            (r, i) =>
              `### Result ${i + 1}: ${r.document_title}\n**Source:** ${r.document_source} (${r.doc_type})${r.source_url ? `\n**URL:** ${r.source_url}` : ""}\n\n${r.chunk_content}`
          )
          .join("\n\n---\n\n");

        return {
          content: [{ type: "text" as const, text: formatted }],
        };
      }
    );

    // Keyword search tool (fallback for exact matches)
    server.tool(
      "search_keyword",
      "Search for exact keyword matches across the knowledge base. Use when you need to find specific names, IDs, or exact phrases.",
      {
        keyword: z.string().describe("Exact keyword or phrase to search for"),
        limit: z.number().int().min(1).max(50).optional().describe("Max results (default 10)"),
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
          db.execute({ sql: "SELECT * FROM sync_status ORDER BY last_sync DESC", args: [] }),
          db.execute({ sql: "SELECT source, doc_type, COUNT(*) as count FROM documents GROUP BY source, doc_type", args: [] }),
          db.execute({ sql: "SELECT COUNT(*) as count FROM chunks WHERE embedding IS NOT NULL", args: [] }),
        ]);

        const statusText = [
          "## Knowledge Base Status",
          "",
          "### Sync Status",
          ...syncStatus.rows.map(
            (r: any) =>
              `- **${r.source}**: Last sync ${r.last_sync || "never"} (${r.last_sync_successful ? "success" : "failed"}${r.error_message ? ` - ${r.error_message}` : ""})`
          ),
          "",
          "### Document Counts",
          ...docCount.rows.map((r: any) => `- ${r.source} / ${r.doc_type}: ${r.count}`),
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

export { handler as GET, handler as POST, handler as DELETE };
