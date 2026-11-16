import { describe, expect, it } from "vitest";
import { z } from "zod";

import { ToolRegistry, registerFetchTool } from "@tavi/runtime";

/**
 * `web_fetch` never asks anyone, so under an allowlist it opens only the hosts
 * on it. A site the user names but the list lacks is read with the browser,
 * which asks them — the fetch must not fail the task on its own.
 */
describe("web_fetch under the operator's allowlist", () => {
  const registered = (allowedHosts: readonly string[], browser = true) => {
    const tools = new ToolRegistry();
    // The browser is a plugin that may be off: a refusal names it only while its tool is registered.
    if (browser)
      tools.register({
        id: "browser.create_session",
        sink: "network",
        urlOnly: true,
        version: "1.0.0",
        description: "Browser fixture",
        effect: "external",
        requiredPermissions: [],
        inputSchema: z.looseObject({ url: z.string() }),
        handler: async () => ({}),
      });
    const execution = {
      ownerSession: "owner",
      implementationHash: "a".repeat(64),
      signal: new AbortController().signal,
      actsIn: (_workspaceId: string, principalId: string) => principalId === "operator",
      ledger: { reserveOperation: async () => {}, finishOperation: async () => {}, operations: async () => [] },
    };
    registerFetchTool(tools, { enabled: true, networkMode: "custom_hosts", allowedHosts, execution });
    return tools;
  };

  it("is not offered when the allowlist is empty", async () => {
    expect((await registered([]).listOffered({ workspaceId: "default" })).map((tool) => tool.id)).not.toContain("web_fetch");
    expect((await registered(["example.com"]).listOffered({ workspaceId: "default" })).map((tool) => tool.id)).toContain("web_fetch");
  });

  it("refuses a host off the list before the call, pointing at the browser", () => {
    const assess = registered(["example.com"]).get("web_fetch")?.assess;
    const context = { workspaceId: "default", principalId: "operator", runId: "task-1", caller: "test" };
    expect(assess?.({ url: "https://example.com/a" }, context).hardDeny).toBeUndefined();
    const refused = assess?.({ url: "https://smart.example.org/" }, context).hardDeny;
    expect(refused).toContain("smart.example.org");
    expect(refused).toContain("browser.create_session");
    const noBrowser = registered(["example.com"], false)
      .get("web_fetch")
      ?.assess?.({ url: "https://smart.example.org/" }, context).hardDeny;
    expect(noBrowser).toContain("smart.example.org");
    expect(noBrowser).not.toContain("browser");
  });
});

/**
 * `format: "raw"` hands back the body as fetched — markup kept — paged,
 * bounded and labelled exactly as the text is; the default stays the page's text.
 */
describe("web_fetch's format", () => {
  const page = `<html><head><script>var tracked = 1;</script></head><body><p>Hi <a href="/x">there</a></p>${"<i>z</i>".repeat(3_000)}</body></html>`;
  const fetchTool = (contentType = "text/html") => {
    const tools = new ToolRegistry();
    const execution = {
      ownerSession: "owner",
      implementationHash: "a".repeat(64),
      signal: new AbortController().signal,
      actsIn: (_workspaceId: string, principalId: string) => principalId === "operator",
      ledger: { reserveOperation: async () => {}, finishOperation: async () => {}, operations: async () => [] },
    };
    registerFetchTool(tools, {
      networkMode: "open_web",
      execution,
      resolve: async () => ["93.184.216.34"],
      transport: {
        exchange: async () => ({
          status: 200,
          headers: { "content-type": contentType },
          chunks: (async function* () {
            yield Buffer.from(page);
          })(),
        }),
      },
    });
    const tool = tools.get("web_fetch")!;
    const context = { workspaceId: "default", principalId: "operator", runId: "task-1", caller: "test" };
    return async (input: Record<string, unknown>) => {
      const binding = await tool.resolveBinding!(input, context);
      return (await tool.handler({ input, context, signal: new AbortController().signal, expectedBindingHash: binding.bindingHash })) as {
        readonly content: { readonly body: { readonly kind: string; readonly content: string } };
        readonly page?: { readonly nextOffset?: number; readonly totalChars: number };
        readonly readable?: string;
      };
    };
  };

  it("returns the page's text by default, and its markup as fetched with raw, a page at a time", async () => {
    const fetch = fetchTool();
    const text = await fetch({ url: "https://example.com/a" });
    expect(text.content.body).toMatchObject({ kind: "text" });
    expect(text.content.body.content).toContain("Hi there (https://example.com/x)");
    expect(text.content.body.content).not.toContain("tracked");
    const raw = await fetch({ url: "https://example.com/a", format: "raw", maxChars: 1_000 });
    expect(raw.content.body).toMatchObject({ kind: "html" });
    expect(raw.content.body.content).toBe(page.slice(0, 1_000));
    expect(raw).not.toHaveProperty("readable");
    expect(raw.page).toMatchObject({ totalChars: page.length, nextOffset: 1_000 });
    const next = await fetch({ url: "https://example.com/a", format: "raw", offset: 1_000, maxChars: 1_000 });
    expect(next.content.body.content).toBe(page.slice(1_000, 2_000));
  });

  it("asks for the same fetch whatever the format: the binding sees the URL alone", async () => {
    const tool = (() => {
      const tools = new ToolRegistry();
      registerFetchTool(tools, {
        networkMode: "open_web",
        execution: {
          ownerSession: "owner",
          implementationHash: "a".repeat(64),
          signal: new AbortController().signal,
          actsIn: () => true,
          ledger: { reserveOperation: async () => {}, finishOperation: async () => {}, operations: async () => [] },
        },
      });
      return tools.get("web_fetch")!;
    })();
    const context = { workspaceId: "default", principalId: "operator", runId: "task-1", caller: "test" };
    const plain = await tool.resolveBinding!({ url: "https://example.com/a" }, context);
    const raw = await tool.resolveBinding!({ url: "https://example.com/a", format: "raw" }, context);
    expect(raw.bindingHash).toBe(plain.bindingHash);
  });

  it("refuses a format it does not know", async () => {
    await expect(fetchTool()({ url: "https://example.com/a", format: "binary" })).rejects.toThrow();
  });
});
