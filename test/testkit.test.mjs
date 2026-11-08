import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { mountClient } from '../lib/testkit/index.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const bundle = path.join(here, '..', 'fixtures', 'client-bundle', 'client.js');

test('a client bundle mounts and its text is readable', async () => {
  const panel = await mountClient({ file: bundle });
  assert.match(panel.text(), /Demo panel/);
  assert.match(panel.text(), /Count 0/);
  assert.equal(panel.must('[data-testid="inc"]').getAttribute('aria-label'), 'increment');
  await panel.unmount();
});

test('a click goes through React and updates the DOM', async () => {
  const panel = await mountClient({ file: bundle });
  await panel.click('[data-testid="inc"]');
  await panel.click('[data-testid="inc"]');
  assert.match(panel.text(), /Count 2/);
  assert.equal(panel.must('.demo-result').getAttribute('aria-live'), 'polite');
  await panel.unmount();
});

test('the registered locale table is what the panel translates through', async () => {
  const panel = await mountClient({ file: bundle, copy: { demo: { title: '演示' } } });
  assert.equal(panel.host.registeredLocale('demo').title, 'Demo');
  assert.equal(panel.host.locale.bind('demo')('title'), 'Demo');
  assert.equal(panel.host.locale.bind('demo')('missing'), 'missing');
  await panel.unmount();
});

test('a bundle that registers nothing is reported by name, not by stack trace', async () => {
  await assert.rejects(() => mountClient({ file: bundle, slot: 'conversation.input.left' }), /registered no "conversation\.input\.left" slot/);
});

test('route stubs answer what they were told, and remember what was asked', async () => {
  const { createFetch } = await import('../lib/testkit/index.mjs');
  const stub = createFetch({
    '/api/report': { body: { score: 71 } },
    '/api/save': ({ }) => ({ status: 201, body: { saved: true } }),
  });
  const first = await stub('/api/report?fresh=1');
  assert.equal(first.status, 200);
  assert.deepEqual(await first.json(), { score: 71 });
  const saved = await stub('/api/save', { method: 'POST', body: '{"x":1}' });
  assert.equal(saved.status, 201);
  const missing = await stub('/api/unknown');
  assert.equal(missing.status, 404);
  assert.deepEqual(stub.requests.map((request) => `${request.method} ${request.path}`), ['GET /api/report', 'POST /api/save', 'GET /api/unknown']);
});

test('a panel mounts against route stubs instead of a live plugin server', async () => {
  const { createFetch } = await import('../lib/testkit/index.mjs');
  const stub = createFetch({});
  const panel = await mountClient({ file: bundle, fetch: stub });
  assert.match(panel.text(), /Demo panel/);
  await panel.unmount();
});

test('the rendered markup matches its baseline', async () => {
  const panel = await mountClient({ file: bundle });
  const dir = path.join(here, '..', 'fixtures', 'client-bundle', '__snapshots__');
  if (process.env.UPDATE_SNAPSHOTS === '1') panel.writeSnapshot(dir, 'panel');
  panel.snapshot(dir, 'panel');
  await panel.unmount();
});

test('panel.snapshot() names UPDATE_SNAPSHOTS=1, then writes and matches on the rerun', async () => {
  const { mkdtemp, readFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const dir = await mkdtemp(path.join(tmpdir(), 'tk-snapshot-'));
  const previous = process.env.UPDATE_SNAPSHOTS;
  const panel = await mountClient({ file: bundle });
  try {
    delete process.env.UPDATE_SNAPSHOTS;
    assert.throws(
      () => panel.snapshot(dir, 'panel'),
      /no baseline at .*panel\.html; run with UPDATE_SNAPSHOTS=1 to create it/,
    );

    process.env.UPDATE_SNAPSHOTS = '1';
    assert.equal(panel.snapshot(dir, 'panel').status, 'written');
    assert.match(await readFile(path.join(dir, 'panel.html'), 'utf8'), /Demo panel/);

    delete process.env.UPDATE_SNAPSHOTS;
    assert.equal(panel.snapshot(dir, 'panel').status, 'same');
  } finally {
    if (previous === undefined) delete process.env.UPDATE_SNAPSHOTS;
    else process.env.UPDATE_SNAPSHOTS = previous;
    await panel.unmount();
  }
});

test('a path that is not a bundle says what to pass instead of raising ENOENT', async () => {
  const { loadBundle } = await import('../lib/testkit/load.mjs');
  const missing = path.join(here, 'definitely-not-here', 'client.js');
  assert.throws(() => loadBundle(missing), /no such file: .*mount takes the client bundle/);
  assert.throws(() => loadBundle(here), /is a directory .*mount takes the client bundle inside it/);
});

test('expectAria names the attribute that differs, not just that one did', async () => {
  const { mountClient } = await import('../lib/testkit/index.mjs');
  const panel = await mountClient({ file: 'fixtures/client-bundle/client.js' });
  try {
    const live = panel.expectAria('[aria-live="polite"]', { live: 'polite', text: '0' });
    assert.equal(live.live, 'polite');
    assert.throws(
      () => panel.expectAria('[aria-live="polite"]', { text: '9' }),
      /expected aria text to be "9", but it is "0"/u,
    );
    // A missing attribute is reported as nothing, not as an empty string.
    assert.throws(
      () => panel.expectAria('[aria-live="polite"]', { selected: 'true' }),
      /expected aria selected to be "true", but it is nothing/u,
    );
  } finally {
    await panel.unmount();
  }
});

test('a bundle sees the real window, not a loader-shaped stand-in', async () => {
  const { mkdtemp, writeFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const dir = await mkdtemp(path.join(tmpdir(), 'tk-window-'));
  const file = path.join(dir, 'client.js');
  // A panel that reads the browser's own storage. Handing the bundle a stand-in
  // `window` that only carries `__ModuleLoader__` turns every one of these into
  // a silent `undefined`, which is exactly how a language choice fails to stick.
  await writeFile(file, `
window.__ModuleLoader__.load({
  id: 'reads-window',
  factory: () => ({
    name: 'reads-window',
    inject: [],
    apply(ctx) {
      window.localStorage.setItem('seen', String(typeof window.localStorage));
      ctx.slots.register({ name: 'sidebar.right.pane.tab', key: 'reads-window' }, () => null);
    },
  }),
});
`);

  const panel = await mountClient({ file });
  assert.equal(panel.window.localStorage.getItem('seen'), 'object');
  await panel.unmount();
});
