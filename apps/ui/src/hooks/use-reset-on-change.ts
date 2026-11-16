import { useState } from "react";

/**
 * Runs `reset` while rendering, when any of `deps` differs (`Object.is`) from
 * the last render's — React's "adjusting state when a prop changes". An effect
 * doing the same commits the stale state first and then renders again; this
 * renders once. Unlike an effect, nothing runs on mount: the state starts as it should.
 * `reset` may only set this component's own state.
 */
export function useResetOnChange(deps: readonly unknown[], reset: () => void): void {
  const [seen, setSeen] = useState(deps);
  if (deps.length !== seen.length || deps.some((dep, at) => !Object.is(dep, seen[at]))) {
    setSeen(deps);
    reset();
  }
}
