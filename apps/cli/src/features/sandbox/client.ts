import { jsonText } from "../../cli/output.js";
import { EXIT } from "../../cli/exit.js";
import { createOwnerSandboxHost } from "./host.js";
import { sandboxDoctorSection, sandboxSectionText, setupPlan } from "./setup.js";
import { execFileSync, spawnSync } from "node:child_process";
import { resolve } from "node:path";
import type { SandboxCommandOptions } from "./parse.js";
import type { CliIo } from "../../cli/io.js";
import type { ResolvedDataDirectory } from "../../cli/store.js";

/**
 * `tavi sandbox check|setup`. `check` runs
 * the live probe offline, as `doctor` does; `setup` prints the root block this
 * host needs and runs it with sudo only under `--apply`, after showing it.
 */
export async function sandboxCommand(options: ResolvedDataDirectory<SandboxCommandOptions>, io: CliIo): Promise<number> {
  // One host port answers both the probe and the facts it is read against.
  const host = createOwnerSandboxHost({ dataDirectory: resolve(options.dataDirectory) }, options.nested === true ? { nested: true } : {});
  const facts = await host.facts();
  if (options.action === "check") {
    const status = await host.check();
    const section = sandboxDoctorSection(status, facts);
    io.stdout(options.format === "json" ? jsonText(section) : sandboxSectionText(section));
    return status.tier === "full" || status.tier === "nested" ? EXIT.ok : EXIT.unavailable;
  }
  // The service's group must run the copy: tavi's when that group exists, else the group of whoever ran sudo, else ours.
  const group =
    options.group ??
    (() => {
      const read = (args: readonly string[]): string | undefined => {
        try {
          return (
            execFileSync(args[0] as string, args.slice(1), { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || undefined
          );
        } catch {
          return undefined;
        }
      };
      if (read(["getent", "group", "tavi"]) !== undefined) return "tavi";
      const sudoUser = process.env["SUDO_USER"];
      return (sudoUser === undefined || sudoUser === "" ? undefined : read(["id", "-gn", sudoUser])) ?? read(["id", "-gn"]) ?? "tavi";
    })();
  const plan = setupPlan(facts, {
    group,
    ...(options.remove === true ? { remove: true } : {}),
    ...(options.copy === true ? { copy: true } : {}),
    ...(options.refreshHook === true ? { refreshHook: true } : {}),
  });
  // Only a block that makes the copy gives it a group.
  if (plan.copies === true) io.stderr(`The copy's group is ${group}: the account serve runs as must be in it (--group names another).\n`);
  io.stdout(`${plan.steps.map((step) => `- ${step}`).join("\n")}\n`);
  if (!plan.needed) return EXIT.ok;
  io.stdout(`\nThe block, run as root:\n\n${plan.script}\n`);
  if (options.apply !== true) {
    io.stderr("\nNothing was run. Review the block, then: tavi sandbox setup --apply (it asks sudo for your password)\n");
    return EXIT.ok;
  }
  const ran = spawnSync("sudo", ["sh", "-c", plan.script], { stdio: "inherit" });
  if (ran.status !== 0) {
    io.stderr(`\nsetup failed (exit ${String(ran.status ?? ran.signal)}); nothing after the failing line ran\n`);
    return EXIT.unavailable;
  }
  io.stderr("\nDone. tavi sandbox check shows the tier now.\n");
  return EXIT.ok;
}
