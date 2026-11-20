// Writes the public data snapshot to a folder, ready to attach to a GitHub Release.
//   node collector/export-snapshot.ts [outDir]      (default: snapshot/)
// Prints the release tag on the last line of stdout. Read-only against D1.
// Environment: CLOUDFLARE_ACCOUNT_ID, D1_DATABASE_ID, CLOUDFLARE_API_TOKEN
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createD1Rest } from "./src/d1-rest.ts";
import { buildSnapshot, releaseTag } from "./src/snapshot.ts";

function need(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing ${name}. Set it as a GitHub repository secret.`);
    process.exit(2);
  }
  return v;
}

const outDir = process.argv[2] ?? "snapshot";
const db = createD1Rest({
  accountId: need("CLOUDFLARE_ACCOUNT_ID"),
  databaseId: need("D1_DATABASE_ID"),
  apiToken: need("CLOUDFLARE_API_TOKEN"),
});
const now = new Date();
const { files, manifest } = await buildSnapshot(db, now);
mkdirSync(outDir, { recursive: true });
for (const f of files) writeFileSync(join(outDir, f.name), f.data);
for (const t of manifest.tables) console.error(`${t.table}: ${t.rows} rows, ${t.bytes} bytes`);
console.log(releaseTag(now));
