import { emit } from "../../cli/output.js";
import { EXIT, configRefusalExit, reportCommandFailure } from "../../cli/exit.js";
import type { RemindersCommandOptions } from "./parse.js";
import { terminalText } from "../../shared/terminal-text.js";
import { remindersCommand as runRemindersAction, workspaceZone } from "./owner.js";
import { needsZone, remindersPayload, remindersResultText } from "./text.js";
import { randomUUID } from "node:crypto";
import { TaviErrorCodeSchema, TaviError } from "@tavi/contracts";
import { prefixedId } from "@tavi/node-kit";
import type { CliIo } from "../../cli/io.js";
import { runFamily } from "../../cli/owner.js";
import type { ResolvedDataDirectory } from "../../cli/store.js";

/**
 * `tavi reminders <action>`: the `reminders`
 * command on a live owner, acting as the workspace's operator; with none, the
 * same actions on the directory itself. Offline nothing fires — the owner
 * delivers what falls due once it starts — but every action is a plain store
 * write, so all of them work.
 */
export async function remindersCliCommand(options: ResolvedDataDirectory<RemindersCommandOptions>, io: CliIo): Promise<number> {
  const operationKey = `cli:${randomUUID()}`;
  const print = (result: unknown): number => {
    emit(io, options.format, result, () => remindersResultText(options, result, new Date(), io.columns));
    return EXIT.ok;
  };
  const mutates = options.action !== "list" && options.action !== "show";
  const codes = { NOT_FOUND: EXIT.usage };
  return runFamily(options.dataDirectory, "reminders", io, {
    label: `tavi reminders ${options.action}`,
    mutates,
    codes,
    build: async (client) => {
      let zone: string | undefined;
      if (needsZone(options)) {
        // The workspace's zone, as the owner resolves it: a local time is read there.
        const listed = await client.request(
          "reminders",
          { action: "list", workspaceId: options.workspaceId, limit: 1 },
          prefixedId("reminders"),
        );
        if (!listed.ok) {
          const code = TaviErrorCodeSchema.safeParse(listed.error?.code);
          throw new TaviError(
            code.success ? code.data : "UNAVAILABLE",
            terminalText(listed.error?.message ?? "The owner refused the reminders list"),
          );
        }
        const answered = (listed.result as { readonly timezone?: unknown }).timezone;
        if (typeof answered !== "string") throw new TaviError("UNAVAILABLE", `The owner did not say the workspace's timezone; pass --zone`);
        zone = answered;
      }
      return remindersPayload(options, zone, operationKey);
    },
    render: (result) => print(result),
    offline: async (store) => {
      const deps = { repositories: store.asPort().repositories, principalOf: () => options.principalId, now: () => new Date() };
      const zone = needsZone(options) ? await workspaceZone(deps, options.workspaceId) : undefined;
      const answer = await runRemindersAction(deps, remindersPayload(options, zone, operationKey));
      if (!answer.ok) {
        io.stderr(`${terminalText(answer.error.message)}\n`);
        return answer.error.code === "NOT_FOUND" ? codes.NOT_FOUND : configRefusalExit(answer.error.code);
      }
      return print(answer.result);
    },
    failed: (error) => reportCommandFailure(error, io, "reminders command failed"),
  });
}
