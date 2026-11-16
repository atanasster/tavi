import type { IncomingMessage, ServerResponse } from "node:http";

import type { ApprovalForm } from "@tavi/contracts";
import { securityHeaders } from "@tavi/node-kit";

import { SERVED_PAGE_STYLE, SERVED_PAGE_STYLE_SRC } from "../../shared/served-page-css.js";
import { FORM_STATUS_TEXT } from "./form.js";
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

function page(res: ServerResponse, status: number, title: string, content: string): void {
  res.statusCode = status;
  for (const [name, value] of Object.entries(HEADERS)) res.setHeader(name, value);
  res.end(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">` +
      `<title>${escapeHtml(title)}</title>${SERVED_PAGE_STYLE}</head>` +
      `<body><h1>${escapeHtml(title)}</h1>${content}</body></html>`,
  );
}

/** A form fill's values as the page shows them: already masked as on a private chat, every cell escaped. */
function formTable(form: ApprovalForm): string {
  const cell = (text: string): string => `<td>${escapeHtml(text)}</td>`;
  const rows = form.rows
    .map(
      (row) =>
        `<tr>${cell(String(row.page))}${cell(row.field)}${cell(row.value)}${cell(row.source)}${cell(FORM_STATUS_TEXT[row.status])}</tr>`,
    )
    .join("");
  return (
    `<p>${escapeHtml(form.source)} → ${escapeHtml(form.output)}</p>` +
    `<table><thead><tr><th>Page</th><th>Field</th><th>Value</th><th>Source</th><th>Checked</th></tr></thead><tbody>${rows}</tbody></table>` +
    (form.leftBlank.length === 0
      ? ""
      : `<p>You sign or complete these yourself: ${form.leftBlank.map((entry) => escapeHtml(entry.field)).join(", ")}</p>`) +
    form.warnings.map((warning) => `<p>⚠ ${escapeHtml(warning)}</p>`).join("")
  );
}

function confirmation(view: LinkView): string {
  return (
    `${view.body === "" ? "" : `<pre>${escapeHtml(view.body)}</pre>`}` +
    (view.forms ?? []).map((form) => formTable(form)).join("") +
    `<form method="post">` +
    (view.options === undefined
      ? `<p>Confirm: <strong>${escapeHtml(view.choiceLabel)}</strong></p>`
      : `<fieldset><legend>Choose any</legend>${view.options
          .map(
            (option, index) =>
              `<label><input type="checkbox" name="pick" value="${index + 1}"> ${escapeHtml(option.label)}${option.description === undefined ? "" : ` — ${escapeHtml(option.description)}`}</label>`,
          )
          .join("")}</fieldset>`) +
    (view.allowsNote
      ? `<label>Reason (optional; the task reads it)<textarea name="note" maxlength="500" rows="3"></textarea></label>`
      : "") +
    (view.needsPin
      ? `<label>This is a critical call. Your PIN<input type="password" name="pin" autocomplete="off" required></label>`
      : "") +
    `<button type="submit">${escapeHtml(view.choiceLabel)}</button></form>` +
    `<p>This link works once. Nothing happens until you press the button.</p>`
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
  channels: Pick<ChannelApprovals, "describeLink" | "useLink">,
  options: { readonly publicUrl?: string | undefined } = {},
): (req: IncomingMessage, res: ServerResponse) => Promise<boolean> {
  const path = linkPath(options.publicUrl);
  return async (req, res) => {
    const match = path.exec((req.url ?? "").split("?")[0] ?? "");
    if (match === null) return false;
    const token = match[1] ?? "";
    if (req.method === "GET" || req.method === "HEAD") {
      const described = await channels.describeLink(token);
      if (!described.ok) page(res, 410, "Nothing to do", `<p>${escapeHtml(described.message)}</p>`);
      else page(res, 200, described.view.title, confirmation(described.view));
      return true;
    }
    if (req.method !== "POST") {
      page(res, 405, "Not allowed", "<p>Open the link from the email.</p>");
      return true;
    }
    const form = await readForm(req);
    if (form === undefined) {
      res.setHeader("connection", "close");
      // Nothing more of an oversized body is read once the refusal is out.
      res.on("finish", () => req.destroy());
      page(res, 413, "Not accepted", "<p>The form was too large.</p>");
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
    page(res, outcome.ok ? 200 : 409, outcome.ok ? "Done" : "Not done", `<p>${escapeHtml(outcome.message)}</p>`);
    return true;
  };
}
