import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

export const ROOT = path.resolve(here, '..');
export const DATA_DIR = process.env.EMR_DATA_DIR
  ? path.resolve(process.env.EMR_DATA_DIR)
  : path.join(ROOT, 'data');
export const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
export const DB_PATH = path.join(DATA_DIR, 'emr.db');
export const PUBLIC_DIR = path.join(ROOT, 'public');

export const PORT = Number(process.env.PORT || 8787);
// Bound to all interfaces so ward phones/tablets on the same network can reach it.
// Set HOST=127.0.0.1 to lock the server to this machine only.
export const HOST = process.env.HOST || '0.0.0.0';

/** Largest single upload accepted, in bytes. Phone photos land well under this. */
export const MAX_UPLOAD_BYTES = 40 * 1024 * 1024;

/** How long a login stays valid before the user must sign in again. */
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

export const CATEGORIES = ['identity', 'chart', 'lab', 'radiology'];

export const CATEGORY_LABELS = {
  identity: 'Identity Page',
  chart: 'Patient Chart',
  lab: 'Ancillary — Lab',
  radiology: 'Ancillary — Radiology',
};

export const ALLOWED_MIME = new Map([
  ['image/jpeg', '.jpg'],
  ['image/png', '.png'],
  ['image/webp', '.webp'],
  ['image/gif', '.gif'],
  ['image/heic', '.heic'],
  ['image/heif', '.heif'],
  ['application/pdf', '.pdf'],
]);
