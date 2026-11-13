/**
 * Editing a plugin that is already installed.
 *
 * The host already knows how to swap a rebuilt bundle: it watches each plugin's
 * entry artifact and reports a `rebuilt` frame on `/plugins/events`, which the
 * page turns into a fresh mount. So `dev` does not need a new transport — it
 * needs to put the new file where the host is looking, and then prove the frame
 * arrived instead of asking the author to check by eye.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { exportTarget } from './doctor.mjs';
import { expandHome, resolvePath } from './paths.mjs';

const IGNORED = new Set(['node_modules', '.git', 'docs', 'test', 'tests', 'coverage', 'fixtures']);

export function resolveEntry(dir, manifest) {
  const root = resolvePath(dir);
  const declared = manifest?.dsh?.client?.entry;
  const exported = manifest?.exports;
  const subpath = typeof exported === 'string' ? undefined : exportTarget(exported?.['./client']);
  const candidates = [declared, subpath, 'client.js', 'lib/client.js', 'dist/client.js'].filter((value) => typeof value === 'string');
  for (const candidate of candidates) {
    const absolute = path.resolve(root, candidate);
    if (fs.existsSync(absolute)) return absolute;
  }
  return null;
}

/** Where the installed copy lives, so the host's watcher sees the change. */
export function resolveDest(name, { dest, home = path.join(os.homedir(), '.dsh') } = {}) {
  if (typeof dest === 'string' && dest.length > 0) return resolvePath(dest);
  const profiles = path.join(resolvePath(home), 'profiles');
  if (fs.existsSync(profiles) === false) return null;
  for (const profile of fs.readdirSync(profiles)) {
    const candidate = path.join(profiles, profile, 'node_modules', name);
    if (fs.existsSync(candidate) === true) return candidate;
  }
  return null;
}

export function copyEntry({ from, to }) {
  if (fs.existsSync(from) === false) throw new Error(`${from} does not exist`);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  // copyFile updates mtime and ctime, which is exactly the revision the host
  // compares — an identical rebuild still counts as a new one.
  fs.copyFileSync(from, to);
  const stat = fs.statSync(to);
  return { file: to, bytes: stat.size, mtimeMs: stat.mtimeMs };
}

export function build({ command, cwd, io = console }) {
  if (typeof command !== 'string' || command.trim() === '') return { ok: true, skipped: true };
  io.log(`running: ${command}`);
  const result = spawnSync(command, { cwd, shell: true, stdio: 'inherit' });
  return { ok: result.status === 0, status: result.status };
}

/**
 * Reads the SSE stream until a `rebuilt` frame names this plugin, then closes
 * the connection. A timeout is reported as such: the file may be fine and the
 * app simply not running.
 */
export async function verifyReload({ host, id, timeoutMs = 6000, fetchImpl = fetch, action }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  // The app sends its plugin graph first. If this plugin is not in it, no amount
  // of waiting will produce a rebuilt frame: it was installed after the app
  // started, and one restart is the fix.
  let loaded = null;
  // Two ways to give up — the stream ended, or it timed out — and both mean the
  // same thing when the app never had this plugin in its graph.
  const miss = (fallback) => (loaded !== null && loaded.has(id) === false
    ? `the running app has not loaded ${id}, so it will not report a reload; restart the app once after installing it`
    : fallback);
  const url = `${String(host).replace(/\/+$/, '')}/plugins/events`;
  try {
    const response = await fetchImpl(url, { headers: { accept: 'text/event-stream' }, signal: controller.signal });
    if (response.ok !== true) return { ok: false, reason: `GET ${url} answered ${response.status}` };
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let acted = false;
    for (;;) {
      const { value, done } = await reader.read();
      if (done === true) break;
      buffer += decoder.decode(value, { stream: true });
      const frames = buffer.split('\n\n');
      buffer = frames.pop() ?? '';
      for (const frame of frames) {
        const data = frame.split('\n').find((line) => line.startsWith('data: '));
        if (data === undefined) continue;
        // The first frame proves the stream is live. Only then is the file
        // written: a copy made before subscribing can be reported to nobody.
        if (acted === false && typeof action === 'function') {
          acted = true;
          await action();
        }
        let payload;
        try {
          payload = JSON.parse(data.slice(6));
        } catch {
          continue;
        }
        if (payload.type === 'graph') {
          const entries = payload.graph?.entries;
          if (Array.isArray(entries) === true) loaded = new Set(entries.map((entry) => entry.id));
          continue;
        }
        if (payload.type !== 'rebuilt') continue;
        if (JSON.stringify(payload).includes(id) === false) continue;
        return { ok: true, rev: payload.rev ?? null, frame: payload };
      }
    }
    return { ok: false, reason: miss('the stream ended before a rebuilt frame arrived') };
  } catch (error) {
    if (error.name === 'AbortError') return { ok: false, reason: miss(`no rebuilt frame for ${id} within ${timeoutMs}ms`) };
    return { ok: false, reason: error.message };
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

/**
 * The app's own list of what it loaded, read once. `audit` uses it to answer
 * "installed, but why is there no panel?" for every plugin at once.
 */
export async function readGraph({ host, timeoutMs = 3000, fetchImpl = fetch }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const url = `${String(host).replace(/\/+$/, '')}/plugins/events`;
  try {
    const response = await fetchImpl(url, { headers: { accept: 'text/event-stream' }, signal: controller.signal });
    if (response.ok !== true) return { ok: false, url, reason: `GET ${url} answered ${response.status}` };
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done === true) break;
      buffer += decoder.decode(value, { stream: true });
      const frames = buffer.split('\n\n');
      buffer = frames.pop() ?? '';
      for (const frame of frames) {
        const data = frame.split('\n').find((line) => line.startsWith('data: '));
        if (data === undefined) continue;
        let payload;
        try {
          payload = JSON.parse(data.slice(6));
        } catch {
          continue;
        }
        if (payload.type !== 'graph' || Array.isArray(payload.graph?.entries) === false) continue;
        return { ok: true, url, ids: new Set(payload.graph.entries.map((entry) => entry.id)) };
      }
    }
    return { ok: false, url, reason: `GET ${url} ended before a graph frame arrived` };
  } catch (error) {
    if (error.name === 'AbortError') return { ok: false, url, reason: `GET ${url} sent no graph frame within ${timeoutMs}ms` };
    return { ok: false, url, reason: `GET ${url}: ${error.message}` };
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

export function watchPlugin({ dir, onChange, debounceMs = 200, io = console }) {
  const root = resolvePath(dir);
  const timers = new Map();
  const watcher = fs.watch(root, { recursive: true }, (event, file) => {
    if (typeof file !== 'string') return;
    const parts = file.split(path.sep);
    if (parts.some((part) => IGNORED.has(part)) === true) return;
    if (/\.(png|jpg|jpeg|gif|webp|map|log)$/i.test(file) === true) return;
    clearTimeout(timers.get(file));
    timers.set(file, setTimeout(() => {
      timers.delete(file);
      onChange(file);
    }, debounceMs));
  });
  io.log(`watching ${root}`);
  return () => {
    for (const timer of timers.values()) clearTimeout(timer);
    watcher.close();
  };
}

export async function dev(options) {
  const {
    dir,
    dest: destOption,
    entry: entryOption,
    build: buildCommand,
    host,
    once = false,
    debounceMs = 200,
    timeoutMs = 4000,
    io = console,
    fetchImpl = fetch,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  } = options;

  const root = resolvePath(dir);
  const manifestPath = path.join(root, 'package.json');
  if (fs.existsSync(manifestPath) === false) {
    io.error(`dsh-plugin dev: ${root} has no package.json`);
    return 1;
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const source = entryOption === undefined ? resolveEntry(root, manifest) : path.resolve(root, expandHome(entryOption));
  if (source === null) {
    io.error('dsh-plugin dev: no client entry found (dsh.client.entry, client.js, lib/client.js)');
    return 1;
  }
  const destDir = resolveDest(manifest.name, { dest: destOption });
  if (destDir === null) {
    io.error(`dsh-plugin dev: ${manifest.name} is not installed in any profile; pass --dest`);
    return 1;
  }
  const relative = path.relative(root, source);
  const target = path.join(destDir, relative);
  io.log(`${manifest.name}: ${source} -> ${target}`);

  const sync = async (reason) => {
    if (buildCommand !== undefined) {
      const built = build({ command: buildCommand, cwd: root, io });
      if (built.ok === false) {
        io.error(`build failed (exit ${built.status}); nothing copied`);
        return { ok: false };
      }
    }
    let copied = null;
    if (typeof host !== 'string' || host.length === 0) {
      // Without the app's URL there is nothing to confirm against, and a
      // guessed port would report "not confirmed" for a reload that happened.
      copied = copyEntry({ from: source, to: target });
      io.log(`${reason}: copied ${copied.bytes} bytes at ${new Date(copied.mtimeMs).toLocaleTimeString()}`);
      io.log('pass --host <the URL the app printed> to confirm the reload happened');
      return { ok: true, verified: { ok: false, reason: 'no host given' } };
    }
    const verified = await verifyReload({
      host,
      id: manifest.name,
      timeoutMs,
      fetchImpl,
      action: () => {
        copied = copyEntry({ from: source, to: target });
        io.log(`${reason}: copied ${copied.bytes} bytes at ${new Date(copied.mtimeMs).toLocaleTimeString()}`);
      },
    });
    if (copied === null) {
      // The stream never opened, so the copy still has to happen — otherwise a
      // stopped app would silently mean "nothing was updated".
      copied = copyEntry({ from: source, to: target });
      io.log(`${reason}: copied ${copied.bytes} bytes (no stream to confirm with)`);
    }
    if (verified.ok === true) io.log(`reloaded ${manifest.name} (rev ${verified.rev})`);
    else io.log(`copied, but not confirmed: ${verified.reason}`);
    return { ok: true, verified };
  };

  if (once === true) {
    const result = await sync('once');
    return result.ok === true ? 0 : 1;
  }

  let stopping = false;
  const stop = () => {
    stopping = true;
  };
  process.once('SIGINT', stop);
  const close = watchPlugin({ dir: root, debounceMs, io, onChange: (file) => { void sync(file); } });
  await sync('initial');
  while (stopping === false) await sleep(200);
  close();
  return 0;
}
