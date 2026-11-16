import type { OnboardingStatus } from "@tavi/contracts";
import { connectLiveOwner } from "../../cli/owner-connection.js";
import type { CliIo } from "../../cli/io.js";
import { ownerWorkspacePrincipal } from "../../cli/owner.js";
import { withStorePreservingOwnership } from "../../cli/store.js";
import { attachedTransport, type OnboardTransport } from "./attached-transport.js";
import type { OnboardIo } from "./client.js";

/**
 * The first-run check, apart from the onboarding flow in `client.ts`: `tavi
 * chat`, `tavi run` and `tavi serve` ask it at every start, and loading the
 * flow (prompts, sign-ins, imports, the service step) for an install that is
 * already set up slowed every one of them. The flow is loaded only when the
 * offer is made.
 */

/**
 * The first-run line: `tavi chat` and `tavi run` at a terminal, on an install
 * with no model that was never set up, offer `tavi onboard` (at each start
 * while that holds; a no stays a no for that start). `tavi serve` asks
 * nothing: it is not where Tavi is talked to, so it says where setup is and
 * serves. Never under `TAVI_SERVICE=1`, and never for an install that had a
 * model before onboarding existed (`firstRun` is false there).
 */
export async function offerFirstRun(
  dataDirectory: string,
  io: CliIo,
  extras: OnboardIo,
  command: "chat" | "run" | "serve",
): Promise<number | undefined> {
  const env = extras.env ?? process.env;
  if (!io.isTty || env["TAVI_SERVICE"] === "1") return undefined;
  let firstRun = false;
  try {
    firstRun = await withOnboardTransport(
      dataDirectory,
      ["onboarding"],
      async (transport) =>
        (await transport.request<OnboardingStatus>("onboarding", { action: "status", workspaceId: "default", surface: "cli" })).firstRun,
    );
  } catch {
    // The command itself says what is wrong with the directory or the owner.
    return undefined;
  }
  if (!firstRun) return undefined;
  if (command === "serve") {
    io.stdout("No model is set up yet: run `tavi chat` or `tavi ui` (or `tavi onboard`) to set one up.\n");
    return undefined;
  }
  const [{ createLinePrompter }, { ONBOARD_EXIT }, { onboardCliCommand }] = await Promise.all([
    import("./prompter.js"),
    import("./flow.js"),
    import("./client.js"),
  ]);
  const prompter = createLinePrompter({ input: extras.input ?? process.stdin, write: io.stdout });
  let yes: boolean;
  try {
    yes = await prompter.confirm({ label: "No model is set up. Run tavi onboard now (about 2 minutes)?", default: true });
  } catch {
    return ONBOARD_EXIT.cancelled;
  } finally {
    prompter.close();
  }
  if (!yes) return undefined;
  const exit = await onboardCliCommand({ action: "onboard", workspaceId: "default", dataDirectory, format: "text" }, io, extras);
  // Stopped with Ctrl-C: the command that asked does not start after it.
  return exit === ONBOARD_EXIT.cancelled ? exit : undefined;
}

/**
 * `body` over a running owner when one holds the directory, else over the store
 * opened here: the two transports, one choice. The offline transport (the
 * owner's command modules) is loaded only when no owner answers.
 */
export async function withOnboardTransport<T>(
  dataDirectory: string,
  commands: readonly string[],
  body: (transport: OnboardTransport) => Promise<T>,
): Promise<T> {
  const client = await connectLiveOwner(dataDirectory, commands);
  if (client !== undefined) {
    try {
      return await body(attachedTransport(client));
    } finally {
      client.close();
    }
  }
  const { offlineTransport } = await import("./transport.js");
  return await withStorePreservingOwnership(
    dataDirectory,
    async (store) => await body(offlineTransport(store, { dataDirectory, principalOf: ownerWorkspacePrincipal })),
  );
}
