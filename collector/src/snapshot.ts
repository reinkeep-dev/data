// Public snapshot of the collector's data: one JSON Lines file per table plus a manifest.
// Only tables that hold public chain and market facts are listed. Left out on purpose:
//   collector_runs  our own run log (internal bookkeeping)
//   chain_cursor    internal read position
//   receipts        signed gate receipts written by the gate API; they belong to the people who asked the gate
// Columns are listed by name, never SELECT *, so a column added to the schema later is not published by accident.
// tokens.last_error is left out too: it is a free-text error from our own reads, not a fact about the token.
import { gzipSync } from "node:zlib";
import type { D1Like } from "./collector-store.ts";

// Bump when a table or column is added, removed or renamed here.
export const SNAPSHOT_SCHEMA_VERSION = 1;
export const PAGE_SIZE = 5000;

export type SnapshotTable = { name: string; key: string; columns: readonly string[] };

export const SNAPSHOT_TABLES: readonly SnapshotTable[] = [
  {
    name: "tokens", key: "token",
    columns: ["token", "symbol", "ticker", "facts_tries", "read_at_ms", "facts_version", "is_contract", "code_size", "is_proxy",
      "implementation", "has_mint", "has_pause", "has_blacklist", "has_upgrade", "has_owner_function", "owner", "owner_renounced",
      "mint_with_live_owner", "total_supply", "decimals", "chain_symbol"],
  },
  {
    name: "pools", key: "pool",
    columns: ["pool", "token", "quote", "name", "symbol", "dex", "created_ms", "first_at_ms", "first_liquidity_usd",
      "first_volume_h24_usd", "first_buys_h24", "first_sells_h24", "first_fdv_usd"],
  },
  {
    name: "pool_outcomes", key: "pool",
    columns: ["pool", "at_ms", "age_h", "liquidity_usd", "volume_h24_usd", "buys_h24", "sells_h24", "fdv_usd", "alive"],
  },
  { name: "launches", key: "token", columns: ["token", "pool", "block", "created_ms", "found_ms"] },
  {
    name: "daily_stats", key: "day",
    columns: ["day", "pools", "outcomes", "alive", "dead", "sum_first_liquidity_usd"],
  },
];

export type ManifestEntry = { table: string; file: string; rows: number; columns: string[]; bytes: number };
export type Manifest = { generated_at: string; schema_version: number; tables: ManifestEntry[] };
export type SnapshotFile = { name: string; data: Buffer };

// Pure: SQL for one page, ordered by the primary key so output is the same for the same data.
export function pageSql(t: SnapshotTable): string {
  return `SELECT ${t.columns.join(", ")} FROM ${t.name} WHERE ${t.key} > ? ORDER BY ${t.key} LIMIT ${PAGE_SIZE}`;
}

// One JSON object per line, keys in the table's column order (a missing column becomes null).
export function toJsonLines(columns: readonly string[], rows: readonly Record<string, unknown>[]): string {
  return rows.map((r) => JSON.stringify(Object.fromEntries(columns.map((c) => [c, r[c] ?? null]))) + "\n").join("");
}

export async function readTable(db: D1Like, t: SnapshotTable): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  let after = "";
  for (;;) {
    const { results } = await db.prepare(pageSql(t)).bind(after).all<Record<string, unknown>>();
    out.push(...results);
    if (results.length < PAGE_SIZE) return out;
    after = String(results[results.length - 1][t.key]);
  }
}

export async function buildSnapshot(db: D1Like, now: Date, tables: readonly SnapshotTable[] = SNAPSHOT_TABLES): Promise<{ files: SnapshotFile[]; manifest: Manifest }> {
  const files: SnapshotFile[] = [];
  const entries: ManifestEntry[] = [];
  for (const t of tables) {
    const rows = await readTable(db, t);
    const data = gzipSync(Buffer.from(toJsonLines(t.columns, rows), "utf8"), { level: 9 });
    const file = `${t.name}.jsonl.gz`;
    files.push({ name: file, data });
    entries.push({ table: t.name, file, rows: rows.length, columns: [...t.columns], bytes: data.length });
  }
  const manifest: Manifest = { generated_at: now.toISOString(), schema_version: SNAPSHOT_SCHEMA_VERSION, tables: entries };
  return { files: [...files, { name: "manifest.json", data: Buffer.from(JSON.stringify(manifest, null, 2) + "\n", "utf8") }], manifest };
}

export const releaseTag = (now: Date): string => `data-${now.toISOString().slice(0, 10)}`;
