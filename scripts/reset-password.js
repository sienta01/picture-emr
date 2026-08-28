// Sets a new password for an account, for when nobody can sign in any more.
//
// This deliberately has no authentication of its own. Anyone who can run it can
// already open data/emr.db and read every patient record directly, so a prompt
// here would guard nothing. The real boundary is who can reach this machine and
// this folder — which is what disk encryption is for, not this script.
//
//   npm run reset-password
//   npm run reset-password -- --user drtimothy

import readline from 'node:readline';
import {
  listUsers,
  findUser,
  setPassword,
  destroyUserSessions,
  adminCount,
  setRole,
} from '../src/auth.js';
import { DB_PATH } from '../src/config.js';

const MIN_PASSWORD = 10;

// One interface for the whole script. Opening a fresh one per question works on a
// real terminal but swallows buffered input when stdin is a pipe, which hangs the
// script in any non-interactive shell.
const interactive = Boolean(process.stdin.isTTY);
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: interactive,
});

if (interactive) {
  // Suppress the echo of typed characters, the way a sudo prompt does.
  rl._writeToOutput = function (chunk) {
    if (!rl.stdoutMuted) rl.output.write(chunk);
  };
}

// When stdin is a pipe, readline delivers every buffered line up front rather than
// one per question, so anything asked later would miss its input. Queueing the
// lines makes the script behave identically typed by hand or fed from a script.
const received = [];
const waiting = [];
let inputClosed = false;

rl.on('line', (line) => {
  if (waiting.length) waiting.shift()(line);
  else received.push(line);
});
rl.on('close', () => {
  inputClosed = true;
  while (waiting.length) waiting.shift()('');
});

function ask(query, hidden = false) {
  process.stdout.write(query);
  if (hidden && interactive) rl.stdoutMuted = true;

  return new Promise((resolve) => {
    const settle = (line) => {
      rl.stdoutMuted = false;
      if (hidden && interactive) process.stdout.write('\n');
      resolve(line);
    };
    if (received.length) settle(received.shift());
    else if (inputClosed) settle('');
    else waiting.push(settle);
  });
}

function finish(code, message) {
  rl.close();
  if (message) console.log(message);
  process.exit(code);
}

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

const users = listUsers();

console.log(`\n  Picture EMR — password reset`);
console.log(`  Database: ${DB_PATH}\n`);

if (users.length === 0) {
  console.log('  There are no accounts in this database yet.');
  console.log('  Start the server with "npm start" and the setup screen will');
  console.log('  ask you to create one.\n');
  finish(0);
}

console.log('  Accounts:');
for (const u of users) {
  const name = u.full_name ? ` (${u.full_name})` : '';
  console.log(`    ${u.username}${name} — ${u.role}`);
}
console.log('');

let username = argValue('--user');
if (!username) username = (await ask('  Username to reset: ')).trim();

const target = findUser(username.trim().toLowerCase());
if (!target) {
  finish(1, `\n  No account called "${username}". Nothing changed.\n`);
}

const first = await ask(`  New password for ${target.username}: `, true);
if (first.length < MIN_PASSWORD) {
  finish(1, `\n  Password must be at least ${MIN_PASSWORD} characters. Nothing changed.\n`);
}

const second = await ask('  Type it again: ', true);
if (first !== second) {
  finish(1, '\n  The two passwords do not match. Nothing changed.\n');
}

setPassword(target.id, first);
destroyUserSessions(target.id);

// A database whose only admin was demoted by hand would otherwise be unmanageable.
if (adminCount() === 0) {
  setRole(target.id, 'admin');
  console.log(`\n  No administrator existed, so ${target.username} has been made one.`);
}

console.log(`\n  Password updated for ${target.username}.`);
finish(0, '  Any device still signed in as this user has been signed out.\n');
