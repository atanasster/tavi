import { execFileSync, type ExecFileSyncOptions } from "node:child_process";

/**
 * Run a child process and, when it fails, rethrow with the captured output.
 *
 * `execFileSync` reports only `Command failed: …` by default, so the reason a
 * packaging gate failed — a registry error, a pack failure, a missing `tar` —
 * would be invisible in the test log.
 *
 * `stdio` is `"pipe"` unless the caller says otherwise; a stdout not piped
 * returns `""`. A run killed — by `timeout`, or for overrunning `maxBuffer` —
 * has no status, and its error names the signal and code instead.
 */
export function run(command: string, args: readonly string[], options: ExecFileSyncOptions & { readonly encoding: "utf8" }): string {
  try {
    return (execFileSync(command, [...args], { stdio: "pipe", ...options }) as string | null) ?? "";
  } catch (error) {
    const failure = error as {
      readonly status?: number | null;
      readonly signal?: string | null;
      readonly code?: string;
      readonly stdout?: string | null;
      readonly stderr?: string | null;
    };
    const how =
      failure.status === null || failure.status === undefined
        ? `signal ${String(failure.signal)}${failure.code === undefined ? "" : `, ${failure.code}`}`
        : `status ${String(failure.status)}`;
    throw new Error(
      `${command} ${args.join(" ")} failed (${how})\n` + `stdout:\n${failure.stdout ?? ""}\nstderr:\n${failure.stderr ?? ""}`,
      { cause: error },
    );
  }
}
