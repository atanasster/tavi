import { inspectDatabase } from "../support/database-fixture.js";
import { join } from "node:path";

import type { AgentDefinition, InvocationContext } from "@tavi/contracts";
import { capture, temporaryDirectories } from "@tavi/test-support";
import { createFixtureModel, type ScriptedTurn } from "@tavi/test-support/fakes";
import { SqliteStore } from "../support/database-fixture.js";
import { afterEach, describe, expect, it } from "vitest";

import { composeTaviRuntime } from "../../src/runtime/composition.js";
import type { TaviRuntime } from "../../src/runtime/types.js";
import { EXIT, main } from "../../src/main.js";
import { fixtureRuntimeOptions } from "../support/serve-fixture.js";

/**
 * The named-agent registry: the `agentDefinitionId` given to `spawn` names a
 * stored persona with its own system prompt, so "create an orchestrator agent
 * named `sdaddy`" has a place to live.
 */

const directories = temporaryDirectories({ prefix: "tavi-agents-" });

afterEach(() => directories.cleanup());

/**
 * The Chief-of-Staff fixture persona: a numbers-only request calls `collect.daily` once, a PDF request calls
 * `reports.generate` directly, and delivery is claimed only after confirmation.
 *
 * This is where the documented flow is **recorded and stored**, not where it is
 * exercised: these tests create, show and update the definition, and no task is
 * admitted under it. There is no shipped persona — nothing seeds
 * `tavi_agent_definitions` — so the flow's behaviour is a live-model question.
 */
const SDADDY_PROMPT =
  "You are sdaddy, the operator's chief of staff. For a numbers-only question, call collect.daily once and answer from it. " +
  "For a PDF, call reports.generate directly and do not repeat the full collection first. " +
  "Claim delivery only after confirmation, and never ask the operator for configuration on an unattended run.";

async function addAgent(directory: string, extra: readonly string[] = []): Promise<string> {
  const created = capture();
  const code = await main(
    [
      "agents",
      "add",
      "sdaddy",
      "--name",
      "Chief of staff",
      "--prompt",
      SDADDY_PROMPT,
      "--description",
      "Runs the morning brief",
      "--format",
      "json",
      "--data-dir",
      directory,
      ...extra,
    ],
    { io: created.io },
  );
  expect(code, created.stderr()).toBe(EXIT.ok);
  return (JSON.parse(created.stdout()) as AgentDefinition).agentId;
}

describe("tavi agents", () => {
  it("creates a definition and shows its persona, which is the thing the runtime resolves", async () => {
    const directory = directories.create();
    const agentId = await addAgent(directory);
    expect(agentId).toBe("sdaddy");

    const shown = capture();
    expect(await main(["agents", "show", "sdaddy", "--data-dir", directory], { io: shown.io })).toBe(EXIT.ok);
    expect(shown.stdout()).toMatch(/agent sdaddy \(Chief of staff\)/);
    expect(shown.stdout()).toMatch(/state {7}enabled/);
    expect(shown.stdout()).toMatch(/for {9}Runs the morning brief/);
    // The instructions are what actually reaches the model, so they are shown
    // in full rather than summarised.
    expect(shown.stdout()).toContain(SDADDY_PROMPT);
  });

  it("refuses a duplicate id rather than silently replacing a persona", async () => {
    const directory = directories.create();
    await addAgent(directory);
    const again = capture();
    // Replacing instructions is `agents` update work; an add that quietly
    // overwrote a persona would change how every task naming it behaves.
    // Usage, not `alreadyOwned`: a duplicate id is the operator's to fix, and
    // `alreadyOwned` means another process holds the data directory.
    expect(
      await main(["agents", "add", "sdaddy", "--name", "Other", "--prompt", "Different", "--data-dir", directory], { io: again.io }),
    ).toBe(EXIT.usage);
    expect(again.stderr()).toMatch(/already exists/);
  });

  it("rejects an invalid agent id and a missing required flag as usage errors", async () => {
    const directory = directories.create();
    const badId = capture();
    expect(await main(["agents", "add", "not a valid id", "--name", "n", "--prompt", "p", "--data-dir", directory], { io: badId.io })).toBe(
      EXIT.usage,
    );
    expect(badId.stderr()).toMatch(/is not a valid agent id/);

    const missing = capture();
    expect(await main(["agents", "add", "ok-id", "--name", "n", "--data-dir", directory], { io: missing.io })).toBe(EXIT.usage);
    expect(missing.stderr()).toMatch(/needs --prompt/);
  });

  it("lists definitions, disables one, and refuses to address an unknown id", async () => {
    const directory = directories.create();
    await addAgent(directory);

    const listed = capture();
    expect(await main(["agents", "list", "--data-dir", directory], { io: listed.io })).toBe(EXIT.ok);
    expect(listed.stdout()).toContain("sdaddy");
    expect(listed.stdout()).toContain("Chief of staff");

    const disabled = capture();
    expect(await main(["agents", "disable", "sdaddy", "--data-dir", directory], { io: disabled.io })).toBe(EXIT.ok);
    expect(disabled.stdout()).toMatch(/sdaddy\tChief of staff\tdisabled/);

    const missing = capture();
    expect(await main(["agents", "show", "nope", "--data-dir", directory], { io: missing.io })).toBe(EXIT.usage);
    expect(missing.stderr()).toMatch(/no agent "nope" exists/);
  });

  it("removes a definition", async () => {
    const directory = directories.create();
    await addAgent(directory);
    const removed = capture();
    expect(await main(["agents", "remove", "sdaddy", "--data-dir", directory], { io: removed.io })).toBe(EXIT.ok);
    expect(removed.stdout()).toMatch(/removed sdaddy/);
    const after = capture();
    expect(await main(["agents", "show", "sdaddy", "--data-dir", directory], { io: after.io })).toBe(EXIT.usage);
  });

  it("edits a persona in place, so a badly-worded one can be fixed without losing its id", async () => {
    const directory = directories.create();
    await addAgent(directory);

    const edited = capture();
    expect(
      await main(
        ["agents", "update", "sdaddy", "--prompt", "You are sdaddy. Send the brief by 07:30.", "--format", "json", "--data-dir", directory],
        { io: edited.io },
      ),
    ).toBe(EXIT.ok);
    const updated = JSON.parse(edited.stdout()) as AgentDefinition;
    expect(updated.systemPrompt).toBe("You are sdaddy. Send the brief by 07:30.");
    // One field at a time: the name and description the operator did not touch
    // must survive, or an edit to the prompt would quietly rename the agent.
    expect(updated.name).toBe("Chief of staff");
    expect(updated.description).toBe("Runs the morning brief");

    // An empty `--description` is the clear: the schema's own minimum is one
    // character, so it cannot mean a value.
    const cleared = capture();
    expect(
      await main(["agents", "update", "sdaddy", "--description", "", "--name", "Chief", "--format", "json", "--data-dir", directory], {
        io: cleared.io,
      }),
    ).toBe(EXIT.ok);
    const after = JSON.parse(cleared.stdout()) as AgentDefinition;
    expect(after.description).toBeUndefined();
    expect(after.name).toBe("Chief");
    expect(after.systemPrompt).toBe("You are sdaddy. Send the brief by 07:30.");
  });

  it("refuses an update that changes nothing, and one whose value the schema rejects", async () => {
    const directory = directories.create();
    await addAgent(directory);

    // Reporting success for an empty edit would print the unchanged definition
    // and leave the operator believing their change landed.
    const nothing = capture();
    expect(await main(["agents", "update", "sdaddy", "--data-dir", directory], { io: nothing.io })).toBe(EXIT.usage);
    expect(nothing.stderr()).toMatch(/needs at least one of/);

    // The bound is real on this path too: the prompt is prepended to every model
    // call of every turn of every task naming the agent.
    const tooLong = capture();
    expect(await main(["agents", "update", "sdaddy", "--prompt", "x".repeat(20_001), "--data-dir", directory], { io: tooLong.io })).toBe(
      EXIT.usage,
    );
    expect(tooLong.stderr()).toMatch(/invalid agent definition/);
    const unchanged = capture();
    expect(await main(["agents", "show", "sdaddy", "--data-dir", directory], { io: unchanged.io })).toBe(EXIT.ok);
    expect(unchanged.stdout()).toContain(SDADDY_PROMPT);

    const ghost = capture();
    expect(await main(["agents", "update", "ghost", "--name", "n", "--data-dir", directory], { io: ghost.io })).toBe(EXIT.usage);
    expect(ghost.stderr()).toMatch(/no agent "ghost" exists/);
  });

  it("documents its own flags on --help", async () => {
    const shown = capture();
    expect(await main(["agents", "--help"], { io: shown.io })).toBe(EXIT.ok);
    expect(shown.stdout()).toMatch(/Manage named agent personas/);
    expect(shown.stdout()).toMatch(/--prompt <text>/);
    // The positional id was undocumented, so the only way to learn it was the
    // error message after a failed attempt.
    expect(shown.stdout()).toMatch(/add <id>/);
    expect(shown.stdout()).toMatch(/update <id>/);
  });
});

describe("schedules naming an agent", () => {
  it("refuses --agent for an unregistered agent, so a typo is caught at add time", async () => {
    const directory = directories.create();
    const bad = capture();
    expect(
      await main(
        [
          "schedules",
          "add",
          "--name",
          "brief",
          "--at",
          "07:00",
          "--timezone",
          "Europe/Sofia",
          "--prompt",
          "go",
          "--agent",
          "ghost",
          "--data-dir",
          directory,
        ],
        { io: bad.io },
      ),
    ).toBe(EXIT.usage);
    // Every fire would otherwise fail at admission, every morning, which is a
    // worse way to learn about a typo than this.
    expect(bad.stderr()).toMatch(/no agent "ghost" exists/);
  });

  it("records the persona and shows it, so an operator can see who runs the brief", async () => {
    const directory = directories.create();
    await addAgent(directory);
    const created = capture();
    expect(
      await main(
        [
          "schedules",
          "add",
          "--name",
          "brief",
          "--at",
          "07:00",
          "--timezone",
          "Europe/Sofia",
          "--prompt",
          "go",
          "--agent",
          "sdaddy",
          "--allow",
          "reports.*",
          "--data-dir",
          directory,
        ],
        { io: created.io },
      ),
    ).toBe(EXIT.ok);

    const shown = capture();
    expect(await main(["schedules", "show", "brief", "--data-dir", directory], { io: shown.io })).toBe(EXIT.ok);
    expect(shown.stdout()).toMatch(/runs as {5}sdaddy/);
  });

  it("shows the base instructions when a schedule names no agent", async () => {
    const directory = directories.create();
    const quiet = capture();
    expect(
      await main(
        ["schedules", "add", "--name", "plain", "--at", "07:00", "--timezone", "Europe/Sofia", "--prompt", "go", "--data-dir", directory],
        { io: quiet.io },
      ),
    ).toBe(EXIT.ok);
    const shown = capture();
    expect(await main(["schedules", "show", "plain", "--data-dir", directory], { io: shown.io })).toBe(EXIT.ok);
    expect(shown.stdout()).toMatch(/runs as {5}\(the base instructions\)/);
  });
});

describe("agent definitions are instructions, not authority", () => {
  it("carries no tool allowlist or credential, so adding an agent cannot widen what may run", async () => {
    const directory = directories.create();
    const store = await SqliteStore.open({
      databasePath: join(directory, "tavi.sqlite"),
      artifactsDirectory: join(directory, "artifacts"),
    });
    try {
      const created = await store.asPort().repositories.agents.create({
        agentId: "sdaddy",
        workspaceId: "default",
        name: "Chief of staff",
        systemPrompt: "Be helpful.",
        enabled: true,
        now: "2026-04-05T00:00:00.000Z",
      });
      // The registry's whole shape: a persona and metadata. Unattended tool
      // policy belongs to the schedule and read authority to the
      // workspace grant, so there is deliberately nothing here to widen.
      expect(Object.keys(created).sort()).toEqual(
        ["agentId", "createdAt", "enabled", "name", "systemPrompt", "updatedAt", "workspaceId"].sort(),
      );
    } finally {
      store.close();
    }
  });

  it("scopes ids per workspace, so two workspaces may each have their own sdaddy", async () => {
    const directory = directories.create();
    const store = await SqliteStore.open({
      databasePath: join(directory, "tavi.sqlite"),
      artifactsDirectory: join(directory, "artifacts"),
    });
    try {
      const agents = store.asPort().repositories.agents;
      await agents.create({
        agentId: "sdaddy",
        workspaceId: "w1",
        name: "One",
        systemPrompt: "First.",
        enabled: true,
        now: "2026-01-01T00:00:00.000Z",
      });
      await expect(
        (async () =>
          await agents.create({
            agentId: "sdaddy",
            workspaceId: "w1",
            name: "Two",
            systemPrompt: "Second.",
            enabled: true,
            now: "2026-01-01T00:00:00.000Z",
          }))(),
      ).rejects.toThrow(/already exists/);
      await (async () =>
        await agents.create({
          agentId: "sdaddy",
          workspaceId: "w2",
          name: "Three",
          systemPrompt: "Third.",
          enabled: true,
          now: "2026-01-01T00:00:00.000Z",
        }))();
      expect((await agents.get("w1", "sdaddy"))?.systemPrompt).toBe("First.");
      expect((await agents.get("w2", "sdaddy"))?.systemPrompt).toBe("Third.");
    } finally {
      store.close();
    }
  });

  it("updates one field without clobbering another", async () => {
    const directory = directories.create();
    const store = await SqliteStore.open({
      databasePath: join(directory, "tavi.sqlite"),
      artifactsDirectory: join(directory, "artifacts"),
    });
    try {
      const agents = store.asPort().repositories.agents;
      await agents.create({
        agentId: "sdaddy",
        workspaceId: "default",
        name: "Chief of staff",
        description: "Runs the brief",
        systemPrompt: "Original.",
        enabled: true,
        now: "2026-01-01T00:00:00.000Z",
      });
      await agents.update({ workspaceId: "default", agentId: "sdaddy", systemPrompt: "Revised.", now: "2026-01-01T00:00:01.000Z" });
      const updated = await agents.get("default", "sdaddy");
      expect(updated?.systemPrompt).toBe("Revised.");
      expect(updated?.description).toBe("Runs the brief");
      expect(updated?.name).toBe("Chief of staff");

      // `null` clears the description; `undefined` means "not supplied".
      await agents.update({ workspaceId: "default", agentId: "sdaddy", description: null, now: "2026-01-01T00:00:02.000Z" });
      expect((await agents.get("default", "sdaddy"))?.description).toBeUndefined();
    } finally {
      store.close();
    }
  });
});

/**
 * The composition wiring, which the live run is the only other thing to exercise.
 *
 * This exists because the unit tests in `packages/agent-host` construct the
 * workflow adapter directly: they prove the *mechanism*, not that
 * `composeTaviRuntime` actually hands the registry to it. A missing wire there
 * is invisible to every one of them — and was, briefly, to a live run too.
 */
describe("a composed runtime resolves the persona it was given", () => {
  async function composed(
    directory: string,
  ): Promise<{ readonly runtime: TaviRuntime; readonly model: ReturnType<typeof createFixtureModel> }> {
    const model = createFixtureModel({ turns: [{ text: "done" }] });
    const runtime = await composeTaviRuntime(fixtureRuntimeOptions(directory, { approvalRequiredFor: [] }), { modelOverride: model });
    return { runtime, model };
  }

  it("puts the agent's instructions in the system message the model receives", async () => {
    const directory = directories.create();
    const { runtime, model } = await composed(directory);
    try {
      await runtime.store.asPort().repositories.agents.create({
        agentId: "sdaddy",
        workspaceId: "default",
        name: "Chief of staff",
        systemPrompt: "You are sdaddy, the operator's chief of staff.",
        enabled: true,
        now: "2026-04-05T00:00:00.000Z",
      });
      const context: InvocationContext = {
        workspaceId: "default",
        principalId: "operator",
        runId: "pending-admission",
        caller: "test",
        agentDefinitionId: "sdaddy",
      };
      await runtime.workflow?.admit({ context, operationKey: "op-persona", kind: "start", prompt: "go" });
      const system = model.calls[0]?.messages.find((message) => message.role === "system");
      expect(system?.text).toContain("You are sdaddy, the operator's chief of staff.");
    } finally {
      await runtime.close();
    }
  });

  it("keeps the persona on a later turn of the same task, which is what a chat conversation is", async () => {
    const directory = directories.create();
    const model = createFixtureModel({ turns: [{ text: "first" }, { text: "second" }] });
    const runtime = await composeTaviRuntime(fixtureRuntimeOptions(directory, { approvalRequiredFor: [] }), { modelOverride: model });
    try {
      await runtime.store.asPort().repositories.agents.create({
        agentId: "sdaddy",
        workspaceId: "default",
        name: "Chief of staff",
        systemPrompt: "You are sdaddy, the operator's chief of staff.",
        enabled: true,
        now: "2026-04-05T00:00:00.000Z",
      });
      const admitted = await runtime.workflow?.admit({
        context: {
          workspaceId: "default",
          principalId: "operator",
          runId: "pending-admission",
          caller: "messaging:telegram",
          agentDefinitionId: "sdaddy",
        },
        operationKey: "op-persona-first",
        kind: "start",
        prompt: "run all projects",
      });
      const taskId = admitted?.taskId ?? "";

      // The second message of the same conversation. Its context is what the
      // inbound path can build — the task id and the sender — and names no
      // agent: the `invocation` channel has no reducer, so before this was
      // carried forward the reply replaced the persona with nothing and the
      // orchestrator answered as the base prompt from message two onwards.
      await runtime.workflow?.admit({
        context: { workspaceId: "default", principalId: "operator", runId: taskId, caller: "messaging:telegram" },
        operationKey: "op-persona-second",
        kind: "reply",
        taskId,
        prompt: "and again",
      });
      expect(model.calls[1]?.messages.find((message) => message.role === "system")?.text).toContain("You are sdaddy");
    } finally {
      await runtime.close();
    }
  });

  it("degrades to the base instructions when the persona row has become unreadable", async () => {
    const directory = directories.create();
    const model = createFixtureModel({ turns: [{ text: "first" }, { text: "second" }] });
    const runtime = await composeTaviRuntime(fixtureRuntimeOptions(directory, { approvalRequiredFor: [] }), { modelOverride: model });
    try {
      await runtime.store.asPort().repositories.agents.create({
        agentId: "sdaddy",
        workspaceId: "default",
        name: "Chief of staff",
        systemPrompt: "You are sdaddy, the operator's chief of staff.",
        enabled: true,
        now: "2026-04-05T00:00:00.000Z",
      });
      const context: InvocationContext = {
        workspaceId: "default",
        principalId: "operator",
        runId: "pending-admission",
        caller: "test",
        agentDefinitionId: "sdaddy",
      };
      const admitted = await runtime.workflow?.admit({ context, operationKey: "op-persona-corrupt", kind: "start", prompt: "go" });
      expect(model.calls[0]?.messages.find((message) => message.role === "system")?.text).toContain("You are sdaddy");

      // A hand edit, or a row restored from an older schema: `agents.get`
      // validates on the way out and *throws* for this row from now on.
      inspectDatabase(runtime.store)
        .prepare("UPDATE tavi_agent_definitions SET system_prompt = '' WHERE workspace_id = 'default' AND agent_id = 'sdaddy'")
        .run();
      await expect((async () => await runtime.store.asPort().repositories.agents.get("default", "sdaddy"))()).rejects.toThrow();

      // The task must still take its next turn. Resolution happens per turn, so
      // an unguarded read here failed every remaining turn of every task naming
      // this agent — the persona is what is lost, never the task.
      const taskId = admitted?.taskId;
      expect(taskId).toBeDefined();
      const next = await runtime.workflow?.admit({
        context: { workspaceId: "default", principalId: "operator", runId: taskId ?? "", caller: "test" },
        operationKey: "op-persona-corrupt-2",
        kind: "reply",
        taskId: taskId ?? "",
        prompt: "and again",
      });
      expect(next?.outcome.status).toBe("completed");
      expect(model.calls[1]?.messages.find((message) => message.role === "system")?.text).not.toContain("sdaddy");
    } finally {
      await runtime.close();
    }
  });

  it("leaves the system message unchanged for a task that names no agent", async () => {
    const directory = directories.create();
    const { runtime, model } = await composed(directory);
    try {
      await runtime.store.asPort().repositories.agents.create({
        agentId: "sdaddy",
        workspaceId: "default",
        name: "Chief of staff",
        systemPrompt: "You are sdaddy, the operator's chief of staff.",
        enabled: true,
        now: "2026-04-05T00:00:00.000Z",
      });
      const context: InvocationContext = { workspaceId: "default", principalId: "operator", runId: "pending-admission", caller: "test" };
      await runtime.workflow?.admit({ context, operationKey: "op-no-persona", kind: "start", prompt: "go" });
      const system = model.calls[0]?.messages.find((message) => message.role === "system");
      expect(system?.text).not.toContain("sdaddy");
    } finally {
      await runtime.close();
    }
  });
});

/**
 * The regression the review found: a persona must survive a worker's *later*
 * turns, not just the one that spawned it.
 *
 * `wake()` admits a worker's next turn with a `taskId` and no `resume`, and the
 * checkpointed `invocation` channel has no reducer — so the context is replaced
 * wholesale from `contextFrom`, which rebuilds it from the delegation row. A
 * persona recorded only on the spawn admission was therefore silently gone by
 * the second turn, and the worker ran under the base instructions while
 * everything still "worked".
 */
describe("a spawned worker keeps its persona across turns", () => {
  it("still runs under its own instructions on the turn after the spawn", async () => {
    const directory = directories.create();
    const turns: ScriptedTurn[] = [{ text: "worker turn one" }, { text: "worker turn two" }];
    const model = createFixtureModel({ turns });
    const runtime = await composeTaviRuntime(fixtureRuntimeOptions(directory, { approvalRequiredFor: [] }), { modelOverride: model });
    try {
      await runtime.store.asPort().repositories.agents.create({
        agentId: "analyst",
        workspaceId: "default",
        name: "Analyst",
        systemPrompt: "You are the analyst. Rank the news by relevance.",
        enabled: true,
        now: "2026-04-05T00:00:00.000Z",
      });
      const orchestratorContext: InvocationContext = {
        workspaceId: "default",
        principalId: "operator",
        runId: "orchestrator-run",
        caller: "test",
      };

      // Spawn a worker that names the agent.
      const spawn = runtime.tools.get("agents.spawn");
      if (spawn === undefined) throw new Error("agents.spawn is not registered");
      const spawned = (await spawn.handler({
        input: { agentDefinitionId: "analyst", input: "rank the news", operationKey: "op-persona-worker" },
        context: orchestratorContext,
        signal: new AbortController().signal,
      })) as { readonly workerTaskId: string; readonly workerAgentId: string };
      expect(spawned.workerTaskId).toBeDefined();
      expect(model.calls[0]?.messages.find((message) => message.role === "system")?.text).toContain("You are the analyst");

      // Wake it: `agents.send` delivers and wakes, which re-admits on the
      // worker's own task with a context rebuilt from the delegation row.
      const send = runtime.tools.get("agents.send");
      if (send === undefined) throw new Error("agents.send is not registered");
      await send.handler({
        input: {
          recipientAgentId: spawned.workerAgentId,
          recipientTaskId: spawned.workerTaskId,
          kind: "message",
          content: "keep going",
        },
        context: orchestratorContext,
        signal: new AbortController().signal,
      });

      const laterSystem = model.calls
        .slice(1)
        .map((call) => call.messages.find((message) => message.role === "system")?.text ?? "")
        .find((text) => text !== "");
      // Without the delegation row carrying the persona this is the base prompt
      // only — the silent loss this guards against.
      expect(laterSystem).toContain("You are the analyst");
    } finally {
      await runtime.close();
    }
  });

  it("removes an unreadable definition, and says which row a listing could not read", async () => {
    const directory = directories.create();
    await addAgent(directory);
    // The row a restored backup or a hand-edit could leave: an id the schema's
    // pattern rejects. `get` refuses to read it, so `remove` must not need `get`
    // — otherwise the one row an operator most needs to clear is undeletable.
    const store = await SqliteStore.open({
      databasePath: join(directory, "tavi.sqlite"),
      artifactsDirectory: join(directory, "artifacts"),
    });
    try {
      store.handle
        .prepare(
          `INSERT INTO tavi_agent_definitions (agent_id, workspace_id, name, system_prompt, enabled, created_at, updated_at)
           VALUES ('bad id/with/slashes', 'default', 'Bad', 'x', 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
        )
        .run();
    } finally {
      store.close();
    }

    const listed = capture();
    expect(await main(["agents", "list", "--data-dir", directory], { io: listed.io })).toBe(EXIT.ok);
    expect(listed.stderr()).toContain("default/bad id/with/slashes");

    const removed = capture();
    expect(await main(["agents", "remove", "bad id/with/slashes", "--data-dir", directory], { io: removed.io })).toBe(EXIT.ok);

    const after = capture();
    expect(await main(["agents", "list", "--data-dir", directory], { io: after.io })).toBe(EXIT.ok);
    expect(after.stderr()).not.toContain("could not be read");
  });
});
