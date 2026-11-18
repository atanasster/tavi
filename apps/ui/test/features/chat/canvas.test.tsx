import { initialRunState, reduceRun, type RunState } from "@tavi/client/browser";
import { CLIENT_PROTOCOL_VERSION, type ClientEvent } from "@tavi/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { TaskListRow } from "@tavi/contracts";

import { Settings } from "../../../src/features/settings/SettingsPage.js";
import { SettingsNav } from "../../../src/features/settings/SettingsNav.js";
import { Bar } from "../../../src/features/shell/Bar.js";
import { Canvas } from "../../../src/features/chat/Canvas.js";
import { SessionDirectory } from "../../../src/features/sessions/SessionDirectory.js";
import { Details } from "../../../src/features/chat-panel/Details.js";
import { replyFacts } from "../../../src/features/chat/reply-facts.js";
import { sessionsOf, sessionStats, shellState } from "../../../src/features/shell/shell.js";
import { Trajectory } from "../../../src/features/chat/Trajectory.js";
import type { CanvasRun, CanvasState, CanvasStore } from "../../../src/features/chat/store/types.js";
import { WorkspaceProvider } from "../../../src/features/shell/Workspace.js";
import { InWorkspace } from "../../support/workspace.js";

/** The chat and run view, rendered from states the reducer produces. */

function fold(events: readonly Record<string, unknown>[]): RunState {
  return events.reduce<RunState>(
    (state, fields, sequence) =>
      reduceRun(state, {
        protocolVersion: CLIENT_PROTOCOL_VERSION,
        epoch: "e",
        sequence,
        runId: "task-1",
        attemptId: "attempt-1",
        at: "2026-09-19T12:00:00.000Z",
        ...fields,
      } as ClientEvent),
    initialRunState(),
  );
}

const noop = () => undefined;
// The shell's main pane shows one session: the newest the page holds, as `App` selects it.
const render = (state: CanvasState) =>
  renderToStaticMarkup(
    <>
      <InWorkspace>
        <Bar state={state} route="chat" onRoute={noop} needs={0} />
      </InWorkspace>
      <InWorkspace>
        <Canvas state={state} session={sessionsOf(state.runs).at(-1)} onSubmit={noop} onDecide={noop} onAbort={noop} onExpand={noop} />
      </InWorkspace>
    </>,
  );
const run = (id: string, prompt: string, state: RunState, extra: Partial<CanvasRun> = {}): CanvasRun => ({
  id,
  prompt,
  run: state,
  roundCalls: {},
  deciding: undefined,
  aborting: false,
  ...extra,
});

describe("the canvas", () => {
  it("offers the two routes, marking the one shown — settings are no longer navigation", () => {
    const html = renderToStaticMarkup(
      <InWorkspace>
        <Bar state={{ connection: "ready", runs: [] }} route="settings" onRoute={noop} needs={0} />
      </InWorkspace>,
    );
    for (const label of ["Chat", "Settings"]) expect(html).toContain(`>${label}<`);
    expect(html).toContain('aria-current="page">Settings<');
    // Models, Web search and Credentials live inside Settings now.
    for (const label of ["Models", "Web search", "Credentials"]) expect(html).not.toContain(`>${label}<`);
  });

  it("says in the header how many of this page's sessions need the reader", () => {
    // Seen, not announced here: the page has one live region, in index.html.
    const quiet = renderToStaticMarkup(
      <InWorkspace>
        <Bar state={{ connection: "ready", runs: [] }} route="chat" onRoute={noop} needs={0} />
      </InWorkspace>,
    );
    expect(quiet).not.toContain("needs-count");
    expect(quiet).not.toContain("aria-live");
    expect(quiet).not.toContain('role="status"');
    expect(
      renderToStaticMarkup(
        <InWorkspace>
          <Bar state={{ connection: "ready", runs: [] }} route="chat" onRoute={noop} needs={1} />
        </InWorkspace>,
      ),
    ).toContain("1 chat needs you");
    expect(
      renderToStaticMarkup(
        <InWorkspace>
          <Bar state={{ connection: "ready", runs: [] }} route="chat" onRoute={noop} needs={3} />
        </InWorkspace>,
      ),
    ).toContain("3 chats need you");
  });

  it("says a new private chat is private before its first message, in its header and its empty text", () => {
    const html = render({ connection: "ready", runs: [], privateDraft: true });
    expect(html).toContain("New private chat");
    expect(html).toContain("Private chat");
    expect(html).toContain("A private chat: nothing in it is remembered");
    expect(render({ connection: "ready", runs: [] })).not.toContain("Private chat");
    // The message box is named as its placeholder says, never "prompt".
    expect(html).toContain('aria-label="Start a private chat: memory off, forgotten a day after its last message"');
  });

  it("shows the connection, and holds the composer until the owner is reachable", () => {
    const waiting = render({ connection: "connecting", runs: [] });
    expect(waiting).toContain("connecting…");
    expect(waiting).toMatch(/<button type="submit"[^>]*aria-disabled="true"/);
    expect(waiting).toContain("Ask Tavi something to start a chat.");
    // The mark says it: in its colours when connected, grey when not; its words are for a screen reader.
    expect(render({ connection: "ready", runs: [] })).toContain('class="brand brand-ready" title="Tavi: connected"');
  });

  it("renders a run's text, tool cards, pending round and failure", () => {
    const state = fold([
      { kind: "run.started", threadId: "t", workspaceId: "default" },
      { kind: "text.delta", blockId: "b", text: "Sending <it> now" },
      { kind: "tool.started", callId: "c1", toolName: "mail.send", input: { to: "a@example.com" } },
      {
        kind: "approval.required",
        steps: 2,
        callId: "c2",
        toolName: "files.delete",
        summary: "delete report.pdf",
        input: {},
        approvalId: "a",
      },
    ]);
    const html = render({ connection: "ready", runs: [run("ui-1", "clean up", state, { roundCalls: { 2: ["c2"] } })] });
    expect(html).toContain("clean up");
    // Text is text: markup a model writes is escaped, never interpreted.
    expect(html).toContain("Sending &lt;it&gt; now");
    expect(html).toContain("<code>mail.send</code>");
    expect(html).toContain("a@example.com");
    expect(html).toContain("Needs your approval");
    expect(html).toContain(">delete report.pdf</strong>");
    expect(html).toContain(">Allow once<");
    expect(html).toContain(">Deny…<");

    expect(html).not.toMatch(/disabled="">Allow once/);
    const deciding = render({ connection: "ready", runs: [run("ui-1", "clean up", state, { roundCalls: { 2: ["c2"] }, deciding: 2 })] });
    expect(deciding).toMatch(/<button[^>]* disabled="">Allow once/);
    expect(deciding).toContain("Deciding…");
    // A call the owner listed has not arrived: the round is not offered yet.
    const partial = render({ connection: "ready", runs: [run("ui-1", "clean up", state, { roundCalls: { 2: ["c2", "c3"] } })] });
    expect(partial).toMatch(/<button[^>]* disabled="">Allow once/);
    expect(partial).toContain("Waiting for the rest of this round");
    // Not listed yet: not offered either.
    expect(render({ connection: "ready", runs: [run("ui-1", "clean up", state)] })).toMatch(/disabled="">Allow once/);

    const failed = fold([
      { kind: "run.started", threadId: "t", workspaceId: "default" },
      { kind: "task.failed", errorCode: "PROVIDER", message: "the model is down" },
    ]);
    expect(render({ connection: "ready", runs: [run("ui-2", "x", failed, { error: "stream ended" })] })).toMatch(
      /Failed \(PROVIDER\).*the model is down[\s\S]*stream ended/,
    );
  });

  it("renders a two-call round, a wait, a review, a late join, a failover, and a closed client's reason", () => {
    const round = fold([
      { kind: "run.started", threadId: "t", workspaceId: "default" },
      { kind: "approval.required", steps: 1, callId: "a", toolName: "t", summary: "one", input: {}, approvalId: "x" },
      { kind: "approval.required", steps: 1, callId: "b", toolName: "t", summary: "two", input: {}, approvalId: "y" },
    ]);
    expect(render({ connection: "ready", runs: [run("r", "p", round)] })).toContain("2 calls need your approval");
    // A call with nothing to say beyond its tool is named once, not twice.
    const bare = render({
      connection: "ready",
      runs: [
        run(
          "b",
          "p",
          fold([
            { kind: "run.started", threadId: "t", workspaceId: "default" },
            {
              kind: "approval.required",
              steps: 1,
              callId: "a",
              toolName: "web_search",
              summary: "Approve web_search?",
              input: {},
              approvalId: "x",
            },
          ]),
        ),
      ],
    });
    expect(bare).toContain(">web_search</strong>");
    expect(bare).not.toContain('<code class="meta-sm">web_search</code>');

    const waiting = fold([
      { kind: "run.started", threadId: "t", workspaceId: "default" },
      { kind: "task.waiting", on: "a reply", deadlineAt: "2026-09-20T00:00:00.000Z", question: "Which folder?", waitId: "wait-1" },
    ]);
    expect(render({ connection: "ready", runs: [run("w", "p", waiting)] })).toContain("Which folder?");

    const late = { ...initialRunState({ truncated: true }) };
    expect(render({ connection: "ready", runs: [run("l", "p", late)] })).toContain("Joined late");

    const failover = fold([
      { kind: "run.started", threadId: "t", workspaceId: "default" },
      { kind: "text.delta", blockId: "b", text: "half an answer" },
      { kind: "attempt.replaced", supersededAttemptId: "attempt-1", attemptId: "attempt-2", reason: "rate limit on main", discarded: true },
    ]);
    const failed = render({ connection: "ready", runs: [run("f", "p", failover)] });
    expect(failed).toContain('class="text discarded"');
    expect(failed).toContain("Retried on another model: rate limit on main");

    const unknown = { ...initialRunState(), status: "unknown" as const };
    expect(render({ connection: "ready", runs: [run("u", "p", unknown)] })).toContain(
      '<code class="command"><span class="command-word">tavi</span> <span class="command-word">tasks</span></code> shows it',
    );

    const closed = render({ connection: "closed", failure: "the bridge refused this page's session", runs: [] });
    expect(closed).toContain('class="brand brand-closed" title="Tavi: disconnected"');
    expect(closed).toContain("the bridge refused this page&#x27;s session");
    expect(closed).toContain("for a new link");
    // The owner's clause is ended before the advice, and the line is the bar's own (Mac mini UI check).
    expect(closed).toContain("the bridge refused this page&#x27;s session. Press Enter");
    expect(closed).toContain('class="failure bar-failure"');
  });

  it("draws an epoch divider between the turns the chat rolled over between, with its archive and fresh context", () => {
    const done = fold([
      { kind: "run.started", threadId: "t", workspaceId: "default" },
      { kind: "task.completed", finalText: "an answer" },
    ]);
    const state: CanvasState = {
      connection: "ready",
      runs: [
        run("ui-1", "first prompt", done, { lastAt: "2026-10-04T08:00:00.000Z" }),
        run("ui-2", "second prompt", done, { lastAt: "2026-10-04T09:00:00.000Z" }),
      ],
    };
    const epoch = {
      noticeId: "epoch-1",
      taskId: "task-1",
      kind: "epoch" as const,
      title: "Epoch 1 began",
      summary: "s",
      afterSeq: 1,
      artifactId: "art-1",
      createdAt: "2026-10-04T08:30:00.000Z",
    };
    const html = renderToStaticMarkup(
      <InWorkspace>
        <Canvas
          state={state}
          session={sessionsOf(state.runs).at(-1)}
          notices={[epoch]}
          onOpenArchive={noop}
          onFreshContext={async () => undefined}
          onSubmit={noop}
          onDecide={noop}
          onAbort={noop}
          onExpand={noop}
        />
      </InWorkspace>,
    );
    expect(html.indexOf("first prompt")).toBeLessThan(html.indexOf("Epoch 1 began"));
    expect(html.indexOf("Epoch 1 began")).toBeLessThan(html.indexOf("second prompt"));
    expect(html).toContain("Open archive");
    expect(html).toContain("Fresh context");
    // Not a card among the notices.
    expect(html).not.toContain("chat-notice");
  });

  it("draws each notice card after the saved turn it followed, a new Home's earlier chats before its first", () => {
    const done = {
      ...fold([
        { kind: "run.started", threadId: "t", workspaceId: "default" },
        { kind: "task.completed", finalText: "an answer" },
      ]),
      taskId: "task-1",
    };
    const state: CanvasState = {
      connection: "ready",
      runs: [run("saved-task-1-1", "first prompt", done, { seq: 1 }), run("saved-task-1-2", "second prompt", done, { seq: 2 })],
    };
    const card = (noticeId: string, kind: "earlier-chats" | "side-chat-settled", title: string, afterSeq: number) => ({
      noticeId,
      taskId: "task-1",
      kind,
      title,
      summary: "",
      afterSeq,
      createdAt: "2026-10-04T08:00:00.000Z",
    });
    const html = renderToStaticMarkup(
      <InWorkspace>
        <Canvas
          state={state}
          session={sessionsOf(state.runs).at(-1)}
          notices={[card("n-1", "earlier-chats", "Earlier chats", 0), card("n-2", "side-chat-settled", "Side chat finished", 1)]}
          onSubmit={noop}
          onDecide={noop}
          onAbort={noop}
          onExpand={noop}
        />
      </InWorkspace>,
    );
    // Read among the turns: the header's title is the first prompt too.
    const turns = html.slice(html.indexOf('class="runs"'));
    expect(turns.indexOf("Earlier chats")).toBeLessThan(turns.indexOf("first prompt"));
    expect(turns.indexOf("first prompt")).toBeLessThan(turns.indexOf("Side chat finished"));
    expect(turns.indexOf("Side chat finished")).toBeLessThan(turns.indexOf("second prompt"));
  });

  it("offers Send now on a prompt queued behind a running turn, and shows a steered message in the turn", () => {
    const going = fold([
      { kind: "run.started", threadId: "t", workspaceId: "default" },
      { kind: "text.delta", blockId: "b1", text: "Checking the route." },
      { kind: "turn.steered", messageId: "ui-0", text: "in kilometres, please" },
    ]);
    const queued = run("ui-2", "and the weather?", initialRunState({ taskId: "task-1" }), { continues: "task-1", queued: true });
    const state: CanvasState = { connection: "ready", runs: [run("ui-1", "how far is it?", going), queued] };
    const html = (props: Partial<Parameters<typeof Canvas>[0]> = {}) =>
      renderToStaticMarkup(
        <InWorkspace>
          <Canvas
            state={state}
            session={sessionsOf(state.runs).at(-1)}
            onSubmit={noop}
            onDecide={noop}
            onAbort={noop}
            onExpand={noop}
            onCancelQueued={noop}
            onSteerQueued={noop}
            {...props}
          />
        </InWorkspace>,
      );
    // The running turn shows the message where the model read it, after what it had said.
    expect(html().indexOf("Checking the route.")).toBeLessThan(html().indexOf("in kilometres, please"));
    expect(html()).toContain("You, during this turn");
    expect(html()).toContain(">Send now<");
    expect(html()).toContain(">Cancel<");
    // Not behind a turn that waits on a decision: Send now would be refused there.
    const waiting = fold([
      { kind: "run.started", threadId: "t", workspaceId: "default" },
      { kind: "task.waiting", on: "the operator", deadlineAt: "2099-01-01T00:00:00Z", question: "Which one?" },
    ]);
    const behindQuestion: CanvasState = { connection: "ready", runs: [run("ui-1", "how far is it?", waiting), queued] };
    expect(
      renderToStaticMarkup(
        <InWorkspace>
          <Canvas
            state={behindQuestion}
            session={sessionsOf(behindQuestion.runs).at(-1)}
            onSubmit={noop}
            onDecide={noop}
            onAbort={noop}
            onExpand={noop}
            onSteerQueued={noop}
          />
        </InWorkspace>,
      ),
    ).not.toContain(">Send now<");
    // On its way, then sent: said, and neither button is offered.
    const sent: CanvasState = { connection: "ready", runs: [run("ui-1", "how far is it?", going), { ...queued, steering: "sent" }] };
    const sentHtml = renderToStaticMarkup(
      <InWorkspace>
        <Canvas
          state={sent}
          session={sessionsOf(sent.runs).at(-1)}
          onSubmit={noop}
          onDecide={noop}
          onAbort={noop}
          onExpand={noop}
          onCancelQueued={noop}
          onSteerQueued={noop}
        />
      </InWorkspace>,
    );
    expect(sentHtml).toContain("Sent into this turn");
    expect(sentHtml).not.toContain(">Send now<");
    expect(sentHtml).not.toContain(">Cancel<");
  });

  it("says in the composer who a prompt goes to, never what the next prompt starts, and marks a continued turn", () => {
    const done = fold([
      { kind: "run.started", threadId: "t", workspaceId: "default" },
      { kind: "task.completed", finalText: "first answer" },
    ]);
    // Its first line: the second says the keys (`COMPOSER_KEYS`).
    const placeholder = (html: string): string | undefined => /<textarea[^>]*placeholder="([^"]*)"/.exec(html)?.[1]?.split("\n")[0];
    const canvas = (props: Partial<Parameters<typeof Canvas>[0]>, state: CanvasState = { connection: "ready", runs: [] }) =>
      renderToStaticMarkup(
        <InWorkspace>
          <Canvas
            state={state}
            session={sessionsOf(state.runs).at(-1)}
            onSubmit={noop}
            onDecide={noop}
            onAbort={noop}
            onExpand={noop}
            {...props}
          />
        </InWorkspace>,
      );
    const held: CanvasState = {
      connection: "ready",
      runs: [run("ui-1", "first", done)],
      continuing: "task-1",
      next: { kind: "continue", taskId: "task-1" },
    };
    // Another chat: its title is in the header, so the box says only "Continue this chat…".
    expect(placeholder(canvas({}, held))).toBe("Continue this chat…");
    expect(/<textarea[^>]*placeholder="Continue this chat…\nEnter to send · Shift\+Enter for a new line"/.test(canvas({}, held))).toBe(
      true,
    );
    expect(
      placeholder(
        canvas(
          {},
          { connection: "ready", runs: [run("ui-1", "", done, { restored: true })], next: { kind: "continue", taskId: "task-1" } },
        ),
      ),
    ).toBe("Continue this chat…");
    // A chat on screen that the next prompt does not continue (its prompt refused, say): never named.
    const refused: CanvasState = {
      connection: "ready",
      runs: [run("ui-1", "first", initialRunState(), { error: "the owner refused the run" })],
      next: { kind: "home" },
    };
    expect(placeholder(canvas({}, refused))).toBe("Message Home…");
    expect(placeholder(canvas({}, { ...refused, next: { kind: "new" } }))).toBe("Start a new chat…");
    // Home: the next prompt goes there, or continues it.
    expect(placeholder(canvas({}, { connection: "ready", runs: [], next: { kind: "home" } }))).toBe("Message Home…");
    expect(placeholder(canvas({}, { ...held, home: "task-1" }))).toBe("Message Home…");
    // After New side chat with a chat on screen: a side chat of it. With none, or with Home off and no parent: an ordinary one.
    expect(placeholder(canvas({}, { connection: "ready", runs: [], next: { kind: "new", side: true } }))).toBe("Start a side chat…");
    expect(placeholder(canvas({}, { connection: "ready", runs: [], next: { kind: "new" } }))).toBe("Start a new chat…");
    expect(placeholder(canvas({}))).toBe("Start a new chat…");
    // A turn going: queued behind it, Home's too.
    const going = fold([{ kind: "run.started", threadId: "t", workspaceId: "default" }]);
    expect(
      placeholder(canvas({}, { connection: "ready", runs: [run("ui-1", "first", going)], next: { kind: "queue", taskId: "task-1" } })),
    ).toBe("Queue a message for after this turn…");
    for (const html of [canvas({}, held), canvas({})]) expect(html).not.toMatch(/next prompt|new task|session/i);
    const turn = render({
      connection: "ready",
      runs: [run("ui-1", "first", done), run("ui-2", "and then?", initialRunState({ taskId: "task-1" }), { continues: "task-1" })],
    });
    // A turn that continues the chat on screen needs no line of its own, and the transcript names no task id.
    expect(turn).not.toContain('class="continues');
    expect(turn).not.toContain("Continues chat");
    const replayed = render({ connection: "ready", runs: [run("ui-1", "", done, { restored: true })] });
    expect(replayed).toContain("Earlier in this chat (no prompt shown)");
    expect(render({ connection: "ready", runs: [run("ui-1", "", done, { restored: true, noTurn: true })] })).not.toContain(
      "no prompt shown",
    );
    expect(replayed).not.toContain("reloaded");
    expect(replayed).not.toContain("Earlier in chat task-1");
    expect(replayed).not.toContain('class="prompt"');
  });

  it("reads a cancelled chat as the person's decision: no failure, no box, nothing to go on with", () => {
    const cancelled = (message: string): RunState => ({
      ...fold([{ kind: "run.started", threadId: "t", workspaceId: "default" }]),
      taskId: "task-1",
      status: "failed",
      outcome: { kind: "failed", errorCode: "CANCELLED", message },
      suggestions: ["Try again"],
    });
    for (const [message, words] of [
      ["qa", "This was cancelled: qa."],
      ["Task was cancelled by atanasster: no longer needed.", "This was cancelled: no longer needed."],
      ["", "This was cancelled."],
    ] as const) {
      const html = render({ connection: "ready", runs: [run("ui-1", "first", cancelled(message))], next: { kind: "new" } });
      expect(html).toContain(words);
      expect(html).toContain("cancelled");
      expect(html).not.toContain("Failed (");
      expect(html).not.toContain('class="failure');
      expect(html).not.toContain("<textarea");
      expect(html).not.toContain("Suggested next");
      expect(html).toContain("takes no more messages");
    }
  });

  it("marks where the earlier turns begin once, and says of each turn only that its prompt is lost", () => {
    const count = (html: string, words: string): number => html.split(words).length - 1;
    const restored = { restored: true } as const;
    const done = fold([{ kind: "run.started", threadId: "t", workspaceId: "default" }]);
    const two = render({ connection: "ready", runs: [run("ui-1", "first", done, restored), run("ui-2", "second", done, restored)] });
    expect(count(two, "Earlier in this chat")).toBe(1);
    expect(two.indexOf("Earlier in this chat")).toBeLessThan(two.indexOf(`class="prompt"`));
    const lost = render({ connection: "ready", runs: [run("ui-1", "first", done, restored), run("ui-2", "", done, restored)] });
    expect(count(lost, "Earlier in this chat")).toBe(1);
    expect(lost).toContain("No prompt shown");
  });

  it("bounds a long transcript behind a divider, and shows a short one whole", () => {
    const entries = (count: number) =>
      Array.from({ length: count }, (_unused, index) => ({
        kind: "text" as const,
        key: `k${index}`,
        attemptId: "a",
        blockId: `b${index}`,
        text: `line ${index}`,
      }));
    const long = { ...initialRunState(), transcript: entries(250) };
    const html = render({ connection: "ready", runs: [run("ui-1", "p", long)] });
    // 250 − 20 − 200: the head and the tail stay, the middle folds away.
    expect(html).toContain("Expand 30 older entries");
    expect(html).toContain(">line 0<");
    expect(html).not.toContain(">line 25<");
    expect(html).toContain(">line 249<");
    expect(html.indexOf(">line 0<")).toBeLessThan(html.indexOf("Expand 30 older"));
    expect(html.indexOf("Expand 30 older")).toBeLessThan(html.indexOf(">line 249<"));

    // Expanded: every entry, and a way back.
    const expanded = render({ connection: "ready", runs: [run("ui-1", "p", long, { expanded: true })] });
    expect(expanded).not.toContain("Expand 30");
    expect(expanded).toContain(">line 25<");
    expect(expanded).toContain(">Collapse<");

    // Short: no divider either way.
    const short = { ...initialRunState(), transcript: entries(220) };
    expect(render({ connection: "ready", runs: [run("ui-1", "p", short)] })).not.toContain("Expand");
    expect(render({ connection: "ready", runs: [run("ui-1", "p", short, { expanded: true })] })).not.toContain("Collapse");

    // One entry folded away reads as an entry, not as entries.
    const boundary = { ...initialRunState(), transcript: entries(221) };
    expect(render({ connection: "ready", runs: [run("ui-1", "p", boundary)] })).toContain("Expand 1 older entry");
  });

  it("lists the workspace's chats by what they need, naming the workspace, and never a worker", () => {
    const html = directory(false);
    // The scope is shown rather than implied: a count that did not say which workspace is the wrong count.
    expect(html).toContain("Workspace <code>default</code>");
    expect(html).toContain("<h3>Needs you</h3>");
    for (const title of ["Home", "Plan the trip", "Book the room", "Morning digest"]) expect(html).toContain(`>${title}<`);
    // The reader's Home is an ordinary chat pinned on top, under no Home heading.
    expect(html).not.toContain("<h3>Home</h3>");
    const pinned = html.slice(html.indexOf('<section class="group pinned-group" aria-label="Pinned">'));
    expect(pinned.slice(0, pinned.indexOf("</section>"))).toContain(">Home<");
    expect(html.indexOf("pinned-group")).toBeLessThan(html.indexOf("<h3>Needs you</h3>"));
    // Home off: no Home or Activity section, nothing nested, and a worker is never a chat.
    expect(html).not.toContain("<h3>Activity</h3>");
    expect(html).not.toContain("side-chat");
    expect(html).not.toContain("Delegated research");
    expect(html).toContain('aria-label="New chat"');
  });

  it("pins Home on top, nests a side chat under its parent and groups runs under Activity while Home is on", () => {
    const html = directory(true);
    const headings = [...html.matchAll(/<h3>([^<]*)<\/h3>/g)].map((match) => match[1]);
    expect(headings[0]).toBe("Home");
    // A status reads in people's words; its class keeps the raw status for styling.
    expect(html).toContain('class="badge badge-plain status-input-required">needs you<');
    expect(html).toContain('class="badge badge-plain status-working">working<');
    expect(html).not.toContain(">input-required<");
    expect(headings.at(-1)).toBe("Activity");
    // The side chat comes right after its parent, marked as nested.
    const home = html.slice(html.indexOf('<section class="group home-group">'), html.indexOf("</section>"));
    expect(home).toMatch(/>Home<[\s\S]*session-item side-chat[\s\S]*>Plan the trip</);
    // A side chat that needs the reader stays under Needs you, not under its parent.
    expect(home).not.toContain("Which hotel?");
    const needs = html.slice(html.indexOf("<h3>Needs you</h3>"));
    expect(needs.slice(0, needs.indexOf("</section>"))).toContain(">Which hotel?<");
    // Only the reader's own Home is pinned; another person's is an ordinary chat.
    expect(home).not.toContain("Someone else");
    expect(html).toContain(">Someone else&#x27;s Home<");
    const activity = html.slice(html.lastIndexOf("<section"));
    expect(activity).toContain(">Morning digest<");
    expect(html).not.toContain("Delegated research");
    expect(html).toContain('aria-label="New side chat"');
  });

  it("offers New chat, a chat of its own, beside New side chat while Home is on", () => {
    const html = directory(true, [], undefined, noop);
    expect(html).toContain('aria-label="New chat"');
    expect(html).toContain('aria-label="New side chat"');
    expect(html.indexOf('aria-label="New chat"')).toBeLessThan(html.indexOf('aria-label="New side chat"'));
  });

  it("lists Home before its first message, after chats begun with +, and only once with a Home to list", () => {
    const sides = [row("side-1", "Plan the trip", { chatKind: "side" })];
    const before = directory(true, sides, noop);
    const headings = [...before.matchAll(/<h3>([^<]*)<\/h3>/g)].map((match) => match[1]);
    expect(headings[0]).toBe("Home");
    expect(before).toContain("No messages yet");
    // Home with a task: its own row, not a second entry.
    const started = directory(true, [row("home-1", "Home", { chatKind: "home", principalId: "operator" }), ...sides], noop);
    expect(started).not.toContain("No messages yet");
    expect([...started.matchAll(/<h3>Home<\/h3>/g)]).toHaveLength(1);
    // Home off: no Home to open.
    expect(directory(false, sides, noop)).not.toContain("No messages yet");
  });

  it("does not say there are no chats above the Home it lists", () => {
    const empty = directory(true, [], noop);
    expect(empty).toContain("No messages yet");
    expect(empty).not.toContain("No chats yet.");
    // Home off: nothing listed, so the list says it is empty.
    expect(directory(false, [], noop)).toContain("No chats yet.");
  });

  it("lists a channel conversation's Home under Conversations, its topics' side chats beneath it, only while Home is on", () => {
    const on = directory(true);
    const headings = [...on.matchAll(/<h3>([^<]*)<\/h3>/g)].map((match) => match[1]);
    expect(headings.slice(0, 2)).toEqual(["Home", "Conversations"]);
    const conversations = on.slice(on.indexOf("<h3>Conversations</h3>"));
    expect(conversations.slice(0, conversations.indexOf("</section>"))).toMatch(
      />Family group<[\s\S]*>group<[\s\S]*session-item side-chat[\s\S]*>Holiday topic</,
    );
    const off = directory(false);
    expect(off).not.toContain("<h3>Conversations</h3>");
    expect(off).toContain(">Family group<");
  });

  it("gives the run's facts in the chat panel's Details tab", () => {
    const state: CanvasState = {
      connection: "ready",
      runs: [run("ui-1", "p", fold([{ kind: "run.started", threadId: "thread-7", workspaceId: "default" }]))],
    };
    const session = shellState(state, undefined).current;
    const open = renderToStaticMarkup(
      <InWorkspace workspaceId="default">
        <Details session={session} />
      </InWorkspace>,
    );
    expect(open).toContain("task-1");
    expect(open).toContain("thread-7");
    expect(open).toContain("<dt>Operation key</dt><dd>ui-1</dd>");
    expect(open).toContain("Nothing.");
  });

  it("says under a finished reply only the figures that have a source", () => {
    const answered = run(
      "ui-1",
      "Name a cat",
      fold([
        { kind: "run.started", threadId: "thread-1", workspaceId: "default" },
        { kind: "text.delta", blockId: "b", text: "Midnight" },
        {
          kind: "task.completed",
          finalText: "Midnight",
          metrics: { models: ["ollama/gemma4-32k:latest"], totalTokens: 22_400, partial: false },
        },
      ]),
      { activeMs: 125_000 },
    );
    expect(replyFacts(answered)).toEqual({ time: "2m 05s", model: "gemma4-32k:latest", modelIds: "ollama/gemma4-32k:latest" });
    const html = render({ connection: "ready", runs: [answered] });
    expect(html).toContain("2m 05s · gemma4-32k:latest");
    expect(html).toContain('title="ollama/gemma4-32k:latest"');
    // No tool call made, none said; and no token, cost, context or tok/s figure.
    expect(html).not.toContain("tool call");
    for (const absent of ["token", "cost", "ctx", "tok/s"]) expect(html.toLowerCase()).not.toContain(absent);
    // A replayed turn whose stamps were not kept has no time, not "0.0s".
    expect(replyFacts({ ...answered, activeMs: 0 }).time).toBeUndefined();
    // Nothing is said of a turn still running.
    expect(replyFacts(run("ui-2", "Again", fold([{ kind: "run.started", threadId: "thread-1", workspaceId: "default" }])))).toEqual({});
  });

  it("holds sends and says why while the owner runs no configured model", () => {
    const html = renderToStaticMarkup(
      <InWorkspace>
        <Canvas
          state={{ connection: "ready", runs: [] }}
          session={undefined}
          modelNotice="The owner started with no model configured, so runs are refused."
          unconfigured
          onSubmit={noop}
          onDecide={noop}
          onAbort={noop}
          onExpand={noop}
        />
      </InWorkspace>,
    );
    expect(html).toContain("so runs are refused.");
    expect(html).toContain("No model is running: restart `tavi serve` with one to send");
    expect(html).toMatch(/<button type="submit"[^>]*aria-disabled="true"/);
  });

  it("puts Models, Web search and Credentials inside Settings", () => {
    const client = { request: () => new Promise<never>(() => undefined) };
    const html = renderToStaticMarkup(
      <WorkspaceProvider client={client} workspaceId="default" timeZone={undefined}>
        <SettingsNav view="search" onView={noop} />
        <Settings view="search" />
      </WorkspaceProvider>,
    );
    for (const label of ["Models", "Web search", "Credentials"]) expect(html).toContain(`>${label}<`);
    expect(html).toMatch(/aria-current="page"><span class="center-nav-label">Web search</);
    expect(html).toContain("<h1>Web search</h1>");
  });

  it("says a working session's next prompt is queued behind its turn", () => {
    const going = fold([{ kind: "run.started", threadId: "t", workspaceId: "default" }]);
    const html = render({ connection: "ready", runs: [run("ui-1", "tidy up", going)], next: { kind: "queue", taskId: "task-1" } });
    // The composer's placeholder says so; no separate line above it does.
    expect(html).not.toContain("the next prompt starts a new chat");
    expect(html).toContain("Queue a message for after this turn");
    // And the composer is not disabled for it.
    expect(html).not.toMatch(/<textarea[^>]*disabled/);
  });

  it("says a prompt queued behind an approval waits for the decision, not the turn", () => {
    const asking = fold([
      { kind: "run.started", threadId: "t", workspaceId: "default" },
      { kind: "approval.required", steps: 1, callId: "c1", toolName: "files.delete", summary: "delete it", input: {}, approvalId: "a" },
    ]);
    expect(asking.status).toBe("awaiting_approval");
    const html = render({
      connection: "ready",
      runs: [
        run("ui-1", "tidy up", asking, { roundCalls: { 1: ["c1"] } }),
        run("ui-2", "and then this", initialRunState(), { queued: true, continues: "task-1" }),
      ],
      next: { kind: "queue", taskId: "task-1" },
    });
    expect(html).toContain("Queue a message for after the approval…");
    // A file review and a browser handoff are said as what they are.
    const reviewing = fold([
      { kind: "run.started", threadId: "t", workspaceId: "default" },
      { kind: "task.review_required", steps: 1, requests: [{ artifactId: "art-1", toolName: "browser.act", callId: "c1" }] } as never,
    ]);
    const handingOver = fold([
      { kind: "run.started", threadId: "t", workspaceId: "default" },
      {
        kind: "task.waiting",
        on: "the operator",
        deadlineAt: "2099-01-01T00:00:00Z",
        handoff: { sessionId: "s", reason: "Sign in" },
      } as never,
    ]);
    for (const [state, words] of [
      [reviewing, "Queue a message for after the review…"],
      [handingOver, "Queue a message for after you finish in the browser…"],
    ] as const) {
      expect(state.status).not.toBe("awaiting_approval");
      expect(
        render({ connection: "ready", runs: [run("ui-1", "get the bills", state)], next: { kind: "queue", taskId: "task-1" } }),
      ).toContain(words);
    }
    expect(html).toContain("Queued: sends after you decide the approval above.");
    expect(html).not.toContain("Queued: sends after this turn.");
    // No Send now: the turn is not running.
    expect(html).not.toContain(">Send now<");
  });

  it("offers Stop only while a run is going, from the composer alone", () => {
    const going = fold([{ kind: "run.started", threadId: "t", workspaceId: "default" }]);
    const streaming = render({ connection: "ready", runs: [run("a", "p", going)] });
    expect(streaming).not.toContain('class="slot"');
    expect(streaming).toMatch(/<button type="submit" class="button-primary">Stop</);
    expect(streaming.match(/>Stop</g)).toHaveLength(1);
    // One on its way: the card says so, and the composer no longer offers another.
    const stopping = render({ connection: "ready", runs: [run("a", "p", going, { aborting: true })] });
    expect(stopping).toContain("Stopping…");
    expect(stopping).not.toContain(">Stop<");
    const done = fold([
      { kind: "run.started", threadId: "t", workspaceId: "default" },
      { kind: "task.completed", finalText: "done" },
    ]);
    expect(render({ connection: "ready", runs: [run("a", "p", done)] })).not.toContain(">Stop<");
  });
});

it("shows message actions, not provider metrics, on a restored response", () => {
  const html = render({
    connection: "ready",
    runs: [
      run(
        "metrics",
        "Hello",
        {
          ...initialRunState(),
          status: "completed",
          outcome: { kind: "completed", finalText: "Welcome" },
          metrics: { models: ["local/model"], totalTokens: 123, partial: false },
        },
        { restored: true, startedAt: "2026-09-20T12:00:00Z", lastAt: "2026-09-20T12:00:02Z" },
      ),
    ],
  });
  // Model and tokens live in the Details tab; elapsed in the strip.
  expect(html).not.toContain("123 tokens");
  expect(html).not.toContain("2.0s elapsed");
  expect(html).toContain('aria-label="Copy prompt"');
  expect(html).toContain('aria-label="Copy response"');
  expect(html).toContain("Read aloud");
});

it("offers Read aloud on the partial answer of a turn the person stopped", () => {
  const stopped = fold([
    { kind: "run.started", threadId: "t", workspaceId: "default" },
    { kind: "text.delta", blockId: "b", text: "So far" },
    { kind: "task.stopped", message: "You stopped this." },
  ]);
  const html = render({ connection: "ready", runs: [run("stopped", "a long job", stopped)] });
  expect(html).toContain("So far");
  expect(html).toContain("Read aloud");
});

it("draws no apology for figures a running turn has not reported yet", () => {
  const html = render({
    connection: "ready",
    runs: [
      run(
        "live",
        "Find flights",
        { ...initialRunState(), status: "running" },
        { startedAt: "2026-09-20T12:00:00Z", lastAt: "2026-09-20T12:00:02Z" },
      ),
    ],
  });
  for (const missing of ["Model not recorded", "Tokens not recorded", "Time not recorded"]) expect(html).not.toContain(missing);
});

it("names the plan's current step on the working line", () => {
  const items = [
    { content: "Search routes", status: "done" },
    { content: "Verify returns", status: "in_progress" },
  ];
  const html = render({
    connection: "ready",
    runs: [
      run("live", "Find flights", {
        ...initialRunState(),
        status: "running",
        transcript: [
          { kind: "tool", key: "c1", attemptId: "a", callId: "c1", toolName: "plan.update", input: { items }, status: "completed" },
        ],
      }),
    ],
  });
  expect(html).toContain("step 2 of 2: Verify returns");
});

it("counts a running turn's step in the plan an earlier turn kept, when it has made none", () => {
  const items = [
    { content: "Search routes", status: "in_progress" },
    { content: "Verify returns", status: "pending" },
  ];
  const earlier = run("first", "Find flights", {
    ...initialRunState({ taskId: "task-1" }),
    status: "completed",
    transcript: [{ kind: "tool", key: "c1", attemptId: "a", callId: "c1", toolName: "plan.update", input: { items }, status: "completed" }],
  });
  const html = render({
    connection: "ready",
    runs: [earlier, run("next", "try again", { ...initialRunState({ taskId: "task-1" }), status: "running" }, { continues: "task-1" })],
  });
  expect(html).toContain("step 1 of 2: Search routes");
});

it("renders durable task details and trajectory when there are no stream events", () => {
  const saved = run(
    "saved",
    "Search",
    { ...initialRunState({ taskId: "task-1" }), status: "completed", outcome: { kind: "completed", finalText: "Saved answer" } },
    {
      startedAt: "2026-09-27T20:29:52Z",
      lastAt: "2026-09-27T20:30:23Z",
      recordedHistory: {
        metrics: { models: ["openrouter/openai/gpt-4.1-mini"], totalTokens: 103054, partial: false },
        partial: false,
        tools: [
          {
            kind: "tool",
            key: "a:c",
            attemptId: "a",
            callId: "c",
            toolName: "web_search",
            status: "completed",
            model: "openrouter/openai/gpt-4.1-mini",
          },
        ],
      },
    },
  );
  const html = render({ connection: "ready", runs: [saved] });
  expect(html).toContain("Saved answer");
  for (const missing of ["Model not recorded", "Tokens not recorded", "Time not recorded"]) expect(html).not.toContain(missing);
  const session = sessionsOf([saved])[0]!;
  expect(sessionStats(session)).toEqual({ elapsedMs: 31000, tools: 1 });
  // Its footer says the same: its time, the model its call named, and the call.
  expect(replyFacts(saved)).toEqual({ time: "31s", model: "gpt-4.1-mini", modelIds: "openrouter/openai/gpt-4.1-mini", tools: 1 });
  const trajectory = renderToStaticMarkup(
    <InWorkspace client={{ request: async () => ({ ok: true }) }} workspaceId="default">
      <Trajectory session={session} />
    </InWorkspace>,
  );
  expect(trajectory).toContain("Recorded chat — 1 tool calls");
  expect(trajectory).toContain("web_search");
  expect(trajectory).toContain("openrouter/openai/gpt-4.1-mini");
  expect(trajectory).toContain("Duration not recorded");
  expect(trajectory).not.toContain("0 tool calls");
});

const row = (taskId: string, title: string, extra: Partial<TaskListRow> = {}): TaskListRow => ({
  taskId,
  workspaceId: "default",
  status: "completed",
  origin: "web",
  title,
  createdAt: "2026-10-04T08:00:00Z",
  updatedAt: "2026-10-04T09:00:00Z",
  needs: [],
  counts: { admissions: 1, tools: null },
  ...extra,
});

/** The sidebar over a Home, its side chat, an ordinary chat, a run and a worker — or over `only` those rows. */
function directory(homeChat: boolean, only?: readonly TaskListRow[], onHome?: () => void, onNewOwn?: () => void): string {
  const rows = only ?? [
    row("home-1", "Home", { chatKind: "home", status: "working", principalId: "operator" }),
    row("side-1", "Plan the trip", { chatKind: "side", parentChatId: "home-1" }),
    row("side-2", "Which hotel?", { chatKind: "side", parentChatId: "home-1", status: "input-required", needs: ["question"] }),
    row("home-2", "Someone else's Home", { chatKind: "home", principalId: "guest" }),
    row("chat-1", "Book the room", { status: "input-required", needs: ["question"] }),
    row("run-1", "Morning digest", { chatKind: "run" }),
    row("worker-1", "Delegated research", { chatKind: "worker", status: "working" }),
    row("conv-1", "Family group", { origin: "messaging", conversationHome: { kind: "group", epoch: 0 } }),
    row("topic-1", "Holiday topic", { origin: "messaging", chatKind: "side", parentChatId: "conv-1" }),
  ];
  const state: CanvasState = { connection: "ready", runs: [], directory: { rows, needs: [], needsTruncated: false, loading: false } };
  const store = { loadSessions: async () => undefined, openTask: async () => undefined } as unknown as CanvasStore;
  return renderToStaticMarkup(
    <InWorkspace client={{ request: () => new Promise<never>(() => undefined) }} workspaceId="default" timeZone="UTC">
      <SessionDirectory
        state={state}
        store={store}
        homeChat={homeChat}
        principal="operator"
        selected={undefined}
        onSelect={noop}
        onNew={noop}
        newLabel={homeChat ? "New side chat" : "New chat"}
        onHome={onHome}
        onNewOwn={onNewOwn}
      />
    </InWorkspace>,
  );
}
