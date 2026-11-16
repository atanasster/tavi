import { join } from "node:path";
import { expect, it, afterEach } from "vitest";
import { temporaryDirectories } from "@tavi/test-support";
import { ToolRegistry } from "@tavi/runtime";
import { SqliteStore } from "../support/database-fixture.js";
import { createFixtureRenderer } from "@tavi/plugin-browser/render";
import { createTelegramConnectorDefinition } from "@tavi/plugin-telegram/connector";
import { collectDaily, renderBriefHtml } from "@tavi/plugin-collectors";
import { registerHttpTools } from "../../src/features/http/tools.js";

const directories = temporaryDirectories();
afterEach(() => directories.cleanup());

it("connects fixture discovery, fetched evidence, report bytes and mocked Telegram document delivery", async () => {
  const directory = directories.create("tavi-routine-news-");
  const store = await SqliteStore.open({ databasePath: join(directory, "db.sqlite"), artifactsDirectory: join(directory, "artifacts") });
  const now = "2026-09-20T06:00:00.000Z";
  const secretReader = { getSecret: async () => null };
  const sent: FormData[] = [];
  const connector = createTelegramConnectorDefinition({
    fetch: async (input, init) => {
      const method = String(input).split("/").at(-1);
      if (method === "getUpdates")
        return new Promise<Response>((_resolve, reject) =>
          init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true }),
        );
      if (method === "getMe") return Response.json({ ok: true, result: { id: 1, is_bot: true, first_name: "Fixture" } });
      if (method !== "sendDocument" || !(init?.body instanceof FormData)) throw new Error("unexpected fixture request");
      sent.push(init.body);
      return Response.json({ ok: true, result: { message_id: 88, date: 0, chat: { id: 7 } } });
    },
    readArtifact: async (id, workspace) => {
      const record = await store.getArtifact(id);
      const bytes = await store.readArtifactBody(id);
      return record?.workspaceId === workspace && record.reviewState === "approved" && bytes !== undefined
        ? { bytes, contentType: record.contentType }
        : undefined;
    },
  }).createConnection({
    connection: {
      connectionId: "fixture-telegram",
      providerId: "telegram",
      workspaceId: "default",
      accountIdentity: "fixture",
      configRevision: 1,
      credentialRef: "fixture-token",
      enabled: true,
    },
    config: {},
    credentials: { get: async () => "fixture-only-token", accessToken: async () => "" },
  });
  try {
    const projects = store.asPort().repositories.projects;
    await projects.create({ workspaceId: "default", project: { id: "llm", name: "LLM", keywords: ["fixture"] }, enabled: true, now });
    await projects.putSettings({ workspaceId: "default", settings: { news: { feedUrls: ["https://news.example/feed"] } }, now });
    const brief = await collectDaily(
      {
        projects,
        dataDirectory: directory,
        secretReader,
        now: () => new Date(now),
        fetchImpl: async (url) => {
          expect(String(url)).toBe("https://news.example/feed");
          return new Response(
            "<rss><channel><item><title>Fixture model v2 released</title><link>https://news.example/release</link><pubDate>Sat, 19 Sep 2026 09:00:00 GMT</pubDate></item></channel></rss>",
          );
        },
      },
      { workspaceId: "default" },
    );
    expect(brief.projects[0]?.news[0]?.url).toBe("https://news.example/release");
    const registry = new ToolRegistry();
    registerHttpTools(registry, {
      secretReader,
      allowedHosts: ["news.example"],
      fetchImpl: async () => new Response("Fixture model v2 released", { headers: { "content-type": "text/plain" } }),
    });
    const evidence = await registry.get("http.request")!.handler({
      input: { url: "https://news.example/release" },
      context: { workspaceId: "default", principalId: "operator", runId: "spike", caller: "test" },
      signal: new AbortController().signal,
    });
    expect(JSON.stringify(evidence)).toContain("Fixture model v2 released");
    // This proves existing project-template composition only. R3 needs a
    // separate typed news-evidence template and semantic claim validation.
    const html = await renderBriefHtml(brief);
    expect(html).toContain('href="https://news.example/release"');
    const document = await createFixtureRenderer().renderPdf({ html });
    const artifact = await store.putArtifact({
      workspaceId: "default",
      contentType: "application/pdf",
      body: document.bytes,
      extension: "pdf",
    });
    await connector.start();
    const outcome = await connector.send({
      effectId: "fixture-report-1",
      workspaceId: "default",
      connectionId: "fixture-telegram",
      destination: { chatId: "7" },
      parts: [{ kind: "file", artifactId: (await artifact).artifactId, filename: "news.pdf" }],
    });
    expect(outcome.parts[0]?.providerMessageId).toBe("88");
    expect(sent).toHaveLength(1);
    expect(sent[0]?.get("chat_id")).toBe("7");
    expect(new Uint8Array(await (sent[0]?.get("document") as File).arrayBuffer())).toEqual(document.bytes);
  } finally {
    await connector.stop();
    await store.close();
  }
});
