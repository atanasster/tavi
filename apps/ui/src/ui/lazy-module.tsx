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
  let loaded: ComponentType<P> | undefined;
  let pending: Promise<ComponentType<P>> | undefined;
  let failed = false;
  const ready = (): Promise<ComponentType<P>> => {
    pending ??= load().then(
      (component) => {
        loaded = component;
        return component;
      },
      (error: unknown) => {
        failed = true;
        throw error;
      },
    );
    return pending;
  };
  const retry = (): void => {
    if (!failed) return;
    failed = false;
    pending = undefined;
  };
  function Route(props: P) {
    const Part = loaded ?? use(ready());
    return <Part {...props} />;
  }
  return { Route, ready, retry };
}
