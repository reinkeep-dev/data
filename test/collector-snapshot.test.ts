import test from "node:test";
import assert from "node:assert/strict";
import { gunzipSync } from "node:zlib";
import { D1CollectorStore } from "../collector/src/d1-store.ts";
import { openSqlite } from "../collector/src/sqlite-adapter.ts";
import { PAGE_SIZE, SNAPSHOT_TABLES, buildSnapshot, pageSql, releaseTag, toJsonLines } from "../collector/src/snapshot.ts";

const NOW = new Date("2026-11-20T01:00:00Z");
const addr = (n: number) => "0x" + n.toString(16).padStart(40, "0");
const poolId = (n: number) => "0x" + n.toString(16).padStart(64, "0");

async function seeded() {
  const db = openSqlite(":memory:");
  const store = new D1CollectorStore(db);
  await store.ensureToken(addr(2), "BBB", "BBB");
  await store.ensureToken(addr(1), "AAA", "AAA");
  await store.addPool({
    pool: poolId(1), token: addr(1), quote: addr(0), name: "AAA / WETH", symbol: "AAA", dex: "uniswap-v4-robinhood", createdMs: 1000,
    first: { atMs: 1001, liquidityUsd: 10, volumeH24Usd: 1, buysH24: 1, sellsH24: 1, fdvUsd: null }, outcome: null,
  });
  await store.noteFactsFailure(addr(1), "secret-looking error text");
  db.raw.prepare("INSERT INTO receipts (id, decision, json, issued_at) VALUES ('r1', 'allow', '{\"payer\":\"0xabc\"}', 1)").run();
  db.raw.prepare("INSERT INTO chain_cursor (name, block) VALUES ('launches', 5)").run();
  return db;
}

test("the tag is data- plus the UTC date", () => {
  assert.equal(releaseTag(NOW), "data-2026-11-20");
  assert.equal(releaseTag(new Date("2026-11-20T23:59:59Z")), "data-2026-11-20");
});

test("every exported column exists in the real schema", async () => {
  const db = openSqlite(":memory:");
  for (const t of SNAPSHOT_TABLES) await db.prepare(pageSql(t)).bind("").all();
});

test("tables with private or internal data are not exported", () => {
  const names = SNAPSHOT_TABLES.map((t) => t.name);
  for (const banned of ["receipts", "collector_runs", "chain_cursor"]) assert.ok(!names.includes(banned), banned);
  const tokens = SNAPSHOT_TABLES.find((t) => t.name === "tokens")!;
  assert.ok(!tokens.columns.includes("last_error"));
});

test("toJsonLines keeps column order and turns missing values into null", () => {
  const out = toJsonLines(["b", "a", "c"], [{ a: 1, b: "x" }]);
  assert.equal(out, '{"b":"x","a":1,"c":null}\n');
  assert.equal(toJsonLines(["a"], []), "");
});

test("snapshot has one gzip file per table plus a manifest that matches the rows", async () => {
  const { files, manifest } = await buildSnapshot(await seeded(), NOW);
  assert.deepEqual(files.map((f) => f.name), [...SNAPSHOT_TABLES.map((t) => `${t.name}.jsonl.gz`), "manifest.json"]);
  assert.equal(manifest.generated_at, "2026-11-20T01:00:00.000Z");
  const byTable = Object.fromEntries(manifest.tables.map((t) => [t.table, t]));
  assert.equal(byTable.tokens.rows, 2);
  assert.equal(byTable.pools.rows, 1);
  assert.equal(byTable.pool_outcomes.rows, 0);
  const tokens = gunzipSync(files[0].data).toString("utf8").trimEnd().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(tokens.map((r) => r.token), [addr(1), addr(2)]); // ordered by key
  assert.deepEqual(Object.keys(tokens[0]), [...SNAPSHOT_TABLES[0].columns]);
  assert.deepEqual(JSON.parse(files[files.length - 1].data.toString("utf8")), manifest);
});

test("no private text reaches any file", async () => {
  const { files } = await buildSnapshot(await seeded(), NOW);
  const all = files.map((f) => (f.name.endsWith(".gz") ? gunzipSync(f.data).toString("utf8") : f.data.toString("utf8"))).join("\n");
  for (const s of ["secret-looking", "payer", "0xabc"]) assert.ok(!all.includes(s), s);
});

test("same data gives byte-identical files", async () => {
  const db = await seeded();
  const a = await buildSnapshot(db, NOW);
  const b = await buildSnapshot(db, NOW);
  assert.deepEqual(a.files.map((f) => f.data.toString("hex")), b.files.map((f) => f.data.toString("hex")));
});

test("tables larger than one page are read completely, without repeats", async () => {
  const db = openSqlite(":memory:");
  const n = PAGE_SIZE * 2 + 7;
  const ins = db.raw.prepare("INSERT INTO daily_stats (day, pools, outcomes, alive, dead, sum_first_liquidity_usd) VALUES (?, 0, 0, 0, 0, 0)");
  db.raw.exec("BEGIN");
  for (let i = 0; i < n; i++) ins.run(new Date(Date.UTC(2000, 0, 1 + i)).toISOString().slice(0, 10));
  db.raw.exec("COMMIT");
  const { manifest } = await buildSnapshot(db, NOW, SNAPSHOT_TABLES.filter((t) => t.name === "daily_stats"));
  assert.equal(manifest.tables[0].rows, n);
});
