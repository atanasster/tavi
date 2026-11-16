# Review an MCP server whose tools changed

When an MCP server you approved starts listing different tools, Tavi holds back what changed until you look. See what changed, field by field, weigh the warnings about tools that compete with Tavi's own, and approve again or leave the new parts out. About five minutes.

> **Uses:** MCP servers (`tavi mcp review mcp.notes`, `tavi mcp approve mcp.notes 1.0.0`) · **Center → Waiting on you** · **Settings → Connected apps**
> **Before you start:** Tavi running in the background with `tavi serve` ([Keep Tavi running in the background](../get-started/keep-tavi-running.md)) · the canvas open ([Open the web canvas and walk through Welcome](../get-started/web-canvas-tour.md)) · an MCP server approved and turned on ([Add any MCP server, sandboxed](add-an-mcp-server.md)): here, the notes server, after an update that changed one tool and added another

## 1. See what's waiting

Tavi lists a running server's tools again each time it starts it, at least every 15 minutes while it is in use, and whenever the server says its tools changed. A tool whose definition changed is **withheld** at once, a new tool waits, and **Center → Activity** shows the server under **Waiting on you**. Home gets the same notice, and your direct chats a message at most once a day.

![Waiting on you: Review notes' tools, 2 of its tools are new or changed and won't be used until you review them](../../assets/use-cases/connected-apps/review-mcp-changes/01-see-what-s-waiting.webp)

## 2. Read what changed

Choose the notice: it opens the server's review in **Settings → Connected apps**. A changed tool is marked **CHANGED since it was approved**, with what changed, field by field: here `read_note`'s description now tells the model to read a secret key, so it is also **FLAGGED** for reading like instructions.

<!-- cover -->
![The review's read_note row: withheld, FLAGGED: its description reads like instructions, CHANGED since it was approved, and the description before and after, with its effect set to Choose…](../../assets/use-cases/connected-apps/review-mcp-changes/02-read-what-changed.webp)

## 3. Weigh the warnings

**Before you approve** names what approving may do to the model's choice of tools: the new `fetch_page` overlaps Tavi's own web tools, `web_fetch` (and `web_search` when web search is set up), and its description names `web_fetch`, which can steer the model away from Tavi's tool (shadowing). They are warnings: approval is never refused for them.

![Before you approve: fetch_page overlaps Tavi's built-in web tools (web_fetch, web_search), and fetch_page's description names other tools (web_fetch), shadowing](../../assets/use-cases/connected-apps/review-mcp-changes/03-weigh-the-warnings.webp)

## 4. Compare in the terminal

`tavi mcp review mcp.notes` shows the same: the warnings, then every tool, `CHANGED since it was approved` with its old and new values, `NEW`, or as you approved it. The model is still offered only the definitions you approved.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="../../assets/use-cases/connected-apps/review-mcp-changes/04-compare-in-the-terminal-dark.svg">
  <img src="../../assets/use-cases/connected-apps/review-mcp-changes/04-compare-in-the-terminal.svg" alt="tavi mcp review mcp.notes: two warnings, fetch_page pending NEW, read_note withheld CHANGED and FLAGGED with its old and new description, add_note and list_notes approved">
</picture>

## 5. Leave out what you don't trust

Tick **Leave out** for `read_note` and `fetch_page`, and choose **Approve 1.0.0**. The tools you kept go on as before, and the notice closes. In the terminal, `tavi mcp approve mcp.notes 1.0.0 --disable read_note --disable fetch_page` does the same; to keep a changed tool instead, give it an effect with `--effect read_note=read-only`.

![The review's tools, read_note and fetch_page ticked Leave out, above Approve 1.0.0](../../assets/use-cases/connected-apps/review-mcp-changes/05-leave-out-what-you-don-t-trust.webp)

## 6. Check what it offers now

The notes app's page, under **What it can do**, shows what the model may use: **List notes** and **Add a note** as before, and `fetch_page` and **Read a note** marked **Left out by its review**. They stay out, even if the server changes them again, until you approve them in a later review.

![What it can do: fetch_page and Read a note, Left out by its review, beside List notes under Reads and Add a note under Changes](../../assets/use-cases/connected-apps/review-mcp-changes/06-check-what-it-offers-now.webp)

## What Tavi will and won't do

A server's new words never reach the model unless you approve them: a changed tool is withheld the moment Tavi sees it, the chats' approvals for it are deleted, and calls already running finish. A server whose files are no longer the ones you approved is not started at all until you review it. The details, and how often Tavi checks, are in [MCP.md](../../MCP.md#when-a-server-changes).

## Related

- [Add any MCP server, sandboxed](add-an-mcp-server.md)
- [Find your way around the Command Center](../chat/command-center.md)
- Reference: [MCP.md](../../MCP.md#when-a-server-changes), [CLI.md](../../CLI.md#tavi-mcp)
