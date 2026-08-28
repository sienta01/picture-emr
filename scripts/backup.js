// Snapshots the database and every stored page into backups/<timestamp>/.
// Safe to run while the server is up: VACUUM INTO takes a consistent snapshot
// even with WAL mode active.

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DATA_DIR, DB_PATH, UPLOAD_DIR, ROOT } from '../src/config.js';

const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const dest = path.join(process.env.EMR_BACKUP_DIR || path.join(ROOT, 'backups'), stamp);

if (!fs.existsSync(DB_PATH)) {
  console.error(`No database found at ${DB_PATH}. Nothing to back up.`);
  process.exit(1);
}

fs.mkdirSync(dest, { recursive: true });

const db = new DatabaseSync(DB_PATH, { readOnly: true });
db.exec(`VACUUM INTO '${path.join(dest, 'emr.db').replaceAll("'", "''")}'`);
db.close();

const uploadsDest = path.join(dest, 'uploads');
fs.mkdirSync(uploadsDest, { recursive: true });
if (fs.existsSync(UPLOAD_DIR)) {
  fs.cpSync(UPLOAD_DIR, uploadsDest, { recursive: true });
}

let files = 0;
let bytes = 0;
for (const entry of fs.readdirSync(uploadsDest, { withFileTypes: true })) {
  if (entry.isFile()) {
    files += 1;
    bytes += fs.statSync(path.join(uploadsDest, entry.name)).size;
  }
}

console.log(`Backup written to ${dest}`);
console.log(`  database + ${files} stored page(s), ${(bytes / 1024 / 1024).toFixed(1)} MB`);
console.log(`\nSource data folder: ${DATA_DIR}`);
