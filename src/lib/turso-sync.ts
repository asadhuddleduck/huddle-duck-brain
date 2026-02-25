// src/lib/turso-sync.ts
import { createClient, type Client } from "@libsql/client";
import { hashContent } from "./hash";
import type { Document } from "./types";

interface TursoSource {
  name: string;
  urlEnv: string;
  tokenEnv: string;
  queries: Array<{
    label: string;
    sql: string;
    titleColumn: string;
    contentColumns: string[];
  }>;
}

const SOURCES: TursoSource[] = [
  {
    name: "turso:client-dashboards",
    urlEnv: "TURSO_CLIENT_DASHBOARDS_URL",
    tokenEnv: "TURSO_CLIENT_DASHBOARDS_TOKEN",
    queries: [
      {
        label: "clients",
        sql: "SELECT * FROM clients WHERE is_active = 1",
        titleColumn: "name",
        contentColumns: ["name", "meta_ad_account_id", "currency", "client_since"],
      },
      {
        label: "campaigns",
        sql: `SELECT c.*, cl.name as client_name FROM campaigns c
              JOIN clients cl ON c.client_id = cl.id
              WHERE c.status = 'ACTIVE' OR c.status = 'PAUSED'`,
        titleColumn: "name",
        contentColumns: ["name", "client_name", "status", "objective", "daily_budget", "lifetime_budget"],
      },
      {
        label: "recent_stats",
        sql: `SELECT ds.*, cl.name as client_name, c.name as campaign_name
              FROM daily_stats ds
              JOIN clients cl ON ds.client_id = cl.id
              JOIN campaigns c ON ds.campaign_id = c.id
              WHERE ds.date >= date('now', '-7 days')
              ORDER BY ds.date DESC`,
        titleColumn: "campaign_name",
        contentColumns: ["client_name", "campaign_name", "date", "spend", "impressions", "clicks", "actions", "cpc", "cpm", "ctr"],
      },
    ],
  },
  {
    name: "turso:attribution-tracker",
    urlEnv: "TURSO_ATTRIBUTION_TRACKER_URL",
    tokenEnv: "TURSO_ATTRIBUTION_TRACKER_TOKEN",
    queries: [
      {
        label: "contacts",
        sql: "SELECT * FROM contacts ORDER BY created_at DESC LIMIT 500",
        titleColumn: "email",
        contentColumns: ["email", "status", "utm_source", "utm_medium", "utm_campaign", "country", "first_seen_at"],
      },
      {
        label: "recent_events",
        sql: `SELECT e.*, c.email FROM events e
              JOIN contacts c ON e.contact_id = c.id
              WHERE e.created_at >= date('now', '-30 days')
              ORDER BY e.created_at DESC LIMIT 500`,
        titleColumn: "event_type",
        contentColumns: ["email", "event_type", "event_source", "page_url", "campaign_name", "created_at"],
      },
    ],
  },
  {
    name: "turso:landing-page",
    urlEnv: "TURSO_LANDING_PAGE_URL",
    tokenEnv: "TURSO_LANDING_PAGE_TOKEN",
    queries: [
      {
        label: "purchases",
        sql: "SELECT * FROM purchases ORDER BY created_at DESC",
        titleColumn: "email",
        contentColumns: ["email", "name", "phone", "amount_total", "currency", "utm_source", "utm_medium", "utm_campaign", "created_at"],
      },
    ],
  },
  {
    name: "turso:finance",
    urlEnv: "TURSO_FINANCE_URL",
    tokenEnv: "TURSO_FINANCE_TOKEN",
    queries: [
      {
        label: "invoices",
        sql: "SELECT * FROM invoices WHERE status != 'DELETED' ORDER BY date DESC LIMIT 200",
        titleColumn: "contact_name",
        contentColumns: ["invoice_number", "contact_name", "status", "total", "amount_paid", "amount_due", "currency", "date", "due_date"],
      },
      {
        label: "monthly_snapshots",
        sql: "SELECT * FROM monthly_snapshots ORDER BY month DESC",
        titleColumn: "month",
        contentColumns: ["month", "revenue", "expenses", "net_profit", "mrr", "closing_balance"],
      },
      {
        label: "subscriptions",
        sql: "SELECT * FROM subscriptions WHERE status = 'active'",
        titleColumn: "customer_name",
        contentColumns: ["customer_name", "amount", "currency", "interval_unit", "status", "next_charge_date"],
      },
    ],
  },
];

function connectToSource(source: TursoSource): Client | null {
  const url = process.env[source.urlEnv]?.trim();
  const token = process.env[source.tokenEnv]?.trim();
  if (!url || !token) {
    console.warn(`[turso-sync] Skipping ${source.name}: missing env vars`);
    return null;
  }
  return createClient({ url, authToken: token });
}

function rowToContent(row: Record<string, unknown>, contentColumns: string[]): string {
  return contentColumns
    .map((col) => {
      const val = row[col];
      if (val === null || val === undefined || val === "") return null;
      return `${col}: ${val}`;
    })
    .filter(Boolean)
    .join("\n");
}

export async function crawlTursoDatabases(): Promise<Document[]> {
  const documents: Document[] = [];

  for (const source of SOURCES) {
    const client = connectToSource(source);
    if (!client) continue;

    try {
      for (const query of source.queries) {
        const result = await client.execute({ sql: query.sql, args: [] });

        for (const row of result.rows) {
          const rowObj = row as unknown as Record<string, unknown>;
          const title = String(rowObj[query.titleColumn] || "Untitled");
          const content = `# ${title}\nSource: ${source.name} / ${query.label}\n\n${rowToContent(rowObj, query.contentColumns)}`;
          const id = rowObj.id
            ? String(rowObj.id)
            : `${query.label}_${hashContent(content).slice(0, 12)}`;

          const lastEdited = (rowObj.synced_at as string | null)
            ?? (rowObj.created_at as string | null)
            ?? null;

          documents.push({
            id,
            source: source.name,
            source_url: null,
            title,
            doc_type: "turso_record",
            content,
            content_hash: hashContent(content),
            metadata: JSON.stringify({ table: query.label, raw: rowObj }),
            last_edited: lastEdited,
            synced_at: new Date().toISOString(),
          });
        }
      }
      console.log(`[turso-sync] ${source.name}: extracted documents`);
    } catch (error) {
      console.error(`[turso-sync] Failed to sync ${source.name}:`, error);
    }
  }

  console.log(`[turso-sync] Complete: ${documents.length} documents`);
  return documents;
}
