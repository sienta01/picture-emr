const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
// A browser's time input hands back HH:MM, but adds :SS once seconds are in play.
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)(?::[0-5]\d)?$/;

/** Returns a validated YYYY-MM-DD string, or null if the input isn't a real calendar date. */
export function cleanDate(value) {
  if (typeof value !== 'string' || !DATE_RE.test(value)) return null;
  const [y, m, d] = value.split('-').map(Number);
  const probe = new Date(Date.UTC(y, m - 1, d));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== m - 1 || probe.getUTCDate() !== d) {
    return null;
  }
  return value;
}

/** Returns a validated 24-hour HH:MM string, or null. Seconds are dropped. */
export function cleanTime(value) {
  if (typeof value !== 'string') return null;
  const match = value.trim().match(TIME_RE);
  return match ? `${match[1]}:${match[2]}` : null;
}

export function todayIso(now = new Date()) {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * The date `delta` days from `iso`, as YYYY-MM-DD. Walked in UTC so a run of days
 * built with it never gains or loses one crossing a daylight-saving boundary.
 */
export function shiftDays(iso, delta) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + delta)).toISOString().slice(0, 10);
}

/** First and last day of the month containing `ref`, as YYYY-MM-DD. */
export function monthBounds(ref = new Date()) {
  const y = ref.getFullYear();
  const m = ref.getMonth();
  const last = new Date(y, m + 1, 0).getDate();
  const mm = String(m + 1).padStart(2, '0');
  return { from: `${y}-${mm}-01`, to: `${y}-${mm}-${String(last).padStart(2, '0')}` };
}

/**
 * Completed years between two YYYY-MM-DD dates. Birthday-aware, so a patient born
 * 1980-12-31 admitted 2026-12-30 is 45, not 46.
 */
export function yearsBetween(dob, onDate) {
  const [by, bm, bd] = dob.split('-').map(Number);
  const [ry, rm, rd] = onDate.split('-').map(Number);
  let age = ry - by;
  if (rm < bm || (rm === bm && rd < bd)) age -= 1;
  return age;
}

/**
 * Age to print on a report row. DOB wins because it stays correct as time passes;
 * the manually typed age is the fallback for charts where the DOB was unreadable.
 */
export function resolveAge(patient, onDate) {
  if (patient.dob && onDate) {
    const age = yearsBetween(patient.dob, onDate);
    if (age >= 0 && age < 150) return age;
  }
  if (patient.age_manual !== null && patient.age_manual !== undefined) {
    return patient.age_manual;
  }
  return null;
}

export function formatDate(iso, style) {
  if (!iso) return '';
  if (style === 'dmy') {
    const [y, m, d] = iso.split('-');
    return `${d}/${m}/${y}`;
  }
  return iso;
}

export function trimStr(value, max = 500) {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, max);
}
