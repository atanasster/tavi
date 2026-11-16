import { createServer } from "node:http";

import { closeServer, listenLocally } from "./port.js";

/**
 * A local web site for the browser-backed plugins' tests (the jobs, places
 * and trends fixture sites): a `node:http` server on 127.0.0.1 answering each
 * path from a function, recording each path asked and each POST's path, so a
 * test can say what the browser read and what it submitted.
 */

export interface SiteAnswer {
  /** Default 200. */
  readonly status?: number;
  /** The content type. Default HTML in UTF-8. */
  readonly type?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body: string;
}

export interface SiteOptions {
  /** The answer to a path (with its query); `origin` is the site's own, for absolute links. */
  readonly answer: (path: string, origin: string) => SiteAnswer;
  /** The answer to a POST, whose body is drained unread. Without it a POST is answered as a GET. */
  readonly post?: (path: string, origin: string) => SiteAnswer;
}

export interface Site {
  readonly origin: string;
  readonly port: number;
  /** Every path asked, in order, POSTs among them. */
  readonly asked: string[];
  /** Each POST's path, in order. */
  readonly posted: string[];
  close(): Promise<void>;
}

/** A minimal HTML page. */
export function page(title: string, body: string, head = ""): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>${head}</head><body>${body}</body></html>`;
}

export async function startSite(options: SiteOptions): Promise<Site> {
  const asked: string[] = [];
  const posted: string[] = [];
  let origin = "";
  const server = createServer((request, response) => {
    const path = request.url ?? "/";
    asked.push(path);
    let answer: SiteAnswer;
    if (request.method === "POST" && options.post !== undefined) {
      posted.push(path);
      request.resume();
      answer = options.post(path, origin);
    } else {
      if (request.method === "POST") posted.push(path);
      answer = options.answer(path, origin);
    }
    response.writeHead(answer.status ?? 200, { "Content-Type": answer.type ?? "text/html; charset=utf-8", ...answer.headers });
    response.end(answer.body);
  });
  const port = await listenLocally(server);
  origin = `http://127.0.0.1:${port}`;
  return { origin, port, asked, posted, close: () => closeServer(server) };
}
