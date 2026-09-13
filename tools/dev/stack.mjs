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
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const args = new Set(process.argv.slice(2));
const dev = args.has('--dev');
const legacy = args.has('--legacy');
const withClient = !args.has('--no-client');

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
  run('control', 'node', ['control/index.js'], {
    env: dev ? { HEARTH_DEV_TOKS: process.env.HEARTH_DEV_TOKS || '' } : {},
  });
  // No HEARTH_DEV here: the dev panels are gated solely on the `dev` claim the
  // control plane signs into the ticket, per-account. A server-wide env flag
  // would hand world-mutating commands to every connected player.
  run('game', 'go', ['run', './cmd/hearthd'], {
    cwd: resolve(ROOT, 'gameserver'),
    env: dev ? { HEARTH_ALLOW_WARP: '1' } : {},
  });
}

if (withClient) run('client', 'npx', ['vite', '--host']);

// --dev alone does NOT grant the F9/F10 panels on the Go path: they need a `dev`
// claim in the ticket, which the control plane only mints for an allowlisted tok.
const devHint =
  dev && !legacy && !process.env.HEARTH_DEV_TOKS
    ? '  note: dev panels need HEARTH_DEV_TOKS=<your localStorage hearth-tok>\n'
    : '';

process.stdout.write(
  `\n  stack: ${legacy ? 'legacy :8081' : 'control :8090 + game :8082'}` +
  `${withClient ? ' + client :5173' : ''}${dev ? '  (warp on)' : ''}\n` +
  devHint +
  `  Ctrl-C stops everything.\n\n`,
);
