import type { ReactNode } from "react";

import { isPlainClick } from "./route.js";

/**
 * A link to a page of this app: a real address, followed in place by
 * `onFollow`. A modified click, or a page with nowhere to go (no `onFollow`),
 * opens the address as the browser would.
 */
export function AppLink({
  href,
  onFollow,
  className,
  children,
}: {
  readonly href: string;
  readonly onFollow: (() => void) | undefined;
  readonly className?: string | undefined;
  readonly children: ReactNode;
}) {
  return (
    <a
      className={className}
      href={href}
      onClick={(event) => {
        if (onFollow === undefined || !isPlainClick(event)) return;
        event.preventDefault();
        onFollow();
      }}
    >
      {children}
    </a>
  );
}
