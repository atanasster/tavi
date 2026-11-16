// docs/MODS.md, Example 4: the guide's code, installed and driven by apps/cli/test/plugins/example-mods.test.ts.
export default {
  register({ hooks, ui }) {
    hooks.on("turn.complete", async (e, next) => {
      const cached = (e.usage?.inputCacheReadTokens ?? 0) + (e.usage?.inputCacheWriteTokens ?? 0);
      // The envelope says which task's status row this is: only one the hook was handed.
      if (cached === 0) ui.status(e.envelope);
      else {
        const until = new Date(Date.now() + 5 * 60_000).toTimeString().slice(0, 5);
        ui.status(e.envelope, `cache warm until ${until}`);
      }
      return next(e);
    });
  },
};
