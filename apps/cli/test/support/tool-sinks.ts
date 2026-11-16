import { temporaryDirectories } from "@tavi/test-support";
import type { Confidentiality, InvocationContext, SourceKind, ToolSink, WebSearchProvider } from "@tavi/contracts";
import { createFixtureModel } from "@tavi/test-support/fakes";
import { ToolRegistry, scopedProvider } from "@tavi/runtime";

import { composeTaviRuntime } from "../../src/runtime/composition.js";
import { registerWebSearchTool } from "../../src/features/search/web-search.js";
import { fixtureRuntimeOptions } from "./serve-fixture.js";

/** One registered tool's declared sink. */
export interface DeclaredSink {
  readonly id: string;
  readonly sink: ToolSink;
  readonly urlOnly: boolean | undefined;
  /** Its output's integrity, source and confidentiality as declared. */
  readonly untrustedOutput: boolean | undefined;
  readonly outputSource: SourceKind | undefined;
  readonly outputConfidentiality: Confidentiality | undefined;
}

/**
 * Every built-in tool as the owner registers it, with its declared sink and output label: the
 * registry a composed owner builds (`composeTaviRuntime`, as `tavi serve`
 * does) with every registration a configuration can switch on — the dev
 * fixture tool, a served live view (`browser.request_handoff`) — and
 * `web_search`, which the owner registers only when a search provider is
 * enabled at start, through its own `registerWebSearchTool` with a stand-in
 * provider. Sorted by id.
 */
export async function declaredToolSinks(): Promise<readonly DeclaredSink[]> {
  const directories = temporaryDirectories();
  const data = directories.create("tavi-sinks-");
  const runtime = await composeTaviRuntime(
    fixtureRuntimeOptions(data, { scheduleSweepEnabled: false, approvalRequiredFor: [], devFixtureTools: true }),
    { modelOverride: createFixtureModel({ turns: [] }), liveViewServed: true },
  );
  try {
    const listed = [...runtime.tools.list()];
    if (!listed.some((tool) => tool.id === "web_search")) listed.push(...(await searchRegistration()).list());
    return listed
      .map(({ id, sink, urlOnly, untrustedOutput, outputSource, outputConfidentiality }) => ({
        id,
        sink,
        urlOnly,
        untrustedOutput,
        outputSource,
        outputConfidentiality,
      }))
      .sort((left, right) => left.id.localeCompare(right.id));
  } finally {
    await runtime.close();
    directories.cleanup();
  }
}

/** `web_search` registered by its own code, with one available stand-in provider. */
async function searchRegistration(): Promise<ToolRegistry> {
  const registry = new ToolRegistry();
  const execution = {
    ownerSession: "owner",
    implementationHash: "a".repeat(64),
    signal: new AbortController().signal,
    actsIn: () => true,
    ledger: { reserveOperation: async () => {}, finishOperation: async () => {}, operations: async () => [] },
  };
  const provider: WebSearchProvider = { id: "stand-in", available: () => true, search: async () => ({ sources: [], truncated: false }) };
  await registerWebSearchTool(registry, () => [provider], {
    ...execution,
    resolve: async (resolved: WebSearchProvider, context: InvocationContext) =>
      scopedProvider(
        execution,
        context,
        { kind: "search", instanceId: resolved.id, accountId: resolved.id, endpoint: "in-process", configRevision: "b".repeat(64) },
        resolved,
      ),
  });
  return registry;
}
