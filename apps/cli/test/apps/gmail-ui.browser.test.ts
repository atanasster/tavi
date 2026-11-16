import { TaviError } from "@tavi/contracts";
import { launchChromium } from "@tavi/plugin-browser/chromium";
import { createFixtureModel, type ScriptedTurn } from "@tavi/test-support/fakes";
import { createIpcClient, readDiscovery, readToken } from "@tavi/runtime";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { temporaryDirectories, fakeFetch } from "@tavi/test-support";

import { builtCanvasDirectory } from "../../src/canvas-directory.js";
import type { CliIo } from "../../src/cli/io.js";
import { serve, type ServeHandle } from "../../src/server/serve.js";
import { startUiBridge, type UiBridge } from "../../src/server/ui-bridge.js";
import { chooseOption } from "../support/select.js";
import { fixtureServeOptions } from "../support/serve-fixture.js";

/**
 * Gmail end to end through the UI: in
 * Chromium, the operator adds a Gmail connection, allows a person, turns on
 * encryption, enters their OAuth app and connects — Google's sign-in page
 * stood in for by the browser, its token and Gmail API by fakes the owner
 * calls. The labelled mail then starts a turn; the agent, told of the channel
 * in its prompt, replies in the thread and sends with `send_to`.
 *
 * Without Chromium, or without a built canvas, the test skips.
 */

const quietIo: CliIo = { stdout: () => undefined, stderr: () => undefined, isTty: false };
type Chromium = Awaited<ReturnType<typeof launchChromium>>;

const ACCOUNT = "me@example.com";
const API = "https://gmail.googleapis.com/gmail/v1/users/me";
const AUTHENTICATED =
  "mx.google.com; dkim=pass header.i=@example.com; spf=pass smtp.mailfrom=ana@example.com; dmarc=pass header.from=example.com";

let chromium: Chromium | undefined;
const directories = temporaryDirectories();
let directory = "";
let handle: ServeHandle | undefined;
let bridge: UiBridge | undefined;
let skip: string | undefined;

/** The agent's script, filled in once the connection it names exists. */
const turns: ScriptedTurn[] = [{ text: "(not yet)" }];
const model = createFixtureModel({ turns });

/** Google's token endpoint, as the owner exchanges a code with it. */
const token = { exchanges: 0, clientId: "" };
const oauthFetch = fakeFetch(async (url, init) => {
  if (url === "https://oauth2.googleapis.com/token") {
    const body = new URLSearchParams(String(init?.body));
    token.exchanges += 1;
    token.clientId = body.get("client_id") ?? "";
    if (
      body.get("grant_type") !== "authorization_code" ||
      body.get("code") !== "google-code" ||
      (body.get("code_verifier") ?? "").length < 43
    )
      return Response.json({ error: "invalid_grant" }, { status: 400 });
    return Response.json({
      access_token: "ya29.access",
      refresh_token: "1//refresh",
      expires_in: 3600,
      // Google names each scope granted in full, as its token response does.
      scope: "openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/gmail.modify",
      token_type: "Bearer",
    });
  }
  // Who signed in, from Google's userinfo, as the sign-in names its account.
  if (url === "https://openidconnect.googleapis.com/v1/userinfo")
    return init?.headers !== undefined && JSON.stringify(init.headers).includes("ya29.access")
      ? Response.json({ email: ACCOUNT })
      : new Response("{}", { status: 401 });
  return new Response("{}", { status: 404 });
});

/** The Gmail API: one labelled message from Ana, listed until it is marked processed. */
const gmail = { modified: [] as string[], sent: [] as { raw: string; threadId?: string }[] };
const inbound = {
  id: "m1",
  threadId: "thread-1",
  internalDate: String(Date.now()),
  snippet: "ping",
  payload: {
    mimeType: "text/plain",
    headers: [
      { name: "From", value: "Ana <ana@example.com>" },
      { name: "Subject", value: "Plans" },
      { name: "Message-ID", value: "<m1@mail>" },
      { name: "Authentication-Results", value: AUTHENTICATED },
    ],
    body: { data: Buffer.from("ping").toString("base64url") },
  },
};
const gmailFetch = fakeFetch(async (url, init) => {
  const path = url.replace(API, "");
  if (!JSON.stringify(init?.headers ?? {}).includes("ya29.access")) return new Response("{}", { status: 401 });
  if (path === "/profile") return Response.json({ emailAddress: ACCOUNT });
  if (path === "/labels" && init?.method !== "POST") return Response.json({ labels: [{ id: "L-tavi", name: "tavi" }] });
  if (path === "/labels") return Response.json({ id: "L-processed", name: "tavi-processed" });
  if (path.startsWith("/messages?")) return Response.json({ messages: gmail.modified.includes("m1") ? [] : [{ id: "m1" }] });
  if (path === "/messages/m1?format=full") return Response.json(inbound);
  if (path === "/messages/m1/modify") {
    gmail.modified.push("m1");
    return Response.json({});
  }
  if (path === "/messages/send") {
    gmail.sent.push(JSON.parse(String(init?.body)) as { raw: string; threadId?: string });
    return Response.json({ id: `sent-${gmail.sent.length}`, threadId: "thread-1" });
  }
  return new Response("{}", { status: 404 });
});

beforeAll(async () => {
  const canvas = builtCanvasDirectory();
  if (canvas === undefined) {
    skip = "the canvas is not built";
    return;
  }
  try {
    chromium = await launchChromium({ headless: true });
  } catch (error) {
    if (error instanceof TaviError && error.code === "CAPABILITY_MISSING") {
      skip = error.message;
      return;
    }
    throw error;
  }
  directory = directories.create("tavi-gmail-ui-");
  handle = await serve(
    fixtureServeOptions(directory, {
      defaultConnectionId: "running-conn",
      defaultModel: "running-model",
      openSavedChannels: true,
      approvalRequiredFor: [],
      messagingAllowedDestinations: ["*:bo@example.com"],
    }),
    {
      dataDirectory: directory,
      drainDeadlineMs: 5_000,
      modelTarget: { source: "default", connectionId: "running-conn", model: "running-model", workspaceId: "default" },
    },
    quietIo,
    { modelOverride: model, channelFetch: { gmail: gmailFetch }, oauthFetchOverride: oauthFetch },
  );
  bridge = await startUiBridge({ dataDirectory: directory, staticDirectory: canvas });
}, 120_000);

afterAll(async () => {
  await chromium?.close();
  await bridge?.close();
  await handle?.shutdown("test");
  directories.cleanup();
});

/** The connection's id, as the owner lists it. */
async function connectionIdOf(): Promise<string> {
  const discovery = readDiscovery(directory);
  const secret = readToken(directory);
  if (discovery === undefined || secret === undefined) throw new Error("no owner");
  const client = await createIpcClient({ endpoint: discovery.endpoint, sessionId: discovery.sessionId, token: secret });
  try {
    const answer = await client.request("channels", { action: "list", workspaceId: "default" }, "gmail-ui-list");
    return (
      (answer.result as { connections: { connectionId: string; providerId: string }[] }).connections.find(
        (connection) => connection.providerId === "gmail",
      )?.connectionId ?? ""
    );
  } finally {
    client.close();
  }
}

describe("Gmail through the UI", () => {
  it("is added, allows a person, connects with Google, and its mail starts a turn the agent replies to and sends from", async (ctx) => {
    if (skip !== undefined || chromium === undefined || bridge === undefined) return ctx.skip();
    const context = await chromium.newContext();
    // Google's sign-in page: the person consents, and Google redirects back with a code for the flow's state.
    const authorized: URL[] = [];
    await context.route("https://accounts.google.com/**", async (route) => {
      const asked = new URL(route.request().url());
      authorized.push(asked);
      const back = new URL(asked.searchParams.get("redirect_uri") ?? "");
      back.searchParams.set("code", "google-code");
      back.searchParams.set("state", asked.searchParams.get("state") ?? "");
      await route.fulfill({ status: 302, headers: { location: back.toString() } });
    });
    const page = await context.newPage();
    await page.goto(bridge.mintLink());
    await page.waitForSelector(".canvas", { timeout: 20_000 });

    // Added from the catalog, with its label.
    await page.goto(`${bridge.origin}/settings/messaging`);
    await chooseOption(page.getByLabel("New connection channel"), "gmail");
    await page.getByRole("button", { name: "Add connection" }).click();
    await page.getByLabel("Label to read").fill("tavi");
    await page.getByRole("button", { name: "Save connection" }).click();
    await expect.poll(connectionIdOf, { timeout: 20_000 }).not.toBe("");
    const connectionId = await connectionIdOf();

    // The agent's script, now that it can name the connection: reply in the thread, then send to Bo.
    turns.splice(
      0,
      turns.length,
      { toolCall: { id: "reply", name: "messaging.send", input: { content: "Sounds good" } } },
      {
        toolCall: {
          id: "note",
          name: "messaging.send_to",
          input: { kind: "text", connectionId, to: "bo@example.com", content: "Ana says the plans are on" },
        },
      },
      { text: "done" },
    );

    // Ana allowed, before any mail of hers is read.
    await page.goto(`${bridge.origin}/settings/people`);
    await chooseOption(page.getByLabel("Person connection"), connectionId);
    await page.getByLabel("Email address").fill("ana@example.com");
    await page.getByLabel("Person ID").fill("ana");
    await page.getByLabel("Display name").fill("Ana");
    await page.getByRole("button", { name: "Allow person" }).click();
    await page.getByText("ana@example.com ·").waitFor({ timeout: 20_000 });

    // Signed in: encryption first, the operator's OAuth app, then Google.
    await page.goto(`${bridge.origin}/settings/messaging`);
    await page.getByRole("button", { name: /Edit Gmail/ }).click();
    await page.getByRole("button", { name: "Encrypt credentials" }).click();
    await page.getByLabel("OAuth client ID").fill("operator-client.apps.googleusercontent.com");
    await page.getByLabel("OAuth client secret").fill("operator-secret");
    await page.getByRole("button", { name: "Save OAuth app" }).click();
    const popup = context.waitForEvent("page");
    await page.getByRole("button", { name: "Connect with Gmail" }).click();
    await (await popup).waitForLoadState();
    await page.getByText(`Connected as ${ACCOUNT}.`).first().waitFor({ timeout: 20_000 });
    expect(authorized[0]?.searchParams.get("client_id")).toBe("operator-client.apps.googleusercontent.com");
    expect(authorized[0]?.searchParams.get("code_challenge_method")).toBe("S256");
    expect(token).toEqual({ exchanges: 1, clientId: "operator-client.apps.googleusercontent.com" });

    // Ana's labelled mail started a turn: the agent replied in the thread, then sent to Bo.
    await expect.poll(() => gmail.sent.length, { timeout: 30_000 }).toBe(2);
    expect(gmail.modified).toEqual(["m1"]);
    const [reply, note] = gmail.sent.map((sent) => ({ threadId: sent.threadId, raw: Buffer.from(sent.raw, "base64url").toString("utf8") }));
    expect(reply?.threadId).toBe("thread-1");
    expect(reply?.raw).toContain(`From: ${ACCOUNT}\r\nTo: ana@example.com\r\nSubject: Re: Plans\r\nIn-Reply-To: <m1@mail>`);
    expect(note?.raw).toContain("To: bo@example.com\r\n");
    // It saw the channel, and the target it may send to, in its prompt.
    // The first call, before any tool call of its own could name them.
    const prompt = JSON.stringify(model.calls[0]);
    expect(prompt).toContain(connectionId);
    expect(prompt).toContain("bo@example.com");
    await context.close();
  }, 120_000);
});
