import { lazy, memo, Suspense, type ComponentType } from "react";

import type { MarkdownProps } from "./MarkdownBody.js";

/**
 * An answer's text as Markdown (`MarkdownBody.tsx` draws it).
 *
 * The renderer is its own chunk, fetched as this module loads rather than on
 * the first answer, so it is usually there before any text is; until it is,
 * the text shows as it is written, line breaks kept. Once it has arrived it
 * is drawn directly: `lazy` would suspend each new answer for a microtask,
 * an extra commit per answer the render budget counts.
 */
type Body = ComponentType<MarkdownProps>;
let loaded: Body | undefined;
/** The text as written: shown while the renderer loads, and in its place if it never does. */
function Plain({ text }: MarkdownProps) {
  return <div className="markdown markdown-pending">{text}</div>;
}

const load = import("./MarkdownBody.js")
  .then(
    (module): Body => module.default,
    (): Body => Plain,
  )
  .then((body) => {
    loaded = body;
    return { default: body };
  });
const LazyBody = lazy(() => load);

/** Settles once the renderer is in, for a measurement that must not count its arrival. */
export const markdownReady: Promise<void> = load.then(() => undefined);

export const Markdown = memo(function Markdown(props: MarkdownProps) {
  const Loaded = loaded;
  if (Loaded !== undefined) return <Loaded {...props} />;
  return (
    <Suspense fallback={<Plain {...props} />}>
      <LazyBody {...props} />
    </Suspense>
  );
});
