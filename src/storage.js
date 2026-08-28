import crypto from 'node:crypto';
import fs from 'node:fs';
import { ALLOWED_MIME } from './config.js';
import { uploadPath } from './db.js';
import { HttpError } from './http.js';

/**
 * Files are stored under a random name, never the name the phone supplied.
 * That removes path traversal and collisions in one move; the original name
 * is kept in the database for display only.
 */
export function storeFile(buffer, mime) {
  const ext = ALLOWED_MIME.get(mime);
  if (!ext) throw new HttpError(415, `Unsupported file type: ${mime}`);
  const storedName = `${Date.now().toString(36)}-${crypto.randomBytes(12).toString('hex')}${ext}`;
  fs.writeFileSync(uploadPath(storedName), buffer);
  return storedName;
}

export function deleteFile(storedName) {
  try {
    fs.unlinkSync(uploadPath(storedName));
  } catch (err) {
    // A missing file is fine — the database row is the record of truth and is
    // about to go away too. Anything else is worth knowing about.
    if (err.code !== 'ENOENT') console.error('[storage] failed to delete', storedName, err.message);
  }
}

export function diskUsage(storedNames) {
  let total = 0;
  for (const name of storedNames) {
    try {
      total += fs.statSync(uploadPath(name)).size;
    } catch {
      /* counted as zero */
    }
  }
  return total;
}
