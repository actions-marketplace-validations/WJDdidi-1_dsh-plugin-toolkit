window.__ModuleLoader__.load({
  id: 'verify-client-apply-async',
  factory: () => ({
    inject: ['slots'],
    async apply(ctx) {
      // The full host has `slots`; the bare boot context verify hands the face
      // does not. Rejecting here is the shape that used to escape the probe.
      if (!ctx.slots) throw new Error('async client apply exploded');
      ctx.slots.register(
        { name: 'sidebar.right.pane.tab', key: 'verify-client-apply-async' },
        () => null,
      );
    },
  }),
});
