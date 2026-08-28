import fs from 'node:fs';
import { db, q, insertId, nowIso, uploadPath } from './db.js';
import { CATEGORIES, ALLOWED_MIME } from './config.js';
import {
  HttpError,
  readJson,
  readBody,
  sendJson,
  sendText,
  serveStatic,
  baseHeaders,
} from './http.js';
import {
  userCount,
  adminCount,
  createUser,
  findUser,
  findUserById,
  listUsers,
  publicUser,
  setPassword,
  setRole,
  setFullName,
  deleteUser,
  verifyPassword,
  createSession,
  destroySession,
  destroyUserSessions,
  sessionToken,
  currentUser,
  sessionCookie,
  clearedCookie,
  loginBlocked,
  noteFailedLogin,
  clearLoginAttempts,
} from './auth.js';
import { storeFile, deleteFile } from './storage.js';
import { toCsv, flattenLines } from './csv.js';
import {
  cleanDate,
  cleanTime,
  monthBounds,
  shiftDays,
  resolveAge,
  formatDate,
  trimStr,
  todayIso,
} from './util.js';

// ---------------------------------------------------------------- validation

const MIN_PASSWORD = 10;

function requirePassword(value) {
  if (typeof value !== 'string' || value.length < MIN_PASSWORD) {
    throw new HttpError(400, `Password must be at least ${MIN_PASSWORD} characters.`);
  }
  return value;
}

function requireUsername(value) {
  const username = trimStr(value, 60).toLowerCase();
  if (!/^[a-z0-9._-]{3,60}$/.test(username)) {
    throw new HttpError(400, 'Username must be 3–60 characters: letters, numbers, . _ - only.');
  }
  return username;
}

function requireRole(value) {
  if (value !== 'admin' && value !== 'user') throw new HttpError(400, 'Role must be admin or user.');
  return value;
}

function requireAdmin(user) {
  if (user.role !== 'admin') {
    throw new HttpError(403, 'Only an administrator can manage accounts.');
  }
}

function requireSex(value) {
  if (value !== 'M' && value !== 'F') throw new HttpError(400, 'Sex must be M or F.');
  return value;
}

function requireType(value) {
  if (value !== 'inpatient' && value !== 'outpatient') {
    throw new HttpError(400, 'Type must be inpatient or outpatient.');
  }
  return value;
}

function requireDate(value, field) {
  const clean = cleanDate(value);
  if (!clean) throw new HttpError(400, `${field} must be a valid date (YYYY-MM-DD).`);
  return clean;
}

function optionalDate(value, field) {
  if (value === null || value === undefined || value === '') return null;
  return requireDate(value, field);
}

function optionalTime(value, field) {
  if (value === null || value === undefined || value === '') return null;
  const clean = cleanTime(value);
  if (!clean) throw new HttpError(400, `${field} must be a valid time (HH:MM).`);
  return clean;
}

function optionalAge(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > 149) throw new HttpError(400, 'Age must be 0–149.');
  return n;
}

/**
 * The statuses each kind of record can carry. Both have a leader; the second
 * option differs because the situation does — an admission can be shared with
 * the team that leads it, a clinic visit can be a consult another department
 * asked for.
 */
const CARE_ROLES = {
  inpatient: new Set(['', 'leader', 'shared']),
  outpatient: new Set(['', 'leader', 'consult']),
};

/** Statuses that name a second party, and what is missing when they don't. */
const CARE_NEEDS_PARTNER = {
  shared: 'Shared care needs the name of the leading doctor or team.',
  consult: 'A consult needs the department or doctor who asked for it.',
};

/**
 * Departments this team has asked to see the patient, as a comma-separated line.
 * Split and rejoined so the stored value is tidy however it was typed, and so the
 * screens can print it without each of them re-doing the same cleaning.
 */
function cleanConsults(value) {
  return trimStr(value, 300)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .join(', ');
}

function readCare(body, type, existing = {}) {
  const sent = body.careRole !== undefined;
  const raw = sent ? body.careRole : existing.care_role;
  let careRole = raw === null || raw === undefined ? '' : String(raw);

  if (!CARE_ROLES[type].has(careRole)) {
    // A status the client picked has to be one this kind of record offers. One
    // merely carried over — a shared-care admission being turned into a clinic
    // visit — is dropped instead, because there is nothing to map it onto.
    if (sent) {
      throw new HttpError(
        400,
        `That patient status does not apply to ${type === 'inpatient' ? 'an admission' : 'a clinic visit'}.`
      );
    }
    careRole = '';
  }

  const rawPartner = body.careLeader === undefined ? existing.care_leader : body.careLeader;
  // The other party's name only means something under a shared or consult
  // status; drop it otherwise, so a record cannot claim to be led while also
  // naming somebody else.
  const careLeader = CARE_NEEDS_PARTNER[careRole] ? trimStr(rawPartner, 120) : '';
  if (CARE_NEEDS_PARTNER[careRole] && !careLeader) {
    throw new HttpError(400, CARE_NEEDS_PARTNER[careRole]);
  }

  // The mirror image of careLeader. Under shared care or a consult somebody else
  // is carrying the patient, so referring them out is not this record's to claim
  // — the value is dropped rather than left contradicting the status beside it.
  const rawConsulted = body.consultedTo === undefined ? existing.consulted_to : body.consultedTo;
  const consultedTo = careRole === 'leader' ? cleanConsults(rawConsulted) : '';

  return { careRole, careLeader, consultedTo };
}

// ---------------------------------------------------------------- patients

function upsertPatient(p) {
  const existing = q('SELECT * FROM patients WHERE mr_number = ?').get(p.mrNumber);
  const ts = nowIso();
  const fields = [
    p.name,
    p.sex,
    p.dob,
    p.ageManual,
    p.deceased,
    p.deathDate,
    p.deathTime,
    p.causeOfDeath,
  ];
  if (existing) {
    q(
      `UPDATE patients
          SET name = ?, sex = ?, dob = ?, age_manual = ?,
              deceased = ?, death_date = ?, death_time = ?, cause_of_death = ?, updated_at = ?
        WHERE id = ?`
    ).run(...fields, ts, existing.id);
    return existing.id;
  }
  const res = q(
    `INSERT INTO patients
       (mr_number, name, sex, dob, age_manual,
        deceased, death_date, death_time, cause_of_death, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(p.mrNumber, ...fields, ts, ts);
  return insertId(res);
}

/**
 * Whether the patient has died, and what the chart says about it. The flag is
 * what counts — a ward usually knows a patient died before it knows the hour or
 * the cause, so every detail is optional. With the flag off the details are
 * dropped rather than kept hidden, so a record can never carry a cause of death
 * for someone it also calls alive.
 */
function readDeath(body, dob) {
  const deceased = body.deceased === true || body.deceased === 1 || body.deceased === '1';
  if (!deceased) return { deceased: 0, deathDate: null, deathTime: null, causeOfDeath: '' };

  const deathDate = optionalDate(body.deathDate, 'Date of death');
  const deathTime = optionalTime(body.deathTime, 'Time of death');
  // A bare time is half a record — there is no day for it to belong to.
  if (deathTime && !deathDate) {
    throw new HttpError(400, 'A time of death needs the date it happened on.');
  }
  if (deathDate) {
    if (deathDate > todayIso()) {
      throw new HttpError(400, 'The date of death cannot be in the future.');
    }
    if (dob && deathDate < dob) {
      throw new HttpError(400, 'The date of death cannot be before the date of birth.');
    }
  }
  return { deceased: 1, deathDate, deathTime, causeOfDeath: trimStr(body.causeOfDeath, 300) };
}

function readIdentity(body) {
  const mrNumber = trimStr(body.mrNumber, 60);
  const name = trimStr(body.name, 200);
  if (!mrNumber) throw new HttpError(400, 'MR number is required.');
  if (!name) throw new HttpError(400, 'Patient name is required.');
  const dob = optionalDate(body.dob, 'Date of birth');
  return {
    mrNumber,
    name,
    sex: requireSex(body.sex),
    dob,
    ageManual: optionalAge(body.ageManual),
    ...readDeath(body, dob),
  };
}

/**
 * A visit cannot happen after the patient died. Without this, an MR number typed
 * one digit wrong would hang today's admission off a dead patient's chart and
 * read as perfectly ordinary in the ward list.
 */
function checkDatesAgainstDeath(identity, admissionDate, dischargeDate) {
  const died = identity.deathDate;
  if (!died) return;
  if (admissionDate > died) {
    throw new HttpError(
      400,
      `${identity.name} is recorded as having died on ${died}, before this date. Check the MR number and the dates.`
    );
  }
  if (dischargeDate && dischargeDate > died) {
    throw new HttpError(400, `The discharge date is after the recorded date of death (${died}).`);
  }
}

/** The patient half of an API response. `id` differs by query, so it's passed in. */
function shapePatient(row, id = row.id) {
  return {
    id,
    mrNumber: row.mr_number,
    name: row.name,
    sex: row.sex,
    dob: row.dob,
    ageManual: row.age_manual,
    deceased: !!row.deceased,
    deathDate: row.death_date ?? null,
    deathTime: row.death_time ?? null,
    causeOfDeath: row.cause_of_death ?? '',
  };
}

// ---------------------------------------------------------------- encounters

const ENCOUNTER_SELECT = `
  SELECT e.id, e.type, e.admission_date, e.discharge_date, e.ward, e.diagnosis,
         e.care_role, e.care_leader, e.consulted_to, e.created_at, e.updated_at,
         p.id AS patient_id, p.mr_number, p.name, p.sex, p.dob, p.age_manual,
         p.deceased, p.death_date, p.death_time, p.cause_of_death,
         (SELECT MAX(r.visit_date) FROM rounds r WHERE r.encounter_id = e.id) AS last_round,
         (SELECT COALESCE(NULLIF(u.full_name, ''), u.username)
            FROM rounds r LEFT JOIN users u ON u.id = r.user_id
           WHERE r.encounter_id = e.id
           ORDER BY r.visit_date DESC LIMIT 1) AS last_round_by
    FROM encounters e
    JOIN patients p ON p.id = e.patient_id`;

function shapeEncounter(row) {
  if (!row) return null;
  const counts = Object.fromEntries(CATEGORIES.map((c) => [c, 0]));
  for (const r of q(
    'SELECT category, COUNT(*) AS n FROM attachments WHERE encounter_id = ? GROUP BY category'
  ).all(row.id)) {
    counts[r.category] = r.n;
  }
  return {
    id: row.id,
    type: row.type,
    admissionDate: row.admission_date,
    dischargeDate: row.discharge_date,
    ward: row.ward,
    diagnosis: row.diagnosis,
    careRole: row.care_role ?? '',
    careLeader: row.care_leader ?? '',
    consultedTo: row.consulted_to ?? '',
    // The ward round: when this patient was last ticked off, and by whom. The
    // flag is what the list draws on, but the date is what makes a stale one
    // readable — "last seen Tuesday" says more than an unlit button.
    lastVisit: row.last_round ?? null,
    lastVisitBy: row.last_round_by ?? '',
    visitedToday: (row.last_round ?? null) === todayIso(),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    patient: shapePatient(row, row.patient_id),
    age: resolveAge({ dob: row.dob, age_manual: row.age_manual }, row.admission_date),
    attachmentCounts: counts,
  };
}

function listEncounters(params) {
  const where = [];
  const args = [];

  if (params.type) {
    where.push('e.type = ?');
    args.push(requireType(params.type));
  }
  const from = cleanDate(params.from);
  const to = cleanDate(params.to);
  if (from) {
    where.push('e.admission_date >= ?');
    args.push(from);
  }
  if (to) {
    where.push('e.admission_date <= ?');
    args.push(to);
  }
  const search = trimStr(params.q, 100);
  if (search) {
    where.push('(p.name LIKE ? OR p.mr_number LIKE ? OR e.diagnosis LIKE ?)');
    const like = `%${search}%`;
    args.push(like, like, like);
  }

  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = q(
    `SELECT COUNT(*) AS n FROM encounters e JOIN patients p ON p.id = e.patient_id ${clause}`
  ).get(...args).n;

  const limit = Math.min(Math.max(Number(params.limit) || 50, 1), 200);
  const offset = Math.max(Number(params.offset) || 0, 0);
  const rows = q(
    `${ENCOUNTER_SELECT} ${clause}
      ORDER BY e.admission_date DESC, e.id DESC
      LIMIT ? OFFSET ?`
  ).all(...args, limit, offset);

  return { total, limit, offset, items: rows.map(shapeEncounter) };
}

function getEncounter(id) {
  const row = q(`${ENCOUNTER_SELECT} WHERE e.id = ?`).get(id);
  if (!row) throw new HttpError(404, 'Encounter not found.');
  return row;
}

// ---------------------------------------------------------------- attachments

function shapeAttachment(row) {
  return {
    id: row.id,
    encounterId: row.encounter_id,
    category: row.category,
    originalName: row.original_name,
    mime: row.mime,
    size: row.size,
    caption: row.caption,
    position: row.position,
    createdAt: row.created_at,
    // ?v= is the revision, so a rotated or cropped page defeats the browser's
    // cache of the previous bytes instead of appearing unchanged.
    url: `/api/attachments/${row.id}/file?v=${row.rev ?? 0}`,
    // What a gallery should actually load. Falls back to the full page for
    // anything stored before thumbnails existed, and for the seconds between a
    // page uploading and its small copy following it up — an old record draws
    // slower, never broken.
    thumbUrl: `/api/attachments/${row.id}/${row.thumb_name ? 'thumb' : 'file'}?v=${row.rev ?? 0}`,
  };
}

/** Largest thumbnail the server will accept. A 400 px JPEG is around 30 KB. */
const MAX_THUMB_BYTES = 2 * 1024 * 1024;

/**
 * Streams a stored page back, with the caching a ward network needs.
 *
 * The stored name is a fresh random string every time bytes are written, so it
 * doubles as the ETag: a page that has not been re-cropped since answers 304
 * from then on, and the phone redraws the gallery from its own disk. Where the
 * URL carries the revision the bytes behind it can never change, so it is
 * cached hard enough to skip even that round trip.
 */
function sendStoredFile(req, res, method, { storedName, mime, filename, immutable }) {
  const target = uploadPath(storedName);
  let stat;
  try {
    stat = fs.statSync(target);
  } catch {
    throw new HttpError(410, 'The stored file is missing from disk.');
  }

  const etag = `"${storedName}"`;
  const cache = immutable
    ? 'private, max-age=31536000, immutable'
    : 'private, max-age=0, must-revalidate';

  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, { ETag: etag, 'Cache-Control': cache });
    return res.end();
  }

  res.writeHead(200, {
    'Content-Type': mime,
    'Content-Length': stat.size,
    'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(filename)}`,
    'Cache-Control': cache,
    ETag: etag,
  });
  if (method === 'HEAD') return res.end();
  return fs.createReadStream(target).pipe(res);
}

function listAttachments(encounterId) {
  // `id` breaks ties so a section whose positions were never touched still comes
  // back in upload order.
  return q('SELECT * FROM attachments WHERE encounter_id = ? ORDER BY category, position, id')
    .all(encounterId)
    .map(shapeAttachment);
}

/** Where a freshly uploaded page lands: last in its own section. */
function nextPosition(encounterId, category) {
  return q(
    `SELECT COALESCE(MAX(position), -1) + 1 AS next FROM attachments
      WHERE encounter_id = ? AND category = ?`
  ).get(encounterId, category).next;
}

/**
 * Rewrites the order of one section. The submitted list must be exactly the pages
 * that section holds — anything else means the browser is working from a stale
 * copy (a page deleted or uploaded on another device), and silently applying it
 * would drop pages to the end in an order nobody chose.
 */
function reorderAttachments(encounterId, category, ids) {
  const current = q(
    `SELECT id FROM attachments WHERE encounter_id = ? AND category = ? ORDER BY position, id`
  )
    .all(encounterId, category)
    .map((r) => r.id);

  const known = new Set(current);
  const seen = new Set(ids);
  if (ids.length !== current.length || seen.size !== ids.length || ids.some((id) => !known.has(id))) {
    throw new HttpError(409, 'These pages changed on another device. Reload the record and try again.');
  }

  const stmt = q('UPDATE attachments SET position = ? WHERE id = ?');
  db.exec('BEGIN IMMEDIATE');
  try {
    ids.forEach((id, index) => stmt.run(index, id));
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

// ------------------------------------------------------------ patient chart

/**
 * How much the rest of this patient's chart holds. A record screen carries the
 * way through to it, and the way through has to say whether there is anything
 * on the other side — a patient on their first visit is the common case.
 */
function patientTotals(patientId) {
  return q(
    `SELECT COUNT(DISTINCT e.id) AS visits, COUNT(a.id) AS pages
       FROM encounters e
       LEFT JOIN attachments a ON a.encounter_id = e.id
      WHERE e.patient_id = ?`
  ).get(patientId);
}

/**
 * Every page a patient has, gathered under the visit it was taken on.
 *
 * Pages are stored per visit because that is where they are photographed, but a
 * chart is read per patient — "what did the last CT show" is not a question
 * about one admission. Without this, answering it means opening every record the
 * patient has in turn and remembering what was in each. The grouping is done
 * here rather than in the browser so it stays one request and two queries,
 * whatever the patient's history looks like.
 */
function patientChart(patientId) {
  const patient = q('SELECT * FROM patients WHERE id = ?').get(patientId);
  if (!patient) throw new HttpError(404, 'Patient not found.');

  const visits = q(
    `SELECT e.*,
            (SELECT MAX(r.visit_date) FROM rounds r WHERE r.encounter_id = e.id) AS last_round
       FROM encounters e
      WHERE e.patient_id = ?
      ORDER BY e.admission_date DESC, e.id DESC`
  ).all(patientId);

  // One query for the lot, not one per visit: a patient with twenty admissions
  // would otherwise cost twenty round trips to the database to draw one screen.
  // The order matches a single record's, so each section reads the same here as
  // it does on the record it came from.
  const pages = q(
    `SELECT a.* FROM attachments a
       JOIN encounters e ON e.id = a.encounter_id
      WHERE e.patient_id = ?
      ORDER BY a.category, a.position, a.id`
  ).all(patientId);

  const byVisit = new Map(visits.map((v) => [v.id, []]));
  const counts = Object.fromEntries(CATEGORIES.map((c) => [c, 0]));
  for (const row of pages) {
    byVisit.get(row.encounter_id)?.push(shapeAttachment(row));
    counts[row.category] += 1;
  }

  return {
    patient: shapePatient(patient),
    total: pages.length,
    counts,
    visits: visits.map((v) => ({
      id: v.id,
      type: v.type,
      admissionDate: v.admission_date,
      dischargeDate: v.discharge_date,
      ward: v.ward,
      diagnosis: v.diagnosis,
      careRole: v.care_role ?? '',
      careLeader: v.care_leader ?? '',
      consultedTo: v.consulted_to ?? '',
      lastVisit: v.last_round ?? null,
      age: resolveAge(patient, v.admission_date),
      attachments: byVisit.get(v.id) ?? [],
    })),
  };
}

// ---------------------------------------------------------------- report

function buildReport(params) {
  const type = requireType(params.type);
  const fallback = monthBounds();
  const from = cleanDate(params.from) ?? fallback.from;
  const to = cleanDate(params.to) ?? fallback.to;
  if (from > to) throw new HttpError(400, 'Start date must be on or before the end date.');

  const rows = q(
    `${ENCOUNTER_SELECT}
      WHERE e.type = ? AND e.admission_date >= ? AND e.admission_date <= ?
      ORDER BY e.admission_date ASC, p.name COLLATE NOCASE ASC, e.id ASC`
  ).all(type, from, to);

  const dateStyle = params.dateFormat === 'dmy' ? 'dmy' : 'iso';
  const flatten = params.flatten === '1' || params.flatten === true;
  const withMr = params.includeMr === '1' || params.includeMr === true;
  const withConsults = params.includeConsults === '1' || params.includeConsults === true;

  const header = withMr
    ? ['No', 'MR Number', 'Name', 'Age (M)', 'Age (F)', 'Admission Date', 'Dx']
    : ['No', 'Name', 'Age (M)', 'Age (F)', 'Admission Date', 'Dx'];
  // Last, after the diagnosis: it is the column a register is least often asked
  // for, and putting it on the end leaves every existing export unshifted.
  if (withConsults) header.push('Consulted To');

  const body = rows.map((row, i) => {
    const age = resolveAge({ dob: row.dob, age_manual: row.age_manual }, row.admission_date);
    const printed = age === null ? '' : String(age);
    // One age value, dropped into the column matching the patient's sex.
    const ageM = row.sex === 'M' ? printed : '';
    const ageF = row.sex === 'F' ? printed : '';
    const dx = flatten ? flattenLines(row.diagnosis) : row.diagnosis;
    const cells = [
      String(i + 1),
      row.name,
      ageM,
      ageF,
      formatDate(row.admission_date, dateStyle),
      dx,
    ];
    if (withMr) cells.splice(1, 0, row.mr_number);
    if (withConsults) cells.push(row.consulted_to ?? '');
    return cells;
  });

  return { type, from, to, header, rows: body };
}

// --------------------------------------------------------- daily activity

/**
 * Look-back windows the daily chart offers. A fortnight is the last two ward
 * rotations, a month matches the register everything else is counted against,
 * and a quarter is as far back as a phone-width chart can still show one column
 * per day.
 */
const DAILY_WINDOWS = [14, 30, 90];

/**
 * How many records each calendar day carries, for one kind of record.
 *
 * Days with nothing on them come back as zeros rather than being left out. A
 * chart built only from the days that had visits draws a closed Sunday exactly
 * as wide as a busy Monday, which hides the quiet stretch that is usually the
 * thing being looked for.
 *
 * Inpatient days also carry `seen`, the ward round tally. That is the other
 * daily number a ward asks about — "how many did we get round to" — and since
 * `rounds` holds one row per patient per day, counting rows over the same window
 * answers it in one more query.
 */
function dailyVisits(params) {
  const type = requireType(params.type);
  const days = DAILY_WINDOWS.includes(Number(params.days)) ? Number(params.days) : 30;
  const to = cleanDate(params.to) ?? todayIso();
  const from = shiftDays(to, -(days - 1));

  const tally = (rows) => new Map(rows.map((row) => [row.date, row.n]));

  const visits = tally(
    q(
      `SELECT admission_date AS date, COUNT(*) AS n FROM encounters
        WHERE type = ? AND admission_date >= ? AND admission_date <= ?
        GROUP BY admission_date`
    ).all(type, from, to)
  );
  const seen =
    type === 'inpatient'
      ? tally(
          q(
            `SELECT visit_date AS date, COUNT(*) AS n FROM rounds
              WHERE visit_date >= ? AND visit_date <= ?
              GROUP BY visit_date`
          ).all(from, to)
        )
      : null;

  const points = [];
  for (let i = 0; i < days; i += 1) {
    const date = shiftDays(from, i);
    const point = { date, visits: visits.get(date) ?? 0 };
    if (seen) point.seen = seen.get(date) ?? 0;
    points.push(point);
  }

  return { type, from, to, days, points };
}

// ---------------------------------------------------------------- router

export async function handleRequest(req, res) {
  baseHeaders(res);

  const url = new URL(req.url, 'http://localhost');
  const pathname = decodeURIComponent(url.pathname);
  const params = Object.fromEntries(url.searchParams);
  const method = req.method ?? 'GET';

  if (!pathname.startsWith('/api/')) {
    if (method !== 'GET' && method !== 'HEAD') throw new HttpError(405, 'Method not allowed.');
    if (serveStatic(res, pathname)) return;
    // Unknown non-API path: hand back the app shell so client-side routes work.
    if (serveStatic(res, '/index.html')) return;
    throw new HttpError(404, 'Not found.');
  }

  // --- unauthenticated endpoints -------------------------------------------

  if (pathname === '/api/bootstrap' && method === 'GET') {
    const user = currentUser(req);
    return sendJson(res, 200, {
      needsSetup: userCount() === 0,
      user,
      today: todayIso(),
      defaultRange: monthBounds(),
    });
  }

  if (pathname === '/api/setup' && method === 'POST') {
    if (userCount() > 0) throw new HttpError(409, 'Setup has already been completed.');
    const body = await readJson(req);
    const id = createUser({
      username: requireUsername(body.username),
      password: requirePassword(body.password),
      fullName: trimStr(body.fullName, 120),
      role: 'admin', // The founding account manages everyone else's.
    });
    const { token, expires } = createSession(id);
    return sendJson(res, 201, { ok: true }, { 'Set-Cookie': sessionCookie(token, expires) });
  }

  if (pathname === '/api/login' && method === 'POST') {
    const body = await readJson(req);
    const username = trimStr(body.username, 60).toLowerCase();
    const password = typeof body.password === 'string' ? body.password : '';
    const key = `${username}|${req.socket.remoteAddress}`;
    if (loginBlocked(key)) {
      throw new HttpError(429, 'Too many failed attempts. Wait 15 minutes and try again.');
    }
    const user = findUser(username);
    if (!user || !verifyPassword(password, user.password_hash)) {
      noteFailedLogin(key);
      throw new HttpError(401, 'Incorrect username or password.');
    }
    clearLoginAttempts(key);
    const { token, expires } = createSession(user.id);
    return sendJson(
      res,
      200,
      { ok: true, user: publicUser(user) },
      { 'Set-Cookie': sessionCookie(token, expires) }
    );
  }

  if (pathname === '/api/logout' && method === 'POST') {
    destroySession(sessionToken(req));
    return sendJson(res, 200, { ok: true }, { 'Set-Cookie': clearedCookie() });
  }

  // --- everything below requires a session ---------------------------------

  const user = currentUser(req);
  if (!user) throw new HttpError(401, 'Please sign in.');

  // --- your own account -----------------------------------------------------

  if (pathname === '/api/account' && method === 'GET') {
    return sendJson(res, 200, publicUser(findUserById(user.id)));
  }

  if (pathname === '/api/account' && method === 'PATCH') {
    const body = await readJson(req);
    setFullName(user.id, trimStr(body.fullName, 120));
    return sendJson(res, 200, publicUser(findUserById(user.id)));
  }

  if (pathname === '/api/account/password' && method === 'POST') {
    const body = await readJson(req);
    const row = findUserById(user.id);

    // Being signed in is not enough. Without this check, anyone who reaches an
    // unlocked browser on the ward could take the account permanently.
    const key = `pw|${user.id}|${req.socket.remoteAddress}`;
    if (loginBlocked(key)) {
      throw new HttpError(429, 'Too many incorrect attempts. Wait 15 minutes and try again.');
    }
    if (!verifyPassword(typeof body.currentPassword === 'string' ? body.currentPassword : '', row.password_hash)) {
      noteFailedLogin(key);
      throw new HttpError(401, 'Your current password is not correct.');
    }
    clearLoginAttempts(key);

    const next = requirePassword(body.newPassword);
    if (verifyPassword(next, row.password_hash)) {
      throw new HttpError(400, 'The new password must be different from the current one.');
    }

    setPassword(user.id, next);
    destroyUserSessions(user.id);
    const { token, expires } = createSession(user.id);
    return sendJson(
      res,
      200,
      { ok: true, signedOutElsewhere: true },
      { 'Set-Cookie': sessionCookie(token, expires) }
    );
  }

  // --- managing other people's accounts (admin only) ------------------------

  if (pathname === '/api/users' && method === 'GET') {
    requireAdmin(user);
    return sendJson(res, 200, { users: listUsers().map(publicUser) });
  }

  if (pathname === '/api/users' && method === 'POST') {
    requireAdmin(user);
    const body = await readJson(req);
    const username = requireUsername(body.username);
    if (findUser(username)) throw new HttpError(409, `The username "${username}" is already taken.`);
    const id = createUser({
      username,
      password: requirePassword(body.password),
      fullName: trimStr(body.fullName, 120),
      role: requireRole(body.role ?? 'user'),
    });
    return sendJson(res, 201, publicUser(findUserById(id)));
  }

  let match = pathname.match(/^\/api\/users\/(\d+)$/);
  if (match) {
    requireAdmin(user);
    const id = Number(match[1]);
    const target = findUserById(id);
    if (!target) throw new HttpError(404, 'That account no longer exists.');

    if (method === 'PATCH') {
      const body = await readJson(req);
      if (body.fullName !== undefined) setFullName(id, trimStr(body.fullName, 120));
      if (body.role !== undefined) {
        const role = requireRole(body.role);
        // Demoting the only admin would leave nobody able to manage accounts.
        if (target.role === 'admin' && role !== 'admin' && adminCount() <= 1) {
          throw new HttpError(409, 'This is the only administrator. Promote someone else first.');
        }
        setRole(id, role);
      }
      return sendJson(res, 200, publicUser(findUserById(id)));
    }

    if (method === 'DELETE') {
      // Self-deletion is the easiest way to lock yourself out of your own system.
      if (id === user.id) {
        throw new HttpError(409, 'You cannot remove your own account. Ask another administrator.');
      }
      if (target.role === 'admin' && adminCount() <= 1) {
        throw new HttpError(409, 'This is the only administrator and cannot be removed.');
      }
      deleteUser(id); // Sessions cascade with the row.
      return sendJson(res, 200, { ok: true });
    }
    throw new HttpError(405, 'Method not allowed.');
  }

  match = pathname.match(/^\/api\/users\/(\d+)\/password$/);
  if (match && method === 'POST') {
    requireAdmin(user);
    const id = Number(match[1]);
    if (!findUserById(id)) throw new HttpError(404, 'That account no longer exists.');
    const body = await readJson(req);
    setPassword(id, requirePassword(body.newPassword));
    destroyUserSessions(id);
    // An admin resetting their own password must not lock themselves out.
    if (id === user.id) {
      const { token, expires } = createSession(user.id);
      return sendJson(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(token, expires) });
    }
    return sendJson(res, 200, { ok: true });
  }

  if (pathname === '/api/patients/lookup' && method === 'GET') {
    const mr = trimStr(params.mr, 60);
    if (!mr) throw new HttpError(400, 'MR number is required.');
    const row = q('SELECT * FROM patients WHERE mr_number = ?').get(mr);
    if (!row) return sendJson(res, 200, { found: false });
    const visits = q(
      'SELECT COUNT(*) AS n FROM encounters WHERE patient_id = ?'
    ).get(row.id).n;
    return sendJson(res, 200, { found: true, patient: shapePatient(row), visits, id: row.id });
  }

  match = pathname.match(/^\/api\/patients\/(\d+)\/chart$/);
  if (match && method === 'GET') {
    return sendJson(res, 200, patientChart(Number(match[1])));
  }

  if (pathname === '/api/encounters' && method === 'GET') {
    return sendJson(res, 200, listEncounters(params));
  }

  if (pathname === '/api/encounters' && method === 'POST') {
    const body = await readJson(req);
    const identity = readIdentity(body);
    const type = requireType(body.type);
    const admissionDate = requireDate(body.admissionDate, 'Admission date');
    const dischargeDate = type === 'inpatient'
      ? optionalDate(body.dischargeDate, 'Discharge date')
      : null;
    if (dischargeDate && dischargeDate < admissionDate) {
      throw new HttpError(400, 'Discharge date cannot be before the admission date.');
    }
    checkDatesAgainstDeath(identity, admissionDate, dischargeDate);
    const care = readCare(body, type);
    const patientId = upsertPatient(identity);
    const ts = nowIso();
    const result = q(
      `INSERT INTO encounters
         (patient_id, type, admission_date, discharge_date, ward, diagnosis,
          care_role, care_leader, consulted_to, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      patientId,
      type,
      admissionDate,
      dischargeDate,
      trimStr(body.ward, 120),
      trimStr(body.diagnosis, 8000),
      care.careRole,
      care.careLeader,
      care.consultedTo,
      ts,
      ts
    );
    return sendJson(res, 201, shapeEncounter(getEncounter(insertId(result))));
  }

  match = pathname.match(/^\/api\/encounters\/(\d+)$/);
  if (match) {
    const id = Number(match[1]);
    if (method === 'GET') {
      const row = getEncounter(id);
      return sendJson(res, 200, {
        ...shapeEncounter(row),
        attachments: listAttachments(id),
        patientTotals: patientTotals(row.patient_id),
      });
    }
    if (method === 'PATCH') {
      const existing = getEncounter(id);
      const body = await readJson(req);
      const identity = readIdentity({
        mrNumber: body.mrNumber ?? existing.mr_number,
        name: body.name ?? existing.name,
        sex: body.sex ?? existing.sex,
        dob: body.dob === undefined ? existing.dob : body.dob,
        ageManual: body.ageManual === undefined ? existing.age_manual : body.ageManual,
        deceased: body.deceased === undefined ? existing.deceased : body.deceased,
        deathDate: body.deathDate === undefined ? existing.death_date : body.deathDate,
        deathTime: body.deathTime === undefined ? existing.death_time : body.deathTime,
        causeOfDeath:
          body.causeOfDeath === undefined ? existing.cause_of_death : body.causeOfDeath,
      });
      // An MR number already owned by a different patient would silently merge
      // two charts, so reject it instead.
      const clash = q('SELECT id FROM patients WHERE mr_number = ? AND id != ?').get(
        identity.mrNumber,
        existing.patient_id
      );
      if (clash) throw new HttpError(409, 'That MR number already belongs to another patient.');

      const type = requireType(body.type ?? existing.type);
      const admissionDate = requireDate(
        body.admissionDate ?? existing.admission_date,
        'Admission date'
      );
      const dischargeDate = type === 'inpatient'
        ? optionalDate(
            body.dischargeDate === undefined ? existing.discharge_date : body.dischargeDate,
            'Discharge date'
          )
        : null;
      if (dischargeDate && dischargeDate < admissionDate) {
        throw new HttpError(400, 'Discharge date cannot be before the admission date.');
      }
      checkDatesAgainstDeath(identity, admissionDate, dischargeDate);
      const care = readCare(body, type, existing);

      const ts = nowIso();
      q(
        `UPDATE patients
            SET mr_number = ?, name = ?, sex = ?, dob = ?, age_manual = ?,
                deceased = ?, death_date = ?, death_time = ?, cause_of_death = ?, updated_at = ?
          WHERE id = ?`
      ).run(
        identity.mrNumber,
        identity.name,
        identity.sex,
        identity.dob,
        identity.ageManual,
        identity.deceased,
        identity.deathDate,
        identity.deathTime,
        identity.causeOfDeath,
        ts,
        existing.patient_id
      );
      q(
        `UPDATE encounters
            SET type = ?, admission_date = ?, discharge_date = ?, ward = ?, diagnosis = ?,
                care_role = ?, care_leader = ?, consulted_to = ?, updated_at = ?
          WHERE id = ?`
      ).run(
        type,
        admissionDate,
        dischargeDate,
        trimStr(body.ward === undefined ? existing.ward : body.ward, 120),
        trimStr(body.diagnosis === undefined ? existing.diagnosis : body.diagnosis, 8000),
        care.careRole,
        care.careLeader,
        care.consultedTo,
        ts,
        id
      );
      return sendJson(res, 200, {
        ...shapeEncounter(getEncounter(id)),
        attachments: listAttachments(id),
        patientTotals: patientTotals(existing.patient_id),
      });
    }
    if (method === 'DELETE') {
      getEncounter(id);
      const files = q('SELECT stored_name, thumb_name FROM attachments WHERE encounter_id = ?').all(id);
      q('DELETE FROM encounters WHERE id = ?').run(id);
      for (const f of files) {
        deleteFile(f.stored_name);
        if (f.thumb_name) deleteFile(f.thumb_name);
      }
      return sendJson(res, 200, { ok: true });
    }
    throw new HttpError(405, 'Method not allowed.');
  }

  match = pathname.match(/^\/api\/encounters\/(\d+)\/attachments$/);
  if (match && method === 'POST') {
    const encounterId = Number(match[1]);
    getEncounter(encounterId);

    const category = String(req.headers['x-category'] ?? '');
    if (!CATEGORIES.includes(category)) throw new HttpError(400, `Unknown category: ${category}`);

    const mime = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
    if (!ALLOWED_MIME.has(mime)) {
      throw new HttpError(415, 'Only JPEG, PNG, WebP, GIF, HEIC images and PDF files are accepted.');
    }

    let originalName = 'upload';
    const rawName = req.headers['x-filename'];
    if (typeof rawName === 'string' && rawName) {
      try {
        originalName = trimStr(decodeURIComponent(rawName), 200) || 'upload';
      } catch {
        originalName = trimStr(rawName, 200);
      }
    }

    const buffer = await readBody(req);
    if (!buffer.length) throw new HttpError(400, 'Empty upload.');

    const storedName = storeFile(buffer, mime);
    const result = q(
      `INSERT INTO attachments
         (encounter_id, category, original_name, stored_name, mime, size, caption, position, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      encounterId,
      category,
      originalName,
      storedName,
      mime,
      buffer.length,
      trimStr(req.headers['x-caption'] ? decodeURIComponent(String(req.headers['x-caption'])) : '', 300),
      nextPosition(encounterId, category),
      nowIso()
    );
    const row = q('SELECT * FROM attachments WHERE id = ?').get(insertId(result));
    return sendJson(res, 201, shapeAttachment(row));
  }

  match = pathname.match(/^\/api\/encounters\/(\d+)\/attachments\/order$/);
  if (match && method === 'POST') {
    const encounterId = Number(match[1]);
    getEncounter(encounterId);

    const body = await readJson(req);
    const category = String(body.category ?? '');
    if (!CATEGORIES.includes(category)) throw new HttpError(400, `Unknown category: ${category}`);
    if (!Array.isArray(body.ids)) throw new HttpError(400, 'Order must be a list of page ids.');

    const ids = body.ids.map(Number);
    if (ids.some((id) => !Number.isInteger(id))) {
      throw new HttpError(400, 'Order must be a list of page ids.');
    }

    reorderAttachments(encounterId, category, ids);
    return sendJson(res, 200, { ok: true, attachments: listAttachments(encounterId) });
  }

  /**
   * Today's ward round, one patient at a time.
   *
   * A round is walked with a phone in one hand, and what gets lost track of is
   * not what you found but who you have already been to — so this is a tick,
   * dated, and nothing else. The date is the server's rather than the browser's:
   * a tablet left on the ward with yesterday's clock would otherwise file today's
   * round under yesterday, and read as a patient nobody has been to see.
   */
  match = pathname.match(/^\/api\/encounters\/(\d+)\/round$/);
  if (match) {
    const encounterId = Number(match[1]);
    getEncounter(encounterId);
    const today = todayIso();

    if (method === 'POST') {
      // Idempotent by the UNIQUE on (encounter, date): a double tap on a slow
      // phone is one round, and whoever ticked it first stays the one credited —
      // they are the one who actually walked in.
      q(
        `INSERT INTO rounds (encounter_id, visit_date, user_id, created_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT (encounter_id, visit_date) DO NOTHING`
      ).run(encounterId, today, user.id, nowIso());
      return sendJson(res, 200, shapeEncounter(getEncounter(encounterId)));
    }
    if (method === 'DELETE') {
      // Undo for the wrong bed. Only today's tick can be taken back — an earlier
      // day is the record of a round that happened, not a box still being filled.
      q('DELETE FROM rounds WHERE encounter_id = ? AND visit_date = ?').run(encounterId, today);
      return sendJson(res, 200, shapeEncounter(getEncounter(encounterId)));
    }
    throw new HttpError(405, 'Method not allowed.');
  }

  match = pathname.match(/^\/api\/attachments\/(\d+)\/file$/);
  if (match && (method === 'GET' || method === 'HEAD')) {
    const row = q('SELECT * FROM attachments WHERE id = ?').get(Number(match[1]));
    if (!row) throw new HttpError(404, 'File not found.');
    return sendStoredFile(req, res, method, {
      storedName: row.stored_name,
      mime: row.mime,
      filename: row.original_name,
      immutable: true,
    });
  }

  // Replaces a page's image with an edited version — rotated or cropped in the
  // browser, because the server has no image library and this app ships with no
  // dependencies. The row keeps its id, caption and position, so an edit never
  // moves a page or loses the note on it.
  if (match && method === 'PUT') {
    const id = Number(match[1]);
    const row = q('SELECT * FROM attachments WHERE id = ?').get(id);
    if (!row) throw new HttpError(404, 'File not found.');

    const mime = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
    if (!ALLOWED_MIME.has(mime)) {
      throw new HttpError(415, 'Only JPEG, PNG, WebP, GIF, HEIC images and PDF files are accepted.');
    }

    const buffer = await readBody(req);
    if (!buffer.length) throw new HttpError(400, 'Empty upload.');

    // Written before the old one is removed: if the write fails there is still a
    // page on disk, which is the right way round to fail.
    const storedName = storeFile(buffer, mime);
    // The thumbnail shows the old orientation, so it goes with the old bytes
    // rather than being left to misrepresent the page in every gallery. The
    // browser sends a fresh one straight after; until it lands the full page
    // stands in for it.
    q(
      `UPDATE attachments
          SET stored_name = ?, mime = ?, size = ?, rev = rev + 1,
              thumb_name = NULL, thumb_mime = NULL
        WHERE id = ?`
    ).run(storedName, mime, buffer.length, id);
    deleteFile(row.stored_name);
    if (row.thumb_name) deleteFile(row.thumb_name);
    return sendJson(res, 200, shapeAttachment(q('SELECT * FROM attachments WHERE id = ?').get(id)));
  }

  /**
   * The gallery-sized copy of a page.
   *
   * A record screen draws twenty thumbnails at a couple of hundred pixels each,
   * and was fetching twenty full-size photographs to do it — the single biggest
   * thing the ward waits on. The small copy is made in the browser, where the
   * picture already is, because the server has no image library and this app
   * ships with no dependencies to give it one.
   */
  match = pathname.match(/^\/api\/attachments\/(\d+)\/thumb$/);
  if (match) {
    const id = Number(match[1]);
    const row = q('SELECT * FROM attachments WHERE id = ?').get(id);
    if (!row) throw new HttpError(404, 'File not found.');

    if (method === 'POST') {
      const mime = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
      if (!ALLOWED_MIME.has(mime)) throw new HttpError(415, 'Unsupported thumbnail type.');

      const buffer = await readBody(req, MAX_THUMB_BYTES);
      if (!buffer.length) throw new HttpError(400, 'Empty upload.');

      const storedName = storeFile(buffer, mime);
      q('UPDATE attachments SET thumb_name = ?, thumb_mime = ? WHERE id = ?').run(storedName, mime, id);
      if (row.thumb_name) deleteFile(row.thumb_name);
      return sendJson(res, 200, shapeAttachment(q('SELECT * FROM attachments WHERE id = ?').get(id)));
    }

    if (method === 'GET' || method === 'HEAD') {
      if (row.thumb_name) {
        return sendStoredFile(req, res, method, {
          storedName: row.thumb_name,
          mime: row.thumb_mime || 'image/jpeg',
          filename: row.original_name,
          immutable: true,
        });
      }
      // No small copy: a page from before thumbnails, or one whose own is still
      // on its way. The full page stands in, and deliberately without the hard
      // cache — the moment the small one lands it should be what gets used.
      return sendStoredFile(req, res, method, {
        storedName: row.stored_name,
        mime: row.mime,
        filename: row.original_name,
        immutable: false,
      });
    }
    throw new HttpError(405, 'Method not allowed.');
  }

  match = pathname.match(/^\/api\/attachments\/(\d+)$/);
  if (match) {
    const id = Number(match[1]);
    const row = q('SELECT * FROM attachments WHERE id = ?').get(id);
    if (!row) throw new HttpError(404, 'File not found.');
    if (method === 'PATCH') {
      const body = await readJson(req);
      q('UPDATE attachments SET caption = ? WHERE id = ?').run(trimStr(body.caption, 300), id);
      return sendJson(res, 200, shapeAttachment(q('SELECT * FROM attachments WHERE id = ?').get(id)));
    }
    if (method === 'DELETE') {
      q('DELETE FROM attachments WHERE id = ?').run(id);
      deleteFile(row.stored_name);
      if (row.thumb_name) deleteFile(row.thumb_name);
      return sendJson(res, 200, { ok: true });
    }
    throw new HttpError(405, 'Method not allowed.');
  }

  if (pathname === '/api/report' && method === 'GET') {
    return sendJson(res, 200, buildReport(params));
  }

  if (pathname === '/api/report.csv' && method === 'GET') {
    const report = buildReport(params);
    const csv = toCsv(report.header, report.rows);
    const filename = `${report.type}-report-${report.from}_to_${report.to}.csv`;
    return sendText(res, 200, csv, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'no-store',
    });
  }

  if (pathname === '/api/stats/daily' && method === 'GET') {
    return sendJson(res, 200, dailyVisits(params));
  }

  if (pathname === '/api/stats' && method === 'GET') {
    const { from, to } = monthBounds();
    const today = todayIso();
    const inRange = (type, start, end) =>
      q(
        `SELECT COUNT(*) AS n FROM encounters
          WHERE type = ? AND admission_date >= ? AND admission_date <= ?`
      ).get(type, start, end).n;
    return sendJson(res, 200, {
      month: { from, to },
      inpatient: inRange('inpatient', from, to),
      outpatient: inRange('outpatient', from, to),
      // Same query narrowed to a single day — for outpatients that is the day's
      // clinic list, which is the number counted at the end of a session.
      today: {
        date: today,
        inpatient: inRange('inpatient', today, today),
        outpatient: inRange('outpatient', today, today),
      },
      patients: q('SELECT COUNT(*) AS n FROM patients').get().n,
      attachments: q('SELECT COUNT(*) AS n FROM attachments').get().n,
    });
  }

  throw new HttpError(404, 'Unknown endpoint.');
}
