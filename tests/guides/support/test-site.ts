import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { onTestFinished } from "vitest";

/**
 * A small made-up website the walk serves on this computer, for the guides
 * that browse, sign in or download: never a real site. With `signIn`, every
 * page but `/login` sends you to `/login` until you sign in with the test
 * username and password it made up for this run (`user`, `password`), which
 * the walk types itself. A form posted to a page's path gets that page. It is
 * stopped when the walk ends.
 *
 * It runs in the test's own process, so it answers only while that process is
 * free: a step that browses it must not wait in a synchronous call meanwhile
 * (`walk.tavi`, or `walk.terminal` with no `input`). The canvas and a `tavi chat`
 * typed into by `input` leave it free.
 */

/** A page: its title and body, drawn in the site's own header and colours. */
interface SitePage {
  readonly title: string;
  readonly html: string;
}

/** A file the site sends as a download. */
interface SiteFile {
  readonly file: Buffer;
  readonly type: string;
  readonly filename: string;
}

export interface SiteOptions {
  /** The site's name, in its header. */
  readonly name: string;
  /** Its accent colour. */
  readonly colour: string;
  /** Links under the name. */
  readonly nav?: string;
  /** By path; `/` is the home page. */
  readonly pages: Readonly<Record<string, SitePage | SiteFile>>;
  /** Where a sign-in lands; without it, no page needs one. */
  readonly signIn?: { readonly landing: string };
}

export interface TestSite {
  /** `http://127.0.0.1:<port>`. */
  readonly origin: string;
  /** `127.0.0.1:<port>`, as `--browser-allow-host` takes it. */
  readonly host: string;
  /** The made-up test username and password, new for each run. */
  readonly user: string;
  readonly password: string;
  /** Every request it answered, as `GET /path`, oldest first. */
  readonly requests: readonly string[];
}

const style = (colour: string) =>
  `<style>body{font-family:system-ui,sans-serif;font-size:22px;line-height:1.5;max-width:900px;margin:32px auto;padding:0 32px;color:#1d2a33;background:#f7f5f0}` +
  `header{display:flex;justify-content:space-between;align-items:center;border-bottom:4px solid ${colour};margin-bottom:24px}` +
  `h1{color:${colour};font-size:40px;margin:16px 0}nav a{margin-left:20px;color:${colour}}label{display:block;margin-top:18px}` +
  `input{font-size:24px;width:100%;padding:12px;margin-top:6px;box-sizing:border-box}` +
  `button{font-size:24px;margin-top:24px;padding:12px 32px;background:${colour};color:#fff;border:0;border-radius:6px}` +
  `table{border-collapse:collapse}td{padding:10px 24px 10px 0;border-bottom:1px solid #ccc}</style>`;

export async function testSite(options: SiteOptions): Promise<TestSite> {
  const user = `test-${randomBytes(3).toString("hex")}`;
  const password = randomBytes(12).toString("base64url");
  const sessions = new Set<string>();
  const requests: string[] = [];
  const draw = (page: SitePage) =>
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${page.title}</title>${style(options.colour)}</head>` +
    `<body><header><h1>${options.name}</h1><nav>${options.nav ?? ""}</nav></header>${page.html}</body></html>`;
  const signedIn = (request: IncomingMessage) =>
    (request.headers.cookie ?? "").split(/;\s*/).some((cookie) => sessions.has(cookie.replace(/^sid=/, "")));
  const html = (response: ServerResponse, page: SitePage, status = 200) => {
    response.writeHead(status, { "content-type": "text/html; charset=utf-8" });
    response.end(draw(page));
  };
  const go = (response: ServerResponse, to: string, cookie?: string) => {
    response.writeHead(303, { location: to, ...(cookie === undefined ? {} : { "set-cookie": cookie }) });
    response.end();
  };
  const signInPage: SitePage = {
    title: `Sign in — ${options.name}`,
    html:
      '<h2>Sign in</h2><form method="post" action="/login">' +
      '<label>Username<input name="username" autocomplete="username" autofocus></label>' +
      '<label>Password<input name="password" type="password" autocomplete="current-password"></label>' +
      '<button type="submit">Sign in</button></form>',
  };
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://site").pathname;
    requests.push(`${request.method ?? "GET"} ${path}`);
    if (options.signIn !== undefined && path === "/login") {
      if (request.method !== "POST") return html(response, signInPage);
      let body = "";
      request.on("data", (chunk: Buffer) => {
        body += chunk.toString();
      });
      request.on("end", () => {
        const form = new URLSearchParams(body);
        if (form.get("username") !== user || form.get("password") !== password) {
          return html(
            response,
            { title: signInPage.title, html: '<p>Wrong username or password.</p><p><a href="/login">Try again</a></p>' },
            401,
          );
        }
        const id = randomBytes(12).toString("hex");
        sessions.add(id);
        go(response, options.signIn?.landing ?? "/", `sid=${id}; Path=/; HttpOnly; SameSite=Lax`);
      });
      return;
    }
    if (options.signIn !== undefined && !signedIn(request)) return go(response, "/login");
    const page = options.pages[path];
    if (page === undefined) return html(response, { title: `Not found — ${options.name}`, html: "<p>There is no such page.</p>" }, 404);
    if ("file" in page) {
      response.writeHead(200, {
        "content-type": page.type,
        "content-length": page.file.length,
        "content-disposition": `attachment; filename="${page.filename}"`,
      });
      response.end(page.file);
      return;
    }
    html(response, page);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  // The agent's browser keeps its connections open: they are cut, so the site stops at once.
  onTestFinished(
    () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  );
  const host = `127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { origin: `http://${host}`, host, user, password, requests };
}
