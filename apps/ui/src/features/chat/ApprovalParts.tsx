import type { PendingRound } from "@tavi/client/browser";
import {
  ARG_PROVENANCE_LIMITS,
  argOriginWords,
  displaySafe,
  isTaintReason,
  isUnifiedDiff,
  neutralizedText,
  provenanceChips,
  requestSources,
  requestTainted,
  whyAskedText,
} from "@tavi/contracts";
import { clip } from "@tavi/contracts/util";
import type { RiskLevel } from "@tavi/contracts";
import type { UiKey } from "../../locales/en.js";
import { translateCore, useT } from "../../lib/i18n.js";
import { Notice } from "../../ui/Parts.js";
import { FormFillTable } from "../transcript/FormFillTable.js";

/** How much of a call's input a card shows before cutting it. */
const INPUT_CHARS = 120;

/**
 * What a request is *for*, as the card says it: the summary when it says more
 * than the tool's name, else the call's input. The workflow's default summary
 * is "Approve <tool>?", which told a reader nothing about a `web_search` (not
 * even the query) and made the button read "Run Approve web_search?". The
 * terminal chat's cards make the same cut (`callLine` in the CLI store).
 */
export function describeRequest(request: {
  readonly toolName: string;
  readonly summary: string;
  readonly input: unknown;
  readonly display?: { readonly title: string; readonly destructive?: true | undefined };
}): string | undefined {
  // A call's own display says what it does better than either.
  if (request.display !== undefined) return request.display.title;
  const given = request.summary.trim();
  if (given !== "" && !given.includes(request.toolName)) return displaySafe(given);
  const input = request.input;
  if (input === undefined || input === null) return undefined;
  // The call's own input, which no verdict cleaned: what it would hide (a bidi override, an invisible character) is marked.
  if (typeof input !== "object") return clamp(displaySafe(String(input)));
  const fields = Object.entries(input as Record<string, unknown>)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}: ${typeof value === "string" ? value : JSON.stringify(value)}`);
  return fields.length === 0 ? undefined : clamp(displaySafe(fields.join(", ")));
}

/** A call's input as the card's Details show it: JSON, with what its strings would hide marked. */
export function inputDetails(input: unknown): string {
  return displaySafe(JSON.stringify(input, (_key, value: unknown) => (typeof value === "string" ? displaySafe(value) : value), 2) ?? "");
}

function clamp(text: string): string {
  return clip(text, INPUT_CHARS, { squeeze: true });
}

/** What else flags a call, in one line: "runs inline code · …". Taint has its own "Why am I asked?" (`Provenance`). */
function whyAsked(risk: NonNullable<PendingRound["requests"][number]["risk"]>): string | undefined {
  const reasons = risk.reasons.filter((reason) => !isTaintReason(reason));
  return reasons.length === 0 ? undefined : reasons.join(" · ");
}

/** How much of an argument a highlight shows. */
const ORIGIN_VALUE_CHARS = 80;

/**
 * Why a call is asked, and from where: "Why am I
 * asked?" in plain words for the taint step's reason; the chat's sources as
 * chips that lead with what Tavi established — the host it parsed, the
 * verified sender domain, the tool — with a page's own title after it as
 * "the page calls itself “…”", clipped and neutralized; and where the call's
 * values appear, each highlighted. Everything content wrote is a text node,
 * never markup. An older owner sends only the risk's label: its chips show.
 */
export function Provenance({ request }: { readonly request: PendingRound["requests"][number] }) {
  const provenance = request.provenance;
  const tainted = requestTainted(request);
  const why = whyAskedText(provenance?.gateReason, tainted, provenance?.skillCeiling, request.toolName, translateCore);
  const sources = requestSources(request);
  const chips = sources === undefined ? [] : provenanceChips(sources, translateCore);
  const origins = (provenance?.argOrigins ?? []).filter((origin) => tainted || origin.from !== "unmatched");
  const t = useT();
  if (why === undefined && chips.length === 0 && origins.length === 0) return null;
  return (
    <div className="provenance">
      {why === undefined ? null : (
        <p className="why-asked meta-sm">
          <strong>{t("chat.provenance.whyAsked")}</strong> {why}
        </p>
      )}
      {chips.length === 0 ? null : (
        <ul className="source-chips list-reset" aria-label={t("chat.provenance.sources")}>
          {chips.map((chip) => (
            <li key={chip.established} className="source-chip">
              <span className="source-established">{chip.established}</span>
              {chip.claim === undefined ? null : <span className="source-claim"> — {chip.claim}</span>}
            </li>
          ))}
        </ul>
      )}
      {origins.length === 0 ? null : (
        <ul className="arg-origins list-reset meta-sm" aria-label={t("chat.provenance.origins")}>
          {origins.map((origin) => (
            <li key={`${origin.path}:${origin.value}`}>
              {/* Quoted, as the terminal says it: the value is the call's, the words after it where it came from. */}“
              <mark
                className={`arg-origin arg-origin-${origin.from}`}
                title={neutralizedText(origin.path, ARG_PROVENANCE_LIMITS.maxPathChars)}
              >
                {neutralizedText(origin.value, ORIGIN_VALUE_CHARS)}
              </mark>
              ” {argOriginWords(origin, translateCore)}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * A call as the card asks about it: what it does in plain words, its risk,
 * and why it is asked — the parts a decision is made on — with the exact
 * command and the full input one click away.
 */
export function CallLine({ request, grouped }: { readonly request: PendingRound["requests"][number]; readonly grouped: boolean }) {
  const form = request.display?.form;
  // A form's table stands for its plain-text command.
  const shown =
    form === undefined ? (request.display?.command ?? request.display?.destination ?? request.display?.detail) : request.display?.detail;
  // A detail that is neither a command, an address nor a diff is the card's read-back in words (a schedule's when, where
  // its results go, what it runs): one of the parts a decision is made on, so on the card, not under Details.
  // A call shown by its address (an email's recipients) whose detail is what it sends (the draft whole) puts that on
  // the card too: what is approved is never only under Details.
  const words = (text: string | undefined): string | undefined =>
    text !== undefined && text !== request.display?.title && text.trim() !== "" && !isUnifiedDiff(text) ? text : undefined;
  const readBack =
    form !== undefined
      ? undefined
      : shown === request.display?.detail
        ? words(shown)
        : request.display?.command === undefined
          ? words(request.display?.detail)
          : undefined;
  const why = request.risk === undefined ? undefined : whyAsked(request.risk);
  const described = describeRequest(request);
  const t = useT();
  return (
    <>
      <span className="call-title">
        {/* At most two lines: a long command is whole under Details. */}
        <strong className="call-title-text" title={described}>
          {described ?? request.toolName}
        </strong>
        {grouped || described === undefined ? null : (
          <>
            {" "}
            <code className="meta-sm">{request.toolName}</code>
          </>
        )}
        {request.risk ? (
          <>
            {" "}
            <span className={`badge risk risk-${request.risk.level}`}>{t(RISK_KEYS[request.risk.level])}</span>
          </>
        ) : grouped ? null : (
          <>
            {" "}
            <span className="badge">{request.effect ?? t("chat.call.effectUnknown")}</span>
          </>
        )}
        {request.display?.destructive === true ? (
          <>
            {" "}
            <span className="badge risk risk-high">{t("chat.call.irreversible")}</span>
          </>
        ) : null}
      </span>
      <Provenance request={request} />
      {readBack === undefined ? null : <p className="call-readback">{readBack}</p>}
      {why === undefined ? null : <p className="risk-why meta-sm">{t("chat.call.flagged", { why })}</p>}
      {form === undefined ? null : <FormTable form={form} />}
      {request.display?.forThisChat === undefined || request.allowedScopes?.includes("session") !== true ? null : (
        <p className="meta-sm">{t("chat.call.forThisChat", { what: request.display.forThisChat })}</p>
      )}
      {/* What runs from standard input is part of the command: shown, never only under Details. */}
      {request.display?.stdin === undefined ? null : (
        <>
          <p className="meta-sm">{t("chat.call.stdin")}</p>
          <pre className="call-command">{request.display.stdin}</pre>
        </>
      )}
      <details className="call-details">
        <summary className="disclosure">{t("chat.call.details")}</summary>
        {shown === undefined || shown === request.display?.title || readBack === shown ? null : isUnifiedDiff(shown) ? (
          <DiffBlock diff={shown} />
        ) : (
          <pre className="call-command">{shown}</pre>
        )}
        <pre>{inputDetails(request.input)}</pre>
      </details>
    </>
  );
}

/** The kind of a unified diff's line, as its class: added, removed, a hunk's header, or context. */
function diffLineClass(line: string): string | undefined {
  if (line.startsWith("+++ ") || line.startsWith("--- ")) return "diff-file";
  if (line.startsWith("@@")) return "diff-hunk";
  if (line.startsWith("+")) return "diff-added";
  if (line.startsWith("-")) return "diff-removed";
  return undefined;
}

/** A file change's diff, its added and removed lines marked, tall enough to read a function's edit. */
export function DiffBlock({ diff }: { readonly diff: string }) {
  return (
    <pre className="call-command call-diff">
      {diff.split("\n").map((line, index) => (
        // A diff's lines repeat ("+}" twice), so their place is their key; the list is never reordered.
        <span key={index} className={diffLineClass(line)}>
          {line}
          {"\n"}
        </span>
      ))}
    </pre>
  );
}

type ApprovalForm = NonNullable<NonNullable<PendingRound["requests"][number]["display"]>["form"]>;

/** A risk level's badge. */
const RISK_KEYS: Readonly<Record<RiskLevel, UiKey>> = {
  low: "chat.call.risk.low",
  medium: "chat.call.risk.medium",
  high: "chat.call.risk.high",
  critical: "chat.call.risk.critical",
};

/** How a row's check reads: a short word, and what it means. */
const FORM_STATUS: Readonly<Record<ApprovalForm["rows"][number]["status"], { readonly mark: UiKey; readonly words: UiKey }>> = {
  verified: { mark: "chat.form.status.verified", words: "chat.form.status.verifiedWords" },
  unmatched: { mark: "chat.form.status.unmatched", words: "chat.form.status.unmatchedWords" },
  document: { mark: "chat.form.status.document", words: "chat.form.status.documentWords" },
  choice: { mark: "chat.form.status.choice", words: "chat.form.status.choiceWords" },
};

/**
 * A form fill's every value, as it will be written, with its source and what
 * the gate checked it against, grouped by page; then what the person signs or
 * completes themselves, and the warnings. Every string is the document's or a
 * source's, so React's escaping is all it gets: none becomes a link.
 */
export function FormTable({ form }: { readonly form: ApprovalForm }) {
  const pages = [...new Set(form.rows.map((row) => row.page))];
  const t = useT();
  return (
    <div className="form-fill">
      <p className="meta-sm">
        {form.source} → <code>{form.output}</code>
      </p>
      <FormFillTable>
        {pages.map((page) => (
          <tbody key={page}>
            <tr>
              <th scope="rowgroup" colSpan={4}>
                {t("chat.form.page", { page })}
              </th>
            </tr>
            {form.rows
              .filter((row) => row.page === page)
              .map((row, index) => (
                <tr key={`${page}:${index}`} className={`form-row-${row.status}`}>
                  <td>{row.field}</td>
                  <td>
                    {row.value}
                    {row.sensitive === undefined || row.sensitive.length === 0 ? null : (
                      <>
                        {" "}
                        <span className="badge" title={row.sensitive.join(", ")}>
                          {t("chat.form.sensitive")}
                        </span>
                      </>
                    )}
                  </td>
                  <td className="meta-sm">{row.source}</td>
                  <td className="form-check meta-sm" title={t(FORM_STATUS[row.status].words)}>
                    {t(FORM_STATUS[row.status].mark)}
                  </td>
                </tr>
              ))}
          </tbody>
        ))}
      </FormFillTable>
      {form.truncated === true ? <Notice>{t("chat.form.truncated")}</Notice> : null}
      {form.leftBlank.length === 0 ? null : (
        <p className="meta-sm">{t("chat.form.leftBlank", { fields: form.leftBlank.map((entry) => entry.field).join(", ") })}</p>
      )}
      {form.warnings.length === 0 ? null : (
        <ul className="list-reset meta-sm">
          {form.warnings.map((warning) => (
            <li key={warning}>{t("chat.form.warning", { warning })}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
