import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DATA_DIR, DB_PATH, UPLOAD_DIR } from './config.js';

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

export const db = new DatabaseSync(DB_PATH);

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  PRAGMA synchronous = NORMAL;

  CREATE TABLE IF NOT EXISTS users (
    id                  INTEGER PRIMARY KEY,
    username            TEXT NOT NULL UNIQUE COLLATE NOCASE,
    full_name           TEXT NOT NULL DEFAULT '',
    password_hash       TEXT NOT NULL,
    role                TEXT NOT NULL DEFAULT 'user',
    password_changed_at TEXT,
    created_at          TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token      TEXT PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS patients (
    id             INTEGER PRIMARY KEY,
    mr_number      TEXT NOT NULL UNIQUE COLLATE NOCASE,
    name           TEXT NOT NULL,
    sex            TEXT NOT NULL CHECK (sex IN ('M', 'F')),
    dob            TEXT,
    age_manual     INTEGER,
    deceased       INTEGER NOT NULL DEFAULT 0,
    death_date     TEXT,
    death_time     TEXT,
    cause_of_death TEXT NOT NULL DEFAULT '',
    created_at     TEXT NOT NULL,
    updated_at     TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS encounters (
    id             INTEGER PRIMARY KEY,
    patient_id     INTEGER NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
    type           TEXT NOT NULL CHECK (type IN ('inpatient', 'outpatient')),
    admission_date TEXT NOT NULL,
    discharge_date TEXT,
    ward           TEXT NOT NULL DEFAULT '',
    diagnosis      TEXT NOT NULL DEFAULT '',
    care_role      TEXT NOT NULL DEFAULT '',
    care_leader    TEXT NOT NULL DEFAULT '',
    consulted_to   TEXT NOT NULL DEFAULT '',
    created_at     TEXT NOT NULL,
    updated_at     TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS attachments (
    id            INTEGER PRIMARY KEY,
    encounter_id  INTEGER NOT NULL REFERENCES encounters(id) ON DELETE CASCADE,
    category      TEXT NOT NULL CHECK (category IN ('identity', 'chart', 'lab', 'radiology')),
    original_name TEXT NOT NULL,
    stored_name   TEXT NOT NULL,
    mime          TEXT NOT NULL,
    size          INTEGER NOT NULL,
    caption       TEXT NOT NULL DEFAULT '',
    position      INTEGER NOT NULL DEFAULT 0,
    rev           INTEGER NOT NULL DEFAULT 0,
    thumb_name    TEXT,
    thumb_mime    TEXT,
    created_at    TEXT NOT NULL
  );

  -- One row per patient per day: the ward round tick. Kept apart from the
  -- encounter because it is a log, not a property of the admission — "seen on
  -- the 3rd but not the 4th" is exactly the question it exists to answer, and an
  -- encounter column could only ever hold the latest answer.
  CREATE TABLE IF NOT EXISTS rounds (
    id           INTEGER PRIMARY KEY,
    encounter_id INTEGER NOT NULL REFERENCES encounters(id) ON DELETE CASCADE,
    visit_date   TEXT NOT NULL,
    user_id      INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at   TEXT NOT NULL,
    UNIQUE (encounter_id, visit_date)
  );

  CREATE INDEX IF NOT EXISTS idx_enc_admission ON encounters(admission_date);
  CREATE INDEX IF NOT EXISTS idx_enc_type_date ON encounters(type, admission_date);
  CREATE INDEX IF NOT EXISTS idx_enc_patient   ON encounters(patient_id);
  CREATE INDEX IF NOT EXISTS idx_att_encounter ON attachments(encounter_id, category);
  CREATE INDEX IF NOT EXISTS idx_sessions_exp  ON sessions(expires_at);
  CREATE INDEX IF NOT EXISTS idx_rounds_date   ON rounds(visit_date);
  CREATE INDEX IF NOT EXISTS idx_rounds_enc    ON rounds(encounter_id, visit_date);
`);

/**
 * Brings an older database up to the current shape. Runs on every start and is a
 * no-op once applied, so upgrading is just "pull and restart" — no migration
 * command to remember, and no way to half-apply it.
 */
function migrate() {
  const columnsOf = (table) =>
    new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((r) => r.name));

  const columns = columnsOf('users');

  if (!columns.has('role')) {
    db.exec("ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'user'");
  }
  if (!columns.has('password_changed_at')) {
    db.exec('ALTER TABLE users ADD COLUMN password_changed_at TEXT');
  }

  const patientColumns = columnsOf('patients');

  // Death belongs to the person, not to one visit: a patient dies once, and every
  // record in their chart has to show it. The flag stands on its own because a
  // ward usually knows a patient died before the chart says when or of what.
  if (!patientColumns.has('deceased')) {
    db.exec('ALTER TABLE patients ADD COLUMN deceased INTEGER NOT NULL DEFAULT 0');
  }
  if (!patientColumns.has('death_date')) {
    db.exec('ALTER TABLE patients ADD COLUMN death_date TEXT');
  }
  if (!patientColumns.has('death_time')) {
    db.exec('ALTER TABLE patients ADD COLUMN death_time TEXT');
  }
  if (!patientColumns.has('cause_of_death')) {
    db.exec("ALTER TABLE patients ADD COLUMN cause_of_death TEXT NOT NULL DEFAULT ''");
  }

  const encounterColumns = columnsOf('encounters');

  // Who leads the care: '' (not recorded), 'leader' or 'shared'. Inpatients only.
  if (!encounterColumns.has('care_role')) {
    db.exec("ALTER TABLE encounters ADD COLUMN care_role TEXT NOT NULL DEFAULT ''");
  }
  // The leading doctor or team, filled in when care_role is 'shared'.
  if (!encounterColumns.has('care_leader')) {
    db.exec("ALTER TABLE encounters ADD COLUMN care_leader TEXT NOT NULL DEFAULT ''");
  }
  // The other way round from care_leader: the departments this team has asked to
  // see the patient, recorded when the care_role is 'leader'. A patient we lead
  // is the only one we can refer out, which is why it hangs off that status.
  if (!encounterColumns.has('consulted_to')) {
    db.exec("ALTER TABLE encounters ADD COLUMN consulted_to TEXT NOT NULL DEFAULT ''");
  }

  const attachmentColumns = columnsOf('attachments');

  // Bumped whenever a page's bytes are replaced (rotated, cropped). The file URL
  // carries it, so a browser holding the old image in cache fetches the new one
  // instead of showing yesterday's orientation.
  if (!attachmentColumns.has('rev')) {
    db.exec('ALTER TABLE attachments ADD COLUMN rev INTEGER NOT NULL DEFAULT 0');
  }

  // A small copy of the page, made in the browser at upload time. NULL on every
  // page stored before thumbnails existed, and the file route falls back to the
  // full image for those, so an old database keeps working while new uploads get
  // the fast gallery.
  if (!attachmentColumns.has('thumb_name')) {
    db.exec('ALTER TABLE attachments ADD COLUMN thumb_name TEXT');
  }
  if (!attachmentColumns.has('thumb_mime')) {
    db.exec('ALTER TABLE attachments ADD COLUMN thumb_mime TEXT');
  }

  if (!attachmentColumns.has('position')) {
    db.exec('ALTER TABLE attachments ADD COLUMN position INTEGER NOT NULL DEFAULT 0');
    // Pages that predate manual ordering keep the order they were uploaded in,
    // so nothing appears to shuffle on the first start after upgrading.
    db.exec(`
      UPDATE attachments SET position = (
        SELECT COUNT(*) FROM attachments AS earlier
         WHERE earlier.encounter_id = attachments.encounter_id
           AND earlier.category     = attachments.category
           AND earlier.id           < attachments.id
      )
    `);
  }

  // A database created before roles existed has accounts that all defaulted to
  // 'user', which would leave nobody able to manage logins. The founding account
  // becomes the admin.
  const people = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  const admins = db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'").get().n;
  if (people > 0 && admins === 0) {
    db.exec("UPDATE users SET role = 'admin' WHERE id = (SELECT MIN(id) FROM users)");
  }
}

migrate();

/** Prepared statements are cached — node:sqlite re-parses SQL on every prepare() otherwise. */
const cache = new Map();
export function q(sql) {
  let stmt = cache.get(sql);
  if (!stmt) {
    stmt = db.prepare(sql);
    cache.set(sql, stmt);
  }
  return stmt;
}

export function insertId(result) {
  return Number(result.lastInsertRowid);
}

export function nowIso() {
  return new Date().toISOString();
}

/** Absolute path for a stored upload. Kept here so storage layout has one owner. */
export function uploadPath(storedName) {
  return path.join(UPLOAD_DIR, storedName);
}
