import { fetchWithTimeout, readCapped, redactedError } from "@tavi/channel-kit";
import { z } from "zod";

/**
 * Telegram's Bot API over plain HTTPS, not a bot-framework dependency.
 * `getMe`/`getUpdates`/`sendMessage` are plain JSON endpoints; wrapping them
 * directly with an injectable `fetch` (mirroring
 * `packages/agent-host/src/models/models.ts`'s `AiSdkModelAdapterOptions.fetch` —
 * "never an ambient global override") keeps the dependency surface
 * minimal and the adapter unit-testable without a third-party framework's
 * own abstractions, exactly like the model adapter already is.
 *
 * **The bot token never appears in a thrown error or log line constructed
 * here.** It is only ever embedded in the outgoing request URL/path. An
 * error message forwarded verbatim from the injected `fetch` implementation
 * is defensively redacted (`redacting` below) in case that implementation
 * embeds the failing URL in its own message — this module cannot otherwise
 * guarantee what a caller-supplied `fetch` puts in its errors.
 */

export const DEFAULT_API_BASE_URL = "https://api.telegram.org";
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
export const DEFAULT_UPLOAD_TIMEOUT_MS = 120_000;

/**
 * The most a Bot API answer read as JSON may hold. A `getUpdates` batch is the
 * largest (up to 100 updates, each a message with its text, entities and
 * attachment metadata — well under 1 MiB in practice); this leaves ample room
 * while a misbehaving server or a configured `apiBaseUrl` cannot make the
 * adapter buffer without bound. Past it the answer reads as malformed.
 */
const ENVELOPE_MAX_BYTES = 8 * 1024 * 1024;

/**
 * The Bot API methods that render a text a link preview can attach to.
 * `sendDocument` captions take no preview. Every method in this set gets
 * `link_preview_options: {is_disabled: true}` in `call`.
 */
const PREVIEW_METHODS: ReadonlySet<string> = new Set(["sendMessage", "editMessageText"]);

const NO_LINK_PREVIEW = { is_disabled: true } as const;

interface TelegramApiSuccess<T> {
  readonly ok: true;
  readonly result: T;
}

interface TelegramApiFailure {
  readonly ok: false;
  readonly error_code: number;
  readonly description: string;
  readonly parameters?: { readonly retry_after?: number };
}

export type TelegramApiResult<T> = TelegramApiSuccess<T> | TelegramApiFailure;

/** The Bot API's envelope; what `result` holds is each method's caller's to read. */
const EnvelopeSchema = z.discriminatedUnion("ok", [
  z.looseObject({ ok: z.literal(true), result: z.unknown().refine((result) => result !== undefined) }),
  z.looseObject({
    ok: z.literal(false),
    error_code: z.number().int(),
    // Optional in the Bot API's own words, though every refusal seen carries one.
    description: z.string().optional(),
    parameters: z.looseObject({ retry_after: z.number().optional() }).optional(),
  }),
]);

/**
 * A response body as the Bot API's envelope. A body that is not one — not
 * JSON at all (a proxy's page, a truncated body), past `ENVELOPE_MAX_BYTES`,
 * or JSON of the wrong shape —
 * throws a token-free error rather than reading as a refusal: the request may
 * still have been carried out, so a send whose answer is malformed is
 * uncertain, never a final rejection.
 */
async function envelopeOf<T>(response: Response): Promise<TelegramApiResult<T>> {
  const malformed = (): Error => new Error(`Telegram answered ${String(response.status)} with a malformed response`);
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder().decode(await readCapped(response, ENVELOPE_MAX_BYTES)));
  } catch {
    throw malformed();
  }
  const parsed = EnvelopeSchema.safeParse(body);
  if (!parsed.success) throw malformed();
  const envelope = parsed.data;
  if (envelope.ok) return { ok: true, result: envelope.result as T };
  return {
    ok: false,
    error_code: envelope.error_code,
    description: envelope.description ?? `Telegram refused with ${String(envelope.error_code)}`,
    ...(envelope.parameters === undefined
      ? {}
      : { parameters: envelope.parameters.retry_after === undefined ? {} : { retry_after: envelope.parameters.retry_after } }),
  };
}

export interface TelegramApiOptions {
  readonly fetch: typeof globalThis.fetch;
  /** The bot token, once the connection has read it. */
  readonly token: () => string | undefined;
  readonly apiBaseUrl: string;
  readonly requestTimeoutMs: number;
  readonly uploadTimeoutMs: number;
  /** A `getUpdates` long poll's own wait, in seconds, on top of the request timeout. */
  readonly pollTimeoutSeconds: number;
}

export interface TelegramApi {
  /** The bot token, once read: what every error is redacted of. */
  readonly token: () => string | undefined;
  readonly call: <T>(method: string, params: Record<string, unknown>, signal?: AbortSignal) => Promise<TelegramApiResult<T>>;
  readonly callMultipart: <T>(
    method: string,
    fields: Readonly<Record<string, string>>,
    file: { readonly field: string; readonly filename: string; readonly contentType: string; readonly bytes: Uint8Array },
  ) => Promise<TelegramApiResult<T>>;
  readonly downloadFile: (path: string, maxBytes: number, signal: AbortSignal) => Promise<Uint8Array>;
}

export function createTelegramApi(options: TelegramApiOptions): TelegramApi {
  const { fetch: fetchImpl, token, apiBaseUrl, requestTimeoutMs, uploadTimeoutMs, pollTimeoutSeconds } = options;

  /**
   * Runs one Bot API request with the token kept out of anything thrown.
   * The token is part of every request URL, and a `fetch` failure may quote
   * that URL — so every call site (start, probe, buttons, edits, sends, the
   * poll loop) gets a redacted error, not just the ones that remember to
   * redact. The original error is not kept as `cause`,
   * since it carries the token too.
   */
  async function redacting<T>(request: () => Promise<T>): Promise<T> {
    try {
      return await request();
    } catch (error) {
      const redacted = new Error(redactedError(error, [token()]));
      if (error instanceof Error) redacted.name = error.name;
      throw redacted;
    }
  }

  async function call<T>(method: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<TelegramApiResult<T>> {
    // A long poll is allowed its own wait on top of the request timeout.
    const timeoutMs = requestTimeoutMs + (method === "getUpdates" ? pollTimeoutSeconds * 1000 : 0);
    // Link previews are off on every text the bot renders, set here once
    // rather than per message kind: Telegram fetches a preview
    // server-side, so a URL in a reply, an approval round, a question or a
    // heartbeat item would otherwise be fetched the moment it is shown.
    const body = PREVIEW_METHODS.has(method) ? { ...params, link_preview_options: NO_LINK_PREVIEW } : params;
    return redacting(async () => {
      const response = await fetchWithTimeout(
        fetchImpl,
        `${apiBaseUrl}/bot${token()}/${method}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        },
        timeoutMs,
        signal,
      );
      return envelopeOf<T>(response);
    });
  }

  /**
   * The `multipart/form-data` sibling of `call`, for methods that
   * upload a file (`sendDocument`). Every scalar field is stringified: form
   * fields carry no JSON types, and the Bot API accepts `chat_id` as a
   * string everywhere it accepts the numeric form.
   *
   * No `content-type` header is set on purpose — the runtime must add its own
   * `boundary`, and setting the header by hand (or omitting the boundary)
   * makes the Bot API see zero parts.
   */
  async function callMultipart<T>(
    method: string,
    fields: Readonly<Record<string, string>>,
    file: { readonly field: string; readonly filename: string; readonly contentType: string; readonly bytes: Uint8Array },
  ): Promise<TelegramApiResult<T>> {
    const form = new FormData();
    for (const [key, value] of Object.entries(fields)) form.set(key, value);
    // Copied into a fresh view: `bytes` may be a `Buffer` that is a slice of a
    // much larger pooled `ArrayBuffer`, and `Blob` would otherwise take the
    // whole pool region rather than just this artifact's range.
    const copy = new Uint8Array(file.bytes.byteLength);
    copy.set(file.bytes);
    form.set(file.field, new Blob([copy], { type: file.contentType }), file.filename);
    return redacting(async () => {
      const response = await fetchWithTimeout(
        fetchImpl,
        `${apiBaseUrl}/bot${token()}/${method}`,
        { method: "POST", body: form },
        uploadTimeoutMs,
      );
      return envelopeOf<T>(response);
    });
  }

  /** A file `getFile` located: it is under `/file/bot<token>/`. */
  async function downloadFile(path: string, maxBytes: number, signal: AbortSignal): Promise<Uint8Array> {
    return redacting(async () => {
      const response = await fetchWithTimeout(
        fetchImpl,
        `${apiBaseUrl}/file/bot${token()}/${path}`,
        { method: "GET" },
        uploadTimeoutMs,
        signal,
      );
      if (!response.ok) throw new Error(`Telegram answered ${response.status} for the file`);
      return readCapped(response, maxBytes);
    });
  }

  return { token, call, callMultipart, downloadFile };
}
