import { IDEA_CATEGORY_LABELS, type Idea, type IdeaRun, type IdeasListAnswer, type IdeasRecurAnswer } from "@tavi/contracts";
import { useCallback, useEffect, useId, useRef, useState } from "react";

import { useT } from "../../lib/i18n.js";
import { whenLocal } from "../../lib/time.js";
import { Icon } from "../../ui/Icon.js";
import { Failure, Notice, Pending, StatusNote } from "../../ui/Parts.js";
import { BriefField } from "./BriefField.js";
import { IdeaCard, type IdeaLinks } from "./IdeaCard.js";
import { RecurIdea, RemindIdea } from "./IdeaForms.js";
import { IDEA_TOGGLE_ATTRIBUTE, IdeaMenu } from "./IdeaMenu.js";
import {
  IDEAS_SECTION_SHOWN,
  getBrief,
  ideasLayout,
  lastLooked,
  listIdeas,
  refreshIdeas,
  runNote,
  setBrief,
  tryIdea,
} from "./ideas-api.js";
import { Button } from "../../ui/Button.js";
import { useTimeZone, useWorkspace } from "../shell/Workspace.js";

/**
 * The Ideas tab: "For you" — the best four —
 * then each section's own, three at a time with *More*, and the footer with
 * when ideas were last and will next be looked for. *Refresh* asks the owner
 * for new ones; *Tune* edits the brief they are written from. *Try it* opens a
 * new chat with the idea's prompt in the composer, and sends nothing; each
 * card's ⋯ menu steers what comes next.
 */

/**
 * After a refresh starts, the list is read again this often until the look
 * is over — a run takes seconds, sometimes a minute — and for no longer than
 * `WATCH_FOR_MS`, after which the page stops asking and says so.
 */
const REREAD_EVERY_MS = 3_000;
const WATCH_FOR_MS = 120_000;

/**
 * Whether `run` is a look that ended since `before` was the last one: a new
 * run, or the one under way then, now finished. A refresh the owner queued
 * behind a look under way is its own run, started once that one ends: only a
 * refresh run other than `before` is it, so the look it waited for is not
 * reported as its answer.
 */
function endedSince(run: IdeaRun | undefined, before: IdeaRun | undefined, queued: boolean): run is IdeaRun {
  if (run === undefined || run.outcome === "running") return false;
  if (queued) return run.trigger === "refresh" && run.id !== before?.id;
  return before === undefined || run.id !== before.id || before.outcome === "running";
}

/** The dialog an idea's ⋯ opened; it holds the idea itself, so a list read that drops the card leaves it open. */
type IdeaForm =
  | { readonly kind: "recur"; readonly idea: Idea; readonly draft: IdeasRecurAnswer["draft"] }
  | { readonly kind: "remind"; readonly idea: Idea };

export interface IdeasPageProps extends IdeaLinks {
  /** A new chat with `prompt` in its composer, not sent; the chat its first message starts is linked to `ideaId`. */
  readonly onTry: (prompt: string, ideaId: string) => void;
  /** Settings → Models, when no fast model is set. */
  readonly onModels?: (() => void) | undefined;
  /** Settings → Ideas, where Ideas that are off are turned on. */
  readonly onSettings?: (() => void) | undefined;
}

export function IdeasPage({ onTry, onModels, onSettings, onOpenTask, onOpenMemory }: IdeasPageProps) {
  const t = useT();
  const { client, workspaceId } = useWorkspace();
  const timeZone = useTimeZone();
  const [answer, setAnswer] = useState<IdeasListAnswer>();
  const [failure, setFailure] = useState<string>();
  const [note, setNote] = useState<string>();
  /** The idea whose *Try it* is on its way: one at a time, so two cards are not both marked tried and two chats opened. */
  const [trying, setTrying] = useState<string>();
  const tryingNow = useRef(false);
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const [tuning, setTuning] = useState(false);
  /** *Tune*'s toggle: closing the panel from inside gives focus back to it, not to the page's body. */
  const tuneToggle = useRef<HTMLButtonElement>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [form, setForm] = useState<IdeaForm>();
  /** Where focus goes once the page has drawn what an action changed: the idea's ⋯, or the heading when the card left. */
  const [focusTo, setFocusTo] = useState<{ readonly ideaId: string }>();
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  /** Which refresh's watch is current: a later refresh, or leaving the page, ends an earlier one mid-read. */
  const watching = useRef(0);
  /** The newest list read: an older answer that lands after it is dropped, so the page never steps back. */
  const generation = useRef(0);
  /** Whether the page is still shown: an answer that lands after it went starts no watch and opens no chat. */
  const mounted = useRef(true);
  const heading = useRef<HTMLHeadingElement>(null);
  const page = useRef<HTMLDivElement>(null);
  const ids = useId();
  /** Reads the list; the answer, when it is the newest read's and the owner gave one. */
  const load = useCallback(async (): Promise<IdeasListAnswer | undefined> => {
    const mine = ++generation.current;
    const outcome = await listIdeas(client, workspaceId);
    if (mine !== generation.current) return undefined;
    if (!outcome.ok) {
      setFailure(outcome.message);
      return undefined;
    }
    setAnswer(outcome.value);
    setFailure(undefined);
    return outcome.value;
  }, [client, workspaceId]);
  useEffect(() => {
    void load();
  }, [load]);
  // Leaving the page ends any watch: the timers pending now, and a read in flight that would set another.
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      watching.current += 1;
      generation.current += 1;
      timers.current.forEach(clearTimeout);
      timers.current = [];
    };
  }, []);
  useEffect(() => {
    if (focusTo === undefined) return;
    const toggle = [...(page.current?.querySelectorAll<HTMLElement>(`[${IDEA_TOGGLE_ATTRIBUTE}]`) ?? [])].find(
      (element) => element.getAttribute(IDEA_TOGGLE_ATTRIBUTE) === focusTo.ideaId,
    );
    (toggle ?? heading.current)?.focus();
    setFocusTo(undefined);
  }, [focusTo]);
  /** Reads the list every few seconds until a look that ended since `before` shows — the queued refresh's own, when it was queued — then says what it found. */
  const watch = (before: IdeaRun | undefined, queued: boolean): void => {
    timers.current.forEach(clearTimeout);
    const mine = ++watching.current;
    const deadline = Date.now() + WATCH_FOR_MS;
    const tick = async (): Promise<void> => {
      const read = await load();
      if (mine !== watching.current) return;
      if (endedSince(read?.lastRun, before, queued)) {
        setNote(runNote(read.lastRun));
        return;
      }
      if (Date.now() + REREAD_EVERY_MS > deadline) {
        setNote(t("ideas.page.stillLooking"));
        return;
      }
      timers.current = [setTimeout(() => void tick(), REREAD_EVERY_MS)];
    };
    timers.current = [setTimeout(() => void tick(), REREAD_EVERY_MS)];
  };
  // Each refresh counts against the hour's three: one at a time, so a double click is not two.
  const refresh = async (): Promise<void> => {
    setNote(undefined);
    setRefreshing(true);
    const before = answer?.lastRun;
    const outcome = await refreshIdeas(client, workspaceId);
    // Left meanwhile: nothing is said, and no watch starts that the page's going could no longer end.
    if (!mounted.current) return;
    setRefreshing(false);
    if (!outcome.ok) {
      setNote(outcome.message);
      return;
    }
    const { status } = outcome.value;
    setNote(status === "busy" ? t("ideas.page.busy") : status === "queued" ? t("ideas.page.queued") : t("ideas.page.looking"));
    watch(before, status === "queued");
  };
  const tryIt = async (idea: Idea): Promise<void> => {
    if (tryingNow.current) return;
    tryingNow.current = true;
    setTrying(idea.id);
    const outcome = await tryIdea(client, workspaceId, idea.id);
    tryingNow.current = false;
    // Left meanwhile: the person is elsewhere now, and a chat opened under them would take them away from it.
    if (!mounted.current) return;
    setTrying(undefined);
    if (outcome.ok) onTry(outcome.value.prompt, idea.id);
    else setNote(outcome.message);
  };
  const links: IdeaLinks = { onOpenTask, onOpenMemory };
  /** Said, and the list read again — what it hid goes, and the cap may bring another in — then focus back where the person was. */
  const settle = (ideaId: string, result: { readonly ok: boolean; readonly note: string }): void => {
    setNote(result.note);
    if (!result.ok) {
      setFocusTo({ ideaId });
      return;
    }
    void load().then(() => setFocusTo({ ideaId }));
  };
  const menu = (idea: Idea) => (
    <IdeaMenu
      idea={idea}
      onDone={(result) => settle(idea.id, result)}
      onRecur={(draft) => setForm({ kind: "recur", idea, draft })}
      onRemind={() => setForm({ kind: "remind", idea })}
    />
  );
  const card = (idea: Idea) => (
    <IdeaCard
      key={idea.id}
      idea={idea}
      links={links}
      onTry={(chosen) => void tryIt(chosen)}
      trying={trying !== undefined}
      menu={menu(idea)}
    />
  );
  const closeForm = (): void => {
    if (form !== undefined) setFocusTo({ ideaId: form.idea.id });
    setForm(undefined);
  };
  const formDone = (note: string): void => {
    if (form === undefined) return;
    setForm(undefined);
    settle(form.idea.id, { ok: true, note });
  };
  const off = answer?.enabled === false;
  /** Closes *Tune* from its Save or Cancel, whose button goes with it: focus returns to the toggle that opened it. */
  const closeTune = (): void => {
    setTuning(false);
    tuneToggle.current?.focus();
  };
  const layout = answer === undefined || off ? undefined : ideasLayout(answer.ideas);
  const empty = layout !== undefined && layout.forYou.length === 0;
  return (
    <div className="ideas-page" ref={page}>
      <header className="ideas-head">
        <div className="ideas-title">
          <h1 ref={heading} tabIndex={-1}>
            <Icon name="lightbulb" /> {t("ideas.page.title")}
          </h1>
          <p className="meta-sm">{t("ideas.page.description")}</p>
        </div>
        <div className="ideas-head-actions">
          <Button variant="ghost" size="sm" disabled={refreshing || off} onClick={() => void refresh()}>
            <Icon name="refresh" size="sm" /> {t("ideas.page.refresh")}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            ref={tuneToggle}
            aria-expanded={tuning}
            aria-controls={tuning ? `${ids}-tune` : undefined}
            onClick={() => setTuning((now) => !now)}
          >
            <Icon name="sliders" size="sm" /> {t("ideas.page.tune")}
          </Button>
        </div>
      </header>
      {tuning ? (
        <Tune
          id={`${ids}-tune`}
          onCancel={closeTune}
          onSaved={() => {
            closeTune();
            // The list says whether Ideas are on, not whether they may read the brief: Settings → Ideas says that.
            setNote(off ? t("ideas.brief.savedOff") : t("ideas.brief.saved"));
            // A rewritten brief ends the ideas that quoted it and drops its words from pinned ones: shown as they are now.
            void load();
          }}
        />
      ) : null}
      <StatusNote note={note} />
      {off ? (
        <Notice as="div" className="ideas-off">
          <p>{t("ideas.page.off")}</p>
          {onSettings === undefined ? null : (
            <Button size="sm" onClick={onSettings}>
              {t("ideas.page.openSettings")}
            </Button>
          )}
        </Notice>
      ) : null}
      {answer?.modelSet === false && !off ? (
        <Notice className="ideas-model">
          {t("ideas.page.noModel")}{" "}
          {onModels === undefined ? null : (
            <Button variant="link" onClick={onModels}>
              {t("ideas.page.setModel")}
            </Button>
          )}
        </Notice>
      ) : null}
      <Failure message={failure} />
      {failure !== undefined && answer === undefined ? (
        <Button size="sm" onClick={() => void load()}>
          {t("ui.boundary.tryAgain")}
        </Button>
      ) : null}
      {answer === undefined && failure === undefined ? <Pending label={t("ideas.page.loading")} className="notice meta-sm" status /> : null}
      {empty ? (
        <div className="ideas-empty">
          <p>{t("ideas.page.empty")}</p>
          <p className="meta-sm">{t("ideas.page.emptyHint")}</p>
        </div>
      ) : null}
      {layout !== undefined && !empty ? (
        <>
          <section className="ideas-section" aria-labelledby={`${ids}-for-you`}>
            <h2 id={`${ids}-for-you`}>{t("ideas.page.forYou")}</h2>
            <div className="ideas-grid">{layout.forYou.map(card)}</div>
          </section>
          {layout.sections.map(({ category, ideas }) => {
            const expanded = open.has(category);
            const shown = expanded ? ideas : ideas.slice(0, IDEAS_SECTION_SHOWN);
            return (
              <section key={category} className="ideas-section" aria-labelledby={`${ids}-${category}`}>
                <h2 id={`${ids}-${category}`}>{IDEA_CATEGORY_LABELS[category]}</h2>
                <div className="ideas-grid">{shown.map(card)}</div>
                {ideas.length > IDEAS_SECTION_SHOWN ? (
                  <Button
                    variant="link"
                    className="ideas-more"
                    aria-expanded={expanded}
                    onClick={() =>
                      setOpen((now) => {
                        const next = new Set(now);
                        if (expanded) next.delete(category);
                        else next.add(category);
                        return next;
                      })
                    }
                  >
                    {expanded ? t("ideas.page.less") : t("ideas.page.moreCount", { count: ideas.length - IDEAS_SECTION_SHOWN })}
                  </Button>
                ) : null}
              </section>
            );
          })}
        </>
      ) : null}
      {answer === undefined ? null : (
        <footer className="ideas-foot meta-sm">
          {empty || off ? null : <p>{t("ideas.page.allForNow")}</p>}
          <p>
            {lastLooked(answer.lastRun, timeZone)}
            {answer.nextAt === undefined ? "" : ` ${t("ideas.page.next", { when: whenLocal(answer.nextAt, timeZone) })}`}
          </p>
        </footer>
      )}
      {form?.kind === "recur" ? (
        <RecurIdea key={form.idea.id} idea={form.idea} draft={form.draft} onClose={closeForm} onDone={formDone} />
      ) : null}
      {form?.kind === "remind" ? <RemindIdea key={form.idea.id} idea={form.idea} onClose={closeForm} onDone={formDone} /> : null}
    </div>
  );
}

/** *Tune*: the brief ideas are written from — what to favour or avoid, in the person's words. */
function Tune({ id, onSaved, onCancel }: { readonly id: string; readonly onSaved: () => void; readonly onCancel: () => void }) {
  const t = useT();
  const { client, workspaceId } = useWorkspace();
  const [text, setText] = useState<string>();
  const [failure, setFailure] = useState<string>();
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let current = true;
    void getBrief(client, workspaceId).then((outcome) => {
      if (!current) return;
      if (outcome.ok) setText(outcome.value.text);
      else setFailure(outcome.message);
    });
    return () => {
      current = false;
    };
  }, [client, workspaceId]);
  return (
    <section id={id} className="section-card ideas-tune" aria-label={t("ideas.tune.label")}>
      <BriefField id={`${id}-brief`} value={text} onChange={setText} />
      <div className="idea-actions">
        <Button
          variant="primary"
          size="sm"
          disabled={busy || text === undefined}
          onClick={() => {
            setBusy(true);
            void setBrief(client, workspaceId, text ?? "").then((outcome) => {
              setBusy(false);
              if (outcome.ok) onSaved();
              else setFailure(outcome.message);
            });
          }}
        >
          {t("ideas.tune.save")}
        </Button>
        <Button variant="ghost" size="sm" disabled={busy} onClick={onCancel}>
          {t("ui.confirm.cancel")}
        </Button>
      </div>
      <Failure message={failure} />
    </section>
  );
}
