/**
 * A replacement for the built-in Gmail channel (docs/CHANNEL-PLUGINS.md,
 * Part 2): with `tavi.gmail` disabled it takes the `gmail` provider id. It
 * signs in through the host's OAuth flow at Google's own addresses, so the
 * operator can hand it the client Google's apps share
 * (`tavi channels share-client google acme.gmaillite`); the host refreshes
 * the token and this code only ever asks for a current one.
 *
 * It polls for unread mail with one label, hands each message to the host,
 * and marks it read only once the host has recorded it. Replies go out as
 * the person, in the message's thread. Text only.
 */

const API = "https://gmail.googleapis.com/gmail/v1/users/me";
const POLL_MS = 30_000;

/** A header value with no line breaks, so nothing put in it can add a header such as `Bcc:`. */
const headerSafe = (value) =>
  String(value ?? "")
    .replace(/[\r\n]+/g, " ")
    .slice(0, 998);

/** The one address a header names, bare or as `Name <local@domain>`, lower-cased; a display name never counts. */
export function addressOf(header) {
  const text = String(header ?? "");
  const angled = [...text.matchAll(/<([^<>\s]+@[^<>\s]+)>/g)].map((match) => match[1]);
  const all = angled.length > 0 ? angled : (text.replace(/"[^"]*"/g, "").match(/[^\s<>,;"@]+@[^\s<>,;"@]+/g) ?? []);
  return all.length === 1 ? all[0].toLowerCase() : undefined;
}

const domainOf = (address) => address?.split("@")[1];

/**
 * `pass` only when Google's own `Authentication-Results` (the topmost one,
 * written by mx.google.com) shows DKIM, SPF or DMARC passing for the From
 * address's domain; a header further down is anyone's.
 */
export function senderAuthenticationOf(headers) {
  const from = domainOf(addressOf(headerOf(headers, "From")));
  const results = headers.find((header) => header.name.toLowerCase() === "authentication-results")?.value;
  if (from === undefined || results === undefined || !/^\s*mx\.google\.com\s*;/i.test(results)) return "unknown";
  const passes = [
    /\bdkim=pass\b[^;]*\bheader\.(?:i=[^@\s;]*@|d=)([^\s;]+)/i,
    /\bspf=pass\b[^;]*\bsmtp\.mailfrom=(?:[^@\s;]*@)?([^\s;]+)/i,
    /\bdmarc=pass\b[^;]*\bheader\.from=([^\s;]+)/i,
  ].map((pattern) => pattern.exec(results)?.[1]?.toLowerCase());
  return passes.some((domain) => domain === from) ? "pass" : "fail";
}

const headerOf = (headers, name) => headers.find((header) => header.name.toLowerCase() === name.toLowerCase())?.value;

const decode = (data) => Buffer.from(String(data ?? ""), "base64url").toString("utf8");

/** The message's plain text: its first `text/plain` part, however deep. */
function plainTextOf(part) {
  if (part === undefined) return "";
  if (part.mimeType === "text/plain" && part.body?.data !== undefined) return decode(part.body.data);
  for (const child of part.parts ?? []) {
    const text = plainTextOf(child);
    if (text !== "") return text;
  }
  return "";
}

/** A Gmail message as the host takes it. */
export function toInboundEvent(connectionId, message, receivedAt) {
  const headers = message.payload?.headers ?? [];
  const sender = addressOf(headerOf(headers, "From"));
  if (sender === undefined) return undefined;
  const references = String(headerOf(headers, "References") ?? "")
    .split(/\s+/)
    .filter((id) => id !== "");
  const inReplyTo = headerOf(headers, "In-Reply-To");
  const messageId = headerOf(headers, "Message-Id") ?? headerOf(headers, "Message-ID");
  const subject = String(headerOf(headers, "Subject") ?? "").trim();
  const at = Number(message.internalDate);
  return {
    connectionId,
    providerEventId: `gmail:${message.id}`,
    kind: "message",
    externalSenderId: sender,
    externalConversationId: `gmail-thread:${message.threadId}`,
    conversationKind: "thread",
    ...(messageId === undefined ? {} : { externalMessageId: messageId }),
    ...(inReplyTo === undefined ? {} : { externalReplyToId: inReplyTo }),
    ...(references.length === 0 ? {} : { externalReferences: references }),
    occurredAt: Number.isFinite(at) && at > 0 ? new Date(at).toISOString() : receivedAt,
    receivedAt,
    content: plainTextOf(message.payload),
    ...(subject === "" ? {} : { subject: subject.slice(0, 998) }),
    senderAuthentication: senderAuthenticationOf(headers),
  };
}

export function gmailLiteChannel({ z, TaviError, fetch = globalThis.fetch, now = () => new Date().toISOString() }) {
  return {
    providerId: "gmail",
    version: "0.1.0",
    configSchema: z.object({ label: z.string().min(1).max(64).optional() }).passthrough(),
    capabilities: {
      receiveMode: "poll",
      send: true,
      editOrProgress: false,
      formats: ["plain"],
      attachments: false,
      maxAttachmentBytes: 0,
      maxPartsPerMessage: 1,
      threads: true,
      interactions: false,
      deliveryReceipts: false,
      maxTextLength: 100_000,
      approvals: "reply-token",
    },
    createConnection: ({ connection, config, credentials }) => {
      const label = config.label ?? "tavi";
      let state = "stopped";
      let since = now();
      let handler;
      let timer;
      let abort;
      /** One Gmail API call with a current token; a sign-in that is gone is UNAVAILABLE, said once. */
      const call = async (path, init = {}, signal = abort?.signal) => {
        let token;
        try {
          token = await credentials.accessToken();
        } catch (error) {
          throw new TaviError("UNAVAILABLE", `Gmail is not signed in: ${error?.message ?? error}`);
        }
        return await fetch(`${API}${path}`, {
          ...init,
          headers: { ...init.headers, authorization: `Bearer ${token}` },
          signal: signal ?? AbortSignal.timeout(30_000),
        });
      };
      const poll = async (signal) => {
        const query = encodeURIComponent(`label:"${label}" is:unread`);
        const listed = await call(`/messages?q=${query}&maxResults=20`, {}, signal);
        if (!listed.ok) throw new Error(`Gmail did not list mail (HTTP ${listed.status})`);
        for (const { id } of (await listed.json()).messages ?? []) {
          const got = await call(`/messages/${encodeURIComponent(id)}?format=full`, {}, signal);
          if (!got.ok) continue;
          const event = toInboundEvent(connection.connectionId, await got.json(), now());
          if (event !== undefined) {
            try {
              await handler?.(event);
            } catch {
              continue; // Not recorded: left unread for the next poll.
            }
          }
          // Only once the host has it.
          await call(
            `/messages/${encodeURIComponent(id)}/modify`,
            { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ removeLabelIds: ["UNREAD"] }) },
            signal,
          );
        }
      };
      const schedule = (delayMs = POLL_MS) => {
        timer = setTimeout(async () => {
          try {
            await poll(abort.signal);
          } catch {
            // Shown on status by the next probe; tried again next time.
          }
          if (!abort.signal.aborted) schedule();
        }, delayMs);
        timer.unref?.();
      };
      const profile = async () => {
        const response = await call("/profile", {}, AbortSignal.timeout(10_000));
        return response.ok ? { ok: true } : { ok: false, detail: `Gmail did not answer (HTTP ${response.status})` };
      };
      return {
        onInboundEvent(next) {
          handler = next;
        },
        async start() {
          abort = new AbortController();
          // The sign-in is checked here, so a failed start says why; no mail is read until start has returned.
          const checked = await profile();
          if (!checked.ok) throw new TaviError("UNAVAILABLE", checked.detail);
          state = "running";
          since = now();
          schedule(0);
        },
        async stop() {
          abort?.abort();
          clearTimeout(timer);
          state = "stopped";
        },
        status: () => ({ state, since }),
        probe: async () => (state === "running" ? await profile() : { ok: false, detail: "the connection is not running" }),
        /** One poll now: what `start` schedules, for a test or a manual check. */
        pollOnce: async () => await poll(AbortSignal.timeout(30_000)),
        async send(message) {
          if (state !== "running") throw new TaviError("UNAVAILABLE", `Gmail connection ${connection.connectionId} is not running`);
          const part = message.parts[0];
          const to = message.destination?.to;
          if (message.parts.length !== 1 || part === undefined || "artifactId" in part || typeof to !== "string")
            return {
              status: "rejected",
              retryable: false,
              parts: [{ index: 0, status: "rejected", error: "this channel sends one text part" }],
            };
          const destination = message.destination;
          const lines = [
            `To: ${headerSafe(to)}`,
            `Subject: ${headerSafe(message.subject ?? destination.subject ?? "A message from Tavi")}`,
            ...(destination.inReplyTo === undefined ? [] : [`In-Reply-To: ${headerSafe(destination.inReplyTo)}`]),
            ...(destination.references === undefined ? [] : [`References: ${headerSafe(destination.references)}`]),
            "MIME-Version: 1.0",
            'Content-Type: text/plain; charset="UTF-8"',
            "Content-Transfer-Encoding: base64",
            "",
            Buffer.from(part.content, "utf8").toString("base64"),
          ];
          const raw = Buffer.from(lines.join("\r\n"), "utf8").toString("base64url");
          let response;
          try {
            response = await call(
              "/messages/send",
              {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ raw, ...(destination.threadId === undefined ? {} : { threadId: destination.threadId }) }),
              },
              AbortSignal.timeout(30_000),
            );
          } catch (error) {
            if (error instanceof TaviError) throw error; // refused before it went out
            return { status: "uncertain", retryable: false, parts: [{ index: 0, status: "uncertain", error: "Gmail did not answer" }] };
          }
          const answer = await response.json().catch(() => undefined);
          if (response.ok && typeof answer?.id === "string")
            return { status: "accepted", retryable: false, parts: [{ index: 0, status: "accepted", providerMessageId: answer.id }] };
          const status = response.ok || response.status >= 500 ? "uncertain" : "rejected";
          return { status, retryable: response.status === 429, parts: [{ index: 0, status, error: `HTTP ${response.status}` }] };
        },
      };
    },
    // A reply goes to the person who wrote, in the Gmail thread, threaded by its headers too.
    destinationFromInbound: (replyTo) => ({
      conversationId: replyTo.externalConversationId,
      to: replyTo.externalSenderId,
      threadId: String(replyTo.externalConversationId ?? "").replace(/^gmail-thread:/, ""),
      subject: headerSafe(/^re:/i.test(replyTo.subject ?? "") ? replyTo.subject : `Re: ${replyTo.subject ?? "your message"}`),
      ...(replyTo.externalMessageId === undefined
        ? {}
        : {
            inReplyTo: replyTo.externalMessageId,
            references: [...(replyTo.externalReferences ?? []), replyTo.externalMessageId].join(" "),
          }),
    }),
    destinationFor: (target) => ({ to: target.to, subject: target.subject ?? "A message from Tavi" }),
    paceTargetOf: (destination) => (typeof destination?.to === "string" ? destination.to : undefined),
  };
}

export function register({ registerChannel, z, TaviError }) {
  registerChannel(gmailLiteChannel({ z, TaviError }));
}
