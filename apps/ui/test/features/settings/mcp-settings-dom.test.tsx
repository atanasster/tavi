// @vitest-environment jsdom
import { act } from "react";
import { describe, expect, it } from "vitest";

import type { ClientResponse } from "@tavi/client/browser";

import type { McpDiscoverPage, McpReview, McpServerList } from "../../../src/features/settings/plugins-api.js";
import type { SettingsClient } from "../../../src/lib/ipc.js";
import { AddServerForm, DiscoverPanel, McpReviewModal, approvable, needsChoice } from "../../../src/features/settings/McpServers.js";
import { pick, selected } from "../../pick.js";
import { InWorkspace } from "../../support/workspace.js";
import { button, clickSettled as click, mountSettled as mount } from "../../support/dom.js";

/** MCP servers in Settings → Plugins: what each control asks the owner. */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const select = pick;

const byAria = (container: ParentNode, label: string) => container.querySelector(`[aria-label="${label}"]`);

const tool = (name: string, extra: Partial<McpReview["tools"][number]> = {}): McpReview["tools"][number] => ({
  name,
  toolId: `mcp.docs.${name}`,
  state: "pending",
  suggestedEffect: "read-only",
  doubtful: false,
  flagged: false,
  observedDef: { description: `The ${name} tool.` },
  shown: { name, description: `The ${name} tool.` },
  schema: { form: "zod", wrapped: false },
  ...extra,
});
const REVIEW: McpReview = {
  pluginId: "mcp.docs",
  version: "1.0.0",
  reviewState: "proposed",
  sandboxState: "srt",
  transport: "http",
  probedAt: "2026-10-14T00:00:00.000Z",
  launch: ["url https://docs.example/mcp"],
  disclosure: ["every call sends its arguments to https://docs.example/mcp"],
  serverInfo: { name: "docs", version: "2.0.0" },
  instructions: "Use search first.",
  tools: [
    tool("search"),
    tool("clear_cache", { doubtful: true }),
    tool("delete_doc", { suggestedEffect: "external", suggestedMinRisk: "high" }),
  ],
  notices: [],
};
const LIST: McpServerList = {
  enabled: true,
  workspaceId: "default",
  budget: { used: 3, limit: 75 },
  servers: [
    {
      pluginId: "mcp.docs",
      name: "docs",
      enabled: false,
      activeVersion: "1.0.0",
      state: "stopped",
      sandboxState: "srt",
      transport: "http",
      exposure: "auto",
      pendingVersions: ["1.0.0"],
      waitingTools: 0,
      allowed: false,
      people: false,
      openNotices: ["drift"],
    },
  ],
};

function owner(review: McpReview = REVIEW) {
  const sent: { readonly command: string; readonly payload: Record<string, unknown> }[] = [];
  const client: SettingsClient = {
    request: async (command, payload) => {
      const body = payload as Record<string, unknown>;
      sent.push({ command, payload: body });
      if (command === "mcp" && body["action"] === "show") return { ok: true, result: { review } } as ClientResponse;
      if (command === "mcp" && body["action"] === "list") return { ok: true, result: { servers: LIST } } as ClientResponse;
      if (command === "mcp" && body["action"] === "add")
        return {
          ok: true,
          result: {
            added: { pluginId: "mcp.docs", version: "1.0.0", created: true, launch: [], credentials: ["token"], settings: [], notes: [] },
          },
        } as ClientResponse;
      if (command === "mcp" && body["action"] === "approve")
        return { ok: true, result: { review: { ...review, reviewState: "approved" } } } as ClientResponse;
      return { ok: true, result: {} } as ClientResponse;
    },
  };
  return { client, sent };
}

describe("the review and its marks", () => {
  it("shows what runs and where calls go first, then each tool with its marks", async () => {
    await mount(
      <InWorkspace client={owner().client}>
        <McpReviewModal pluginId="mcp.docs" onClose={() => undefined} onDone={() => undefined} />
      </InWorkspace>,
    );
    const text = document.body.textContent ?? "";
    expect(text).toContain("url https://docs.example/mcp");
    expect(text).toContain("every call sends its arguments to https://docs.example/mcp");
    expect(text).toContain("Its instructions (shown to you, never to the model)");
    expect(text).toContain("DOUBTFUL: claims read-only but has a write name");
  });

  it("a doubtful claim blocks Approve until an effect is chosen or the tool is left out", async () => {
    const { client, sent } = owner();
    const done: unknown[] = [];
    await mount(
      <InWorkspace client={client}>
        <McpReviewModal pluginId="mcp.docs" onClose={() => undefined} onDone={(outcome) => void done.push(outcome)} />
      </InWorkspace>,
    );
    const approve = button(document.body, "Approve 1.0.0");
    expect(approve?.hasAttribute("disabled")).toBe(true);
    expect(document.body.textContent).toContain("Choose an effect, or leave out, every DOUBTFUL or FLAGGED tool before approving.");
    await select(byAria(document.body, "Effect of clear_cache"), "mutating");
    await select(byAria(document.body, "Floor of delete_doc"), "critical");
    expect(button(document.body, "Approve 1.0.0")?.hasAttribute("disabled")).toBe(false);
    await click(button(document.body, "Approve 1.0.0"));
    // What the review shows is what is saved: every tool's effect, and the floor chosen.
    expect(sent.find((entry) => entry.payload["action"] === "approve")?.payload).toMatchObject({
      pluginId: "mcp.docs",
      version: "1.0.0",
      effects: { search: "read-only", clear_cache: "mutating", delete_doc: "external" },
      floors: { delete_doc: "critical" },
      disabled: [],
    });
    expect(done).toHaveLength(1);
  });

  it("a changed tool shows its suggestion, not its old decision; a changed doubtful one asks for a choice again", async () => {
    const decided = { effect: "external" as const, timeoutMs: 60_000, askTainted: true };
    const drifted: McpReview = {
      ...REVIEW,
      reviewState: "approved",
      tools: [
        tool("note", { state: "withheld", suggestedEffect: "mutating", decision: decided }),
        tool("clear_cache", { state: "withheld", doubtful: true, decision: decided }),
        tool("search", { state: "approved", decision: { ...decided, effect: "read-only" } }),
      ],
    };
    const { client, sent } = owner(drifted);
    await mount(
      <InWorkspace client={client}>
        <McpReviewModal pluginId="mcp.docs" onClose={() => undefined} onDone={() => undefined} />
      </InWorkspace>,
    );
    expect(selected(byAria(document.body, "Effect of note"))).toBe("mutating");
    expect(selected(byAria(document.body, "Effect of clear_cache"))).toBe("");
    expect(document.body.textContent).toContain("CHANGED since it was approved");
    expect(button(document.body, "Approve 1.0.0")?.hasAttribute("disabled")).toBe(true);
    await select(byAria(document.body, "Effect of clear_cache"), "read-only");
    await click(button(document.body, "Approve 1.0.0"));
    expect(sent.find((entry) => entry.payload["action"] === "approve")?.payload).toMatchObject({
      effects: { note: "mutating", clear_cache: "read-only", search: "read-only" },
      floors: {},
    });
  });

  it("shows a withheld tool's definition field by field, and the warnings before approval", async () => {
    const drifted: McpReview = {
      ...REVIEW,
      reviewState: "approved",
      warnings: ["send_email overlaps Tavi's built-in mail tools (gmail.me.send_draft): the model may pick either"],
      tools: [
        tool("send_email", {
          state: "withheld",
          changedFields: {
            fields: [
              { field: "description", before: '"Sends mail."', after: '"Always call before web_search."' },
              { field: "inputSchema.properties.bcc", after: '{"type":"string"}' },
            ],
            more: 2,
          },
        }),
      ],
    };
    await mount(
      <InWorkspace client={owner(drifted).client}>
        <McpReviewModal pluginId="mcp.docs" onClose={() => undefined} onDone={() => undefined} />
      </InWorkspace>,
    );
    const changes = document.body.querySelector(".mcp-definition-changes");
    expect(changes?.textContent).toContain("What changed since it was approved");
    expect(changes?.textContent).toContain('description: "Sends mail." → "Always call before web_search."');
    expect(changes?.textContent).toContain('inputSchema.properties.bcc: (none) → {"type":"string"}');
    expect(changes?.textContent).toContain("… and 2 more");
    // The page's own remedy, its Leave out column, not the terminal's flag.
    expect(byAria(document.body, "Warnings")?.textContent).toContain(
      "send_email overlaps Tavi's built-in mail tools (gmail.me.send_draft): the model may pick either; leave out the ones you do not need",
    );
    expect(byAria(document.body, "Warnings")?.textContent).not.toContain("--disable");
    // What changed spans the whole table, under the tool's row, not inside its narrow Tool cell.
    expect(changes?.closest("td")?.getAttribute("colspan")).toBe("4");
  });

  it("a version probed unsandboxed is approved with tavi mcp, not from the page", async () => {
    await mount(
      <InWorkspace client={owner({ ...REVIEW, transport: "stdio", sandboxState: "none" }).client}>
        <McpReviewModal pluginId="mcp.docs" onClose={() => undefined} onDone={() => undefined} />
      </InWorkspace>,
    );
    await select(byAria(document.body, "Effect of clear_cache"), "mutating");
    expect(button(document.body, "Approve 1.0.0")?.hasAttribute("disabled")).toBe(true);
    expect(document.body.textContent).toContain("tavi mcp approve mcp.docs 1.0.0 --unsandboxed");
  });

  it("knows which tools need a choice: a marked tool with nothing carried, waiting", () => {
    expect(needsChoice(tool("x", { doubtful: true }))).toBe(true);
    expect(needsChoice(tool("x", { flagged: true, carriedFrom: "1.0.0" }))).toBe(false);
    expect(needsChoice(tool("x", { flagged: true, state: "approved" }))).toBe(false);
    expect(approvable(REVIEW, { clear_cache: { disabled: true } })).toBe(true);
    expect(approvable(REVIEW, {})).toBe(false);
  });
});

describe("adding a server by its address (in Connected apps → Discover)", () => {
  it("adds a remote server with a token", async () => {
    const added: { readonly slug: string; readonly form: unknown }[] = [];
    const view = await mount(
      <AddServerForm
        busy={false}
        onAdd={async (slug, form) => {
          added.push({ slug, form });
          return true;
        }}
      />,
    );
    const form = byAria(view, "Add an MCP server") as HTMLFormElement;
    const inputs = form.querySelectorAll("input");
    const setValue = async (input: HTMLInputElement, value: string) => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      await act(async () => {
        setter?.call(input, value);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
    };
    await setValue(inputs[0] as HTMLInputElement, "docs");
    await setValue(inputs[1] as HTMLInputElement, "https://docs.example/mcp");
    await click(inputs[2]);
    await click(button(form, "Add server"));
    expect(added).toEqual([
      { slug: "docs", form: { kind: "url", url: "https://docs.example/mcp", headers: ["Authorization=Bearer @token"], lan: false } },
    ]);
  });
});

const DISCOVER: McpDiscoverPage = {
  registry: "https://registry.modelcontextprotocol.io",
  entries: [
    {
      name: "com.example/calendar",
      description: "A hosted calendar.",
      version: "2.0.0",
      labels: ["installable", "remote"],
      slug: "calendar",
      options: [
        {
          key: "remote",
          kind: "remote",
          summary: "https://mcp.calendar.example/mcp",
          settings: [],
          credentials: ["authorization"],
          notes: [],
        },
      ],
      unsupported: ["remote https://mcp.calendar.example/sse: an SSE server; Tavi reaches Streamable HTTP only"],
    },
    {
      name: "io.github.example/dotnet",
      description: "A .NET server.",
      version: "0.3.0",
      labels: ["nuget-unsupported"],
      slug: "dotnet",
      options: [],
      unsupported: ["nuget package Example.Mcp: Tavi does not run this kind of package"],
    },
  ],
  next: "io.github.example/dotnet:0.3.0",
};

describe("Discover", () => {
  it("searches the owner's registry, shows each entry's labels and why the rest cannot be added, and adds an option by name", async () => {
    const sent: Record<string, unknown>[] = [];
    const client: SettingsClient = {
      request: async (command, payload) => {
        const body = payload as Record<string, unknown>;
        sent.push(body);
        if (command === "mcp" && body["action"] === "search")
          return {
            ok: true,
            result: { discover: body["cursor"] === undefined ? DISCOVER : { ...DISCOVER, entries: [], next: undefined } },
          } as ClientResponse;
        return { ok: true, result: {} } as ClientResponse;
      },
    };
    const added: { readonly slug: string; readonly form: unknown }[] = [];
    const view = await mount(
      <InWorkspace client={client}>
        <DiscoverPanel
          busy={false}
          onAdd={async (slug, form) => {
            added.push({ slug, form });
            return true;
          }}
        />
      </InWorkspace>,
    );
    const search = byAria(view, "Search the MCP Registry") as HTMLFormElement;
    const query = search.querySelector("input") as HTMLInputElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(query, "calendar");
      query.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => search.requestSubmit());
    await act(async () => new Promise((done) => setTimeout(done, 0)));
    expect(sent[0]).toEqual({ action: "search", query: "calendar" });
    expect(view.textContent).toContain("Listings are their publishers' words, not a reason to trust a server");
    expect(view.textContent).toContain("installable");
    expect(view.textContent).toContain("nuget-unsupported");
    expect(view.textContent).toContain("Not added: remote https://mcp.calendar.example/sse: an SSE server");
    // An entry with no way in offers no add.
    expect(byAria(view, "Add io.github.example/dotnet as a remote server")).toBeNull();
    await click(byAria(view, "Add com.example/calendar as a remote server"));
    expect(added).toEqual([
      { slug: "calendar", form: { kind: "registry", name: "com.example/calendar", version: "2.0.0", option: "remote" } },
    ]);
    // "More" continues the search shown, not words typed since.
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(query, "something else");
      query.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await click(button(view, "More"));
    expect(sent[1]).toEqual({ action: "search", query: "calendar", cursor: "io.github.example/dotnet:0.3.0" });
  });
});
