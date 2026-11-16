import { describeChannelConformance, type ProviderMood } from "@tavi/channel-kit/conformance";

import { createMailgunConnectorDefinition, MAILGUN_CHANNEL_DESCRIPTOR } from "../src/connector.js";

/** Mailgun against the channel conformance suite. */

const hang = (signal?: AbortSignal | null): Promise<Response> =>
  new Promise((_resolve, reject) => signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));

function fakeMailgun(mood: ProviderMood): typeof fetch {
  return (async (url: string, init?: RequestInit) => {
    if (url.includes("/domains/")) return new Response("{}", { status: 200 });
    if (mood === "hang") return hang(init?.signal);
    // A failure that quotes the request, its Basic authorization header included.
    if (mood === "echo") throw new TypeError(`fetch failed for ${url} with ${JSON.stringify(init?.headers)}`);
    if (mood === "garbled") return new Response("<html>proxy page</html>", { status: 200 });
    return new Response(JSON.stringify({ id: "<m-1@mail>", message: "Queued" }), { status: 200 });
  }) as unknown as typeof fetch;
}

describeChannelConformance("Mailgun", {
  descriptor: MAILGUN_CHANNEL_DESCRIPTOR,
  provider: fakeMailgun,
  create: (fetch) => createMailgunConnectorDefinition({ fetch, requestTimeoutMs: 30 }),
  basicUsers: ["api"],
  connection: {
    connectionId: "mailgun-conformance",
    providerId: "mailgun",
    accountIdentity: "tavi@mail.example.com",
    workspaceId: "w",
    configRevision: 1,
    credentialRef: "apiKey",
    enabled: true,
  },
  config: { domain: "mail.example.com" },
  secret: "key-s3cret",
  target: "ana@example.com",
});
