// Dev stack launcher — starts the control plane, the Go game server and Vite
// together, with one Ctrl-C stopping all three.
//
// Why a script instead of npm scripts: running three long-lived processes in
// parallel needs either a dependency (concurrently / npm-run-all) or a shell
// idiom that differs between cmd.exe, PowerShell and sh. This repo has kept
// zero server dependencies, and `set X=1&&` in package.json is already
// Windows-only. A ~90-line Node script is the portable answer.
//
//   node tools/dev/stack.mjs            control + game + client
//   node tools/dev/stack.mjs --dev      ...with the tester panels and warp enabled
//   node tools/dev/stack.mjs --no-client   servers only (for test-go.mjs)
//   node tools/dev/stack.mjs --legacy   the pre-migration Node server on :8081

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const args = new Set(process.argv.slice(2));
const dev = args.has('--dev');
const legacy = args.has('--legacy');
const withClient = !args.has('--no-client');

// gameserver/test-go.mjs mints its own tickets (it needs both a dev-claimed and
// an unclaimed one, which no single control-plane policy can produce), so it
// only works against a control plane pinned to its keypair. Read the pair out of
// the test itself rather than copying it: one source of truth, and rotating the
// key there cannot silently desync this launcher.
function testTicketKeys() {
  const src = readFileSync(resolve(ROOT, 'gameserver/test-go.mjs'), 'utf8');
  const grab = (name) => src.match(new RegExp(`const ${name} = '([^']+)'`))?.[1];
  const HEARTH_TICKET_PUBKEY = grab('TEST_PUBKEY');
  const HEARTH_TICKET_PRIVKEY = grab('TEST_PRIVKEY');
  if (!HEARTH_TICKET_PUBKEY || !HEARTH_TICKET_PRIVKEY) {
    console.error('stack: could not read TEST_PUBKEY/TEST_PRIVKEY from gameserver/test-go.mjs');
    process.exit(1);
  }
  return { HEARTH_TICKET_PUBKEY, HEARTH_TICKET_PRIVKEY };
}

// ANSI colours keep three interleaved streams readable; harmless if unsupported.
const COLOURS = { control: '\x1b[36m', game: '\x1b[32m', client: '\x1b[35m', legacy: '\x1b[33m' };
const RESET = '\x1b[0m';

const children = [];
let shuttingDown = false;

function run(name, cmd, cmdArgs, opts = {}) {
  const child = spawn(cmd, cmdArgs, {
    cwd: opts.cwd || ROOT,
    env: { ...process.env, ...(opts.env || {}) },
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: process.platform === 'win32',   // resolves go.exe / npx.cmd from PATH
  });
  const tag = `${COLOURS[name] || ''}[${name}]${RESET} `;
  const pipe = (stream) => {
    let buf = '';
    stream.on('data', (d) => {
      buf += d.toString();
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const l of lines) if (l.trim()) process.stdout.write(tag + l + '\n');
    });
  };
  pipe(child.stdout);
  pipe(child.stderr);
  child.on('exit', (code) => {
    if (shuttingDown) return;
    process.stdout.write(tag + `exited with code ${code}\n`);
    shutdown(code ?? 1);        // one process dying takes the stack down: a half-up
  });                           // stack silently misleads more than it helps
  children.push(child);
  return child;
}

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const c of children) {
    if (c.exitCode !== null) continue;
    // On Windows, killing the shell wrapper leaves the real process orphaned.
    if (process.platform === 'win32') spawn('taskkill', ['/pid', c.pid, '/f', '/t'], { stdio: 'ignore' });
    else c.kill('SIGTERM');
  }
  setTimeout(() => process.exit(code), 400);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

if (legacy) {
  // The pre-migration single-server path. The client needs ?legacy=1 to match.
  run('legacy', 'node', ['server/index.js'], { env: dev ? { DEV: '1', HEARTH_ALLOW_WARP: '1' } : {} });
} else {
  // HEARTH_DEV_ALL grants the ticket's dev claim to LOOPBACK clients only, so
  // --dev restores the old `npm run server:dev` ergonomics (F9 kit, F10 panel)
  // without handing world-mutating commands to LAN or remote players.
  run('control', 'node', ['control/index.js'], {
    env: {
      ...(dev ? { HEARTH_DEV_ALL: '1', HEARTH_DEV_TOKS: process.env.HEARTH_DEV_TOKS || '' } : {}),
      // --no-client is the mode the wire suites run against; pin the keypair
      // they sign with so `npm run test:go` needs no extra setup.
      ...(withClient ? {} : testTicketKeys()),
    },
  });
  // No HEARTH_DEV here: the dev panels are gated solely on the `dev` claim the
  // control plane signs into the ticket, per-account. A server-wide env flag
  // would hand world-mutating commands to every connected player.
  // Worlds build lazily by default, which is right for a multi-world process but
  // makes the FIRST join pay ~6s of worldgen. Build eagerly here: a dev stack
  // hosts one world that is certain to be joined, and the wire suites time out
  // waiting for `init` behind a cold build.
  run('game', 'go', ['run', './cmd/hearthd'], {
    cwd: resolve(ROOT, 'gameserver'),
    env: { HEARTH_EAGER_WORLDS: '1', ...(dev ? { HEARTH_ALLOW_WARP: '1' } : {}) },
  });
}

if (withClient) run('client', 'npx', ['vite', '--host']);

process.stdout.write(
  `\n  stack: ${legacy ? 'legacy :8081' : 'control :8090 + game :8082'}` +
  `${withClient ? ' + client :5173' : ''}\n` +
  (dev
    ? `  dev: F9 kit + F10 tester panel + warp, granted to this machine only\n`
    : '') +
  `  Ctrl-C stops everything.\n\n`,
);
