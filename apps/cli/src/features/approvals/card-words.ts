import type { Locale } from "@tavi/contracts/i18n";
import { coreEnglish, type CoreKey, type CoreT } from "@tavi/contracts/locales/core";
import { coreIn } from "@tavi/contracts/locales/core-server";

/**
 * The words an approval card is written in. The gate tells a tool's `assess`
 * the workspace's language (`InvocationContext.locale`); a card's title,
 * detail and reasons are said in it and stored with the approval as said.
 * What the model reads (a refusal, `hardDeny`) stays English, and a card
 * stored before keeps the English it was stored in.
 */

const translators = new Map<Locale, CoreT>();

/** The `core` words for the language an assessor was given; English when none was, or it is English. */
export function cardWords(context?: { readonly locale?: Locale | undefined } | undefined): CoreT {
  const locale = context?.locale;
  if (locale === undefined || locale === "en") return coreEnglish;
  let t = translators.get(locale);
  if (t === undefined) {
    t = coreIn(locale);
    translators.set(locale, t);
  }
  return t;
}

/**
 * The reasons an assessor writes in English as fixed phrases, by key: `cardReason` says each in a card's language.
 * Shell reasons come from `@tavi/contracts`' shell reader in English too (`shell.reason.*`).
 */
const FIXED_REASON_KEYS = [
  "approval.reason.elevated",
  "approval.reason.deletesRecursively",
  "approval.reason.deletesFound",
  "approval.reason.deletesFiles",
  "approval.reason.network",
  "approval.reason.permissions",
  "approval.reason.repository",
  "approval.reason.inlineCode",
  "approval.reason.package",
  "approval.reason.stopsProcesses",
  "approval.reason.tooDeep",
  "approval.reason.unparsed",
  "approval.reason.redirectsOutside",
  "approval.reason.nestedShell",
  "approval.reason.startupShell",
  "approval.reason.gitSetting",
  "approval.reason.stdinScript",
  "approval.reason.sideChatRule",
  "approval.reason.commandSubstitution",
  "approval.reason.eval",
  "approval.reason.hereDocument",
  "approval.reason.controlFlow",
  "approval.reason.shellFunction",
  "approval.reason.shellComment",
  "shell.reason.quoting",
  "shell.reason.continuation",
  "shell.reason.bracedExpansion",
  "shell.reason.processSubstitution",
  "shell.reason.parseDisagreement",
  "approval.reason.httpDelete",
  "approval.reason.sendsElsewhere",
  "approval.reason.sendsFile",
  "approval.reason.uploadsFile",
  "approval.reason.pressesEnter",
  "approval.reason.submits",
  "approval.reason.uploads",
  "approval.reason.downloads",
  "approval.reason.worker",
  "approval.reason.search",
  "approval.reason.query.link",
  "approval.reason.query.dataLink",
  "approval.reason.query.addressLink",
  "approval.reason.query.dataDomain",
  "approval.reason.query.code",
  "approval.reason.query.number",
  "approval.reason.query.email",
  "approval.reason.query.secret",
  "approval.reason.query.long",
  "approval.reason.desktop.credential",
  "approval.reason.desktop.authDialog",
  "approval.reason.desktop.viewOnly",
  "approval.reason.desktop.clickOnly",
  "approval.reason.desktop.controls",
  "approval.reason.desktop.computerUse",
] as const satisfies readonly CoreKey[];

let fixedReasons: ReadonlyMap<string, CoreKey> | undefined;

/** A reason as `t` says it: a fixed English phrase by its key, anything else (a reason with names in it) as given. */
export function cardReason(reason: string, t: CoreT): string {
  if (t === coreEnglish) return reason;
  fixedReasons ??= new Map(FIXED_REASON_KEYS.map((key) => [coreEnglish(key), key]));
  const key = fixedReasons.get(reason);
  return key === undefined ? reason : t(key);
}

/** An action's kind (`click`, `type`) in `t`'s words; one it has none for, as written. */
export function cardKind(kind: string, t: CoreT): string {
  if (t === coreEnglish) return kind;
  const key = `approval.card.kind.${kind}`;
  return Object.hasOwn(KIND_KEYS, kind) ? t(key as CoreKey) : kind;
}

/** The kinds a card names in words: a browser's and the desktop's. */
const KIND_KEYS = {
  click: true,
  type: true,
  submit: true,
  upload: true,
  download: true,
  select: true,
  hover: true,
  drag: true,
  press: true,
  scroll: true,
  back: true,
  wait_for: true,
  tab: true,
  open_in_tab: true,
  close_tab: true,
  move: true,
  wait: true,
} as const;
