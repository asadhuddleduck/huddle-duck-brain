// src/lib/notion-crawler.ts
import { Client } from "@notionhq/client";
import { createHash } from "crypto";
import { RateLimiter } from "./retry";
import type { Document } from "./types";

const notion = new Client({ auth: process.env.NOTION_TOKEN });
const limiter = new RateLimiter(3); // Notion: 3 req/s

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

const MAX_DEPTH = 10;

async function extractBlockChildren(
  blockId: string,
  lines: string[],
  depth: number
): Promise<void> {
  if (depth > MAX_DEPTH) return;

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

// --- Content hashing ---

export function hashContent(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

// --- Main crawl functions ---

export async function crawlNotionWorkspace(): Promise<Document[]> {
  const documents: Document[] = [];

  // 1. Discover all pages
  const allPages: any[] = [];
  let cursor: string | undefined;
  do {
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
  } while (cursor);

  // 2. Discover all databases
  const allDatabases: any[] = [];
  cursor = undefined;
  do {
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

  // 3. Separate standalone pages from database rows
  const standalonePages = allPages.filter(
    (p: any) => p.parent?.type !== "database_id"
  );

  console.log(
    `Discovered: ${standalonePages.length} pages, ${allDatabases.length} databases`
  );

  // 4. Extract standalone pages
  for (const page of standalonePages) {
    try {
      const content = await extractPageContent(page.id);
      if (!content.trim()) continue; // Skip empty pages

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
    } catch (error) {
      console.error(`Failed to extract page ${page.id}:`, error);
    }
  }

  // 5. Extract databases (schema + rows)
  for (const database of allDatabases) {
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

      // Database rows
      let rowCursor: string | undefined;
      do {
        const rowResponse: any = await limiter.execute(() =>
          notion.dataSources.query({
            data_source_id: database.id,
            page_size: 100,
            start_cursor: rowCursor,
          })
        );

        for (const row of rowResponse.results) {
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
          } catch (error) {
            console.error(`Failed to extract row ${row.id}:`, error);
          }
        }

        rowCursor = rowResponse.has_more ? rowResponse.next_cursor : undefined;
      } while (rowCursor);
    } catch (error) {
      console.error(`Failed to extract database ${database.id}:`, error);
    }
  }

  console.log(`Notion crawl complete: ${documents.length} documents`);
  return documents;
}
