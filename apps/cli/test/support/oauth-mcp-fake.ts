import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * An OAuth-protected MCP server for tests: an
 * authorization server (RFC 8414 metadata, RFC 9728 protected-resource
 * metadata, DCR, PKCE-checked codes, refresh, revoke) in front of the HTTP MCP
 * fake, which it serves at `/mcp` only to a valid Bearer token. Each switch
 * makes it misbehave the way a real one might.
 */

const FAKE = join(resolve(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "mcp"), "fake-server.mjs");

export interface OAuthFakeOptions {
  /** Advertises DCR (default true). */
  readonly registration?: boolean;
  /** Advertises CIMD. */
  readonly cimd?: boolean;
  /** A client it knows already (pre-registered). */
  readonly client?: { readonly id: string; readonly secret?: string };
  /** Omits `code_challenge_methods_supported`. */
  readonly noPkce?: boolean;
  /** Its metadata names another issuer. */
  readonly issuerMismatch?: boolean;
  /** Its authorization endpoint is `javascript:`. */
  readonly scriptEndpoint?: boolean;
  /** Seconds an access token lives. */
  readonly expiresIn?: number;
  /**
   * Its authorization server lives at this path (`/as`): its metadata only under it, and its protected-resource
   * metadata only at `/custom/prm`, which the 401 names — found by the challenge, never by the root's well-known paths.
   */
  readonly authServerPath?: string;
  /** Advertises RFC 9207's `iss` on every authorization response. */
  readonly issParameter?: boolean;
  /** Its `scopes_supported`. */
  readonly scopesSupported?: readonly string[];
  /** Its protected-resource metadata's `scopes_supported`. */
  readonly resourceScopes?: readonly string[];
}

export interface OAuthFake {
  readonly base: string;
  readonly mcpUrl: string;
  readonly registrations: Record<string, unknown>[];
  readonly authorizations: Record<string, string>[];
  readonly tokenRequests: Record<string, string>[];
  readonly revoked: string[];
  /** Every access and refresh token it issued. */
  readonly issued: string[];
  /** Revocations are refused (HTTP 503) while set. */
  refuseRevoke: boolean;
  /** Refreshes are refused with `invalid_grant` while set (a revoked or expired grant). */
  refuseRefresh: boolean;
  /** `/mcp` answers 403 `insufficient_scope` while set. */
  forbid: boolean;
  /** `/mcp` answers a bare 403 (no `insufficient_scope`) while set. */
  deny: boolean;
  /** The scope a token response names, as granular consent narrows it; absent, none is named (the request stood). */
  grantedScope: string | undefined;
  /** An `id_token` naming this email comes with each token, while set. */
  email: string | undefined;
  /** Revokes every token at the server, as an operator revoking Tavi's access there would. */
  revokeAll(): void;
  /** Follows the authorization URL as a browser that consents would: the redirect's code and state. */
  consent(authorizeUrl: string): Promise<{ readonly state: string; readonly code: string; readonly redirect: string }>;
  close(): Promise<void>;
}

async function body(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

export async function startOAuthFake(options: OAuthFakeOptions = {}): Promise<OAuthFake> {
  const mcp: ChildProcess = spawn(process.execPath, [FAKE], {
    env: { PATH: process.env["PATH"] ?? "", FAKE_TRANSPORT: "http", FAKE_ERA: "legacy" },
    stdio: ["ignore", "pipe", "inherit"],
  });
  const mcpPort = await new Promise<number>((done) =>
    mcp.stdout?.on("data", (chunk: Buffer) => {
      const match = /port (\d+)/.exec(chunk.toString());
      if (match?.[1] !== undefined) done(Number(match[1]));
    }),
  );
  const codes = new Map<string, { readonly challenge: string; readonly clientId: string; readonly redirect: string }>();
  const access = new Set<string>();
  const refresh = new Map<string, string>();
  const clients = new Map<string, string | undefined>(options.client === undefined ? [] : [[options.client.id, options.client.secret]]);
  let base = "";
  const fake = {
    registrations: [] as Record<string, unknown>[],
    authorizations: [] as Record<string, string>[],
    tokenRequests: [] as Record<string, string>[],
    revoked: [] as string[],
    issued: [] as string[],
    refuseRevoke: false,
    refuseRefresh: false,
    forbid: false,
    deny: false,
    grantedScope: undefined as string | undefined,
    email: undefined as string | undefined,
    revokeAll: () => {
      access.clear();
      refresh.clear();
    },
  };
  const issue = (issuer: string, clientId: string): Record<string, unknown> => {
    const token = randomBytes(16).toString("hex");
    const refreshToken = randomBytes(16).toString("hex");
    access.add(token);
    refresh.set(refreshToken, token);
    fake.issued.push(token, refreshToken);
    const idToken =
      fake.email === undefined
        ? undefined
        : `${Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url")}.${Buffer.from(JSON.stringify({ iss: issuer, aud: clientId, email: fake.email, sub: "1" })).toString("base64url")}.`;
    return {
      access_token: token,
      token_type: "Bearer",
      refresh_token: refreshToken,
      expires_in: options.expiresIn ?? 3600,
      ...(fake.grantedScope === undefined ? {} : { scope: fake.grantedScope }),
      ...(idToken === undefined ? {} : { id_token: idToken }),
    };
  };
  const server: Server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? "/", base);
      const json = (status: number, value: unknown, headers: Record<string, string> = {}) =>
        response.writeHead(status, { "content-type": "application/json", ...headers }).end(JSON.stringify(value));
      const asPath = options.authServerPath;
      const issuer = `${base}${asPath ?? ""}`;
      const prmPaths =
        asPath === undefined ? ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"] : ["/custom/prm"];
      const asPaths =
        asPath === undefined
          ? ["/.well-known/oauth-authorization-server", "/.well-known/openid-configuration"]
          : [
              `/.well-known/oauth-authorization-server${asPath}`,
              `/.well-known/openid-configuration${asPath}`,
              `${asPath}/.well-known/openid-configuration`,
            ];
      if (prmPaths.includes(url.pathname)) {
        return json(200, {
          resource: `${base}/mcp`,
          authorization_servers: [issuer],
          ...(options.resourceScopes === undefined ? {} : { scopes_supported: options.resourceScopes }),
        });
      }
      if (asPaths.includes(url.pathname)) {
        return json(200, {
          issuer: options.issuerMismatch === true ? "https://someone-else.example" : issuer,
          authorization_endpoint: options.scriptEndpoint === true ? "javascript:alert(1)" : `${base}/authorize`,
          token_endpoint: `${base}/token`,
          revocation_endpoint: `${base}/revoke`,
          ...(options.registration === false ? {} : { registration_endpoint: `${base}/register` }),
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          token_endpoint_auth_methods_supported: ["none", "client_secret_post"],
          ...(options.noPkce === true ? {} : { code_challenge_methods_supported: ["S256"] }),
          ...(options.cimd === true ? { client_id_metadata_document_supported: true } : {}),
          ...(options.issParameter === true ? { authorization_response_iss_parameter_supported: true } : {}),
          ...(options.scopesSupported === undefined ? {} : { scopes_supported: options.scopesSupported }),
        });
      }
      if (url.pathname === "/register" && request.method === "POST") {
        const registration = JSON.parse(await body(request)) as Record<string, unknown>;
        fake.registrations.push(registration);
        const clientId = `dcr-${randomBytes(4).toString("hex")}`;
        clients.set(clientId, undefined);
        return json(201, { ...registration, client_id: clientId });
      }
      if (url.pathname === "/authorize") {
        const params = Object.fromEntries(url.searchParams);
        fake.authorizations.push(params);
        const code = randomBytes(12).toString("hex");
        codes.set(code, {
          challenge: params["code_challenge"] ?? "",
          clientId: params["client_id"] ?? "",
          redirect: params["redirect_uri"] ?? "",
        });
        const back = new URL(params["redirect_uri"] ?? "");
        back.searchParams.set("code", code);
        back.searchParams.set("state", params["state"] ?? "");
        return response.writeHead(302, { location: back.href }).end();
      }
      if (url.pathname === "/token" && request.method === "POST") {
        const form = Object.fromEntries(new URLSearchParams(await body(request)));
        fake.tokenRequests.push(form);
        if (form["grant_type"] === "authorization_code") {
          const pending = codes.get(form["code"] ?? "");
          codes.delete(form["code"] ?? "");
          const verified =
            pending !== undefined &&
            createHash("sha256")
              .update(form["code_verifier"] ?? "")
              .digest("base64url") === pending.challenge &&
            pending.clientId === form["client_id"] &&
            pending.redirect === form["redirect_uri"];
          const secretOk =
            clients.get(form["client_id"] ?? "") === undefined || clients.get(form["client_id"] ?? "") === form["client_secret"];
          return verified && secretOk ? json(200, issue(issuer, form["client_id"] ?? "")) : json(400, { error: "invalid_grant" });
        }
        if (form["grant_type"] === "refresh_token") {
          if (fake.refuseRefresh || !refresh.has(form["refresh_token"] ?? "")) return json(400, { error: "invalid_grant" });
          refresh.delete(form["refresh_token"] ?? "");
          return json(200, issue(issuer, form["client_id"] ?? ""));
        }
        return json(400, { error: "unsupported_grant_type" });
      }
      if (url.pathname === "/revoke" && request.method === "POST") {
        const form = Object.fromEntries(new URLSearchParams(await body(request)));
        if (fake.refuseRevoke) return json(503, { error: "temporarily_unavailable" });
        // A confidential client authenticates, as at the token endpoint (RFC 7009 §2.1).
        const secret = clients.get(form["client_id"] ?? "");
        if (secret !== undefined && form["client_secret"] !== secret) return json(401, { error: "invalid_client" });
        fake.revoked.push(form["token"] ?? "");
        access.delete(form["token"] ?? "");
        refresh.delete(form["token"] ?? "");
        return response.writeHead(200).end();
      }
      if (url.pathname === "/mcp") {
        const token = /^Bearer (.+)$/.exec(request.headers.authorization ?? "")?.[1];
        if (fake.deny) return json(403, { error: "access_denied" });
        if (fake.forbid)
          return json(
            403,
            { error: "insufficient_scope" },
            { "www-authenticate": 'Bearer error="insufficient_scope", scope="calendar.write"' },
          );
        if (token === undefined || !access.has(token)) {
          return json(
            401,
            { error: "invalid_token" },
            {
              "www-authenticate": `Bearer resource_metadata="${base}${options.authServerPath === undefined ? "/.well-known/oauth-protected-resource/mcp" : "/custom/prm"}"`,
            },
          );
        }
        // Forwarded to the MCP fake as it came.
        const forwarded = await fetch(`http://127.0.0.1:${String(mcpPort)}/mcp`, {
          method: request.method ?? "GET",
          headers: Object.fromEntries(
            Object.entries(request.headers).filter(
              ([name, value]) => typeof value === "string" && !["host", "authorization", "content-length", "connection"].includes(name),
            ) as [string, string][],
          ),
          ...(request.method === "GET" || request.method === "HEAD" ? {} : { body: await body(request) }),
        });
        response.writeHead(forwarded.status, Object.fromEntries(forwarded.headers));
        response.end(Buffer.from(await forwarded.arrayBuffer()));
        return;
      }
      response.writeHead(404).end();
      return undefined;
    })().catch((error: unknown) => {
      if (!response.headersSent) response.writeHead(500);
      response.end(String(error));
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  return Object.assign(fake, {
    base,
    mcpUrl: `${base}/mcp`,
    async consent(authorizeUrl: string) {
      const answer = await fetch(authorizeUrl, { redirect: "manual" });
      const location = new URL(answer.headers.get("location") ?? "");
      return {
        state: location.searchParams.get("state") ?? "",
        code: location.searchParams.get("code") ?? "",
        redirect: `${location.origin}${location.pathname}`,
      };
    },
    async close() {
      mcp.kill("SIGKILL");
      await new Promise<void>((done) => server.close(() => done()));
    },
  });
}
