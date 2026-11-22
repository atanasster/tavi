import { ideaCategoryLabel, type Idea, type IdeasRecurAnswer } from "@tavi/contracts";
import { useId, useRef, useState } from "react";

import { useDismiss } from "../../hooks/use-dismiss.js";
import { translateCore, useT } from "../../lib/i18n.js";
import { Icon } from "../../ui/Icon.js";
import { ideaFeedback, pinIdea, recurIdea } from "./ideas-api.js";
import { Button } from "../../ui/Button.js";
import { useWorkspace } from "../shell/Workspace.js";

/**
 * A card's ⋯ menu: Pin, *Make it
 * recurring* (a repeating idea) and *Remind me*, each through its form, More like this, Not
 * now, Not interested, Not interested in its section, and *Don't use this* for
 * each source it rests on. Each is one signal to the owner, which the next run
 * honours; every one is undone in Settings → Ideas. A disclosure, not an ARIA
 * menu: a list of buttons that Escape or a click elsewhere closes.
 *
 * The forms *Make it recurring* and *Remind me* open are the page's, not the
 * menu's: the list is read again while one is open, and a card that moves or
 * leaves would otherwise take a half-filled dialog with it.
 */

/** What an action did, in words for the page's note. */
export interface IdeaMenuResult {
  readonly ok: boolean;
  readonly note: string;
}

/** The toggle's mark (`data-idea-toggle`), by which the page finds a card's ⋯ again to give it focus back. */
export const IDEA_TOGGLE_ATTRIBUTE = "data-idea-toggle";

export function IdeaMenu({
  idea,
  onDone,
  onRecur,
  onRemind,
}: {
  readonly idea: Idea;
  readonly onDone: (result: IdeaMenuResult) => void;
  /** Open *Make it recurring* with the routine the owner drafted. */
  readonly onRecur: (draft: IdeasRecurAnswer["draft"]) => void;
  /** Open *Remind me*. */
  readonly onRemind: () => void;
}) {
  const t = useT();
  const { client, workspaceId } = useWorkspace();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const ids = useId();
  const toggle = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  useDismiss(
    open,
    (by) => {
      setOpen(false);
      if (by === "escape") toggle.current?.focus();
    },
    { inside: [panel, toggle] },
  );
  const section = ideaCategoryLabel(idea.category, translateCore);
  const act = async (work: () => ReturnType<typeof ideaFeedback>, note: string): Promise<void> => {
    setBusy(true);
    const outcome = await work();
    setBusy(false);
    setOpen(false);
    onDone(outcome.ok ? { ok: true, note } : { ok: false, note: outcome.message });
  };
  const signal = (fields: Parameters<typeof ideaFeedback>[2], note: string) => () =>
    void act(() => ideaFeedback(client, workspaceId, fields), note);
  const sources = idea.basis.filter((basis) => basis.kind !== "general");
  return (
    // Tab out of the toggle and its panel closes it, as a press outside does.
    <span
      className="idea-menu"
      onBlur={(event) => {
        if (open && event.relatedTarget !== null && !event.currentTarget.contains(event.relatedTarget)) setOpen(false);
      }}
    >
      <Button
        variant="ghost"
        size="sm"
        ref={toggle}
        aria-label={t("ideas.menu.more", { title: idea.title })}
        data-idea-toggle={idea.id}
        aria-expanded={open}
        aria-controls={open ? `${ids}-menu` : undefined}
        onClick={() => setOpen((now) => !now)}
      >
        <Icon name="ellipsis" size="sm" />
      </Button>
      {open ? (
        <div ref={panel} id={`${ids}-menu`} className="idea-menu-panel surface-popover">
          <Button
            variant="bare"
            className="row-menu-item"
            disabled={busy}
            onClick={() =>
              void act(
                () => pinIdea(client, workspaceId, idea.id, !idea.pinned),
                idea.pinned ? t("ideas.menu.unpinned") : t("ideas.menu.pinned"),
              )
            }
          >
            {idea.pinned ? t("ideas.menu.unpin") : t("ideas.menu.pin")}
          </Button>
          {/* Routines repeat daily or weekly: a monthly idea is not offered as one. */}
          {idea.recurring === undefined || idea.recurring.cadence === "monthly" ? null : (
            <Button
              variant="bare"
              className="row-menu-item"
              disabled={busy}
              onClick={() =>
                void (async () => {
                  setBusy(true);
                  const drafted = await recurIdea(client, workspaceId, idea.id);
                  setBusy(false);
                  setOpen(false);
                  if (drafted.ok) onRecur(drafted.value.draft);
                  else onDone({ ok: false, note: drafted.message });
                })()
              }
            >
              {t("ideas.menu.recur")}
            </Button>
          )}
          <Button
            variant="bare"
            className="row-menu-item"
            disabled={busy}
            onClick={() => {
              setOpen(false);
              onRemind();
            }}
          >
            {t("ideas.menu.remind")}
          </Button>
          <Button
            variant="bare"
            className="row-menu-item"
            disabled={busy}
            onClick={signal({ signal: "more-like-this", id: idea.id }, t("ideas.menu.moreLikeThisDone", { section }))}
          >
            {t("ideas.menu.moreLikeThis")}
          </Button>
          <Button
            variant="bare"
            className="row-menu-item"
            disabled={busy}
            onClick={signal({ signal: "not-now", id: idea.id }, t("ideas.menu.notNowDone"))}
          >
            {t("ideas.menu.notNow")}
          </Button>
          <Button
            variant="bare"
            className="row-menu-item"
            disabled={busy}
            onClick={signal({ signal: "not-interested", id: idea.id }, t("ideas.menu.notInterestedDone"))}
          >
            {t("ideas.menu.notInterested")}
          </Button>
          <Button
            variant="bare"
            className="row-menu-item"
            disabled={busy}
            onClick={signal({ signal: "mute-category", id: idea.id }, t("ideas.menu.muteDone", { section }))}
          >
            {t("ideas.menu.mute", { section })}
          </Button>
          {sources.map((basis) => (
            <Button
              variant="bare"
              className="row-menu-item"
              key={`${basis.kind}:${basis.ref}`}
              disabled={busy}
              onClick={signal({ signal: "exclude-basis", id: idea.id, basisRef: basis.ref }, t("ideas.menu.excludeDone"))}
            >
              {basis.kind === "brief"
                ? t("ideas.menu.excludeBrief")
                : basis.excerpt === undefined || basis.excerpt.trim() === ""
                  ? basis.kind === "task"
                    ? t("ideas.menu.excludeChat")
                    : t("ideas.menu.excludeThat")
                  : t("ideas.menu.excludeQuote", { excerpt: basis.excerpt })}
            </Button>
          ))}
        </div>
      ) : null}
    </span>
  );
}
