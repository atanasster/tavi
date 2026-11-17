import { type ComponentType, use } from "react";

/**
 * A part of the page that is its own chunk, fetched the first time it is
 * drawn (never as this module loads, which would put it back on the canvas's
 * first load) and drawn directly from then on. Until it arrives it suspends to
 * the nearest `Suspense`. A fetch that fails stays failed, so every render
 * throws it to the nearest error boundary instead of fetching again on each
 * re-render; `retry` (the boundary's "Try again", or moving elsewhere)
 * forgets it, and the next render fetches the chunk again. `ready` fetches it
 * now, for a test that renders it synchronously.
 */
export function lazyModule<P extends object>(load: () => Promise<ComponentType<P>>) {
  // The fetch, tagged with how it settled the way React reads a thenable, so
  // `use` returns a loaded chunk in the same pass instead of suspending again.
  // `Route` calls `use` on every render: one that suspended and then skipped
  // `use` once the chunk arrived would break React's rule for `use`.
  type Fetch = Promise<ComponentType<P>> & { status?: string; value?: unknown; reason?: unknown };
  let pending: Fetch | undefined;
  let failed = false;
  const ready = (): Promise<ComponentType<P>> => {
    if (pending === undefined) {
      const fetching: Fetch = load().then(
        (component) => {
          Object.assign(fetching, { status: "fulfilled", value: component });
          return component;
        },
        (error: unknown) => {
          failed = true;
          Object.assign(fetching, { status: "rejected", reason: error });
          throw error;
        },
      );
      pending = fetching;
    }
    return pending;
  };
  const retry = (): void => {
    if (!failed) return;
    failed = false;
    pending = undefined;
  };
  function Route(props: P) {
    const Part = use(ready());
    return <Part {...props} />;
  }
  return { Route, ready, retry };
}
