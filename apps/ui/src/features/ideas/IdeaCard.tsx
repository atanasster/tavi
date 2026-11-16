import { BUILTIN_IDEAS_PROVIDER_ID, IDEA_CAPABILITY_LABELS, type Idea, type IdeaBasis, type IdeaCategory } from "@tavi/contracts";
import type { ReactNode } from "react";

import { Icon, type IconName } from "../../ui/Icon.js";
import { Button } from "../../ui/Button.js";

/**
 * One idea: its section's icon, the offer and its
 * pitch, *Why this* — each source a link to where the person said it — the
 * capabilities it would use and whether it asks first, and *Try it*, which
 * only fills a new chat's composer. The idea's own emoji is not drawn: the
 * canvas draws its icons (docs/brand.md).
 */

const CATEGORY_ICONS: Readonly<Record<IdeaCategory, IconName>> = {
  productivity: "list-checks",
  work: "briefcase",
  learning: "book-open",
  "health-home": "house",
  travel: "plane",
  shopping: "shopping-bag",
  people: "users",
};

/** Where a source leads: a chat opens it, a memory record opens Soul & memory; the brief and a general idea lead nowhere. */
export interface IdeaLinks {
  readonly onOpenTask?: ((taskId: string) => void) | undefined;
  readonly onOpenMemory?: (() => void) | undefined;
}

/** A source's words, quoted; a source whose words were dropped (its record rewritten, a pin kept) is named without them. */
function quoted(lead: string, bare: string, excerpt: string | undefined): string {
  return excerpt === undefined || excerpt.trim() === "" ? bare : `${lead} “${excerpt}”`;
}

function Why({
  basis,
  links,
  providerId,
}: {
  readonly basis: IdeaBasis;
  readonly links: IdeaLinks;
  readonly providerId: string;
}): ReactNode {
  switch (basis.kind) {
    case "memory": {
      const text = quoted("you said", "something you told me", basis.excerpt);
      return links.onOpenMemory === undefined ? (
        <span>{text}</span>
      ) : (
        <Button variant="link" onClick={links.onOpenMemory}>
          {text}
        </Button>
      );
    }
    case "task": {
      const text = quoted("chat", "one of your chats", basis.excerpt);
      return links.onOpenTask === undefined ? (
        <span>{text}</span>
      ) : (
        <Button variant="link" onClick={() => links.onOpenTask?.(basis.ref)}>
          {text}
        </Button>
      );
    }
    case "brief":
      return <span>{quoted("your brief:", "your brief", basis.excerpt)}</span>;
    default:
      // Nothing personal: the built-in catalogue's ideas are common asks; a plugin's are its own suggestion.
      return <span>{providerId === BUILTIN_IDEAS_PROVIDER_ID ? "something many people ask for" : `suggested by ${providerId}`}</span>;
  }
}

export function IdeaCard({
  idea,
  links,
  onTry,
  trying = false,
  menu,
}: {
  readonly idea: Idea;
  readonly links: IdeaLinks;
  readonly onTry: (idea: Idea) => void;
  readonly trying?: boolean;
  readonly menu?: ReactNode;
}) {
  const asks = idea.uses.some((use) => use.approval);
  const titleId = `idea-${idea.id}-title`;
  return (
    <article className="card idea-card" aria-labelledby={titleId}>
      <div className="idea-card-head">
        <span className="idea-icon">
          <Icon name={CATEGORY_ICONS[idea.category]} />
        </span>
        <h3 id={titleId}>{idea.title}</h3>
        {idea.pinned ? <span className="badge">Pinned</span> : null}
        {menu}
      </div>
      <p className="idea-pitch">{idea.pitch}</p>
      <p className="idea-meta">
        <strong>Why this:</strong>{" "}
        {idea.basis.map((basis, index) => (
          <span key={`${basis.kind}:${basis.ref}`}>
            {index === 0 ? null : " · "}
            <Why basis={basis} links={links} providerId={idea.providerId} />
          </span>
        ))}
      </p>
      <p className="idea-meta">
        <strong>Uses:</strong> {idea.uses.map((use) => IDEA_CAPABILITY_LABELS[use.capability]).join(" · ")}
        {asks ? " — asks before acting" : ""}
      </p>
      {idea.prepared === undefined ? null : (
        <p className="idea-meta">
          <strong>Ready:</strong> I looked already; Try it starts from what I found.
        </p>
      )}
      <div className="idea-actions">
        <Button size="sm" disabled={trying} onClick={() => onTry(idea)} aria-describedby={titleId}>
          Try it
        </Button>
      </div>
    </article>
  );
}
