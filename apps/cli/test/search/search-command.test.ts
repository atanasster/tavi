import { createServer, type Server } from "node:http";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { capture, temporaryDirectories } from "@tavi/test-support";
import { sse, textChunk, toolCallChunk } from "@tavi/test-support/openai-stub";
import { afterEach, describe, expect, it } from "vitest";

import { EXIT, main } from "../../src/main.js";

/**
 * `tavi search` and `web_search` end to end: providers configured by
 * the command, tested against a real SearXNG-shaped HTTP stub, and reached by
 * an unattended schedule only through its own allowlist. Only the model and
 * the search instance are stubs.
 */

const directories = temporaryDirectories({ prefix: "tavi-search-cmd-" });
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
  directories.cleanup();
});

/** A local HTTP server; `answer` sees each request's path and body. */
async function server(
  answer: (path: string, body: string) => { readonly status?: number; readonly type?: string; readonly body: string },
): Promise<{ readonly url: string; readonly requests: string[]; readonly bodies: string[] }> {
  const requests: string[] = [];
  const bodies: string[] = [];
  const instance: Server = createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk) => (raw += String(chunk)));
    request.on("end", () => {
      requests.push(request.url ?? "");
      bodies.push(raw);
      const given = answer(request.url ?? "", raw);
      response.writeHead(given.status ?? 200, { "content-type": given.type ?? "application/json" });
      response.end(given.body);
    });
  });
  await new Promise<void>((resolve) => instance.listen(0, "127.0.0.1", () => resolve()));
  cleanups.push(() => new Promise<void>((done) => instance.close(() => done())));
  const address = instance.address();
  if (address === null || typeof address === "string") throw new Error("no TCP port");
  return { url: `http://127.0.0.1:${address.port}`, requests, bodies };
}

/** A SearXNG instance answering every search with one result. */
const searxng = async () =>
  await server((path) =>
    path.startsWith("/search?")
      ? { body: JSON.stringify({ results: [{ title: "Tavi", url: "https://tavi.example/", content: "an orchestrator" }] }) }
      : { status: 404, body: "{}" },
  );

const directory = (): string => directories.create();

describe("tavi search", () => {
  it("adds, lists, disables, enables and removes providers, refusing a configuration that cannot work", async () => {
    const data = directory();
    const run = async (...args: string[]) => {
      const captured = capture();
      const code = await main(["search", ...args, "--data-dir", data], { io: captured.io });
      return { code, out: captured.stdout(), err: captured.stderr() };
    };
    expect((await run("list")).out).toContain("no search provider is configured");
    expect((await run("add", "free", "--kind", "tavily")).code).toBe(EXIT.ok);
    expect((await run("add", "home", "--kind", "searxng", "--base-url", "http://127.0.0.1:8888")).code).toBe(EXIT.ok);
    expect((await run("add", "brave", "--kind", "brave", "--credential", "brave.apiKey")).code).toBe(EXIT.ok);
    const listed = await run("list");
    expect(listed.out).toBe(
      "free\ttavily\t(keyless)\tenabled\nhome\tsearxng\thttp://127.0.0.1:8888\tenabled\nbrave\tbrave\tcredential brave.apiKey\tenabled\n",
    );

    // Refused, saying why, with nothing written.
    const refusals = [
      await run("add", "keyless-brave", "--kind", "brave"),
      await run("add", "keyed-searx", "--kind", "searxng", "--base-url", "https://s.example", "--credential", "k.key"),
      await run("add", "hosted-base", "--kind", "serper", "--credential", "serper.apiKey", "--base-url", "https://s.example"),
      await run("add", "free", "--kind", "tavily"),
      await run("add", "bing", "--kind", "bing"),
      // A key that is not a search reference: a model's, say.
      await run("add", "stolen", "--kind", "brave", "--credential", "openai.apiKey"),
    ];
    expect(refusals.map((refusal) => refusal.code)).toEqual(Array(6).fill(EXIT.usage));
    expect(refusals[5]?.err).toContain("must be stored under search.<name> or brave.<name>");

    // A search reference a stored model connection holds is refused offline too.
    const models = async (...args: string[]) => main(["models", ...args, "--data-dir", data], { io: capture().io });
    expect(await models("add", "shared", "--base-url", "https://api.example.com/v1", "--credential", "search.shared", "--model", "m")).toBe(
      EXIT.ok,
    );
    const held = await run("add", "held", "--kind", "brave", "--credential", "search.shared");
    expect(held.code).toBe(EXIT.usage);
    expect(held.err).toContain("a model connection's key");
    expect(refusals[0]?.err).toContain("a brave provider needs a credentialRef");
    expect(refusals[3]?.err).toContain("already exists");
    expect(refusals[4]?.err).toContain("--kind must be one of tavily, brave, serper, searxng");

    expect((await run("disable", "home", "--format", "json")).out).toContain('"enabled": false');
    expect((await run("enable", "home")).out).toBe("home\tsearxng\thttp://127.0.0.1:8888\tenabled\n");
    expect((await run("remove", "free")).out).toBe("removed free\n");
    expect((await run("remove", "free")).code).toBe(EXIT.unavailable);
    expect((await run("test", "nobody")).code).toBe(EXIT.unavailable);
    expect(
      JSON.parse((await run("list", "--format", "json")).out).providers.map((provider: { providerId: string }) => provider.providerId),
    ).toEqual(["home", "brave"]);
  }, 15_000);

  it("tests a provider through the adapter web_search uses: an answer, or the typed refusal and exit 1", async () => {
    const instance = await searxng();
    const data = directory();
    await main(["search", "add", "home", "--kind", "searxng", "--base-url", instance.url, "--data-dir", data], { io: capture().io });
    const tested = capture();
    expect(await main(["search", "test", "home", "--query", "tavi orchestrator", "--data-dir", data], { io: tested.io })).toBe(EXIT.ok);
    expect(tested.stdout()).toBe("home answered 1 result(s)\n  Tavi\n    https://tavi.example/\n");
    expect(instance.requests).toEqual(["/search?q=tavi+orchestrator&format=json"]);

    // A keyed provider whose key is not stored fails its test, naming the fix.
    await main(["search", "add", "brave", "--kind", "brave", "--credential", "brave.apiKey", "--data-dir", data], { io: capture().io });
    const unkeyed = capture();
    expect(await main(["search", "test", "brave", "--data-dir", data], { io: unkeyed.io })).toBe(EXIT.taskFailed);
    expect(unkeyed.stderr()).toContain("NOT_CONFIGURED");
    expect(unkeyed.stderr()).toContain("tavi credentials set brave.apiKey");

    // A key a model connection took since the provider was added is not sent to the search endpoint, offline as on an owner.
    expect(
      await main(
        [
          "models",
          "add",
          "grab",
          "--base-url",
          "https://models.example/v1",
          "--credential",
          "brave.apiKey",
          "--model",
          "m",
          "--data-dir",
          data,
        ],
        { io: capture().io },
      ),
    ).toBe(EXIT.ok);
    const taken = capture();
    expect(await main(["search", "test", "brave", "--data-dir", data], { io: taken.io })).toBe(EXIT.usage);
    expect(taken.stderr()).toContain("credential brave.apiKey is a model connection's key");
  });
});

describe("web_search in an unattended schedule", () => {
  /** A model that searches the web first, then answers from what came back. */
  const searchingModel = async () =>
    await server((_path, body) => {
      const messages = (JSON.parse(body === "" ? "{}" : body) as { messages?: { role: string }[] }).messages ?? [];
      const searched = messages.some((message) => message.role === "tool");
      return {
        type: "text/event-stream",
        body: searched
          ? sse([textChunk("Tavi is an orchestrator.", null), textChunk("", "stop")])
          : sse([toolCallChunk({ id: "call-1", name: "web_search", arguments: { query: "tavi" } }), textChunk("", "tool_calls")]),
      };
    });

  interface ModelRequestBody {
    readonly tools?: readonly { readonly function?: { readonly name?: string } }[];
    readonly messages?: readonly { readonly role: string; readonly content?: unknown }[];
  }

  async function scheduled(
    allow: readonly string[],
    options: { readonly askForSearch?: boolean } = {},
  ): Promise<{
    readonly searches: string[];
    readonly code: number;
    readonly out: string;
    readonly modelRequests: readonly ModelRequestBody[];
  }> {
    const model = await searchingModel();
    const instance = await searxng();
    const data = directory();
    const key = join(data, "model.key");
    writeFileSync(key, "sk-model\n", { mode: 0o600 });
    for (const args of [
      ["credentials", "set", "model.key", "--file", key],
      ["models", "add", "stub", "--base-url", `${model.url}/v1`, "--credential", "model.key", "--model", "m", "--local-only"],
      ["models", "set-default", "--connection", "stub", "--model", "m"],
      ["search", "add", "home", "--kind", "searxng", "--base-url", instance.url],
      [
        "schedules",
        "add",
        "--name",
        "brief",
        "--at",
        "07:00",
        "--timezone",
        "UTC",
        "--prompt",
        "What is tavi? Search the web.",
        ...allow.flatMap((tool) => ["--allow", tool]),
      ],
      // The seeded rule lets any search run unasked; an ask rule, which comes before every allow rule, puts the
      // schedule's own tool list back in charge, as revoking the seeded rule does.
      ...(options.askForSearch === true ? [["permissions", "add", "--tool", "web_search", "--decision", "ask"]] : []),
    ]) {
      expect(await main([...args, "--data-dir", data], { io: capture().io }), args.join(" ")).toBe(EXIT.ok);
    }
    const fired = capture();
    const code = await main(["schedules", "run-now", "brief", "--data-dir", data, "--format", "json"], { io: fired.io });
    return {
      searches: instance.requests,
      code,
      out: fired.stdout(),
      modelRequests: model.bodies.map((body) => JSON.parse(body) as ModelRequestBody),
    };
  }

  it("reaches web_search when the schedule's allowlist covers it", async () => {
    const { searches, code, out } = await scheduled(["web_search"]);
    expect(code).toBe(EXIT.ok);
    expect(searches).toEqual(["/search?q=tavi&format=json"]);
    expect(out).toContain("Tavi is an orchestrator.");
  });

  it("searches with no tool list, by the seeded rule", async () => {
    const { searches, code } = await scheduled([]);
    expect(code).toBe(EXIT.ok);
    expect(searches).toEqual(["/search?q=tavi&format=json"]);
  });

  it("asked about, is denied by the policy loop without it: offered, asked for, refused — and no search is made", async () => {
    const { searches, code, modelRequests } = await scheduled([], { askForSearch: true });
    expect(searches).toEqual([]);
    // The tool was offered, and the model did ask for it: what stopped the call was the policy.
    expect(modelRequests[0]?.tools?.some((tool) => tool.function?.name === "web_search")).toBe(true);
    const toolResult = modelRequests[1]?.messages?.find((message) => message.role === "tool");
    expect(JSON.stringify(toolResult?.content ?? "")).toMatch(/denied|not approved|reject/i);
    // The run went on to its end with the model's answer, rather than failing before any tool call.
    expect(code).toBe(EXIT.ok);
  });
});
