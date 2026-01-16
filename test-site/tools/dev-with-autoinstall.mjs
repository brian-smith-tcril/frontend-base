#!/usr/bin/env node

import chokidar from 'chokidar';
import fs from 'fs';
import path from 'path';
import net from 'net';
import { spawn } from 'child_process';

const APP_ROOT = process.cwd();
const FRONTEND_BASE_DIR = path.resolve(APP_ROOT, '..');
const PACK_DIR = path.resolve(FRONTEND_BASE_DIR, 'pack');
const TGZ_FILENAME = 'openedx-frontend-base.tgz';
const TGZ_PATH = path.join(PACK_DIR, TGZ_FILENAME);
const PORT = 8080;

const portInUse = () => {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(true)); // EADDRINUSE etc
    s.once('listening', () => s.close(() => resolve(false)));
    s.listen(PORT, '127.0.0.1');
  });
};

const waitForPortFree = async (timeoutMs = 8000) => {
  const start = Date.now();
  while (await portInUse()) {
    if ((Date.now() - start) > timeoutMs) {
      throw new Error(`Port ${PORT} still in use after ${timeoutMs}ms`);
    }

    await new Promise((r) => setTimeout(r, 150));
  }
};

let devServerProcess = null;
const startDev = () => {
  console.log(`\n[dev] start: npm run dev\n`);
  devServerProcess = spawn('npm', ['run', 'dev'], {
    cwd: APP_ROOT,
    stdio: 'inherit',
    shell: false,
    detached: true, // crucial: gives us a process group to kill
    env: process.env,
  });
  devServerProcess?.once('error', (e) => console.error('[dev] spawn failed:', e));
  devServerProcess.unref();
};

const WAIT_BETWEEN_TERM_AND_KILL_MS = 1200;
const stopDev = async () => {
  if (!devServerProcess) {
    return;
  }

  console.log('\n[dev] stop\n');

  try {
    process.kill(-devServerProcess.pid, 'SIGTERM');
  } catch (e) {
    if (e.code !== 'ESRCH') {
      throw e;
    }
  }

  await new Promise((r) => setTimeout(r, WAIT_BETWEEN_TERM_AND_KILL_MS));

  if (await portInUse()) {
    try {
      process.kill(-devServerProcess.pid, 'SIGKILL');
    } catch (e) {
      if (e.code !== 'ESRCH') {
        throw e;
      }
    }
  }

  await waitForPortFree();
  devServerProcess = null;
};

const installBase = () => {
  return new Promise((resolve, reject) => {
    const baseInstallProcess = spawn(
      'npm',
      ['i', '--no-save', TGZ_PATH],
      { stdio: 'inherit', shell: false, cwd: APP_ROOT }
    );

    baseInstallProcess.once('error', reject);

    baseInstallProcess.once('exit', (code) => (
      code === 0
        ? resolve()
        : reject(new Error(`npm exited ${code}`))
    )
    );
  });
};

const tryInstallBase = async () => {
  if (!fs.existsSync(TGZ_PATH)) {
    throw new Error(`${TGZ_FILENAME} not found at ${TGZ_PATH}`);
  }

  console.log(`\n[base] install: ${TGZ_PATH}\n`);
  await installBase();
};

let restarting = false;
let timer = null;
const RESTART_DEBOUNCE_MS = 350;
const scheduleRestart = (reason) => {
  if (timer) {
    clearTimeout(timer);
  }

  timer = setTimeout(() => restart(reason), RESTART_DEBOUNCE_MS);
};

const restart = async (reason) => {
  if (restarting) return;
  restarting = true;
  try {
    console.log(`\n[watch] restart (${reason})`);
    await stopDev();
    await tryInstallBase();
    startDev();
  } catch (e) {
    console.error('\n[error]', e.message || e);
  } finally {
    restarting = false;
  }
};

let watcher;
const watchTgz = () => {
  console.log(`[watch] ${TGZ_PATH}`);

  watcher = chokidar
    .watch(TGZ_PATH, { ignoreInitial: true, awaitWriteFinish: true })
    .on('add', () => scheduleRestart('tgz:add'))
    .on('change', () => scheduleRestart('tgz:change'));
};

const shutdown = async () => {
  console.log('\n[exit]');
  if (timer) {
    clearTimeout(timer);
  }

  try {
    await watcher?.close();
    await stopDev();
  } finally {
    process.exit(0);
  }
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

watchTgz();
await tryInstallBase();
startDev();
