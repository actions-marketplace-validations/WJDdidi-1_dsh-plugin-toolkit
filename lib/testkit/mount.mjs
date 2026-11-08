/**
 * Mounting a panel the way the host does, then poking at it the way a user does.
 *
 * The helpers are deliberately blunt — click, type, press — because that is the
 * vocabulary a bug report uses. Anything cleverer hides which selector was hit.
 */
import { createDom, installGlobals, requireFrom } from './env.mjs';
import { createHost } from './host.mjs';
import { loadBundle } from './load.mjs';
import { expectSnapshot, write } from './snapshot.mjs';

function moduleShim(modules) {
  return (name) => {
    if (Object.prototype.hasOwnProperty.call(modules, name)) return modules[name];
    // An unknown host module should be obviously fake, not silently empty.
    return new Proxy(
      {},
      {
        get: (target, key) => {
          if (key === 'then') return undefined;
          if (key === Symbol.toPrimitive) return () => `[unknown module ${name}]`;
          return () => null;
        },
      },
    );
  };
}

export async function mountClient(options) {
  const {
    file,
    copy = {},
    surface = 'sidebar',
    slot = 'sidebar.right.pane.tab',
    props = {},
    fetch: fetchImpl,
    container = 'root',
  } = options;

  // React is resolved from the plugin's folder too: when the tool runs from
  // npx's cache, its own dependencies are not the ones the panel was written
  // against.
  const resolveFrom = options.resolveFrom ?? process.cwd();
  const need = (name) => requireFrom(name, resolveFrom);

  const { dom, window, document } = createDom({ resolveFrom });
  const restoreGlobals = installGlobals(window, document);

  const React = need('react');
  const reactDom = need('react-dom/client');
  const jsxRuntime = need('react/jsx-runtime');
  const jsxDevRuntime = (() => {
    try {
      return need('react/jsx-dev-runtime');
    } catch {
      return jsxRuntime;
    }
  })();

  const modules = {
    react: React.default ?? React,
    'react-dom': need('react-dom'),
    'react-dom/client': reactDom.default ?? reactDom,
    'react/jsx-runtime': jsxRuntime,
    'react/jsx-dev-runtime': jsxDevRuntime,
  };

  // A test that needs a host which fails on purpose passes its own: the default
  // host never throws, and "the service threw" is the failure mode that costs
  // the most to debug in the real app.
  const host = options.host ?? createHost({ locale: copy, fetch: fetchImpl, surface });
  // A caller that passes both a host and a fetch stub means the stub for this
  // mount: silently keeping the host's own fetch answers 404 to everything and
  // the test then blames the panel.
  if (options.host !== undefined && fetchImpl !== undefined) host.fetch = fetchImpl;
  // The panel calls the browser's fetch, not a service, so the stub has to be
  // the global one for the duration of the mount.
  const previousFetch = globalThis.fetch;
  globalThis.fetch = host.fetch;
  try {
    const exported = loadBundle(file, { require: moduleShim(modules), window });
    const apply = exported.apply ?? exported.default ?? exported.install ?? exported;
    if (typeof apply !== 'function') {
      throw new Error(`${file} exports no apply(ctx) function, so there is nothing to mount`);
    }
    await apply(host);
  } catch (error) {
    globalThis.fetch = previousFetch;
    restoreGlobals();
    throw error;
  }

  const registered = host.slot(slot);
  if (registered === null) {
    globalThis.fetch = previousFetch;
    restoreGlobals();
    throw new Error(`the bundle registered no "${slot}" slot; it registered: ${[...new Set(host.registrations.slots.map((entry) => entry.definition.name))].join(', ') || 'nothing'}`);
  }

  const root = document.getElementById(container);
  const clientRoot = (reactDom.default ?? reactDom).createRoot(root);
  const act = React.act ?? ((run) => run());

  await act(async () => {
    clientRoot.render(React.createElement(registered.component, props));
    // The first paint is followed by the panel's own fetches; letting them land
    // inside act keeps the "not wrapped in act" warnings from drowning the run.
    for (let tick = 0; tick < 3; tick += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  });

  const settle = async (run) => {
    await act(async () => {
      if (run !== undefined) await run();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  };

  const query = (selector) => root.querySelector(selector);
  const queryAll = (selector) => [...root.querySelectorAll(selector)];
  const must = (selector) => {
    const element = query(selector);
    if (element === null) throw new Error(`no element matched "${selector}" in:\n${root.innerHTML.slice(0, 600)}`);
    return element;
  };

  const helpers = {
    window,
    document,
    root,
    host,
    react: React,
    // textContent glues siblings together ("Demo panelCount 0"); a reader of the
    // screen does not, so leaves are joined with a space.
    text: () => {
      const leaves = [];
      const walk = (node) => {
        if (node.nodeType === 3) {
          const value = node.nodeValue.replace(/\s+/g, ' ').trim();
          if (value !== '') leaves.push(value);
          return;
        }
        if (node.nodeType !== 1) return;
        const tag = node.tagName.toLowerCase();
        if (tag === 'script' || tag === 'style') return;
        for (const child of node.childNodes) walk(child);
      };
      walk(root);
      return leaves.join(' ');
    },
    html: () => root.innerHTML,
    query,
    queryAll,
    must,
    click: async (selector) => {
      const element = must(selector);
      await settle(() => {
        element.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
      });
      return element;
    },
    press: async (selector, key, init = {}) => {
      const element = selector === null ? root : must(selector);
      await settle(() => {
        element.dispatchEvent(new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }));
      });
      return element;
    },
    type: async (selector, value) => {
      const element = must(selector);
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
        ?? Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
      await settle(() => {
        setter?.call(element, value);
        element.dispatchEvent(new window.Event('input', { bubbles: true }));
      });
      return element;
    },
    focus: (selector) => {
      const element = must(selector);
      element.focus();
      return element;
    },
    attributes: (selector) => {
      const element = must(selector);
      return Object.fromEntries([...element.attributes].map((attribute) => [attribute.name, attribute.value]));
    },
    // What a screen reader would report, in the same blunt vocabulary as the
    // rest: the attributes, not a re-implementation of the accessibility tree.
    aria: (selector) => {
      const element = must(selector);
      const read = (name) => element.getAttribute(name) ?? undefined;
      return {
        role: read('role'),
        label: read('aria-label'),
        labelledBy: read('aria-labelledby'),
        describedBy: read('aria-describedby'),
        live: read('aria-live'),
        selected: read('aria-selected'),
        expanded: read('aria-expanded'),
        checked: read('aria-checked'),
        pressed: read('aria-pressed'),
        disabled: read('aria-disabled') ?? (element.disabled === true ? 'true' : undefined),
        hidden: read('aria-hidden'),
        text: element.textContent.replace(/\s+/g, ' ').trim(),
      };
    },
    expectAria: (selector, expected) => {
      const actual = helpers.aria(selector);
      for (const [key, value] of Object.entries(expected)) {
        if (actual[key] === value) continue;
        const shown = actual[key] === undefined ? 'nothing' : `"${actual[key]}"`;
        throw new Error(`${selector}: expected aria ${key} to be "${value}", but it is ${shown}`);
      }
      return actual;
    },
    // Same contract as expectSnapshot: compare by default, write only when
    // UPDATE_SNAPSHOTS=1 asks for it.
    snapshot: (dir, name) => expectSnapshot(root.innerHTML, dir, name),
    writeSnapshot: (dir, name) => write(dir, name, root.innerHTML),
    unmount: async () => {
      await act(async () => {
        clientRoot.unmount();
        // React schedules follow-up work, and a polling panel schedules timers.
        // One macrotask lets that land while the DOM is still alive; closing the
        // window first turns it into "ReferenceError: window is not defined"
        // after the test has already passed.
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      globalThis.fetch = previousFetch;
      restoreGlobals();
      // A panel polls; jsdom's timers and rAF would keep the test process alive
      // for as long as the app runs. Closing the window cancels them.
      dom.window.close();
    },
  };

  return helpers;
}
