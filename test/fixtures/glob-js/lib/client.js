// `node --test` imports every .js file under test/, including fixtures. Guard the
// browser loader so importing this fixture is also harmless outside a window.
if (typeof window !== 'undefined') {
  window.__ModuleLoader__.load({
    id: 'glob-js',
    factory: () => ({
      apply() {},
    }),
  });
}
