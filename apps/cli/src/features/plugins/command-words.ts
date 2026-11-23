import type { PluginCommandView } from "@tavi/contracts";
import type { CoreKey, CoreT } from "@tavi/contracts/locales/core";

/**
 * Tavi's own slash commands' descriptions in the workspace's language, for a
 * front end's list of commands (the canvas's composer, `tavi chat`'s help). A
 * command is answered by its plugin and never read by the model, so its
 * description is the person's alone. Another plugin's description is its own.
 */
const BUILTIN_COMMAND_KEYS: Readonly<Record<string, CoreKey>> = {
  "tavi.memory/remember": "command.memory.remember",
  "tavi.memory/forget": "command.memory.forget",
  "tavi.memory/memory": "command.memory.memory",
  "tavi.memory/why": "command.memory.why",
  "tavi.heartbeat/heartbeat": "command.heartbeat.heartbeat",
  "tavi.ideas/ideas": "command.ideas.ideas",
};

/** `commands` with each built-in's description in `t`'s words; a name typed as `<plugin>:<name>` is matched by its name. */
export function commandsIn(commands: readonly PluginCommandView[], t: CoreT): readonly PluginCommandView[] {
  return commands.map((command) => {
    const key = BUILTIN_COMMAND_KEYS[`${command.pluginId}/${command.name.split(":").at(-1) ?? command.name}`];
    return key === undefined ? command : { ...command, description: t(key) };
  });
}
