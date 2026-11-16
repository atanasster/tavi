// Every hook event a plugin can declare: the counts land in its state store.
const counts = { "prompt.submit": 0, "turn.start": 0, "model.step": 0, "tool.check": 0, "tool.call": 0, "tool.result": 0, "turn.complete": 0 };

export function register({ hooks, state, ui }) {
  const seen = (event) => {
    counts[event] += 1;
    return state.put("counts", counts);
  };
  hooks.on("tool.check", async (e, next) => {
    await seen("tool.check");
    const verdict = await next(e);
    const steps = (e.input?.items ?? []).map((item) => item.content).join(" ");
    return /delete/i.test(steps) ? { decision: "deny", reason: "A plan may not say delete." } : verdict;
  });
  hooks.on("prompt.submit", async (e, next) => {
    await seen("prompt.submit");
    const answer = await next(e);
    return { context: [...(answer.context ?? []), "the fixture saw this prompt"] };
  });
  hooks.on("tool.call", async (e, next) => { await seen("tool.call"); return next(e); });
  hooks.on("tool.result", async (e, next) => { await seen("tool.result"); return next(e); });
  hooks.on("turn.start", async (e, next) => {
    await seen("turn.start");
    await state.put("attended", e.envelope.attended);
    return next(e);
  });
  hooks.on("model.step", async (e, next) => { await seen("model.step"); return next(e); });
  hooks.on("turn.complete", async (e, next) => {
    await seen("turn.complete");
    ui.status(e.envelope, `turns: ${counts["turn.complete"]}`);
    ui.notice(e.envelope, "the turn is done");
    // An envelope it was never handed is refused.
    try {
      ui.status({ ...e.envelope }, "forged");
      await state.put("forged", "shown");
    } catch {
      await state.put("forged", "refused");
    }
    const ended = await next(e);
    return { ...ended, suggestions: ["Run the tests"] };
  });
}
