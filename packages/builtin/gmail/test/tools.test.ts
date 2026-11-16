import { describe, expect, it } from "vitest";

import { GMAIL_SEARCH_MAX, GMAIL_THREAD_BOUNDS, GmailMailbox } from "../src/tools.js";

/** One Gmail account's mailbox: what the owner's mailbox tools call. */

const TOKEN = "ya29.secret-token";
const header = (name: string, value: string) => ({ name, value });
const signedBy = (domain: string) =>
  header("Authentication-Results", `mx.google.com; dkim=pass header.i=@${domain}; dmarc=pass (p=NONE) header.from=${domain}`);

interface Call {
  readonly method: string;
  readonly path: string;
  readonly body?: unknown;
}

/** A Gmail API that answers each path from `routes`, recording every call. */
function mailbox(routes: (call: Call) => Response) {
  const calls: Call[] = [];
  const fetch = (async (url: string | URL, init?: RequestInit) => {
    expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${TOKEN}`);
    const call: Call = {
      method: init?.method ?? "GET",
      path: String(url).replace("https://gmail.test/v1", ""),
      ...(typeof init?.body === "string" ? { body: JSON.parse(init.body) as unknown } : {}),
    };
    calls.push(call);
    return routes(call);
  }) as typeof globalThis.fetch;
  return { calls, box: new GmailMailbox({ accessToken: async () => TOKEN, fetch, apiBaseUrl: "https://gmail.test/v1" }) };
}

const text = (value: string) => ({ mimeType: "text/plain", body: { data: Buffer.from(value).toString("base64url") } });
const rawOf = (call: Call | undefined): string =>
  Buffer.from((call?.body as { message: { raw: string } }).message.raw, "base64url").toString("utf8");

describe("searching and reading", () => {
  it("lists at most the search cap, in Gmail's order, with whether each sender was authenticated", async () => {
    const { calls, box } = mailbox((call) => {
      if (call.path.startsWith("/messages?"))
        return Response.json({ messages: Array.from({ length: 30 }, (_, index) => ({ id: `m${String(index)}` })) });
      const id = /\/messages\/(m\d+)/.exec(call.path)?.[1] ?? "";
      const from = id === "m0" ? "Ana <ana@example.com>" : "Bank <alerts@bank.example>";
      return Response.json({
        id,
        threadId: `t-${id}`,
        snippet: "hi",
        payload: { headers: [header("From", from), header("Subject", `About ${id}`), ...(id === "m0" ? [signedBy("example.com")] : [])] },
      });
    });
    const listed = await box.search("from:ana", 50);
    expect(listed).toHaveLength(GMAIL_SEARCH_MAX);
    expect(listed.map((message) => message.id)).toEqual(Array.from({ length: GMAIL_SEARCH_MAX }, (_, index) => `m${String(index)}`));
    expect(listed[0]).toEqual({
      id: "m0",
      threadId: "t-m0",
      from: "Ana <ana@example.com>",
      subject: "About m0",
      snippet: "hi",
      fromVerified: "pass",
    });
    expect(listed[1]?.fromVerified).toBe("fail");
    expect(calls[0]?.path).toBe(`/messages?q=from%3Aana&maxResults=${String(GMAIL_SEARCH_MAX)}`);
    expect(calls[1]?.path).toContain("metadataHeaders=Authentication-Results");
  });

  it("reads the sender's own words apart from what they quoted, with its recipients", async () => {
    const { box } = mailbox(() =>
      Response.json({
        id: "m1",
        threadId: "t1",
        payload: {
          mimeType: "multipart/alternative",
          headers: [
            header("From", "ana@example.com"),
            header("To", "me@example.com"),
            header("Cc", "bo@example.com"),
            signedBy("example.com"),
          ],
          parts: [text("See you at six.\n\nOn Mon, Bo wrote:\n> are we on?\n")],
        },
      }),
    );
    const read = await box.read("m1");
    expect(read).toMatchObject({
      id: "m1",
      threadId: "t1",
      to: "me@example.com",
      cc: "bo@example.com",
      fromVerified: "pass",
      fromSnippet: false,
      text: "See you at six.",
    });
    expect(read.quoted.map((range) => range.text).join("\n")).toContain("are we on?");
  });

  it("says a refused sign-in is one to make again, and never names the token", async () => {
    const refused = mailbox(() => new Response(`bad token ${TOKEN}`, { status: 401 }));
    const error = await refused.box.read("m1").catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "NOT_AUTHORIZED", details: { signIn: true } });
    expect(String((error as Error).message)).not.toContain(TOKEN);
    await expect(mailbox(() => new Response("", { status: 404 })).box.read("gone")).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(mailbox(() => new Response("", { status: 500 })).box.read("m1")).rejects.toMatchObject({ code: "UNAVAILABLE" });
    // Signed in without Gmail's access (a box left unticked): a sign-in to make again, not an outage.
    const narrow = mailbox(() => Response.json({ error: { details: [{ reason: "ACCESS_TOKEN_SCOPE_INSUFFICIENT" }] } }, { status: 403 }));
    await expect(narrow.box.read("m1")).rejects.toMatchObject({ code: "NOT_AUTHORIZED", details: { signIn: true } });
    await expect(mailbox(() => Response.json({ error: { message: "rate" } }, { status: 403 })).box.read("m1")).rejects.toMatchObject({
      code: "UNAVAILABLE",
    });
  });
});

describe("drafts", () => {
  const made = Response.json({ id: "d1", message: { id: "dm1" } });

  it("makes a draft, never sent, with its recipients", async () => {
    const { calls, box } = mailbox(() => made.clone());
    expect(
      await box.createDraft({ from: "me@example.com", to: ["ana@example.com"], cc: ["bo@example.com"], subject: "Dinner", body: "Six?" }),
    ).toEqual({ draftId: "d1", messageId: "dm1" });
    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual(["POST /drafts"]);
    const raw = rawOf(calls[0]);
    expect(raw).toMatch(/^To: ana@example.com$/m);
    expect(raw).toMatch(/^Cc: bo@example.com$/m);
    expect(raw).not.toMatch(/^In-Reply-To:/m);
  });

  it("threads a reply by the message's own Message-ID and References, and says who and what it answers", async () => {
    const earlier = Array.from({ length: 40 }, (_, index) => `<ref${String(index)}.${"x".repeat(20)}@mail.example>`);
    const { calls, box } = mailbox((call) => {
      if (call.path.startsWith("/messages/m1"))
        return Response.json({
          id: "m1",
          threadId: "t1",
          payload: {
            headers: [
              header("Message-ID", "<abc@mail.example>"),
              header("References", earlier.join(" ")),
              header("From", "Ana <ana@example.com>"),
              header("Subject", "Dinner?"),
            ],
          },
        });
      return made.clone();
    });
    const draft = await box.createDraft({
      from: "me@example.com",
      to: ["ana@example.com"],
      subject: "Re: Dinner?",
      body: "Six.",
      replyTo: { threadId: "t1", messageId: "m1" },
    });
    expect(draft).toEqual({ draftId: "d1", messageId: "dm1", replyingTo: { from: "Ana <ana@example.com>", subject: "Dinner?" } });
    expect(calls[0]?.path).toContain("metadataHeaders=Message-ID");
    expect((calls[1]?.body as { message: { threadId: string } }).message.threadId).toBe("t1");
    const raw = rawOf(calls[1]);
    expect(raw).toMatch(/^In-Reply-To: <abc@mail\.example>$/m);
    const references = /^References: (.*)$/m.exec(raw)?.[1] ?? "";
    // Fitted to one header line, ending with the message replied to.
    expect(references.endsWith("<abc@mail.example>")).toBe(true);
    expect(`References: ${references}`.length).toBeLessThanOrEqual(998);
    expect(references).toContain(earlier.at(-1));
    // The thread's first id names its conversation: the ids after it go first.
    expect(references).toContain(earlier[0]);
    expect(references).not.toContain(earlier[1]);
  });

  it("refuses a reply to a message outside the thread it names, and makes no draft", async () => {
    const { calls, box } = mailbox(() =>
      Response.json({ id: "m1", threadId: "other", payload: { headers: [header("Message-ID", "<abc@mail.example>")] } }),
    );
    await expect(
      box.createDraft({
        from: "me@example.com",
        to: ["ana@example.com"],
        subject: "Re",
        body: "x",
        replyTo: { threadId: "t1", messageId: "m1" },
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(calls.some((call) => call.path === "/drafts")).toBe(false);
  });

  it("threads without In-Reply-To when the message's Message-ID is not one", async () => {
    const { calls, box } = mailbox((call) =>
      call.path.startsWith("/messages/")
        ? Response.json({ id: "m1", threadId: "t1", payload: { headers: [header("Message-ID", "not an id\r\nBcc: x@evil.example")] } })
        : made.clone(),
    );
    await box.createDraft({
      from: "me@example.com",
      to: ["ana@example.com"],
      subject: "Re",
      body: "x",
      replyTo: { threadId: "t1", messageId: "m1" },
    });
    const raw = rawOf(calls[1]);
    expect(raw).not.toMatch(/^In-Reply-To:/m);
    expect(raw).not.toMatch(/^Bcc:/m);
  });

  it("reads the message a draft holds, sends it, and finds whether an address was written to before", async () => {
    const { calls, box } = mailbox((call) => {
      if (call.path.startsWith("/drafts/d1")) return Response.json({ id: "d1", message: { id: "dm2" } });
      if (call.path === "/drafts/send") return Response.json({ id: "sent1", threadId: "t1" });
      return Response.json({ messages: call.path.includes("ana%40example.com") ? [{ id: "x" }] : [] });
    });
    expect(await box.draftMessageId("d1")).toBe("dm2");
    expect(await box.sendDraft("d1")).toEqual({ messageId: "sent1", threadId: "t1" });
    expect(calls.find((call) => call.path === "/drafts/send")?.body).toEqual({ id: "d1" });
    expect(await box.hasSentTo("ana@example.com")).toBe(true);
    expect(await box.hasSentTo("new@example.com")).toBe(false);
    expect(calls.at(-1)?.path).toBe("/messages?q=in%3Asent+to%3Anew%40example.com&maxResults=1");
  });
});

describe("triage", () => {
  it("pages a search by Gmail's own nextPageToken", async () => {
    const { calls, box } = mailbox((call) => {
      if (call.path.startsWith("/messages?"))
        return Response.json({ messages: [{ id: "m1" }], ...(call.path.includes("pageToken") ? {} : { nextPageToken: "p2" }) });
      return Response.json({ id: "m1", threadId: "t1", payload: { headers: [] } });
    });
    expect(await box.searchPage("is:unread", 5, undefined)).toEqual({ messages: [{ id: "m1", threadId: "t1" }], nextPageToken: "p2" });
    expect(await box.searchPage("is:unread", 5, "p2")).toEqual({ messages: [{ id: "m1", threadId: "t1" }] });
    expect(calls.at(-2)?.path).toBe("/messages?q=is%3Aunread&maxResults=5&pageToken=p2");
  });

  it("reads a thread's latest messages within its bounds, oldest first, and counts the earlier ones left out", async () => {
    const count = GMAIL_THREAD_BOUNDS.messages + 3;
    const { calls, box } = mailbox(() =>
      Response.json({
        id: "t1",
        messages: Array.from({ length: count }, (_, index) => ({
          id: `m${String(index)}`,
          threadId: "t1",
          payload: {
            mimeType: "text/plain",
            headers: [header("From", "ana@example.com")],
            body: {
              data: Buffer.from(
                index === count - 1
                  ? `${"x".repeat(GMAIL_THREAD_BOUNDS.text + 10)}\n\nOn Mon, Bo wrote:\n> ${"q".repeat(2_000)}\n`
                  : `Reply ${String(index)}`,
              ).toString("base64url"),
            },
          },
        })),
      }),
    );
    const thread = await box.thread("t1");
    expect(calls[0]?.path).toBe("/threads/t1?format=full");
    expect(thread.threadId).toBe("t1");
    expect(thread.messages).toHaveLength(GMAIL_THREAD_BOUNDS.messages);
    expect(thread.omitted).toBe(3);
    expect(thread.messages[0]?.id).toBe("m3");
    const latest = thread.messages.at(-1);
    expect(latest).toMatchObject({ id: `m${String(count - 1)}`, clipped: true });
    expect(latest?.text).toHaveLength(GMAIL_THREAD_BOUNDS.text);
    expect(latest?.quoted.reduce((sum, part) => sum + part.text.length, 0)).toBeLessThanOrEqual(GMAIL_THREAD_BOUNDS.quoted);
    expect(thread.messages[0]?.clipped).toBeUndefined();
  });

  it("leaves out of a thread what was deleted or marked spam, as Gmail shows it", async () => {
    const message = (id: string, labelIds: string[]) => ({
      id,
      threadId: "t1",
      labelIds,
      payload: {
        mimeType: "text/plain",
        headers: [header("From", "ana@example.com")],
        body: { data: Buffer.from(id).toString("base64url") },
      },
    });
    const { box } = mailbox(() =>
      Response.json({
        id: "t1",
        messages: [message("m1", ["INBOX"]), message("m2", ["TRASH"]), message("m3", ["SPAM"]), message("m4", ["SENT"])],
      }),
    );
    const thread = await box.thread("t1");
    expect(thread.messages.map((each) => each.id)).toEqual(["m1", "m4"]);
    expect(thread.omitted).toBe(0);
  });

  const labels = Response.json({
    labels: [
      { id: "INBOX", name: "INBOX" },
      { id: "UNREAD", name: "UNREAD" },
      { id: "TRASH", name: "TRASH" },
      { id: "Label_7", name: "Receipts" },
    ],
  });

  it("labels, archives and marks read in one batchModify, by label name, and reads each message back", async () => {
    const { calls, box } = mailbox((call) => {
      if (call.path === "/labels") return labels.clone();
      if (call.path === "/messages/batchModify") return new Response(null, { status: 204 });
      return Response.json({ id: "x", labelIds: call.path.startsWith("/messages/m2") ? ["INBOX", "Label_7"] : ["Label_7", "IMPORTANT"] });
    });
    const read = await box.modifyLabels({ ids: ["m1", "m2", "m1"], add: ["receipts"], remove: [], archive: true, read: true });
    expect(calls.find((call) => call.path === "/messages/batchModify")?.body).toEqual({
      ids: ["m1", "m2"],
      addLabelIds: ["Label_7"],
      removeLabelIds: ["INBOX", "UNREAD"],
    });
    expect(read).toEqual([
      { id: "m1", labels: ["Receipts", "IMPORTANT"], applied: true },
      { id: "m2", labels: ["INBOX", "Receipts"], applied: false },
    ]);
    expect(calls.filter((call) => call.path.endsWith("?format=minimal"))).toHaveLength(2);
  });

  it("refuses an unknown label, Trash, and too many messages, before anything changes", async () => {
    const { calls, box } = mailbox((call) => (call.path === "/labels" ? labels.clone() : Response.json({})));
    await expect(box.modifyLabels({ ids: ["m1"], add: ["Nope"], remove: [] })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(box.modifyLabels({ ids: ["m1"], add: ["TRASH"], remove: [] })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(box.modifyLabels({ ids: ["m1"], add: ["UNREAD"], remove: [], read: true })).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    await expect(
      box.modifyLabels({ ids: Array.from({ length: 51 }, (_, index) => `m${String(index)}`), add: [], remove: [], archive: true }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(calls.some((call) => call.path === "/messages/batchModify")).toBe(false);
  });
});
