import { describeChannelConformance, type ProviderMood } from "@tavi/channel-kit/conformance";

import { createGmailConnectorDefinition, GMAIL_CHANNEL_DESCRIPTOR } from "../src/connector.js";

/** Gmail against the channel conformance suite. */

const hang = (signal?: AbortSignal | null): Promise<Response> =>
  new Promise((_resolve, reject) => signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));

function fakeGmail(mood: ProviderMood): typeof fetch {
  return (async (url: string, init?: RequestInit) => {
    if (url.endsWith("/profile")) return new Response(JSON.stringify({ emailAddress: "me@example.com" }), { status: 200 });
    if (url.endsWith("/labels")) return new Response(JSON.stringify({ labels: [{ id: "L1", name: "tavi-processed" }] }), { status: 200 });
    if (url.includes("/messages?")) return new Response(JSON.stringify({}), { status: 200 });
    if (mood === "hang") return hang(init?.signal);
    // A failure that quotes the request, its bearer token included.
    if (mood === "echo") throw new TypeError(`fetch failed for ${url} with ${JSON.stringify(init?.headers)}`);
    if (mood === "garbled") return new Response("<html>proxy page</html>", { status: 200 });
    return new Response(JSON.stringify({ id: "msg-1", threadId: "t-1" }), { status: 200 });
  }) as unknown as typeof fetch;
}

describeChannelConformance("Gmail", {
  descriptor: GMAIL_CHANNEL_DESCRIPTOR,
  provider: fakeGmail,
  create: (fetch) => createGmailConnectorDefinition({ fetch, requestTimeoutMs: 30, pollIntervalMs: 60_000 }),
  connection: {
    connectionId: "gmail-conformance",
    providerId: "gmail",
    accountIdentity: "me@example.com",
    workspaceId: "w",
    configRevision: 1,
    enabled: true,
  },
  config: { label: "tavi" },
  secret: "ya29.s3cret-access-token",
  target: "ana@example.com",
});
