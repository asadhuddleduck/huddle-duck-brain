// src/lib/notion-crawler.ts
//
// COLD START ANALYSIS:
// This module is imported by sync-engine.ts which is imported by /api/sync.
// The @notionhq/client package is ~50KB bundled. The Client is initialized
// at module load time (reads NOTION_TOKEN from env). This adds ~20-30ms
// to cold start but is acceptable since:
//   - /api/sync is only called by cron (6x/day), not user-facing
//   - /api/query and /api/mcp do NOT import this module (no impact)
//
// TODO: If cold start becomes an issue for sync routes, lazy-initialize
// the Notion client (same pattern as db.ts getDb()).
//
import { Client } from "@notionhq/client";
import { RateLimiter } from "./retry";
import { hashContent } from "./hash";
import { NOTION_RATE_LIMIT, NOTION_MAX_BLOCK_DEPTH } from "./constants";
import type { Document } from "./types";

const notion = new Client({ auth: process.env.NOTION_TOKEN });
const limiter = new RateLimiter(NOTION_RATE_LIMIT);

// Time budget: stop crawling at 240s to leave 60s for DB writes (300s Vercel limit)
const DEFAULT_TIME_BUDGET_MS = 240_000;

export interface CrawlOptions {
  /** ISO timestamp — only crawl pages edited after this time */
  since?: string;
  /** Max milliseconds to spend crawling (default 240s) */
  timeBudgetMs?: number;
}

export interface CrawlResult {
  documents: Document[];
  /** true if we stopped early due to time budget */
  partial: boolean;
  /** Total pages/databases discovered (before filtering) */
  totalDiscovered: number;
  /** Number of items we actually processed */
  totalProcessed: number;
  /** Number of items skipped (not edited since `since`) */
  totalSkipped: number;
}

// --- Rich text extraction ---

function richTextToPlain(richTextArray: any[]): string {
  if (!richTextArray) return "";
  return richTextArray
    .map((rt: any) => {
      if (rt.href) return `${rt.plain_text} (${rt.href})`;
      if (rt.annotations?.code) return `\`${rt.plain_text}\``;
      return rt.plain_text;
    })
    .join("");
}

// --- Block to text conversion ---

function blockToText(block: any, depth: number = 0): string {
  const indent = "  ".repeat(depth);
  const type = block.type;
  const data = block[type];
  if (!data) return "";

  switch (type) {
    case "paragraph":
      return richTextToPlain(data.rich_text);
    case "heading_1":
      return `# ${richTextToPlain(data.rich_text)}`;
    case "heading_2":
      return `## ${richTextToPlain(data.rich_text)}`;
    case "heading_3":
      return `### ${richTextToPlain(data.rich_text)}`;
    case "bulleted_list_item":
      return `${indent}- ${richTextToPlain(data.rich_text)}`;
    case "numbered_list_item":
      return `${indent}1. ${richTextToPlain(data.rich_text)}`;
    case "to_do": {
      const checked = data.checked ? "[x]" : "[ ]";
      return `${indent}${checked} ${richTextToPlain(data.rich_text)}`;
    }
    case "toggle":
    case "quote":
      return `> ${richTextToPlain(data.rich_text)}`;
    case "callout": {
      const icon = data.icon?.emoji || "";
      return `${icon} ${richTextToPlain(data.rich_text)}`;
    }
    case "code":
      return `\`\`\`${data.language || ""}\n${richTextToPlain(data.rich_text)}\n\`\`\``;
    case "divider":
      return "---";
    case "table_row":
      if (data.cells) {
        return data.cells.map((cell: any[]) => richTextToPlain(cell)).join(" | ");
      }
      return "";
    case "child_database":
      return `[Database: ${data.title || "Untitled"}]`;
    case "child_page":
      return `[Page: ${data.title || "Untitled"}]`;
    case "image":
      return `[Image: ${data.caption ? richTextToPlain(data.caption) : "image"}]`;
    case "bookmark":
      return `[Bookmark: ${data.url || ""}]`;
    case "equation":
      return data.expression || "";
    default:
      return "";
  }
}

// --- Recursive block extraction ---

async function extractBlockChildren(
  blockId: string,
  lines: string[],
  depth: number
): Promise<void> {
  if (depth > NOTION_MAX_BLOCK_DEPTH) return;

  let cursor: string | undefined;
  do {
    const response: any = await limiter.execute(() =>
      notion.blocks.children.list({
        block_id: blockId,
        page_size: 100,
        start_cursor: cursor,
      })
    );

    for (const block of response.results) {
      const text = blockToText(block, depth);
      if (text) lines.push(text);

      if (block.has_children) {
        if (block.type === "synced_block" && block.synced_block?.synced_from) {
          await extractBlockChildren(block.synced_block.synced_from.block_id, lines, depth);
        } else {
          await extractBlockChildren(block.id, lines, depth + 1);
        }
      }
    }

    cursor = response.has_more ? response.next_cursor : undefined;
  } while (cursor);
}

async function extractPageContent(pageId: string): Promise<string> {
  const lines: string[] = [];
  await extractBlockChildren(pageId, lines, 0);
  return lines.filter((l) => l.trim() !== "").join("\n\n");
}

// --- Property extraction for database rows ---

function extractPropertyValue(prop: any): string {
  switch (prop.type) {
    case "title": return richTextToPlain(prop.title);
    case "rich_text": return richTextToPlain(prop.rich_text);
    case "number": return prop.number?.toString() ?? "";
    case "select": return prop.select?.name ?? "";
    case "multi_select": return prop.multi_select?.map((s: any) => s.name).join(", ") ?? "";
    case "status": return prop.status?.name ?? "";
    case "date": {
      if (!prop.date) return "";
      return prop.date.end ? `${prop.date.start} to ${prop.date.end}` : prop.date.start;
    }
    case "people": return prop.people?.map((p: any) => p.name || p.id).join(", ") ?? "";
    case "checkbox": return prop.checkbox ? "Yes" : "No";
    case "url": return prop.url ?? "";
    case "email": return prop.email ?? "";
    case "phone_number": return prop.phone_number ?? "";
    case "formula": {
      const f = prop.formula;
      if (!f) return "";
      if (f.type === "string") return f.string ?? "";
      if (f.type === "number") return f.number?.toString() ?? "";
      if (f.type === "boolean") return f.boolean?.toString() ?? "";
      if (f.type === "date") return f.date?.start ?? "";
      return "";
    }
    case "relation": return prop.relation?.map((r: any) => r.id).join(", ") ?? "";
    case "created_time": return prop.created_time ?? "";
    case "created_by": return prop.created_by?.name ?? "";
    case "last_edited_time": return prop.last_edited_time ?? "";
    case "last_edited_by": return prop.last_edited_by?.name ?? "";
    default: return "";
  }
}

function extractTitle(properties: Record<string, any>): string {
  for (const prop of Object.values(properties)) {
    if (prop.type === "title") return richTextToPlain(prop.title);
  }
  return "Untitled";
}

// --- Time budget helper ---

class TimeBudget {
  private startTime: number;
  private budgetMs: number;

  constructor(budgetMs: number) {
    this.startTime = Date.now();
    this.budgetMs = budgetMs;
  }

  /** Returns true if we have exhausted the time budget */
  expired(): boolean {
    return Date.now() - this.startTime >= this.budgetMs;
  }

  /** Milliseconds elapsed so far */
  elapsed(): number {
    return Date.now() - this.startTime;
  }

  /** Milliseconds remaining */
  remaining(): number {
    return Math.max(0, this.budgetMs - this.elapsed());
  }
}

// --- Main crawl function (incremental + time-budgeted) ---

export async function crawlNotionWorkspace(
  options: CrawlOptions = {}
): Promise<CrawlResult> {
  const { since, timeBudgetMs = DEFAULT_TIME_BUDGET_MS } = options;
  const timer = new TimeBudget(timeBudgetMs);
  const documents: Document[] = [];
  let totalDiscovered = 0;
  let totalProcessed = 0;
  let totalSkipped = 0;
  let partial = false;

  console.log(
    `Notion crawl starting${since ? ` (incremental, since ${since})` : " (full)"}` +
    ` with ${timeBudgetMs / 1000}s time budget`
  );

  // 1. Discover all pages (sorted by last_edited_time desc)
  //    The search API itself is fast (metadata only). The expensive part is
  //    extractPageContent() below, so we discover everything first, then
  //    filter by `since` before doing the expensive content extraction.
  const allPages: any[] = [];
  let cursor: string | undefined;
  do {
    if (timer.expired()) {
      console.log("Time budget expired during page discovery");
      partial = true;
      break;
    }
    const response: any = await limiter.execute(() =>
      notion.search({
        filter: { property: "object", value: "page" },
        sort: { direction: "descending", timestamp: "last_edited_time" },
        page_size: 100,
        start_cursor: cursor,
      })
    );
    allPages.push(...response.results);
    cursor = response.has_more ? response.next_cursor : undefined;

    // Optimization: if doing incremental sync and the search is sorted
    // by last_edited desc, once we see a page older than `since`, all
    // subsequent pages will also be older — we can stop paginating.
    if (since && response.results.length > 0) {
      const lastResult = response.results[response.results.length - 1];
      if (lastResult.last_edited_time && lastResult.last_edited_time < since) {
        // All remaining pages are older than `since`, stop fetching
        break;
      }
    }
  } while (cursor);

  // 2. Discover all databases
  const allDatabases: any[] = [];
  cursor = undefined;
  if (!partial) {
    do {
      if (timer.expired()) {
        console.log("Time budget expired during database discovery");
        partial = true;
        break;
      }
      const response: any = await limiter.execute(() =>
        notion.search({
          filter: { property: "object", value: "data_source" },
          page_size: 100,
          start_cursor: cursor,
        })
      );
      allDatabases.push(...response.results);
      cursor = response.has_more ? response.next_cursor : undefined;
    } while (cursor);
  }

  // 3. Separate standalone pages from database rows
  const standalonePages = allPages.filter(
    (p: any) => p.parent?.type !== "database_id"
  );

  // Filter by `since` if doing incremental sync
  const pagesToCrawl = since
    ? standalonePages.filter((p: any) => !p.last_edited_time || p.last_edited_time >= since)
    : standalonePages;

  const pagesSkipped = standalonePages.length - pagesToCrawl.length;

  const databasesToCrawl = since
    ? allDatabases.filter((d: any) => !d.last_edited_time || d.last_edited_time >= since)
    : allDatabases;

  const dbsSkipped = allDatabases.length - databasesToCrawl.length;

  totalDiscovered = standalonePages.length + allDatabases.length;
  totalSkipped = pagesSkipped + dbsSkipped;

  console.log(
    `Discovered: ${standalonePages.length} pages (${pagesToCrawl.length} to crawl), ` +
    `${allDatabases.length} databases (${databasesToCrawl.length} to crawl)`
  );

  // 4. Extract standalone pages (time-budgeted)
  for (const page of pagesToCrawl) {
    if (timer.expired()) {
      console.log(`Time budget expired after processing ${totalProcessed} pages (${timer.elapsed()}ms)`);
      partial = true;
      break;
    }

    try {
      const content = await extractPageContent(page.id);
      if (!content.trim()) continue;

      const title = extractTitle(page.properties || {});
      documents.push({
        id: page.id,
        source: "notion",
        source_url: page.url,
        title,
        doc_type: "page",
        content,
        content_hash: hashContent(content),
        metadata: JSON.stringify({ parent: page.parent }),
        last_edited: page.last_edited_time,
        synced_at: new Date().toISOString(),
      });
      totalProcessed++;
    } catch (error) {
      console.error(`Failed to extract page ${page.id}:`, error);
    }
  }

  // 5. Extract databases (schema + rows) — time-budgeted
  if (!partial) {
    for (const database of databasesToCrawl) {
      if (timer.expired()) {
        console.log(`Time budget expired during database extraction (${timer.elapsed()}ms)`);
        partial = true;
        break;
      }

      try {
        // Schema document
        const dbDetail: any = await limiter.execute(() =>
          notion.databases.retrieve({ database_id: database.id })
        );
        const dbTitle = richTextToPlain(dbDetail.title || []);
        const schemaLines = Object.entries(dbDetail.properties || {}).map(
          ([name, prop]: [string, any]) => {
            let desc = `- ${name} (${prop.type})`;
            if (prop.type === "select" && prop.select?.options) {
              desc += `: ${prop.select.options.map((o: any) => o.name).join(", ")}`;
            }
            if (prop.type === "multi_select" && prop.multi_select?.options) {
              desc += `: ${prop.multi_select.options.map((o: any) => o.name).join(", ")}`;
            }
            if (prop.type === "status" && prop.status?.options) {
              desc += `: ${prop.status.options.map((o: any) => o.name).join(", ")}`;
            }
            return desc;
          }
        );

        const schemaContent = `# Database: ${dbTitle}\n\n## Properties\n${schemaLines.join("\n")}`;
        documents.push({
          id: database.id,
          source: "notion",
          source_url: database.url,
          title: `Database Schema: ${dbTitle}`,
          doc_type: "database_schema",
          content: schemaContent,
          content_hash: hashContent(schemaContent),
          metadata: JSON.stringify({ type: "database_schema" }),
          last_edited: database.last_edited_time,
          synced_at: new Date().toISOString(),
        });
        totalProcessed++;

        // Database rows
        let rowCursor: string | undefined;
        do {
          if (timer.expired()) {
            console.log(`Time budget expired during database rows for ${dbTitle} (${timer.elapsed()}ms)`);
            partial = true;
            break;
          }

          const rowResponse: any = await limiter.execute(() =>
            notion.dataSources.query({
              data_source_id: database.id,
              page_size: 100,
              start_cursor: rowCursor,
            })
          );

          for (const row of rowResponse.results) {
            if (timer.expired()) {
              partial = true;
              break;
            }

            // For incremental sync, skip rows not edited since `since`
            if (since && row.last_edited_time && row.last_edited_time < since) {
              totalSkipped++;
              continue;
            }

            try {
              const properties = Object.fromEntries(
                Object.entries(row.properties || {})
                  .map(([name, prop]: [string, any]) => [name, extractPropertyValue(prop)])
                  .filter(([_, v]) => (v as string).trim() !== "")
              );

              const title = extractTitle(row.properties || {});
              const bodyContent = await extractPageContent(row.id);

              const propertiesText = Object.entries(properties)
                .map(([k, v]) => `${k}: ${v}`)
                .join("\n");

              const fullContent = [
                title ? `# ${title}` : "",
                `Database: ${dbTitle}`,
                propertiesText,
                bodyContent,
              ]
                .filter(Boolean)
                .join("\n\n");

              if (!fullContent.trim()) continue;

              documents.push({
                id: row.id,
                source: "notion",
                source_url: row.url,
                title: title || "Untitled",
                doc_type: "database_row",
                content: fullContent,
                content_hash: hashContent(fullContent),
                metadata: JSON.stringify({ database_id: database.id, database_title: dbTitle, properties }),
                last_edited: row.last_edited_time,
                synced_at: new Date().toISOString(),
              });
              totalProcessed++;
            } catch (error) {
              console.error(`Failed to extract row ${row.id}:`, error);
            }
          }

          if (partial) break;
          rowCursor = rowResponse.has_more ? rowResponse.next_cursor : undefined;
        } while (rowCursor);

        if (partial) break;
      } catch (error) {
        console.error(`Failed to extract database ${database.id}:`, error);
      }
    }
  }

  console.log(
    `Notion crawl ${partial ? "PARTIAL" : "complete"}: ${documents.length} documents extracted, ` +
    `${totalProcessed} processed, ${totalSkipped} skipped (${timer.elapsed()}ms elapsed)`
  );

  return { documents, partial, totalDiscovered, totalProcessed, totalSkipped };
}
