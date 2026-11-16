import { emit, emitJson } from "../../cli/output.js";
import { EXIT, reportCommandFailure } from "../../cli/exit.js";
import { type AgentDefinition, AgentDefinitionSchema } from "@tavi/contracts";
import { definedOnly, nowTimestamp } from "@tavi/contracts/util";
import type { AgentsCommandOptions } from "./parse.js";
import { type CliIo, printUnreadableWarning } from "../../cli/io.js";
import { configOnOwner } from "../../cli/owner.js";
import { type ResolvedDataDirectory, withStorePreservingOwnership } from "../../cli/store.js";

/** Agent configuration uses the active owner's repository while it is running. */
async function agentsOnOwner(options: ResolvedDataDirectory<AgentsCommandOptions>, io: CliIo): Promise<number | undefined> {
  return configOnOwner(options.dataDirectory, "agents", io, {
    label: `tavi agents ${options.action}`,
    mutates: options.action !== "list" && options.action !== "show",
    // A mistyped id, as offline.
    codes: { NOT_FOUND: EXIT.usage },
    build: () => {
      if (options.action !== "list" && options.agentId === undefined) {
        io.stderr(`agents ${options.action} needs an agent id\n`);
        return EXIT.usage;
      }
      return {
        action: options.action,
        workspaceId: options.workspaceId,
        ...definedOnly({
          agentId: options.agentId,
          name: options.name,
          prompt: options.prompt,
          description: options.description,
        }),
      };
    },
    render: (result) => {
      if (options.action !== "list" && options.action !== "show") {
        if (options.action === "remove") {
          const removed = result as { removed: string; existed: boolean };
          emit(io, options.format, removed, () => `${removed.existed ? "removed" : "no agent existed:"} ${removed.removed}`);
        } else emit(io, options.format, result as AgentDefinition, agentLine);
        return EXIT.ok;
      }
      if (options.action === "show") {
        emit(io, options.format, result as AgentDefinition, agentShowText);
        return EXIT.ok;
      }
      const listed = result as {
        readonly agents: readonly Omit<AgentDefinition, "systemPrompt">[];
        readonly truncated: boolean;
        readonly unreadable?: readonly string[];
      };
      if (options.format === "json") {
        emitJson(io, listed);
        return EXIT.ok;
      }
      for (const agent of listed.agents) io.stdout(agentLine(agent));
      printUnreadableWarning(
        io,
        "agent definition(s)",
        listed.unreadable ?? [],
        "Fix them with `tavi agents remove <id>` once the owner is stopped.",
      );
      if (listed.truncated) io.stderr(`note: the owner lists the first ${listed.agents.length} agents\n`);
      return EXIT.ok;
    },
  });
}

/** `tavi agents list`'s text line for one agent. */
function agentLine(agent: Omit<AgentDefinition, "systemPrompt">): string {
  return `${agent.agentId}\t${agent.name}\t${agent.enabled ? "enabled" : "disabled"}\t${agent.description ?? ""}\n`;
}

/** `tavi agents show`'s text. */
function agentShowText(value: AgentDefinition): string {
  return [
    `agent ${value.agentId} (${value.name})`,
    `  state       ${value.enabled ? "enabled" : "disabled"}`,
    `  for         ${value.description ?? "(no description)"}`,
    "  instructions:",
    ...value.systemPrompt.split("\n").map((line) => `    ${line}`),
  ].join("\n");
}

/**
 * `tavi agents <action>` — the named-persona registry.
 *
 * Plain store operations, like the read side of `tavi schedules`: a persona is
 * configuration, and inspecting it must work while `serve` owns the directory.
 * Nothing here admits work, so there is no runtime to compose — the task that
 * *uses* a persona is the thing that needs a model connection, not the
 * definition of it.
 */
export async function agentsCommand(options: ResolvedDataDirectory<AgentsCommandOptions>, io: CliIo): Promise<number> {
  const onOwner = await agentsOnOwner(options, io);
  if (onOwner !== undefined) return onOwner;
  try {
    return await withStorePreservingOwnership(options.dataDirectory, async (store) => {
      const agents = store.asPort().repositories.agents;
      const now = nowTimestamp();

      if (options.action === "list") {
        const { agents: all, unreadable } = await agents.list(options.workspaceId);
        if (options.format === "json") {
          emitJson(io, { agents: all, ...(unreadable.length === 0 ? {} : { unreadable }) });
          return EXIT.ok;
        }
        for (const agent of all) io.stdout(agentLine(agent));
        // Reported, not swallowed: a definition the model can no longer load
        // looks exactly like a definition that was never created.
        printUnreadableWarning(
          io,
          "agent definition(s)",
          unreadable,
          "Fix them with `tavi agents remove <id>` (adding --workspace if it is not the default), or restore a backup.",
        );
        return EXIT.ok;
      }

      if (options.action === "add") {
        const { agentId, name, prompt } = options;
        if (agentId === undefined || name === undefined || prompt === undefined) {
          io.stderr("agents add needs an agent id, --name and --prompt\n");
          return EXIT.usage;
        }
        // The bounds live in `AgentDefinitionSchema`, which nothing parses on
        // this path — so they are applied here too, or `--prompt` would be
        // accepted at any length and then prepended to every model call for
        // every turn of every task naming this agent.
        const validated = AgentDefinitionSchema.pick({ agentId: true, name: true, description: true, systemPrompt: true }).safeParse({
          agentId,
          name,
          ...(options.description === undefined ? {} : { description: options.description }),
          systemPrompt: prompt,
        });
        if (!validated.success) {
          io.stderr(`invalid agent definition: ${validated.error.issues.map((issue) => issue.message).join("; ")}\n`);
          return EXIT.usage;
        }
        const created = await agents.create({
          agentId,
          workspaceId: options.workspaceId,
          name,
          ...(options.description === undefined ? {} : { description: options.description }),
          systemPrompt: prompt,
          enabled: true,
          now,
        });
        emit(io, options.format, created, (value) => `${value.agentId}\t${value.name}\tenabled\n`);
        return EXIT.ok;
      }

      const agentId = options.agentId;
      if (agentId === undefined) {
        io.stderr(`agents ${options.action} needs an agent id\n`);
        return EXIT.usage;
      }
      // `remove` is answered before the read: it needs only the id, and `get`
      // now throws on an unreadable row — so looking it up first would make a
      // broken definition impossible to delete, which is exactly the row an
      // operator most needs to clear.
      if (options.action === "remove") {
        const removed = await agents.remove(options.workspaceId, agentId);
        emit(io, options.format, { removed: agentId, existed: removed }, (value) =>
          value.existed ? `removed ${value.removed}\n` : `no agent ${value.removed} existed\n`,
        );
        return EXIT.ok;
      }

      const existing = await agents.get(options.workspaceId, agentId);
      if (existing === undefined) {
        io.stderr(`no agent ${JSON.stringify(agentId)} exists in workspace ${options.workspaceId}\n`);
        return EXIT.usage;
      }

      if (options.action === "show") {
        emit(io, options.format, existing, agentShowText);
        return EXIT.ok;
      }

      if (options.action === "update") {
        // Bounded here for the same reason `add` is: nothing on this path parses
        // `AgentDefinitionSchema`, and an unbounded `--prompt` would be prepended
        // to every model call of every turn of every task naming this agent.
        // `update` itself refuses an invalid value too — this turns that typed
        // throw into a usage error with the field named.
        const validated = AgentDefinitionSchema.pick({ name: true, description: true, systemPrompt: true })
          .partial()
          .safeParse({
            ...(options.name === undefined ? {} : { name: options.name }),
            // An empty `--description` is the clear, not a value: the schema's
            // own minimum is 1 character, so "" can only mean "remove it".
            ...(options.description === undefined || options.description === "" ? {} : { description: options.description }),
            ...(options.prompt === undefined ? {} : { systemPrompt: options.prompt }),
          });
        if (!validated.success) {
          io.stderr(`invalid agent definition: ${validated.error.issues.map((issue) => issue.message).join("; ")}\n`);
          return EXIT.usage;
        }
        await agents.update({
          workspaceId: options.workspaceId,
          agentId,
          ...(options.name === undefined ? {} : { name: options.name }),
          ...(options.description === undefined ? {} : { description: options.description === "" ? null : options.description }),
          ...(options.prompt === undefined ? {} : { systemPrompt: options.prompt }),
          now,
        });
        // Read back rather than echoing the input: the row is what the next turn
        // will resolve, and a caller checking the output is checking that.
        const updated = (await agents.get(options.workspaceId, agentId)) ?? existing;
        emit(
          io,
          options.format,
          updated,
          (value) => `${value.agentId}\t${value.name}\t${value.enabled ? "enabled" : "disabled"}\t${value.description ?? ""}\n`,
        );
        return EXIT.ok;
      }

      if (options.action === "enable" || options.action === "disable") {
        const enabled = options.action === "enable";
        await agents.update({ workspaceId: options.workspaceId, agentId, enabled, now });
        const updated = (await agents.get(options.workspaceId, agentId)) ?? existing;
        emit(io, options.format, updated, (value) => `${value.agentId}\t${value.name}\t${value.enabled ? "enabled" : "disabled"}\n`);
        return EXIT.ok;
      }

      io.stderr(`agents ${options.action} is not implemented\n`);
      return EXIT.usage;
    });
  } catch (error) {
    return reportCommandFailure(error, io, "agents command failed");
  }
}
