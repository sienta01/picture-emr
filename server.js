import http from 'node:http';
import os from 'node:os';
import { HOST, PORT, DATA_DIR } from './src/config.js';
import { handleRequest } from './src/routes.js';
import { HttpError, sendJson } from './src/http.js';
import { purgeExpiredSessions } from './src/auth.js';
import { db } from './src/db.js';

purgeExpiredSessions();
setInterval(purgeExpiredSessions, 60 * 60 * 1000).unref();

const server = http.createServer((req, res) => {
  handleRequest(req, res).catch((err) => {
    if (res.headersSent) return res.destroy();
    if (err instanceof HttpError) return sendJson(res, err.status, { error: err.message });
    console.error(`[error] ${req.method} ${req.url}`, err);
    sendJson(res, 500, { error: 'Something went wrong on the server.' });
  });
});

server.listen(PORT, HOST, () => {
  const addresses = [`http://localhost:${PORT}`];
  if (HOST === '0.0.0.0') {
    for (const list of Object.values(os.networkInterfaces())) {
      for (const net of list ?? []) {
        if (net.family === 'IPv4' && !net.internal) addresses.push(`http://${net.address}:${PORT}`);
      }
    }
  }
  console.log('\n  Picture EMR is running.\n');
  for (const address of addresses) console.log(`    ${address}`);
  console.log(`\n  Data folder: ${DATA_DIR}`);
  if (HOST === '0.0.0.0' && addresses.length > 1) {
    console.log('  Ward devices on this network can use any of the addresses above.');
  }
  console.log('\n  Press Ctrl+C to stop.\n');
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    console.log('\nShutting down…');
    server.close(() => {
      try {
        db.close();
      } catch {
        /* already closed */
      }
      process.exit(0);
    });
    // Don't let a hung keep-alive connection block the shutdown.
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
