# Tool-selection eval

An offline, deterministic check of how well Tavi's lexical tool rankers find
the right tool for an everyday request. `cases.json` holds the requests, each
with the tools that serve it; `selection.ts` scores them; `baseline.json` is
the last committed score.

The test (`apps/cli/test/tools/tool-selection-eval.test.ts`) builds the real
tool registry, ranks every case with `discoverTools` (what `tools.search`
returns) and `shortlistTools` (the router's lexical fallback), and fails when
recall falls below the baseline, or when a case the baseline found in the top
five is missed. The shortlist is scored as an attended chat builds it: its
deferred families left out until `tools.search` finds them, and with the
tools every list holds, so a case one of them serves counts as served. A change that raises recall updates the baseline in
the same commit:

```bash
TAVI_UPDATE_TOOL_SELECTION_BASELINE=1 pnpm --filter @tavi/cli exec vitest run test/tools/tool-selection-eval.test.ts
```

It measures ranking only, not whether a model then calls the tool well: that
takes a model in the loop.
