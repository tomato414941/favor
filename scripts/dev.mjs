import { spawn } from 'node:child_process';

const children = ['dev:server', 'dev:web'].map((script) =>
  spawn('npm', ['run', script], { stdio: 'inherit', detached: true }),
);
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    if (child.pid) {
      try { process.kill(-child.pid, 'SIGTERM'); } catch { /* Already stopped. */ }
    }
  }
  process.exitCode = code;
}
for (const child of children) {
  child.on('error', (error) => { console.error(error.message); stop(1); });
  child.on('exit', (code) => stop(code ?? 1));
}
process.on('SIGINT', () => stop());
process.on('SIGTERM', () => stop());
