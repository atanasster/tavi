import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import {
  TaviError,
  type PersistencePort,
  SCHEDULE_WEBHOOK_MAX_PAYLOAD_BYTES,
  SCHEDULE_WEBHOOK_SIGNATURE_TOLERANCE_MS,
  type ScheduleRecord,
  type ScheduleRepositoryPort,
  type ScheduleWebhookAnswer,
  type ScheduleWebhookMode,
  scheduleWebhookPath,
} from "@tavi/contracts";
import { errorMessage } from "@tavi/contracts/util";
import type { ScheduleWebhookFire } from "@tavi/agent-host/schedule-scheduler";
import { sha256Hex } from "@tavi/node-kit";
import {
  clientAddressOf,
  createFailureBuckets,
  decryptSecret,
  encryptSecret,
  failureKeyOf,
  type IngressGuards,
  readBody,
  readCredentialKey,
} from "@tavi/runtime";

import type { ScheduleFireNow } from "./actions.js";
import { createRefusalCounter, createTriggerRateLimit, type ScheduleTriggerDeps } from "./trigger-limits.js";

/**
 * A schedule's webhook: `POST <public address>/hooks/schedules/<scheduleId>` on
 * the channels' ingress fires the schedule now, as `run-now` does, when the call
 * carries the webhook's secret as a bearer token, or is signed with its signing
 * key. Off by default; a person turns it on (`tavi schedules webhook`, the app),
 * never a model, so neither passes through one.
 *
 * Only the secret's SHA-256 is kept, and a bearer call is checked by hashing
 * what it sends. The signing key is a key of its own, kept encrypted with the
 * credential key (none is made while the credential store is not encrypted, and
 * signed calls are then refused); a signed call is checked over
 * `<timestamp>.<body>`, its timestamp within five minutes and each signature
 * taken once. What a call carries reaches the run quoted as untrusted data, and
 * the run starts tainted.
 */

/**
 * Failed calls from one address to any schedule's webhook — a wrong secret, a bad or missing signature, a body over the
 * cap, an id with no webhook — as a burst, refilled at the same number a minute. Once it is spent, a call with no secret and no fresh
 * signature is refused before its body is read; a signed call is still checked, and charged only if it fails, so
 * others' junk never locks a good caller out.
 *
 * Keyed by the caller's address (`clientAddressOf`: the socket's, or the one a reverse proxy on this machine or one the
 * operator trusts forwards; an IPv6 address by its /64, `failureKeyOf`): behind any other proxy every caller has the
 * proxy's, and shares one burst. A bearer or correctly signed call is never held back by it there either; only
 * unauthenticated callers share it.
 *
 * One burst for all ids, so made-up ids never grow the buckets, and spending it on one id answers alike for every
 * other: a call to an id with no webhook is answered as a wrong secret is (`405` for a method other than POST, `413`
 * over the cap, `401` otherwise) and is never recorded. Once the burst is spent, a call with no secret and no fresh
 * signature is refused `429` before its schedule is looked up, and any failed call from the address is answered `429`.
 */
const FLOOD_BURST = 10;

/** The reference a schedule's signing key is encrypted for: a key stored for another schedule does not decrypt as its. */
function signingKeyRef(scheduleId: string): string {
  return `schedule-webhook:${scheduleId}`;
}

/**
 * A new secret and its SHA-256 (what is kept), and, when the credential store is encrypted, a signing key for signed
 * calls with its encryption (what is kept of it).
 */
async function mintScheduleWebhookSecret(
  scheduleId: string,
  credentialKeyFile: string,
): Promise<{ readonly secret: string; readonly secretHash: string; readonly signingKey?: string; readonly signingKeyEncrypted?: string }> {
  const secret = `twh_${randomBytes(32).toString("base64url")}`;
  const key = await readCredentialKey(credentialKeyFile);
  if (key === undefined) return { secret, secretHash: sha256Hex(secret) };
  const signingKey = `twhk_${randomBytes(32).toString("base64url")}`;
  return {
    secret,
    secretHash: sha256Hex(secret),
    signingKey,
    signingKeyEncrypted: await encryptSecret(signingKey, key, signingKeyRef(scheduleId)),
  };
}

/**
 * `schedules webhook <schedule> on|off|rotate`: `on` makes a secret when it has none, `rotate` replaces it, `off`
 * forgets it. The secret and signing key are in the answer only when they were made: the secret is kept only as its
 * hash, the signing key only encrypted with the credential key in `credentialKeyFile`.
 */
export async function setScheduleWebhook(
  repositories: Pick<PersistencePort["repositories"], "schedules"> & Partial<Pick<PersistencePort["repositories"], "channelIngress">>,
  schedule: ScheduleRecord,
  mode: ScheduleWebhookMode,
  at: Date,
  credentialKeyFile: string,
): Promise<ScheduleWebhookAnswer> {
  const schedules = repositories.schedules;
  const on = (await schedules.webhookSecretHash(schedule.scheduleId)) !== undefined;
  if (mode === "rotate" && !on)
    throw new TaviError(
      "CONFLICT",
      `${schedule.name} has no webhook to rotate; turn it on with \`tavi schedules webhook ${schedule.name} on\``,
    );
  let minted: Awaited<ReturnType<typeof mintScheduleWebhookSecret>> | undefined;
  if (mode === "off") {
    if (on) await schedules.setWebhook({ scheduleId: schedule.scheduleId, secretHash: null, now: at.toISOString() });
  } else if (mode === "rotate" || !on) {
    minted = await mintScheduleWebhookSecret(schedule.scheduleId, credentialKeyFile);
    const kept = {
      scheduleId: schedule.scheduleId,
      secretHash: minted.secretHash,
      signingKeyEncrypted: minted.signingKeyEncrypted ?? null,
      now: at.toISOString(),
    };
    if (!(await schedules.setWebhook(kept))) throw new TaviError("NOT_FOUND", `no schedule ${schedule.scheduleId}`);
  }
  const stored = (await schedules.get(schedule.scheduleId)) ?? schedule;
  const path = scheduleWebhookPath(schedule.scheduleId);
  const url = await scheduleWebhookUrl(repositories.channelIngress, schedule.scheduleId);
  return {
    scheduleId: schedule.scheduleId,
    name: schedule.name,
    webhook: stored.webhook === undefined ? "off" : "on",
    path,
    ...(url === undefined ? {} : { url }),
    ...(stored.webhook === undefined ? {} : { since: stored.webhook.since }),
    ...(minted === undefined ? {} : { secret: minted.secret }),
    ...(minted?.signingKey === undefined ? {} : { signingKey: minted.signingKey }),
    ...(mode === "on" && on ? { unchanged: true as const } : {}),
  };
}

/**
 * Where a call reaches a schedule's webhook: under the ingress's public address when one is set, else the
 * listener's own address on this machine (`http://127.0.0.1:<port>/hooks/schedules/<id>`) once the ingress is
 * configured; `undefined` before it is.
 */
export async function scheduleWebhookUrl(
  ingress: Pick<PersistencePort["repositories"]["channelIngress"], "get"> | undefined,
  scheduleId: string,
): Promise<string | undefined> {
  const settings = await ingress?.get();
  if (settings === undefined) return undefined;
  const path = scheduleWebhookPath(scheduleId);
  if (settings.publicUrl !== undefined) return `${settings.publicUrl.replace(/\/+$/, "")}${path}`;
  // A listener on every interface is reached on loopback; one on a single address, at that address.
  const host = settings.host === "0.0.0.0" || settings.host === "::" ? "127.0.0.1" : settings.host;
  return `http://${host.includes(":") ? `[${host}]` : host}:${settings.port}${path}`;
}

/** Whether a webhook address is the listener's own, reached only from this machine (no public address is set). */
const isLocalAddress = (url: string): boolean => url.startsWith("http://");

/** `schedules webhook`'s text: the address, and the secret with how to send it, once. */
export function scheduleWebhookText(answer: ScheduleWebhookAnswer): string {
  if (answer.webhook === "off") return `${answer.scheduleId}\t${answer.name}\twebhook off`;
  const lines = [`${answer.scheduleId}\t${answer.name}\twebhook on`, `  address   POST ${answer.url ?? `<public address>${answer.path}`}`];
  if (answer.url === undefined)
    lines.push("  (no public address is set: `tavi channels ingress --public-url https://…`, or call the listener locally)");
  else if (isLocalAddress(answer.url))
    lines.push(
      "  (the listener's own address, reached only from this machine: `tavi channels ingress --public-url https://…` for callers outside)",
    );
  if (answer.secret === undefined) {
    lines.push(
      answer.unchanged === true
        ? "  already on; its secret is not shown again (`rotate` makes a new one)"
        : "  its secret is not shown again",
    );
    return lines.join("\n");
  }
  lines.push(`  secret    ${answer.secret}`, "            send it as  Authorization: Bearer <secret>");
  if (answer.signingKey === undefined)
    lines.push("  (no signing key: signed calls need an encrypted credential store, `tavi credentials encrypt`, then `rotate`)");
  else
    lines.push(
      `  signing   ${answer.signingKey}`,
      "            or sign:    X-Tavi-Timestamp: <unix seconds>",
      '                        X-Tavi-Signature: sha256=<hex HMAC-SHA256 of "<timestamp>.<body>" keyed with the signing key>',
    );
  lines.push(
    "  Shown once: the secret is stored only as its hash, the signing key only encrypted. Keep them now.",
    "  A body (at most 8 KiB, JSON or text) reaches the run as quoted data.",
  );
  return lines.join("\n");
}

/**
 * The ids of the schedules whose webhook is on, held by the owner: a call to any other id is refused with no database
 * read. Loaded at the owner's start and after each webhook change (`ingress.ensure`), and an id is dropped when its
 * schedule is removed or a lookup finds its webhook off.
 */
export interface ScheduleWebhookIds {
  has(scheduleId: string): boolean;
  delete(scheduleId: string): void;
  /** Reloads the ids from the store, and answers how many schedules have a webhook on. */
  load(): Promise<number>;
}

/** The owner's set of webhook-enabled schedule ids, empty until it is loaded. */
export function createScheduleWebhookIds(schedules: Pick<ScheduleRepositoryPort, "webhookScheduleIds">): ScheduleWebhookIds {
  let ids = new Set<string>();
  return {
    has: (scheduleId) => ids.has(scheduleId),
    delete: (scheduleId) => {
      ids.delete(scheduleId);
    },
    load: async () => {
      ids = new Set(await schedules.webhookScheduleIds());
      return ids.size;
    },
  };
}

/** What the handler needs from the owner. */
export interface ScheduleWebhookDependencies extends ScheduleTriggerDeps<ScheduleWebhookFire> {
  readonly schedules: Pick<ScheduleRepositoryPort, "get" | "webhookSecretHash" | "webhookSigningKey" | "recordFire">;
  /** The schedules whose webhook is on: only these are looked up. */
  readonly webhookIds: Pick<ScheduleWebhookIds, "has" | "delete">;
  /** The credential key a signing key is encrypted with. */
  readonly credentialKeyFile: string;
  /** The ingress's replay cache, which remembers each signature taken, and the body bytes every request may have in flight. */
  readonly guards: Pick<IngressGuards, "replays" | "bodyBytes" | "trustedProxies">;
}

/** Why a call started nothing, as its ledger row counts it. */
type Refusal =
  | "bad credentials"
  | "over the rate limit"
  | "too large"
  | "malformed"
  | "paused"
  | "not allowed"
  | "in flight"
  | "not started";

/**
 * The webhook routes, ahead of the channels' ingress: answers every call to `/hooks/schedules/<id>` (true) — one to an
 * id with no webhook as a wrong secret is — and leaves every other request (false) to the ingress.
 */
export function createScheduleWebhookHandler(
  deps: ScheduleWebhookDependencies,
): (req: IncomingMessage, res: ServerResponse, pathPrefix?: string) => Promise<boolean> {
  const nowMs = (): number => Date.parse(deps.now());
  const flood = createFailureBuckets({ burst: FLOOD_BURST, now: nowMs });
  const rate = createTriggerRateLimit(nowMs);
  /** Counts a refused call in its schedule's row for the hour (`webhook-refused`), and logs it. */
  const refuse = createRefusalCounter<Refusal>({
    schedules: deps.schedules,
    reasonCode: "webhook-refused",
    label: "webhook",
    noun: ["call", "calls"],
    logMessage: "a call to a schedule's webhook was refused",
    nowMs,
    now: deps.now,
    log: deps.log,
  });

  /**
   * Decrypted signing keys, by schedule and the stored ciphertext they came from: a rotated key is a new ciphertext,
   * so it is never answered from here. Bounded by the schedules with a signing key.
   */
  const signingKeys = new Map<string, { readonly stored: string; readonly key: string }>();

  /** The schedule's signing key, decrypted; `undefined` when it has none or it cannot be read (signed calls are then refused). */
  const signingKeyOf = async (scheduleId: string): Promise<string | undefined> => {
    const stored = await deps.schedules.webhookSigningKey(scheduleId);
    if (stored === undefined) {
      signingKeys.delete(scheduleId);
      return undefined;
    }
    const cached = signingKeys.get(scheduleId);
    if (cached?.stored === stored) return cached.key;
    try {
      const credentialKey = await readCredentialKey(deps.credentialKeyFile);
      if (credentialKey === undefined) return undefined;
      const key = await decryptSecret(stored, credentialKey, signingKeyRef(scheduleId), deps.credentialKeyFile);
      signingKeys.set(scheduleId, { stored, key });
      return key;
    } catch (error) {
      deps.log("warn", "a schedule webhook's signing key could not be read", { scheduleId, error: errorMessage(error) });
      return undefined;
    }
  };

  return async (req, res, pathPrefix) => {
    const scheduleId = scheduleIdOf(req.url ?? "/", pathPrefix);
    if (scheduleId === undefined) return false;
    // The caller's address, whose failures on every id share one burst.
    const floodKey = failureKeyOf(clientAddressOf(req, deps.guards.trustedProxies.trusts));
    const bearer = bearerOf(req);
    const signing = bearer === undefined && signedHeadersOf(req, nowMs()) !== undefined;
    if (bearer === undefined && !signing && flood.spent(floodKey)) {
      answer(res, 429, "too many requests", { "retry-after": "60" });
      return true;
    }
    // Only an id whose webhook is on is looked up: a flood of made-up ids never reaches the database.
    const secretHash = deps.webhookIds.has(scheduleId) ? await deps.schedules.webhookSecretHash(scheduleId) : undefined;
    // An id with no webhook (none by that id, or its webhook off) is answered as a wrong secret is, never recorded.
    const known = secretHash !== undefined;
    if (!known) deps.webhookIds.delete(scheduleId);
    const target = { scheduleId };
    if (req.method !== "POST") {
      res.setHeader("allow", "POST");
      answer(res, 405, "method not allowed");
      return true;
    }
    // A bearer call is checked before its body is read, and one with the secret is never held back by others' refusals;
    // nor is a call whose signature headers are fresh, whose signature is checked before anything is charged for it.
    const bearerGood = known && bearer !== undefined && sameBytes(Buffer.from(sha256Hex(bearer), "utf8"), Buffer.from(secretHash, "utf8"));
    /** Refuses a call that failed: charged to its address's burst, and answered 429 once that is spent. */
    const failed = async (status: 401 | 413, message: string, cause: Refusal, headers: Record<string, string> = {}): Promise<true> => {
      if (!flood.charge(floodKey)) {
        if (known) await refuse(target, "over the rate limit");
        answer(res, 429, "too many requests", { "retry-after": "60", ...headers });
        return true;
      }
      if (known) await refuse(target, cause);
      answer(res, status, message, status === 401 ? { "www-authenticate": "Bearer", ...headers } : headers);
      return true;
    };
    // Only an id with a webhook has a signature worth reading a body for once the burst is spent.
    if (!bearerGood && (!signing || !known) && flood.spent(floodKey)) {
      if (known) await refuse(target, "over the rate limit");
      answer(res, 429, "too many requests", { "retry-after": "60" });
      return true;
    }
    if (bearer !== undefined && !bearerGood) return failed(401, "unauthorized", "bad credentials");
    let body: Uint8Array | "too-large" | "busy";
    try {
      body = await readBody(req, SCHEDULE_WEBHOOK_MAX_PAYLOAD_BYTES, "pause", deps.guards.bodyBytes.forAddress(floodKey));
    } catch {
      answer(res, 400, "bad request");
      return true;
    }
    // Too many bytes in flight, the address's or the whole ingress's: the caller retries later. Charged to the address
    // unless it carried the secret, so one address's flood of reads is spent like any other failure.
    if (body === "busy") {
      if (!bearerGood) flood.charge(floodKey);
      res.on("finish", () => req.destroy());
      answer(res, 503, "busy", { connection: "close", "retry-after": "5" });
      return true;
    }
    if (body === "too-large") {
      // The rest is not read: the connection closes once the refusal is sent.
      res.on("finish", () => req.destroy());
      if (!bearerGood) return failed(413, "payload too large", "too large", { connection: "close" });
      await refuse(target, "too large");
      answer(res, 413, "payload too large", { connection: "close" });
      return true;
    }
    if (!bearerGood) {
      const mac = known ? await signatureOf(req, body, nowMs(), () => signingKeyOf(scheduleId)) : undefined;
      const claimed =
        mac === undefined
          ? false
          : deps.guards.replays.claim(`schedule:${scheduleId}\u0000${mac}`, 2 * SCHEDULE_WEBHOOK_SIGNATURE_TOLERANCE_MS);
      // Too many live signatures to remember another: the caller retries later, and none is forgotten early.
      if (claimed === "full") {
        answer(res, 503, "busy");
        return true;
      }
      if (!claimed) return failed(401, "unauthorized", "bad credentials");
    }
    const payload = payloadText(body, req.headers["content-type"]);
    if (payload === undefined) {
      await refuse(target, "malformed");
      answer(res, 400, "the body must be UTF-8 text, and JSON when it says it is");
      return true;
    }
    const schedule = await deps.schedules.get(scheduleId);
    if (schedule === undefined) return false;
    if (!schedule.enabled) {
      await refuse(schedule, "paused");
      answer(res, 409, "the schedule is paused");
      return true;
    }
    if (deps.actsIn !== undefined && !deps.actsIn(schedule.workspaceId, schedule.principalId)) {
      await refuse(schedule, "not allowed");
      answer(res, 403, "the schedule's owner is no longer allowed");
      return true;
    }
    if (await deps.routineOwned(schedule.scheduleId)) {
      await refuse(schedule, "not started");
      answer(res, 409, "a routine's schedule fires through its routine");
      return true;
    }
    if (deps.inFlight(schedule.scheduleId)) {
      await refuse(schedule, "in flight");
      answer(res, 409, "a run of the schedule is in flight");
      return true;
    }
    const wait = rate.wait(scheduleId);
    if (wait > 0) {
      await refuse(schedule, "over the rate limit");
      answer(res, 429, "too many requests", { "retry-after": String(Math.ceil(wait / 1000)) });
      return true;
    }
    const giveBack = rate.take(scheduleId);
    let fired: ScheduleFireNow;
    try {
      fired = await deps.fire(schedule, payload === "" ? {} : { payload });
    } catch (error) {
      giveBack();
      deps.log("warn", "a schedule's webhook could not fire it", { scheduleId, error: errorMessage(error) });
      answer(res, 503, "unavailable");
      return true;
    }
    if (fired.taskId !== undefined) {
      deps.log("info", "a schedule's webhook fired it", { scheduleId, taskId: fired.taskId });
      answer(res, 202, JSON.stringify({ accepted: true }), {}, "application/json");
      return true;
    }
    // A fire that started no run took none of the hour's fires, and its own record says why: not counted again here.
    giveBack();
    deps.log("info", "a call to a schedule's webhook started no run", { scheduleId, outcome: fired.outcome?.kind });
    answer(res, 409, "not started");
    return true;
  };
}

/** Whether a request's path is a schedule webhook's: decided before anything is awaited, so any other request reaches the ingress as it came. */
export function isScheduleWebhookPath(url: string, pathPrefix: string | undefined): boolean {
  return scheduleIdOf(url, pathPrefix) !== undefined;
}

/** The schedule a request's path names, under the public address's prefix or not; `undefined` for any other path. */
function scheduleIdOf(url: string, pathPrefix: string | undefined): string | undefined {
  const path = new URL(url, "http://ingress.invalid").pathname;
  const local = pathPrefix !== undefined && pathPrefix !== "" && path.startsWith(`${pathPrefix}/`) ? path.slice(pathPrefix.length) : path;
  const match = /^\/hooks\/schedules\/([^/]+)\/?$/.exec(local);
  if (match === null) return undefined;
  try {
    return decodeURIComponent(match[1]!);
  } catch {
    return undefined;
  }
}

/**
 * The token of `Authorization: Bearer <secret>`, or `undefined` for a call without one. Any other `Authorization`
 * counts as a wrong bearer token.
 */
function bearerOf(req: IncomingMessage): string | undefined {
  const header = headerOf(req, "authorization");
  if (header === undefined) return undefined;
  return /^Bearer\s+(\S{1,512})$/i.exec(header)?.[1] ?? "";
}

/**
 * A signed call's signature, `X-Tavi-Signature: sha256=<hex>` over `<X-Tavi-Timestamp>.<body>` keyed with the signing
 * key, when it is good and its timestamp within the tolerance; `undefined` otherwise. The key is read only for a call
 * that carries both headers in time.
 */
async function signatureOf(
  req: IncomingMessage,
  body: Uint8Array,
  nowMs: number,
  signingKey: () => Promise<string | undefined>,
): Promise<string | undefined> {
  const signed = signedHeadersOf(req, nowMs);
  if (signed === undefined) return undefined;
  const key = await signingKey();
  if (key === undefined) return undefined;
  const mac = createHmac("sha256", key).update(`${signed.timestamp}.`).update(body).digest("hex");
  return sameBytes(Buffer.from(signed.signature.toLowerCase(), "utf8"), Buffer.from(mac, "utf8")) ? mac : undefined;
}

/** A call's signature and timestamp headers, when both are well formed and the timestamp within the tolerance. */
function signedHeadersOf(req: IncomingMessage, nowMs: number): { readonly signature: string; readonly timestamp: string } | undefined {
  const signature = /^sha256=([0-9a-f]{64})$/i.exec(headerOf(req, "x-tavi-signature") ?? "")?.[1];
  const timestamp = headerOf(req, "x-tavi-timestamp") ?? "";
  if (signature === undefined || !/^\d{1,12}$/.test(timestamp)) return undefined;
  if (Math.abs(nowMs - Number(timestamp) * 1000) > SCHEDULE_WEBHOOK_SIGNATURE_TOLERANCE_MS) return undefined;
  return { signature, timestamp };
}

function sameBytes(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

function headerOf(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

/** The body as text: UTF-8, and valid JSON when its content type says JSON; `undefined` when it is neither. */
function payloadText(body: Uint8Array, contentType: string | undefined): string | undefined {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    return undefined;
  }
  if (/^application\/(?:[\w.+-]+\+)?json\b/i.test(contentType ?? "") && text.trim() !== "") {
    try {
      JSON.parse(text);
    } catch {
      return undefined;
    }
  }
  return text.trim() === "" ? "" : text;
}

function answer(
  res: ServerResponse,
  status: number,
  body: string,
  headers: Record<string, string> = {},
  contentType = "text/plain; charset=utf-8",
): void {
  res.statusCode = status;
  res.setHeader("content-type", contentType);
  res.setHeader("cache-control", "no-store");
  for (const [name, value] of Object.entries(headers)) res.setHeader(name, value);
  res.end(body);
}
