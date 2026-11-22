import { createContext, memo, useContext, type ReactNode } from "react";

import type { AttemptBoundary, ToolCard } from "@tavi/client/browser";
import {
  PLAN_TOOL_ID,
  SESSIONS_SEARCH_TOOL_ID,
  TOOL_HEADLINE_FIELDS,
  TOOL_HEADLINE_MAX_CHARS,
  maskedSecretsNote,
  pastChatSearchCitations,
  pastChatSearchSummary,
  toolCallHeadline,
  toolFamily,
} from "@tavi/contracts";
import { clip } from "@tavi/contracts/util";

import { AppLink } from "../shell/AppLink.js";
import { ConnectCard, connectAskOf, type ConnectAsk } from "../apps/ConnectCard.js";
import { FillReview, PdfPage, pdfPagesOf } from "./FillReview.js";
import { VideoFrames } from "./VideoFrames.js";
import { formatDuration } from "../../lib/time.js";
import { taskPath } from "../shell/route.js";
import { ErrorBoundary } from "../../ui/ViewBoundary.js";
import { Failure } from "../../ui/Parts.js";
import { render } from "./Receipts.js";
import { translateNow, useT } from "../../lib/i18n.js";
import type { UiKey } from "../../locales/en.js";
import { saidRecord } from "../shell/said.js";

/**
 * What counts a render of each entry, when something installs one — the
 * per-entry counter the render budget test asserts with.
 *
 * It has to live inside the memoized components: a `MutationObserver` cannot
 * see a wasted render, because React writes no DOM mutation when a
 * re-rendered subtree produces identical output, and a counter *around* a
 * memoized component counts its parent rather than itself. A page installs
 * nothing and pays one `undefined` check per render.
 */
export let countRender: ((key: string) => void) | undefined;

/** Install (or, with `undefined`, remove) the per-entry render counter. */
export function instrumentRenders(count: ((key: string) => void) | undefined): void {
  countRender = count;
}

/** A failover's line, the same inside a block or on its own. */
export function failoverText(boundary: AttemptBoundary): string {
  return translateNow("transcript.tool.retriedOn", { reason: boundary.reason });
}

/** What one tool family adds to the generic card. */
export interface ToolRenderer {
  /**
   * What the call is called on its line, in place of its tool id, when the
   * family can say what it did in words. Nothing keeps the id.
   */
  label?: (card: ToolCard) => string | undefined;
  /**
   * A short line for the collapsed summary — the thing a reader scans for,
   * such as the path a file tool touched. Nothing when the family has no
   * better answer than its name.
   */
  headline?: (card: ToolCard) => string | undefined;
  /** The expanded body, when the family has a better shape for it than raw JSON. */
  body?: (card: ToolCard) => ReactNode;
}

/**
 * A renderer per family, keyed by the part of a tool id before the first dot.
 * Adding a family is adding an entry here, not a case in a component.
 *
 * The families and the input fields their headline reads are the contracts'
 * `TOOL_HEADLINE_FIELDS` (`packages/contracts/src/tool-headline.ts`), which
 * the approvals inbox shares, so a call reads the same on its transcript card
 * and on the card asking to run it. The table there cites each family's
 * registration site; a family registered later simply gets the generic card —
 * the fallback is the contract, not an oversight.
 */
export const TOOL_FAMILIES: readonly string[] = Object.keys(TOOL_HEADLINE_FIELDS).sort();

const RENDERERS: Record<string, ToolRenderer> = Object.fromEntries(
  TOOL_FAMILIES.map((family) => [family, { headline: (card: ToolCard) => toolCallHeadline(card.toolName, card.input) }]),
);

export const TOOL_RENDERERS: Readonly<Record<string, ToolRenderer>> = RENDERERS;

/**
 * How the transcript opens a chat a card links to: the page's own way, in
 * place, as a link elsewhere in the app is followed. Absent (a view with
 * nowhere to go), a link opens its address as the browser would.
 */
export const OpenChatContext = createContext<((taskId: string) => void) | undefined>(undefined);

/** A render's pages, beside the payloads; a completed fill's review panel. */
function PdfPages({ card }: { readonly card: ToolCard }) {
  if ((card.toolName === "pdf.fill" || card.toolName === "pdf.overlay") && card.status === "completed")
    return <FillReview input={card.input} output={card.output} />;
  const pages = card.status === "completed" ? pdfPagesOf(card.output) : [];
  return (
    <>
      {pages.length === 0 ? null : (
        <div className="pdf-pages">
          {pages.map((entry) => (
            <PdfPage key={entry.artifactId} page={entry.page} artifactId={entry.artifactId} />
          ))}
        </div>
      )}
      <Payloads card={card} />
    </>
  );
}

/**
 * A tool's input or output as written: a region a keyboard can reach and
 * scroll (WCAG 2.1.1), its long lines wrapped rather than running off the side.
 */
function Payload({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable region must take focus so a keyboard can scroll it.
    <pre className="tool-payload" tabIndex={0} role="region" aria-label={label}>
      {children}
    </pre>
  );
}

/** A tool card's input and output, each as a `Payload`. */
function Payloads({ card }: { readonly card: ToolCard }) {
  const t = useT();
  return (
    <>
      {card.input !== undefined ? <Payload label={t("transcript.tool.input")}>{render(card.input)}</Payload> : null}
      {card.output !== undefined ? <Payload label={t("transcript.tool.output")}>{render(card.output)}</Payload> : null}
    </>
  );
}

/** A video tool's frames, sheet or overlays, beside the payloads. */
function VideoCard({ card }: { readonly card: ToolCard }) {
  return (
    <>
      {card.status === "completed" ? <VideoFrames output={card.output} /> : null}
      <Payloads card={card} />
    </>
  );
}

/** The chats a past-chat search cited, each a link to that chat by its title. */
function PastChatLinks({
  found,
  chats,
}: {
  readonly found: number;
  readonly chats: readonly { readonly taskId: string; readonly title: string }[];
}) {
  const t = useT();
  const open = useContext(OpenChatContext);
  if (chats.length === 0)
    return (
      <p className="meta-base">{found === 0 ? t("transcript.pastChats.none") : t("transcript.pastChats.unlisted", { count: found })}</p>
    );
  return (
    <>
      <ul className="past-chats" aria-label={t("transcript.pastChats.label")}>
        {chats.map((chat) => (
          <li key={chat.taskId}>
            <AppLink href={taskPath(chat.taskId)} onFollow={open === undefined ? undefined : () => open(chat.taskId)}>
              {chat.title}
            </AppLink>
          </li>
        ))}
      </ul>
      {found > chats.length ? <p className="meta-base">{t("transcript.pastChats.more", { count: found - chats.length })}</p> : null}
    </>
  );
}

/**
 * Renderers for one tool id, ahead of its family's: past-chat search says what
 * it did and links each chat it found, its query as the headline.
 */
const TOOL_ID_RENDERERS: Record<string, ToolRenderer> = {
  "pdf.fill": { headline: (card) => toolCallHeadline(card.toolName, card.input), body: (card) => <PdfPages card={card} /> },
  "pdf.overlay": { headline: (card) => toolCallHeadline(card.toolName, card.input), body: (card) => <PdfPages card={card} /> },
  "pdf.render": { headline: (card) => toolCallHeadline(card.toolName, card.input), body: (card) => <PdfPages card={card} /> },
  // The pages `pdf.view` rendered to stand in for the document (its `images`), beside its result.
  "pdf.view": { headline: (card) => toolCallHeadline(card.toolName, card.input), body: (card) => <PdfPages card={card} /> },
  // A video's sheet and stills (and, as they land, the whole-clip view's fallback and pose's overlays), beside its result.
  "video.frames": { headline: (card) => toolCallHeadline(card.toolName, card.input), body: (card) => <VideoCard card={card} /> },
  "video.view": { headline: (card) => toolCallHeadline(card.toolName, card.input), body: (card) => <VideoCard card={card} /> },
  "video.pose": { headline: (card) => toolCallHeadline(card.toolName, card.input), body: (card) => <VideoCard card={card} /> },
  [SESSIONS_SEARCH_TOOL_ID]: {
    label: (card) => {
      if (card.status === "running") return translateNow("transcript.pastChats.searching");
      const cited = card.status === "completed" ? pastChatSearchCitations(card.output) : undefined;
      return cited === undefined ? undefined : pastChatSearchSummary(cited.found);
    },
    headline: (card) => {
      const query = typeof card.input === "object" && card.input !== null ? (card.input as { readonly query?: unknown }).query : undefined;
      return typeof query === "string" && query !== "" ? query : undefined;
    },
    body: (card) => {
      const cited = card.status === "completed" ? pastChatSearchCitations(card.output) : undefined;
      return cited === undefined ? undefined : <PastChatLinks found={cited.found} chats={cited.chats} />;
    },
  },
};

/** The renderer for `toolName`, or the generic one — which adds nothing and renders the payloads as they are. */
export function rendererFor(toolName: string): ToolRenderer {
  if (Object.hasOwn(TOOL_ID_RENDERERS, toolName)) return TOOL_ID_RENDERERS[toolName] ?? {};
  const family = toolFamily(toolName);
  // `hasOwn`, not a plain lookup: a tool id may be `constructor.x`, and
  // `RENDERERS["constructor"]` would otherwise answer `Object`.
  return Object.hasOwn(RENDERERS, family) ? (RENDERERS[family] ?? {}) : {};
}

/** The headline a family offers for this call, clamped so a long path cannot take the row. */
export function headlineOf(card: ToolCard): string | undefined {
  let headline: string | undefined;
  try {
    headline = rendererFor(card.toolName).headline?.(card);
  } catch {
    // A renderer that threw on an odd payload says nothing rather than taking the row with it.
    return undefined;
  }
  if (headline === undefined) return undefined;
  const line = headline.split("\n", 1)[0] ?? "";
  return clip(line, TOOL_HEADLINE_MAX_CHARS);
}

/**
 * One entry's own error boundary. The transcript is the one surface where a
 * payload the page did not write is rendered, so a throw inside a row is
 * expected rather than exceptional: it is caught here, named, and the rows
 * around it are untouched.
 */
/** What an entry is, as its error row names it. */
type EntryKind = "answer" | "message" | "note" | "toolCall" | "connectCard";

const UNRENDERED: Readonly<Record<EntryKind, UiKey>> = {
  answer: "transcript.unrendered.answer",
  message: "transcript.unrendered.message",
  note: "transcript.unrendered.note",
  toolCall: "transcript.unrendered.toolCall",
  connectCard: "transcript.unrendered.connectCard",
};

export function EntryBoundary({ children, what }: { readonly children: ReactNode; readonly what: EntryKind }) {
  // A card that threw mid-flight — a half-written payload — is tried again
  // once its payload changes, rather than staying an error row for the rest
  // of the session. One that is genuinely undrawable simply fails again.
  return (
    <ErrorBoundary
      resetOn={children}
      logAs="a transcript entry"
      fallback={(failed) => <p className="unrendered">{translateNow(UNRENDERED[what], { failed })}</p>}
    >
      {children}
    </ErrorBoundary>
  );
}

const STATUS_LABELS: Readonly<Record<ToolCard["status"], string>> = saidRecord({
  running: "transcript.tool.status.running",
  completed: "transcript.tool.status.completed",
  failed: "transcript.tool.status.failed",
  interrupted: "transcript.tool.status.interrupted",
});

/** A family's words for the call, in place of its id; nothing when it has none or its renderer threw. */
function labelOf(card: ToolCard): string | undefined {
  try {
    return rendererFor(card.toolName).label?.(card);
  } catch {
    return undefined;
  }
}

/** The scanned line of one call: what it is, what it touched, how it ended. */
function ToolLine({ card }: { readonly card: ToolCard }) {
  const headline = headlineOf(card);
  const label = labelOf(card);
  return (
    <>
      {label === undefined ? <code>{card.toolName}</code> : <span className="tool-label">{label}</span>}
      {headline === undefined ? null : <span className="tool-headline meta-base truncate">{headline}</span>}
      <span className={`badge badge-plain status-tool-${card.status}`}>{STATUS_LABELS[card.status]}</span>
      {card.durationMs === undefined ? null : <span className="tool-status meta-base">{formatDuration(card.durationMs)}</span>}
    </>
  );
}

/**
 * What a failed call's answer carries for the model beside its code and detail: whether to retry and a hint about it,
 * the detail again as a list, a sign-in's names for its Connect card. None is for the reader (QA 1904).
 */
const FAILURE_MODEL_KEYS: ReadonlySet<string> = new Set(["retryable", "hint", "issues", "pluginId", "appId", "accountId"]);

/**
 * A failed call's message as a reader takes it: a tool's `{"error", "detail"}`
 * answer reads "CODE: detail", the detail's own line breaks kept; any other
 * message is shown as it came.
 */
function failureText(message: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(message);
  } catch {
    return message;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return message;
  const { error, detail, ...rest } = parsed as Record<string, unknown>;
  if (typeof error !== "string" || Object.keys(rest).some((key) => !FAILURE_MODEL_KEYS.has(key))) return message;
  if (detail === undefined) return error;
  return typeof detail === "string" ? `${error}: ${detail}` : message;
}

/** One call's payloads: its family's own shape, or the generic one. */
function ToolBody({ card }: { readonly card: ToolCard }) {
  const masked = maskedSecretsNote(card.redacted);
  let body: ReactNode;
  try {
    body = rendererFor(card.toolName).body?.(card);
  } catch {
    // As `headlineOf` does: a renderer that threw falls back to the generic
    // rendering rather than taking the card to the error row.
    body = undefined;
  }
  return (
    <>
      {body ?? <Payloads card={card} />}
      {card.message !== undefined ? <Failure alert={false}>{failureText(card.message)}</Failure> : null}
      {masked === undefined ? null : <p className="meta-base">{masked}</p>}
    </>
  );
}

/** One tool call: collapsed, with its family's headline and its status on the summary. */
export const Tool = memo(function Tool({ card }: { readonly card: ToolCard }) {
  countRender?.(card.key);
  const t = useT();
  return (
    <details className={`tool tool-${card.status}`} data-tool-key={card.key}>
      <summary className="disclosure">
        <span className="visually-hidden">{t("transcript.tool.said")}</span>
        <ToolLine card={card} />
      </summary>
      <ToolBody card={card} />
    </details>
  );
});

/**
 * A run of consecutive tool calls, as one collapsed block. Its summary says
 * how many and how they ended, so nothing is hidden by folding them: a reader
 * who does not care about tool output is not made to scroll past it, and one
 * who does is one click away.
 *
 * A run of **one** is the same element, with that call's own line as the
 * summary — so a card the reader expanded stays expanded when a second call
 * joins it, instead of being replaced and folded away under their cursor.
 * Open or folded is the reader's alone: a call starting or ending never
 * toggles it, so the transcript does not jump under them while a turn runs.
 */
/**
 * Two folds hold the same cards when they hold the same card objects. The
 * reducer replaces only the entry a delta touched, so the cards either side of
 * it are the same objects — but `groupEntries` and `transcriptWindow` both
 * allocate fresh arrays per render, so a reference comparison never hits and
 * every group would re-render on every token. The render budget test guards
 * against that.
 */
function sameCards(before: ToolGroupProps, after: ToolGroupProps): boolean {
  if (before.cards.length !== after.cards.length || before.failovers.length !== after.failovers.length) return false;
  return (
    before.cards.every((card, index) => card === after.cards[index]) &&
    before.failovers.every((boundary, index) => boundary === after.failovers[index])
  );
}

interface ToolGroupProps {
  readonly cards: readonly ToolCard[];
  readonly failovers: readonly AttemptBoundary[];
}

/** `web_search ×11, sandbox.run`: what a block's calls were, most used first. */
function tally(cards: readonly ToolCard[]): string {
  const counts = new Map<string, number>();
  for (const card of cards) counts.set(card.toolName, (counts.get(card.toolName) ?? 0) + 1);
  const names = [...counts].sort((a, b) => b[1] - a[1]).map(([name, count]) => (count > 1 ? `${name} ×${count}` : name));
  return `${names.slice(0, 3).join(", ")}${names.length > 3 ? ", …" : ""}`;
}

/** A call that asks the person to connect an app shows its card under the block, folded or not. */
function ConnectCards({ cards }: { readonly cards: readonly ToolCard[] }) {
  // One card per app: a call retried against the same lapsed app asks once.
  const asks = new Map<string, ConnectAsk>();
  for (const card of cards) {
    const ask = connectAskOf(card);
    if (ask !== undefined)
      asks.set(
        ask.kind === "sign-in"
          ? `plugin:${ask.pluginId}`
          : ask.kind === "account"
            ? `account:${ask.accountId}`
            : ask.kind === "wait"
              ? `wait:${ask.waitId}`
              : `app:${ask.request.appId ?? ask.request.name}`,
        ask,
      );
  }
  return (
    <>
      {[...asks].map(([key, ask]) => (
        <ConnectCard key={`connect:${key}`} ask={ask} />
      ))}
    </>
  );
}

export const ToolGroup = memo(function ToolGroup({ cards, failovers }: ToolGroupProps) {
  countRender?.(cards[0]?.key ?? "");
  const failed = cards.filter((card) => card.status === "failed").length;
  const solo = cards.length === 1 ? cards[0] : undefined;
  // Keeping the plan is bookkeeping, not work: the plan is in the Activity tab, so it is not a step.
  const steps = cards.filter((card) => card.toolName !== PLAN_TOOL_ID);
  // The step under way, if any: the block's summary says what the turn is doing now.
  const current = steps.findLast((card) => card.status === "running");
  const t = useT();
  return (
    <>
      <details className={failed > 0 ? "tools tools-failed" : "tools"} data-tool-key={solo?.key}>
        <summary className="disclosure">
          <span className="visually-hidden">{t("transcript.tool.said")}</span>
          {solo !== undefined ? (
            <ToolLine card={solo} />
          ) : (
            <>
              {/* Its words keep one line; the calls' names after them give way (ellipsis) in a narrow line. */}
              <span className="tool-label">
                {steps.length === 0
                  ? t("transcript.tool.updatedPlan")
                  : t(current === undefined ? "transcript.tool.worked" : "transcript.tool.working", { count: steps.length })}
              </span>
              <span className="tool-headline meta-base truncate">
                {current === undefined ? tally(steps) : `${current.toolName} ${headlineOf(current) ?? ""}`.trimEnd()}
              </span>
              {failed > 0 ? (
                <span className="badge badge-plain status-tool-failed">{t("transcript.tool.failedCount", { count: failed })}</span>
              ) : null}
            </>
          )}
          {failovers.length > 0 ? <span className="badge badge-plain">{t("transcript.tool.retried")}</span> : null}
        </summary>
        {failovers.map((boundary) => (
          <p key={boundary.key} className="boundary">
            {failoverText(boundary)}
          </p>
        ))}
        {solo !== undefined ? (
          <EntryBoundary what="toolCall">
            <ToolBody card={solo} />
          </EntryBoundary>
        ) : (
          cards.map((card) => (
            <EntryBoundary key={card.key} what="toolCall">
              <Tool card={card} />
            </EntryBoundary>
          ))
        )}
      </details>
      <EntryBoundary what="connectCard">
        <ConnectCards cards={cards} />
      </EntryBoundary>
    </>
  );
}, sameCards);
