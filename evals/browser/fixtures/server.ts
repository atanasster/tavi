import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * Deterministic local HTTP fixture server ("mini-web") for browser qualification.
 *
 * Starts two local HTTP origins on the loopback address: `origin` on
 * `127.0.0.1` and `crossOrigin` on `localhost`, another site, so same-origin
 * and cross-site (out-of-process) frames, popups and cross-site navigation
 * transitions can be tested without touching the public internet. Every action
 * mutates server-held state (`state`), so tests assert what actually happened
 * on the server rather than relying on a model judge.
 *
 * Erasable TypeScript only so `node` can execute it directly without a build step.
 */

export interface MiniWebState {
  spaClicked: string[];
  spaRoute: string;
  chosenRow: string | undefined;
  frameInputs: {
    sameOrigin?: string;
    crossOrigin?: string;
    paid: string[];
  };
  submissions: { kind: string; fields: Record<string, string> }[];
  dialogs: { kind: string; outcome: string }[];
  secretsPosted: Record<string, string>[];
  oauthToken: string | undefined;
  coveredClicks: number;
  noopClicks: number;
  scrollBatches: number;
  downloadsServed: string[];
  twoStep: {
    step1?: Record<string, string>;
    finalSubmitted: boolean;
  };
  canvasClicks: number;
  canvasSliderValue: number;
  canvasCommitted: boolean;
  settings: { weeklyDigest: boolean };
  /** Action-tool tasks (plan G3): what each fixture page below recorded. */
  uploads: { field: string; filename: string; content: string }[];
  catalogListViews: number;
  catalogDetailViews: string[];
  promoCodes: string[];
  cart: string[];
  savedAddress: Record<string, string> | undefined;
  feedPagesServed: number[];
}

export interface MiniWebServer {
  readonly origin: string;
  readonly host: string;
  readonly crossOrigin: string;
  readonly crossHost: string;
  readonly state: MiniWebState;
  reset(): void;
  close(): Promise<void>;
}

function freshState(): MiniWebState {
  return {
    spaClicked: [],
    spaRoute: "/spa",
    chosenRow: undefined,
    frameInputs: { paid: [] },
    submissions: [],
    dialogs: [],
    secretsPosted: [],
    oauthToken: undefined,
    coveredClicks: 0,
    noopClicks: 0,
    scrollBatches: 0,
    downloadsServed: [],
    twoStep: { finalSubmitted: false },
    canvasClicks: 0,
    canvasSliderValue: 10,
    canvasCommitted: false,
    settings: { weeklyDigest: true },
    uploads: [],
    catalogListViews: 0,
    catalogDetailViews: [],
    promoCodes: [],
    cart: [],
    savedAddress: undefined,
    feedPagesServed: [],
  };
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function parseForm(body: string, url: URL): Record<string, string> {
  const out: Record<string, string> = {};
  const params = body.trim().startsWith("{")
    ? new URLSearchParams(Object.entries(JSON.parse(body) as Record<string, string>))
    : new URLSearchParams(body || url.search.slice(1));
  for (const [key, value] of params.entries()) out[key] = value;
  return out;
}

function escapeHtml(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

function html(res: ServerResponse, body: string, status = 200): void {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  res.end(`<!doctype html><html><head><meta charset="utf-8"><title>MiniWeb</title></head><body>${body}</body></html>`);
}

function json(res: ServerResponse, payload: unknown, status = 200): void {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(payload));
}

function buildMinimalPdf(text: string): Buffer {
  const escaped = text.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
  const stream = `BT /F1 12 Tf 72 720 Td (${escaped}) Tj ET`;
  const objects = [
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
    "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
    "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>\nendobj\n",
    `4 0 obj\n<< /Length ${Buffer.byteLength(stream, "latin1")} >>\nstream\n${stream}\nendstream\nendobj\n`,
    "5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n",
  ];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [0];
  for (const obj of objects) {
    offsets.push(Buffer.byteLength(out, "latin1"));
    out += obj;
  }
  const xrefStart = Buffer.byteLength(out, "latin1");
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i < offsets.length; i += 1) {
    out += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  }
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

/** The file parts of a small `multipart/form-data` body: each part's field name, file name and text. */
function parseMultipart(body: string, contentType: string): { field: string; filename: string; content: string }[] {
  const boundary = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  const marker = boundary?.[1] ?? boundary?.[2];
  if (marker === undefined) return [];
  const files: { field: string; filename: string; content: string }[] = [];
  for (const part of body.split(`--${marker}`)) {
    const split = part.indexOf("\r\n\r\n");
    if (split === -1) continue;
    const head = part.slice(0, split);
    const filename = /filename="([^"]*)"/i.exec(head)?.[1];
    if (filename === undefined || filename === "") continue;
    const field = /name="([^"]*)"/i.exec(head)?.[1] ?? "";
    files.push({ field, filename, content: part.slice(split + 4).replace(/\r\n$/, "") });
  }
  return files;
}

/** The catalog's lamps (`/catalog`): the list names them, only each one's own page gives its price. */
export const CATALOG_LAMPS = [
  { id: "aurora", name: "Aurora desk lamp", price: "$64.00" },
  { id: "boreal", name: "Boreal desk lamp", price: "$58.50" },
  { id: "cirrus", name: "Cirrus desk lamp", price: "$71.25" },
  { id: "dune", name: "Dune desk lamp", price: "$59.90" },
] as const;

/** The stale-ref shop's products (`/stale`), listed by name first; "Sort by price" rebuilds every row. */
export const STALE_PRODUCTS = [
  { id: "blue-kettle", name: "Blue Kettle", price: 49 },
  { id: "copper-pan", name: "Copper Pan", price: 35 },
  { id: "glass-teapot", name: "Glass Teapot", price: 22 },
  { id: "steel-wok", name: "Steel Wok", price: 61 },
] as const;

/** The infinite feed (`/feed`): pages of ten posts, loaded as the reader scrolls; post 37 is on page 4. */
export const FEED_PAGES = 6;
export const FEED_PAGE_SIZE = 10;
export const FEED_TARGET = { post: 37, title: "Lighthouse keeper's logbook" } as const;
export function feedPost(post: number): { readonly post: number; readonly title: string } {
  return { post, title: post === FEED_TARGET.post ? FEED_TARGET.title : `Field note ${post}` };
}

async function listenOnLoopback(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
  hostname = "127.0.0.1",
): Promise<{
  server: Server;
  origin: string;
  host: string;
}> {
  const server = createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address() as AddressInfo;
  const host = `${hostname}:${address.port}`;
  return { server, origin: `http://${host}`, host };
}

export async function startMiniWebServer(): Promise<MiniWebServer> {
  let state = freshState();
  let primaryOrigin = "";
  let secondaryOrigin = "";

  const handleRequest = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? "/", primaryOrigin || "http://127.0.0.1");
    const method = req.method ?? "GET";

    if (method === "OPTIONS") {
      res.writeHead(204, {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET, POST, OPTIONS",
        "access-control-allow-headers": "content-type",
      });
      res.end();
      return;
    }

    if (url.pathname === "/state" && method === "GET") {
      json(res, state);
      return;
    }

    // 1. SPA page that prepends a sibling button and supports history.pushState
    if (url.pathname === "/spa" && method === "GET") {
      html(
        res,
        `<main>
          <h1>SPA Controls</h1>
          <div id="list">
            <button id="alpha" type="button" onclick="recordClick('Alpha')">Alpha</button>
            <button id="beta" type="button" onclick="recordClick('Beta')">Beta</button>
          </div>
          <button id="prepend" type="button" onclick="prependButton()">Insert Above</button>
          <button id="push-route" type="button" onclick="pushRoute()">Navigate Client Route</button>
          <p role="status" id="spa-status">Ready</p>
        </main>
        <script>
          function prependButton() {
            const list = document.getElementById('list');
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.textContent = 'Inserted';
            btn.onclick = () => recordClick('Inserted');
            list.insertBefore(btn, list.firstChild);
            document.getElementById('spa-status').textContent = 'Inserted node';
          }
          function pushRoute() {
            history.pushState({}, '', '/spa/step-2');
            document.getElementById('list').innerHTML = '<button type="button" onclick="recordClick(\\'Step2Only\\')">Step 2 Action</button>';
            fetch('/spa/route', { method: 'POST', body: 'route=/spa/step-2' });
          }
          function recordClick(label) {
            fetch('/spa/click', { method: 'POST', body: 'label=' + encodeURIComponent(label) })
              .then(() => { document.getElementById('spa-status').textContent = 'Clicked ' + label; });
          }
        </script>`,
      );
      return;
    }
    if (url.pathname === "/spa/click" && method === "POST") {
      const fields = parseForm(await readBody(req), url);
      if (fields["label"]) state.spaClicked.push(fields["label"]);
      json(res, { ok: true });
      return;
    }
    if (url.pathname === "/spa/route" && method === "POST") {
      const fields = parseForm(await readBody(req), url);
      if (fields["route"]) state.spaRoute = fields["route"];
      json(res, { ok: true });
      return;
    }

    // 2. Repeated "Select" buttons across distinct rows
    if (url.pathname === "/rows" && method === "GET") {
      html(
        res,
        `<main>
          <h1>Available Fares</h1>
          <table>
            <tbody>
              <tr data-row="fare-1">
                <td>Fare 1 · Morning · $120</td>
                <td><button type="button" onclick="choose('fare-1')">Select</button></td>
              </tr>
              <tr data-row="fare-2">
                <td>Fare 2 · Midday · $210</td>
                <td><button type="button" onclick="choose('fare-2')">Select</button></td>
              </tr>
              <tr data-row="fare-3">
                <td>Fare 3 · Evening · $300</td>
                <td><button type="button" onclick="choose('fare-3')">Select</button></td>
              </tr>
            </tbody>
          </table>
          <p role="status" id="row-status">None selected</p>
        </main>
        <script>
          function choose(id) {
            fetch('/rows/choose', { method: 'POST', body: 'row=' + encodeURIComponent(id) })
              .then(() => { document.getElementById('row-status').textContent = 'Selected ' + id; });
          }
        </script>`,
      );
      return;
    }
    if (url.pathname === "/rows/choose" && method === "POST") {
      const fields = parseForm(await readBody(req), url);
      state.chosenRow = fields["row"];
      json(res, { chosenRow: state.chosenRow });
      return;
    }

    // 3. Same-origin and cross-origin iframes with an input and a "Pay" button
    if (url.pathname === "/frames" && method === "GET") {
      html(
        res,
        `<main>
          <h1>Embedded Checkout Frames</h1>
          <iframe id="same-frame" title="Same Origin Widget" src="${primaryOrigin}/frame-inner?origin=same" width="420" height="180"></iframe>
          <iframe id="cross-frame" title="Cross Origin Widget" src="${secondaryOrigin}/frame-inner?origin=cross" width="420" height="180"></iframe>
        </main>`,
      );
      return;
    }
    if (url.pathname === "/frame-inner" && method === "GET") {
      const which = url.searchParams.get("origin") === "cross" ? "cross" : "same";
      html(
        res,
        `<section>
          <h2>Frame (${which})</h2>
          <label for="note-${which}">Note (${which})</label>
          <input id="note-${which}" name="note" type="text" placeholder="Frame note ${which}" />
          <label for="eeo-${which}">Gender</label>
          <input id="eeo-${which}" name="eeo_gender" type="text" />
          <button id="save-${which}" type="button" onclick="saveNote()">Save Note</button>
          <button id="pay-${which}" type="button" onclick="payNow()">Pay</button>
          <label for="card-${which}">Card number</label>
          <input id="card-${which}" name="card-number" type="text" />
          <button id="demo-card-${which}" type="button" onclick="document.getElementById('card-${which}').value = '4242 4242 4242 4242'">Use demo card</button>
          <p role="status" id="frame-status">Idle</p>
          ${which === "cross" ? `<iframe title="Nested widget" srcdoc="<p>Nested widget text</p>" width="200" height="60"></iframe>` : ""}
        </section>
        <script>
          function saveNote() {
            const val = document.getElementById('note-${which}').value;
            fetch('${primaryOrigin}/frames/record', {
              method: 'POST',
              body: new URLSearchParams({ origin: '${which}', note: val }).toString()
            }).then(() => { document.getElementById('frame-status').textContent = 'Saved ' + val; });
          }
          function payNow() {
            fetch('${primaryOrigin}/frames/record', {
              method: 'POST',
              body: new URLSearchParams({ origin: '${which}', paid: '1' }).toString()
            }).then(() => { document.getElementById('frame-status').textContent = 'Paid'; });
          }
        </script>`,
      );
      return;
    }
    if (url.pathname === "/frames/record" && method === "POST") {
      const fields = parseForm(await readBody(req), url);
      if (fields["note"] !== undefined) {
        if (fields["origin"] === "cross") state.frameInputs.crossOrigin = fields["note"];
        else state.frameInputs.sameOrigin = fields["note"];
      }
      if (fields["paid"] === "1" && fields["origin"]) {
        state.frameInputs.paid.push(fields["origin"]);
      }
      json(res, { ok: true });
      return;
    }

    // 4. Multilingual/unlabelled submit buttons and a strict search form
    if (url.pathname === "/submits" && method === "GET") {
      html(
        res,
        `<main>
          <h1>Commit and Search Forms</h1>
          <form id="post-form" action="/submits/record?kind=post" method="POST">
            <input type="text" name="body" value="hello" />
            <button type="submit">Post</button>
          </form>
          <form id="weiter-form" action="/submits/record?kind=weiter" method="POST">
            <input type="text" name="step" value="next" />
            <button type="submit">Weiter</button>
          </form>
          <form id="comprar-form" action="/submits/record?kind=comprar" method="POST">
            <input type="text" name="item" value="ticket" />
            <button type="submit">Comprar</button>
          </form>
          <form id="authorize-form" action="/submits/record?kind=authorize" method="POST">
            <input type="text" name="scope" value="read" />
            <button type="submit">Authorize</button>
          </form>
          <form id="icon-form" action="/submits/record?kind=icon" method="POST">
            <input type="text" name="message" value="ping" />
            <button type="submit"><svg width="12" height="12" aria-hidden="true"></svg></button>
          </form>
          <form id="checkout-form" action="/submits/record?kind=checkout" method="POST">
            <label for="country-select">Country</label>
            <select id="country-select" name="country"><option>Portugal</option><option>Spain</option></select>
            <input type="email" name="email" aria-label="Email" />
          </form>
          <form id="search-form" role="search" action="/submits/record?kind=search" method="POST">
            <label for="dest-input">Destination</label>
            <input id="dest-input" type="text" name="destination" placeholder="Where to?" />
            <button type="submit">Search</button>
          </form>
        </main>`,
      );
      return;
    }
    // A popup that closes by itself a moment after it opens, as a payment window does once it is done.
    if (url.pathname === "/self-closing" && method === "GET") {
      html(
        res,
        `<main><h1>Pay</h1><button type="button" onclick="window.open('/closes-soon', '_blank')">Open payment window</button></main>`,
      );
      return;
    }
    if (url.pathname === "/closes-soon" && method === "GET") {
      html(res, `<main><h1>Paying</h1><button type="button">Wait</button></main><script>setTimeout(() => window.close(), 800);</script>`);
      return;
    }
    // A long article that never grows as it is scrolled.
    if (url.pathname === "/long" && method === "GET") {
      html(res, `<main><h1>Long read</h1><div style="height:12000px">Text</div><p>The end</p></main>`);
      return;
    }
    // A page that raises an alert while a popup it opened is the active tab: it must not hang behind it.
    if (url.pathname === "/background-dialog" && method === "GET") {
      html(
        res,
        `<main>
          <h1>Helper</h1>
          <button type="button" onclick="openHelper()">Open helper</button>
        </main>
        <script>
          function openHelper() {
            window.open('/submits', '_blank');
            setTimeout(() => {
              alert('Background notice');
              fetch('/dialogs/record', { method: 'POST', body: 'kind=background&outcome=answered' });
            }, 1500);
          }
        </script>`,
      );
      return;
    }
    // An account setting the person can change: a checkbox and its Save.
    if (url.pathname === "/settings" && method === "GET") {
      html(
        res,
        `<main>
          <h1>Notification settings</h1>
          <form action="/settings" method="POST">
            <label><input type="checkbox" name="weeklyDigest" ${state.settings.weeklyDigest ? "checked" : ""} /> Email me a weekly digest</label>
            <button type="submit">Save settings</button>
          </form>
          <p role="status">${state.settings.weeklyDigest ? "Weekly digest on" : "Weekly digest off"}</p>
        </main>`,
      );
      return;
    }
    if (url.pathname === "/settings" && method === "POST") {
      const fields = parseForm(await readBody(req), url);
      state.settings = { weeklyDigest: fields["weeklyDigest"] === "on" };
      html(res, `<p role="status">Saved: weekly digest ${state.settings.weeklyDigest ? "on" : "off"}</p>`);
      return;
    }
    // A page whose script replaces the canvas encoder: what it would hand back instead of an image.
    if (url.pathname === "/tamper-canvas" && method === "GET") {
      html(
        res,
        `<main>
          <h1>Gallery</h1>
          <button type="button">Next picture</button>
        </main>
        <script>
          OffscreenCanvas.prototype.convertToBlob = async () => new Blob(["TAMPERED"], { type: "image/jpeg" });
        </script>`,
      );
      return;
    }
    // A search form whose button turns into a commit after the page was observed.
    if (url.pathname === "/submits/swap" && method === "GET") {
      html(
        res,
        `<main>
          <h1>Search</h1>
          <form id="swap-form" role="search" action="/submits/record?kind=swap" method="POST">
            <label for="swap-input">Destination</label>
            <input id="swap-input" type="text" name="destination" value="Lisbon" />
            <button id="swap-submit" type="submit" style="position:fixed;left:20px;top:200px;width:120px;height:40px">Search</button>
          </form>
          <button id="swap-trigger" type="button" onclick="document.getElementById('swap-submit').textContent = 'Pay'">Show prices</button>
        </main>`,
      );
      return;
    }
    if (url.pathname === "/submits/record" && method === "POST") {
      const kind = url.searchParams.get("kind") ?? "unknown";
      const fields = parseForm(await readBody(req), url);
      state.submissions.push({ kind, fields });
      html(res, `<p role="status">Submitted ${escapeHtml(kind)}</p>`);
      return;
    }

    // 5. JS dialogs: alert, confirm, prompt, beforeunload
    if (url.pathname === "/dialogs" && method === "GET") {
      html(
        res,
        `<main>
          <h1>Dialog Triggers</h1>
          <button id="btn-alert" type="button" onclick="runAlert()">Trigger Alert</button>
          <button id="btn-confirm" type="button" onclick="runConfirm()">Delete Item</button>
          <button id="btn-prompt" type="button" onclick="runPrompt()">Rename Item</button>
          <p role="status" id="dialog-status">None</p>
        </main>
        <script>
          window.addEventListener('beforeunload', (event) => {
            event.preventDefault();
            event.returnValue = '';
          });
          function report(kind, outcome) {
            fetch('/dialogs/record', {
              method: 'POST',
              body: new URLSearchParams({ kind, outcome: String(outcome) }).toString()
            }).then(() => {
              document.getElementById('dialog-status').textContent = kind + ':' + outcome;
            });
          }
          function runAlert() {
            alert('Notice: session active');
            report('alert', 'accepted');
          }
          function runConfirm() {
            const ok = confirm('Permanently delete this record?');
            report('confirm', ok ? 'accepted' : 'dismissed');
          }
          function runPrompt() {
            const val = prompt('Enter new name:');
            report('prompt', val === null ? 'dismissed' : val);
          }
        </script>`,
      );
      return;
    }
    if (url.pathname === "/dialogs/record" && method === "POST") {
      const fields = parseForm(await readBody(req), url);
      state.dialogs.push({ kind: fields["kind"] ?? "unknown", outcome: fields["outcome"] ?? "" });
      json(res, { ok: true });
      return;
    }

    // 6. Password and one-time-code secret fields
    if (url.pathname === "/secrets" && method === "GET") {
      html(
        res,
        `<main>
          <h1>Sign In & Verification</h1>
          <form action="/secrets/submit" method="POST">
            <label for="user-field">Username</label>
            <input id="user-field" name="username" type="text" autocomplete="username" />
            <label for="pass-field">Password</label>
            <input id="pass-field" name="password" type="password" autocomplete="current-password" />
            <label for="otp-field">Verification code</label>
            <input id="otp-field" name="otp" type="text" autocomplete="one-time-code" />
            <button type="submit">Continue</button>
          </form>
        </main>`,
      );
      return;
    }
    if (url.pathname === "/secrets/submit" && method === "POST") {
      state.secretsPosted.push(parseForm(await readBody(req), url));
      html(res, `<p role="status">Posted credentials</p>`);
      return;
    }

    // 7. OAuth popup that postMessages its opener and closes
    if (url.pathname === "/oauth" && method === "GET") {
      html(
        res,
        `<main>
          <h1>Connect Account</h1>
          <button id="open-oauth" type="button" onclick="window.open('/oauth-popup', 'oauth', 'width=400,height=300')">Sign in with Provider</button>
          <p role="status" id="oauth-status">Waiting</p>
        </main>
        <script>
          window.addEventListener('message', (event) => {
            if (event.data && event.data.token) {
              fetch('/oauth/record', { method: 'POST', body: 'token=' + encodeURIComponent(event.data.token) })
                .then(() => { document.getElementById('oauth-status').textContent = 'Connected: ' + event.data.token; });
            }
          });
        </script>`,
      );
      return;
    }
    if (url.pathname === "/oauth-popup" && method === "GET") {
      html(
        res,
        `<main>
          <h1>Provider Consent</h1>
          <button id="complete-oauth" type="button" onclick="finish()">Allow Access</button>
        </main>
        <script>
          function finish() {
            if (window.opener && !window.opener.closed) {
              window.opener.postMessage({ token: 'oauth-token-77' }, '*');
            }
            window.close();
          }
        </script>`,
      );
      return;
    }
    if (url.pathname === "/oauth/record" && method === "POST") {
      const fields = parseForm(await readBody(req), url);
      state.oauthToken = fields["token"];
      json(res, { ok: true });
      return;
    }

    // 7b. Results page with target="_blank" links for multi-tab round trip
    if (url.pathname === "/results" && method === "GET") {
      html(
        res,
        `<main>
          <h1>Search Results</h1>
          <a id="result-1" href="/results/item-1" target="_blank">Result One</a>
          <a id="result-2" href="/results/item-2" target="_blank">Result Two</a>
        </main>`,
      );
      return;
    }
    if (url.pathname === "/results/item-1" && method === "GET") {
      html(
        res,
        `<main>
          <h1>Result One Detail</h1>
          <p>Detail for result one.</p>
        </main>`,
      );
      return;
    }
    if (url.pathname === "/results/item-2" && method === "GET") {
      html(
        res,
        `<main>
          <h1>Result Two Detail</h1>
          <p>Detail for result two.</p>
        </main>`,
      );
      return;
    }

    // 8. Covered button (obscured by a fixed modal overlay)
    if (url.pathname === "/covered" && method === "GET") {
      html(
        res,
        `<main>
          <h1>Action Behind Modal</h1>
          <button id="underneath" type="button" onclick="fetch('/covered/click', { method: 'POST' })">Continue</button>
          <div role="dialog" aria-label="Sign in" style="position:fixed;inset:0;background:rgba(0,0,0,0.8);display:flex;align-items:center;justify-content:center;z-index:9999;">
            <p>Please sign in first</p>
          </div>
        </main>`,
      );
      return;
    }
    if (url.pathname === "/covered/click" && method === "POST") {
      state.coveredClicks += 1;
      json(res, { clicked: state.coveredClicks });
      return;
    }

    // 9. Infinite scroll and no-op button
    if (url.pathname === "/loops" && method === "GET") {
      html(
        res,
        `<main>
          <h1>Feed</h1>
          <button id="noop-btn" type="button" onclick="fetch('/loops/noop', { method: 'POST' })">Refresh Feed</button>
          <div id="feed">
            <div style="height:1100px;">Item 1</div>
          </div>
        </main>
        <script>
          let batches = 0;
          const maxBatches = Number(new URLSearchParams(location.search).get('batches') ?? '2');
          window.addEventListener('scroll', () => {
            if (batches < maxBatches && window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 300) {
              batches += 1;
              fetch('/loops/scroll', { method: 'POST' });
              const div = document.createElement('div');
              div.style.height = '600px';
              div.textContent = 'More items loaded ' + batches;
              document.getElementById('feed').appendChild(div);
            }
          });
        </script>`,
      );
      return;
    }
    if (url.pathname === "/loops/noop" && method === "POST") {
      state.noopClicks += 1;
      json(res, { noopClicks: state.noopClicks });
      return;
    }
    if (url.pathname === "/loops/scroll" && method === "POST") {
      state.scrollBatches += 1;
      json(res, { scrollBatches: state.scrollBatches });
      return;
    }

    // 10. Downloads: click-triggered download, PDF response, and oversized download
    if (url.pathname === "/downloads" && method === "GET") {
      html(
        res,
        `<main>
          <h1>Exports</h1>
          <button id="click-download" type="button" onclick="window.location.href='/files/report.csv'">Export CSV</button>
          <a id="direct-download" href="/files/report.csv" download="report.csv">Direct CSV Link</a>
          <a id="pdf-link" href="/files/statement.pdf">View Statement PDF</a>
          <a id="large-download" href="/files/oversized.bin" download="oversized.bin">Download Oversized Archive</a>
          <a id="chunked-download" href="/files/chunked.bin" download="chunked.bin">Download Streamed Archive</a>
        </main>`,
      );
      return;
    }
    if (url.pathname === "/files/report.csv" && method === "GET") {
      state.downloadsServed.push("report.csv");
      res.writeHead(200, {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": 'attachment; filename="report.csv"',
      });
      res.end("id,amount\n1,42.00\n");
      return;
    }
    if (url.pathname === "/files/statement.pdf" && method === "GET") {
      state.downloadsServed.push("statement.pdf");
      const pdfBytes = buildMinimalPdf("Quarterly Statement: Paid $42.00");
      res.writeHead(200, {
        "content-type": "application/pdf",
        "content-length": String(pdfBytes.byteLength),
      });
      res.end(pdfBytes);
      return;
    }
    if (url.pathname === "/files/chunked.bin" && method === "GET") {
      // 2 MiB sent in chunks, with no Content-Length: only its body says how large it is.
      state.downloadsServed.push("chunked.bin");
      res.writeHead(200, {
        "content-type": "application/octet-stream",
        "content-disposition": 'attachment; filename="chunked.bin"',
      });
      for (let chunk = 0; chunk < 32; chunk += 1) res.write(Buffer.alloc(64 * 1024, 0x62));
      res.end();
      return;
    }
    if (url.pathname === "/files/oversized.bin" && method === "GET") {
      state.downloadsServed.push("oversized.bin");
      const declaredBytes = 300 * 1024 * 1024;
      res.writeHead(200, {
        "content-type": "application/octet-stream",
        "content-disposition": 'attachment; filename="oversized.bin"',
        "content-length": String(declaredBytes),
      });
      res.write(Buffer.alloc(64 * 1024, 0x61));
      res.end();
      return;
    }

    // 11. Cross-site click landing on a page with a cookie banner
    if (url.pathname === "/cross-site" && method === "GET") {
      html(
        res,
        `<main>
          <h1>Directory</h1>
          <a id="go-partner" href="${secondaryOrigin}/with-banner">Visit Partner Site</a>
        </main>`,
      );
      return;
    }
    if (url.pathname === "/with-banner" && method === "GET") {
      html(
        res,
        `<main>
          <h1>Partner Destination</h1>
          <div id="cookie-banner" role="dialog" aria-label="Cookie consent">
            <p>We use cookies for analytics.</p>
            <button id="reject-cookies" type="button" onclick="declineCookies()">Reject all</button>
            <button id="accept-cookies" type="button">Accept all</button>
          </div>
          <p id="partner-content">Partner article body.</p>
        </main>
        <script>
          function declineCookies() {
            const banner = document.getElementById('cookie-banner');
            if (banner) banner.remove();
            fetch('${primaryOrigin}/with-banner/declined', { method: 'POST' });
          }
        </script>`,
      );
      return;
    }

    // 12. Two-page wizard whose second page is a gated final checkout step
    if (url.pathname === "/wizard/step1" && method === "GET") {
      html(
        res,
        `<main>
          <h1>Shipping Details</h1>
          <form action="/wizard/step1" method="POST">
            <label for="recipient">Recipient</label>
            <input id="recipient" name="recipient" type="text" />
            <label for="city">City</label>
            <input id="city" name="city" type="text" />
            <button type="submit">Continue to review</button>
          </form>
        </main>`,
      );
      return;
    }
    if (url.pathname === "/wizard/step1" && method === "POST") {
      state.twoStep.step1 = parseForm(await readBody(req), url);
      res.writeHead(303, { location: "/wizard/checkout" });
      res.end();
      return;
    }
    if (url.pathname === "/wizard/checkout" && method === "GET") {
      html(
        res,
        `<main>
          <h1>Review and Place Order</h1>
          <p>Recipient: ${escapeHtml(state.twoStep.step1?.["recipient"] ?? "none")}</p>
          <form action="/wizard/checkout" method="POST">
            <button id="place-order" type="submit">Place order</button>
          </form>
        </main>`,
      );
      return;
    }
    if (url.pathname === "/wizard/checkout" && method === "POST") {
      state.twoStep.finalSubmitted = true;
      html(res, `<p role="status">Order placed</p>`);
      return;
    }
    if (url.pathname === "/with-banner/declined" && method === "POST") {
      json(res, { ok: true });
      return;
    }

    // 13. Slider drag, drag-to-ref, horizontal carousel scroll, and mode: "keys" clear
    if (url.pathname === "/primitives" && method === "GET") {
      html(
        res,
        `<main>
          <h1>Interactive Controls</h1>
          <label for="volume-slider">Volume</label>
          <input id="volume-slider" type="range" min="0" max="100" value="20" style="width:200px;" oninput="document.getElementById('slider-status').textContent = 'Volume: ' + this.value" />
          <p role="status" id="slider-status">Volume: 20</p>
          <div style="display:flex;gap:40px;margin:16px 0;">
            <button id="drag-chip" type="button" onmousedown="window.__draggingChip = true">Drag Chip</button>
            <button id="drop-zone" type="button" onmouseup="if (window.__draggingChip) { window.__draggingChip = false; document.getElementById('drop-status').textContent = 'Dropped on zone'; }">Drop Zone</button>
          </div>
          <p role="status" id="drop-status">Not dropped</p>
          <div id="carousel" style="width:220px;overflow-x:auto;display:flex;gap:20px;white-space:nowrap;">
            <button id="slide-1" type="button" style="min-width:180px;flex-shrink:0;">Slide 1</button>
            <button id="slide-2" type="button" style="min-width:180px;flex-shrink:0;">Slide 2</button>
            <button id="slide-3" type="button" style="min-width:180px;flex-shrink:0;">Slide 3</button>
          </div>
          <label for="query-box">Query</label>
          <input id="query-box" type="text" value="seed" />
        </main>`,
      );
      return;
    }

    // 14. Fixed-position canvas, range slider, and commit button for vision_act adapter qualification
    if (url.pathname === "/canvas" && method === "GET") {
      html(
        res,
        `<main style="margin:0;padding:0;">
          <canvas id="draw-canvas" width="200" height="100" style="position:fixed;left:40px;top:40px;width:200px;height:100px;border:1px solid #000;" onclick="fetch('/canvas/record', { method: 'POST', body: 'clicked=1' })"></canvas>
          <input id="canvas-slider" type="range" min="0" max="100" value="10" aria-label="Canvas intensity" style="position:fixed;left:40px;top:160px;width:200px;height:24px;" oninput="fetch('/canvas/record', { method: 'POST', body: 'slider=' + encodeURIComponent(this.value) })" />
          <button id="canvas-commit" type="button" style="position:fixed;left:40px;top:210px;width:140px;height:36px;" onclick="fetch('/canvas/record', { method: 'POST', body: 'committed=1' })">Place order</button>
        </main>`,
      );
      return;
    }
    if (url.pathname === "/canvas/record" && method === "POST") {
      const fields = parseForm(await readBody(req), url);
      if (fields["clicked"] === "1") state.canvasClicks += 1;
      if (fields["slider"] !== undefined) state.canvasSliderValue = Number(fields["slider"]);
      if (fields["committed"] === "1") state.canvasCommitted = true;
      json(res, { ok: true });
      return;
    }

    // 15. File upload: a multipart form whose file the server keeps (name and text).
    if (url.pathname === "/upload" && method === "GET") {
      html(
        res,
        `<main>
          <h1>Upload a receipt</h1>
          <form action="/upload" method="POST" enctype="multipart/form-data">
            <label for="receipt-file">Receipt file</label>
            <input id="receipt-file" name="receipt" type="file" />
            <button type="submit">Upload receipt</button>
          </form>
        </main>`,
      );
      return;
    }
    if (url.pathname === "/upload" && method === "POST") {
      const files = parseMultipart(await readBody(req), req.headers["content-type"] ?? "");
      state.uploads.push(...files);
      html(
        res,
        `<p role="status">${files.length === 0 ? "No file received" : files.map((file) => `Uploaded ${escapeHtml(file.filename)} (${Buffer.byteLength(file.content)} bytes)`).join("; ")}</p>`,
      );
      return;
    }

    // 16. List and detail: the list names the lamps, each detail page its price (open each in a tab).
    if (url.pathname === "/catalog" && method === "GET") {
      state.catalogListViews += 1;
      html(
        res,
        `<main>
          <h1>Desk lamps</h1>
          <p>Prices are on each lamp's own page.</p>
          <ul>${CATALOG_LAMPS.map((lamp) => `<li><a href="/catalog/${lamp.id}">${lamp.name}</a></li>`).join("")}</ul>
        </main>`,
      );
      return;
    }
    const lamp = /^\/catalog\/([a-z]+)$/.exec(url.pathname)?.[1];
    if (lamp !== undefined && method === "GET") {
      const found = CATALOG_LAMPS.find((entry) => entry.id === lamp);
      if (found !== undefined) {
        state.catalogDetailViews.push(found.id);
        html(res, `<main><h1>${found.name}</h1><p>Price: <strong>${found.price}</strong></p><p>In stock.</p></main>`);
        return;
      }
    }

    // 17. A coupon widget in an iframe, its field and button inside an open shadow root.
    if (url.pathname === "/widgets" && method === "GET") {
      html(
        res,
        `<main>
          <h1>Your basket</h1>
          <p>Basket total: $120.00</p>
          <iframe id="coupon-frame" title="Coupon widget" src="/widgets/coupon" width="460" height="200"></iframe>
        </main>`,
      );
      return;
    }
    if (url.pathname === "/widgets/coupon" && method === "GET") {
      html(
        res,
        `<coupon-box></coupon-box>
        <script>
          customElements.define('coupon-box', class extends HTMLElement {
            connectedCallback() {
              const root = this.attachShadow({ mode: 'open' });
              root.innerHTML = '<section><h2>Coupon</h2><label for="code">Promo code</label> <input id="code" type="text" /> <button id="apply" type="button">Apply code</button><p role="status" id="coupon-status">No code applied</p></section>';
              root.getElementById('apply').addEventListener('click', () => {
                const code = root.getElementById('code').value.trim();
                fetch('/widgets/apply', { method: 'POST', body: new URLSearchParams({ code }).toString() })
                  .then((response) => response.json())
                  .then((result) => {
                    root.getElementById('coupon-status').textContent = result.discount ? 'Code ' + code + ' applied: ' + result.discount + ' off' : 'Code ' + code + ' is not valid';
                  });
              });
            }
          });
        </script>`,
      );
      return;
    }
    if (url.pathname === "/widgets/apply" && method === "POST") {
      const code = (parseForm(await readBody(req), url)["code"] ?? "").toUpperCase();
      state.promoCodes.push(code);
      json(res, code === "SPRING26" ? { discount: "15%" } : {});
      return;
    }

    // 18. Stale refs after find: "Sort by price" rebuilds every row, so a ref (or a spot) found before it points elsewhere.
    if (url.pathname === "/stale" && method === "GET") {
      const row = (product: (typeof STALE_PRODUCTS)[number]): string =>
        `<tr><td>${product.name} · $${product.price}</td><td><button type="button" data-item="${product.id}">Add to cart</button></td></tr>`;
      html(
        res,
        `<main>
          <h1>Kitchen shop</h1>
          <button id="sort-price" type="button">Sort by price</button>
          <table><tbody id="products">${STALE_PRODUCTS.map(row).join("")}</tbody></table>
          <p role="status" id="cart-status">Cart: empty</p>
        </main>
        <script>
          const products = ${JSON.stringify(STALE_PRODUCTS)};
          const body = document.getElementById('products');
          body.addEventListener('click', (event) => {
            const item = event.target.closest('button[data-item]')?.dataset.item;
            if (!item) return;
            fetch('/stale/add', { method: 'POST', body: 'item=' + encodeURIComponent(item) })
              .then((response) => response.json())
              .then((result) => { document.getElementById('cart-status').textContent = 'Cart: ' + result.cart.join(', '); });
          });
          document.getElementById('sort-price').addEventListener('click', () => {
            body.innerHTML = [...products].sort((a, b) => a.price - b.price)
              .map((p) => '<tr><td>' + p.name + ' · $' + p.price + '</td><td><button type="button" data-item="' + p.id + '">Add to cart</button></td></tr>')
              .join('');
          });
        </script>`,
      );
      return;
    }
    if (url.pathname === "/stale/add" && method === "POST") {
      const item = parseForm(await readBody(req), url)["item"];
      if (item !== undefined) state.cart.push(item);
      json(res, { cart: state.cart });
      return;
    }

    // 19. Stale refs after a scoped observe: the dialog's Business tab replaces its fields with new ones.
    if (url.pathname === "/address" && method === "GET") {
      html(
        res,
        `<main>
          <h1>Account</h1>
          <p>Shipping address: none</p>
          <button id="edit-address" type="button">Edit address</button>
          <p role="status" id="address-status">Not saved</p>
        </main>
        <script>
          const fieldsFor = {
            home: [['street', 'Street'], ['city', 'City']],
            business: [['company', 'Company'], ['street', 'Street'], ['city', 'City']],
          };
          let kind = 'home';
          function renderFields(dialog) {
            dialog.querySelector('#address-fields').innerHTML = fieldsFor[kind]
              .map(([name, label]) => '<label for="addr-' + name + '">' + label + '</label> <input id="addr-' + name + '" name="' + name + '" type="text" /><br />')
              .join('');
            for (const tab of dialog.querySelectorAll('[role=tab]')) tab.setAttribute('aria-selected', String(tab.dataset.kind === kind));
          }
          document.getElementById('edit-address').addEventListener('click', () => {
            if (document.getElementById('address-dialog')) return;
            const dialog = document.createElement('div');
            dialog.id = 'address-dialog';
            dialog.setAttribute('role', 'dialog');
            dialog.setAttribute('aria-modal', 'true');
            dialog.setAttribute('aria-label', 'Edit address');
            dialog.innerHTML = '<h2>Edit address</h2><div role="tablist"><button type="button" role="tab" data-kind="home">Home</button><button type="button" role="tab" data-kind="business">Business</button></div><div id="address-fields"></div><button id="save-address" type="button">Save address</button>';
            document.querySelector('main').appendChild(dialog);
            for (const tab of dialog.querySelectorAll('[role=tab]'))
              tab.addEventListener('click', () => { kind = tab.dataset.kind; renderFields(dialog); });
            dialog.querySelector('#save-address').addEventListener('click', () => {
              const fields = { kind };
              for (const input of dialog.querySelectorAll('#address-fields input')) fields[input.name] = input.value;
              fetch('/address/save', { method: 'POST', body: JSON.stringify(fields) }).then(() => {
                dialog.remove();
                document.getElementById('address-status').textContent = 'Saved ' + kind + ' address';
              });
            });
            renderFields(dialog);
          });
        </script>`,
      );
      return;
    }
    if (url.pathname === "/address/save" && method === "POST") {
      state.savedAddress = parseForm(await readBody(req), url);
      json(res, { ok: true });
      return;
    }

    // 20. Infinite scroll: ten posts a page, the next page fetched as the reader nears the bottom.
    if (url.pathname === "/feed" && method === "GET") {
      html(
        res,
        `<main>
          <h1>Field journal</h1>
          <div id="posts"></div>
          <p role="status" id="feed-status">Loading…</p>
        </main>
        <script>
          let loaded = 0;
          let loading = false;
          function loadNext() {
            if (loading || loaded >= ${FEED_PAGES}) return;
            loading = true;
            fetch('/feed/page?n=' + (loaded + 1))
              .then((response) => response.json())
              .then((page) => {
                loaded += 1;
                for (const post of page.posts) {
                  const article = document.createElement('article');
                  article.style.height = '160px';
                  article.innerHTML = '<h2></h2><p>Post ' + post.post + ' of the journal.</p>';
                  article.querySelector('h2').textContent = '#' + post.post + ' — ' + post.title;
                  document.getElementById('posts').appendChild(article);
                }
                document.getElementById('feed-status').textContent = loaded >= ${FEED_PAGES} ? 'End of journal' : 'Scroll for more';
                loading = false;
              });
          }
          window.addEventListener('scroll', () => {
            if (window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 400) loadNext();
          });
          loadNext();
        </script>`,
      );
      return;
    }
    if (url.pathname === "/feed/page" && method === "GET") {
      const page = Number(url.searchParams.get("n") ?? "1");
      if (!Number.isInteger(page) || page < 1 || page > FEED_PAGES) {
        json(res, { posts: [] }, 404);
        return;
      }
      state.feedPagesServed.push(page);
      const first = (page - 1) * FEED_PAGE_SIZE + 1;
      json(res, { posts: Array.from({ length: FEED_PAGE_SIZE }, (_, index) => feedPost(first + index)) });
      return;
    }

    html(res, `<p>Not found: ${escapeHtml(url.pathname)}</p>`, 404);
  };

  const primary = await listenOnLoopback((req, res) => {
    void handleRequest(req, res);
  });
  // Another site, not only another port: Chromium runs its frames out of process, as a real third-party widget's.
  const secondary = await listenOnLoopback((req, res) => {
    void handleRequest(req, res);
  }, "localhost");
  primaryOrigin = primary.origin;
  secondaryOrigin = secondary.origin;

  return {
    origin: primary.origin,
    host: primary.host,
    crossOrigin: secondary.origin,
    crossHost: secondary.host,
    get state() {
      return state;
    },
    reset() {
      state = freshState();
    },
    async close() {
      await Promise.all([
        new Promise<void>((resolve) => primary.server.close(() => resolve())),
        new Promise<void>((resolve) => secondary.server.close(() => resolve())),
      ]);
    },
  };
}
