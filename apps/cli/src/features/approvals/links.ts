import type { IncomingMessage, ServerResponse } from "node:http";

import type { ApprovalForm } from "@tavi/contracts";
import { DEFAULT_LOCALE, type Locale } from "@tavi/contracts/i18n";
import { coreEnglish, type CoreT } from "@tavi/contracts/locales/core";
import { coreIn } from "@tavi/contracts/locales/core-server";
import { securityHeaders } from "@tavi/node-kit";

import { SERVED_PAGE_STYLE, SERVED_PAGE_STYLE_SRC } from "../../shared/served-page-css.js";
import { GLYPHS } from "../../tui/theme.js";
import type { LinkView } from "./channel-approval-text.js";
import type { ChannelApprovals } from "./channel-approvals.js";

/**
 * The confirmation page behind an email's single-use links, served by
 * the Mailgun webhook listener — the one surface already reachable from the
 * internet — at `/i/<token>`.
 *
 * A GET only shows what the link would do: mail scanners and link previewers
 * follow links, and a GET that decided would let them decide. Only the page's
 * own POST spends the link. The page loads nothing from anywhere (strict CSP,
 * no scripts), is never cached, never framed, and sends no referrer.
 */

const TOKEN_PATH = "/i/([A-Za-z0-9_-]{16,64})";

/**
 * The paths a link's token is read from. A link is `<public URL>/i/<token>`,
 * and `--mailgun-public-url` may carry a path (`https://mail.example.com/tavi`)
 * that a reverse proxy either forwards as is or strips: both
 * `/tavi/i/<token>` and `/i/<token>` are served.
 */
function linkPath(publicUrl: string | undefined): RegExp {
  let prefix = "";
  if (publicUrl !== undefined) {
    try {
      prefix = new URL(publicUrl).pathname.replace(/\/+$/, "");
    } catch {
      prefix = "";
    }
  }
  const escaped = prefix.replace(/[.*+?^${}()|[\]\\/-]/g, "\\$&");
  return new RegExp(prefix === "" ? `^${TOKEN_PATH}$` : `^(?:${escaped})?${TOKEN_PATH}$`);
}
/** A form of a PIN and a reason is small; anything larger is not this form. */
const MAX_FORM_BYTES = 8 * 1024;

const HEADERS: Readonly<Record<string, string>> = {
  "content-type": "text/html; charset=utf-8",
  ...securityHeaders(`default-src 'none'; style-src ${SERVED_PAGE_STYLE_SRC}; form-action 'self'; frame-ancestors 'none'; base-uri 'none'`),
};

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

/** The page's words: the language of the workspace the link belongs to, English when none is known. */
const wordsIn = (locale: Locale | undefined): CoreT => (locale === undefined || locale === DEFAULT_LOCALE ? coreEnglish : coreIn(locale));

function page(res: ServerResponse, status: number, title: string, content: string, locale: Locale = DEFAULT_LOCALE): void {
  res.statusCode = status;
  for (const [name, value] of Object.entries(HEADERS)) res.setHeader(name, value);
  res.end(
    `<!doctype html><html lang="${locale}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">` +
      `<title>${escapeHtml(title)}</title>${SERVED_PAGE_STYLE}</head>` +
      `<body><h1>${escapeHtml(title)}</h1>${content}</body></html>`,
  );
}

/** How each row's value was checked, as the page says it. */
function statusText(status: ApprovalForm["rows"][number]["status"], t: CoreT): string {
  switch (status) {
    case "verified":
      return `${GLYPHS.done} ${t("page.link.form.verified")}`;
    case "unmatched":
      return `? ${t("page.link.form.unmatched")}`;
    case "document":
      return t("page.link.form.document");
    case "choice":
      return t("page.link.form.choice");
  }
}

/** A form fill's values as the page shows them: already masked as on a private chat, every cell escaped. */
function formTable(form: ApprovalForm, t: CoreT): string {
  const cell = (text: string): string => `<td>${escapeHtml(text)}</td>`;
  const head = (["page", "field", "value", "source", "checked"] as const)
    .map((column) => `<th>${escapeHtml(t(`page.link.form.${column}`))}</th>`)
    .join("");
  const rows = form.rows
    .map(
      (row) =>
        `<tr>${cell(String(row.page))}${cell(row.field)}${cell(row.value)}${cell(row.source)}${cell(statusText(row.status, t))}</tr>`,
    )
    .join("");
  return (
    `<p>${escapeHtml(form.source)} → ${escapeHtml(form.output)}</p>` +
    `<table><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table>` +
    (form.leftBlank.length === 0
      ? ""
      : `<p>${withHtml(t("page.link.form.leftBlank", { fields: "\u0000" }), form.leftBlank.map((entry) => escapeHtml(entry.field)).join(", "))}</p>`) +
    form.warnings.map((warning) => `<p>⚠ ${escapeHtml(warning)}</p>`).join("")
  );
}

/** Words with one parameter written as a NUL, escaped, and that parameter as the HTML given. */
function withHtml(text: string, html: string): string {
  return escapeHtml(text).replace("\u0000", () => html);
}

function confirmation(view: LinkView, t: CoreT): string {
  return (
    `${view.body === "" ? "" : `<pre>${escapeHtml(view.body)}</pre>`}` +
    (view.forms ?? []).map((form) => formTable(form, t)).join("") +
    `<form method="post">` +
    (view.options === undefined
      ? `<p>${withHtml(t("page.link.confirm", { choice: "\u0000" }), `<strong>${escapeHtml(view.choiceLabel)}</strong>`)}</p>`
      : `<fieldset><legend>${escapeHtml(t("page.link.chooseAny"))}</legend>${view.options
          .map(
            (option, index) =>
              `<label><input type="checkbox" name="pick" value="${index + 1}"> ${escapeHtml(option.label)}${option.description === undefined ? "" : ` — ${escapeHtml(option.description)}`}</label>`,
          )
          .join("")}</fieldset>`) +
    (view.allowsNote
      ? `<label>${escapeHtml(t("page.link.reason"))}<textarea name="note" maxlength="500" rows="3"></textarea></label>`
      : "") +
    (view.needsPin
      ? `<label>${escapeHtml(t("page.link.pin"))}<input type="password" name="pin" autocomplete="off" required></label>`
      : "") +
    `<button type="submit">${escapeHtml(view.choiceLabel)}</button></form>` +
    `<p>${escapeHtml(t("page.link.worksOnce"))}</p>`
  );
}

function readForm(req: IncomingMessage): Promise<URLSearchParams | undefined> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    req.on("data", (chunk: Buffer) => {
      if (tooLarge) return;
      size += chunk.byteLength;
      if (size > MAX_FORM_BYTES) {
        // Stop keeping it and answer at once; the request is torn down once
        // the refusal is sent.
        tooLarge = true;
        chunks.length = 0;
        resolve(undefined);
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!tooLarge) resolve(new URLSearchParams(Buffer.concat(chunks).toString("utf8")));
    });
    req.on("error", () => resolve(undefined));
  });
}

/**
 * A request listener for `/i/<token>` (and `<public URL path>/i/<token>`):
 * `true` when it answered the request, `false` for any other path, which the
 * caller hands on (the webhook). `publicUrl` is the base the links were
 * written with (`--mailgun-public-url`).
 */
export function createApprovalLinkHandler(
  channels: Pick<ChannelApprovals, "describeLink" | "useLink"> & Partial<Pick<ChannelApprovals, "linkLocale">>,
  options: { readonly publicUrl?: string | undefined } = {},
): (req: IncomingMessage, res: ServerResponse) => Promise<boolean> {
  const path = linkPath(options.publicUrl);
  return async (req, res) => {
    const match = path.exec((req.url ?? "").split("?")[0] ?? "");
    if (match === null) return false;
    const token = match[1] ?? "";
    if (req.method === "GET" || req.method === "HEAD") {
      const described = await channels.describeLink(token);
      const t = wordsIn(described.locale);
      if (!described.ok) page(res, 410, t("page.link.nothingToDo"), `<p>${escapeHtml(described.message)}</p>`, described.locale);
      else page(res, 200, described.view.title, confirmation(described.view, t), described.locale);
      return true;
    }
    if (req.method !== "POST") {
      // No link is read for any other method: the default workspace's words, as for a link that names none.
      const locale = await channels.linkLocale?.();
      const t = wordsIn(locale);
      page(res, 405, t("page.link.notAllowed"), `<p>${escapeHtml(t("page.link.openFromEmail"))}</p>`, locale);
      return true;
    }
    const form = await readForm(req);
    if (form === undefined) {
      res.setHeader("connection", "close");
      // Nothing more of an oversized body is read once the refusal is out.
      res.on("finish", () => req.destroy());
      const locale = await channels.linkLocale?.();
      const t = wordsIn(locale);
      page(res, 413, t("page.link.notAccepted"), `<p>${escapeHtml(t("page.link.tooLarge"))}</p>`, locale);
      return true;
    }
    const pin = form.get("pin");
    const note = form.get("note");
    // A multi-select question's ticked boxes; anything that is not an option number is dropped.
    const picks = form
      .getAll("pick")
      .map(Number)
      .filter((pick) => Number.isInteger(pick) && pick >= 1 && pick <= 4);
    const outcome = await channels.useLink(token, {
      ...(pin === null ? {} : { pin }),
      ...(note === null ? {} : { note }),
      ...(picks.length === 0 ? {} : { picks }),
    });
    const t = wordsIn(outcome.locale);
    page(
      res,
      outcome.ok ? 200 : 409,
      t(outcome.ok ? "page.link.done" : "page.link.notDone"),
      `<p>${escapeHtml(outcome.message)}</p>`,
      outcome.locale,
    );
    return true;
  };
}
