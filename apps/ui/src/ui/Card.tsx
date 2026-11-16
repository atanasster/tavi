import type { ReactNode } from "react";

/**
 * A section card: its title in a head, with the card's own actions beside it,
 * over its body. With `titleId` the card is named by its title. `as="div"` is
 * a card that is no landmark of its own; `bare` puts the children straight
 * under the head (a list that is the whole card).
 */
export function Card({
  title,
  titleId,
  level = 3,
  as = "section",
  actions,
  badge,
  bare = false,
  className = "",
  children,
}: {
  readonly title: ReactNode;
  readonly titleId?: string;
  readonly level?: 2 | 3;
  readonly as?: "section" | "div";
  /** The card's own buttons, at the end of its head. */
  readonly actions?: ReactNode;
  /** A mark beside the title (a count, a warning). */
  readonly badge?: ReactNode;
  readonly bare?: boolean;
  readonly className?: string;
  readonly children: ReactNode;
}) {
  const Root = as;
  const Head = as === "section" ? "header" : "div";
  const Heading = level === 2 ? "h2" : "h3";
  return (
    <Root className={`section-card ${className}`.trim()} aria-labelledby={titleId}>
      <Head className="section-card-head">
        <Heading id={titleId}>{title}</Heading>
        {badge}
        {actions === undefined ? null : <div className="section-card-actions">{actions}</div>}
      </Head>
      {bare ? children : <div className="section-card-body">{children}</div>}
    </Root>
  );
}
