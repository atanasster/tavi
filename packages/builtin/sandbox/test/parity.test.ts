import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { SandboxPolicy, SandboxPort } from "@tavi/contracts";
import { temporaryDirectories } from "@tavi/test-support";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { canApplySeatbeltProfile } from "@tavi/test-support/sandbox";
import { createSandboxHost } from "../src/host.js";
import { createRuntimeSandbox } from "../src/runtime.js";

/**
 * The parity suite: one table of
 * `(attempt, expected)` run on macOS and Linux against the real srt. A row
 * whose platforms differ carries its reason, printed with the run, so a
 * difference is a recorded fact, never a surprise. The escape suite
 * (`escape.test.ts`) holds E1-E19 case by case; this table holds what the two
 * platforms are expected to do alike, and where they are not.
 */

type Outcome = "refused" | "allowed";
interface Row {
  readonly id: string;
  /** A shell line whose exit status is the attempt's: 0 when it got through (then the run prints the open marker). */
  readonly attempt: string;
  /** What the attempt needs on the host to mean anything; the row is skipped without it. */
  readonly needs?: readonly ("python3" | "network" | "curl")[];
  /** The row's own policy, from the table's. */
  readonly policy?: (base: SandboxPolicy) => SandboxPolicy;
  /** Variables the run must not see, set in the owner's environment and inherited (`denyEnv` covers what the caller passes on). */
  readonly denyEnv?: readonly string[];
  readonly darwin: Outcome;
  readonly linux: Outcome;
  /** Required when the platforms differ: why. */
  readonly reason?: string;
}

const SECRET = "TAVI-PARITY-SECRET";
const CONNECT = "import socket; socket.create_connection(('1.1.1.1', 443), timeout=5)";
const OPEN = "TAVI-PARITY-OPEN";
const python3 = spawnSync("python3", ["-c", "1"]).status === 0;
const curl = spawnSync("curl", ["--version"]).status === 0;
/** A plain fetch through the run's proxy (curl reads the proxy variables srt sets). */
const FETCH = (host: string): string => `curl -s -f -m 10 -o /dev/null http://${host}/`;
const granted = (base: SandboxPolicy): SandboxPolicy => ({ ...base, network: { allow: true, allowedHosts: ["example.org"] } });
/** Whether the host itself reaches the network: a refusal inside means something only when it does. */
const online = python3 && spawnSync("python3", ["-c", CONNECT], { timeout: 10_000 }).status === 0;

/** The run's folders, made in `beforeAll` and passed to each attempt as variables. */
const paths = { WORK: "", DENIED: "", OUTSIDE: "", OWNER_TMP: "", CARVED: "" };

const ROWS: readonly Row[] = [
  { id: "read a denied key", attempt: 'cat "$DENIED/id_ed25519"', darwin: "refused", linux: "refused" },
  { id: "write outside the writable root", attempt: 'echo x > "$OUTSIDE/planted"', darwin: "refused", linux: "refused" },
  { id: "write an existing repository's hooks", attempt: 'echo x > "$WORK/.git/hooks/post-checkout"', darwin: "refused", linux: "refused" },
  { id: "write a shell profile at the root", attempt: 'echo x >> "$WORK/.bashrc"', darwin: "refused", linux: "refused" },
  { id: "read the owner's temporary file", attempt: 'cat "$OWNER_TMP/spool"', darwin: "refused", linux: "refused" },
  { id: "reach the network", attempt: `python3 -c "${CONNECT}"`, needs: ["network"], darwin: "refused", linux: "refused" },
  {
    id: "reach a granted host through the run's proxy",
    attempt: FETCH("example.org"),
    needs: ["network", "curl"],
    policy: granted,
    darwin: "allowed",
    linux: "allowed",
  },
  // Refused whether or not the host is online: the proxy answers 403 before any dial.
  {
    id: "reach a host the run is not granted",
    attempt: FETCH("example.com"),
    needs: ["curl"],
    policy: granted,
    darwin: "refused",
    linux: "refused",
  },
  {
    id: "read a variable denied by denyEnv",
    attempt: 'test -n "$TAVI_PARITY_TOKEN"',
    denyEnv: ["TAVI_PARITY_TOKEN"],
    darwin: "refused",
    linux: "refused",
  },
  {
    id: "read a folder allowRead carves out of a denied one",
    attempt: 'cat "$CARVED/readable.txt"',
    policy: (base) => ({ ...base, filesystem: { ...base.filesystem, allowRead: [...base.filesystem.allowRead, paths.CARVED] } }),
    darwin: "allowed",
    linux: "allowed",
  },
  {
    id: "write a denyWrite folder inside the writable root",
    attempt: 'echo x > "$WORK/locked/planted"',
    policy: (base) => ({ ...base, filesystem: { ...base.filesystem, denyWrite: [join(paths.WORK, "locked")] } }),
    darwin: "refused",
    linux: "refused",
  },
  { id: "write its working folder", attempt: 'echo x > "$WORK/notes.txt"', darwin: "allowed", linux: "allowed" },
  {
    id: "make a repository's .git and hooks in a new folder during the run",
    attempt: 'mkdir -p "$WORK/later/repo/.git/hooks" && echo x > "$WORK/later/repo/.git/hooks/post-checkout"',
    darwin: "refused",
    linux: "allowed",
    reason:
      "macOS denies the protected names by pattern wherever they appear, so the new .git itself is refused; Linux denies the literal paths found when the run starts, so a repository made in a new folder during the run is not covered (a known gap)",
  },
  {
    id: "open an AF_UNIX socket",
    attempt: 'python3 -c "import socket; socket.socket(socket.AF_UNIX)"',
    needs: ["python3"],
    darwin: "allowed",
    linux: "refused",
    reason:
      "srt filters AF_UNIX by path on macOS (opening one is allowed, binding or connecting outside allowed paths is not); its Linux seccomp filter refuses every socket(AF_UNIX)",
  },
];

/** Differences no attempt here shows, recorded with their reasons. */
const NOTED = [
  "resource limits are enforced on Linux (cgroups) and advisory on macOS",
  "socket families beyond AF_UNIX are restricted on Linux only, by the service unit's RestrictAddressFamilies=",
  "credentials.files masking is Linux-only; macOS degrades it to a deny",
  "the nested tier changes E3 and E10 by tier, not by platform",
  "a case-folding writable root is refused on Linux and covered by case-blind patterns on macOS",
] as const;

const MODE = process.env["TAVI_SANDBOX_MATRIX"] ?? (process.platform === "darwin" && canApplySeatbeltProfile() ? "srt" : undefined);

describe("the parity table", () => {
  it("gives every difference between the platforms a reason", () => {
    for (const row of ROWS) if (row.darwin !== row.linux) expect(row.reason, row.id).toBeTruthy();
    expect(NOTED.length).toBeGreaterThan(0);
  });
});

describe.skipIf(MODE !== "srt")(`parity on ${process.platform}`, () => {
  const platform = process.platform === "linux" ? "linux" : "darwin";
  let root = "";
  let sandbox: SandboxPort;
  const temp = temporaryDirectories();
  beforeAll(() => {
    root = temp.create("tavi-parity-");
    paths.WORK = join(root, "work");
    paths.DENIED = join(root, "home", ".ssh");
    paths.OUTSIDE = join(root, "outside");
    paths.OWNER_TMP = join(root, "owner-tmp");
    paths.CARVED = join(root, "home", "projects");
    for (const directory of [
      join(paths.WORK, ".git", "hooks"),
      join(paths.WORK, ".tmp"),
      join(paths.WORK, "locked"),
      paths.DENIED,
      paths.OUTSIDE,
      paths.OWNER_TMP,
      paths.CARVED,
    ])
      mkdirSync(directory, { recursive: true });
    writeFileSync(join(paths.CARVED, "readable.txt"), "carved");
    process.env["TAVI_PARITY_TOKEN"] = SECRET;
    writeFileSync(join(paths.DENIED, "id_ed25519"), SECRET);
    writeFileSync(join(paths.OWNER_TMP, "spool"), SECRET);
    writeFileSync(join(paths.WORK, ".bashrc"), "");
    // A network row's proxy keeps its sockets here on Linux: outside every denied folder, short enough for a socket path.
    sandbox = createRuntimeSandbox({ host: createSandboxHost({ dataDirectory: join(root, "probe") }), runtimeDirectory: join(root, "rt") });
    for (const row of ROWS.filter((candidate) => candidate.darwin !== candidate.linux))
      console.info(`parity: ${row.id}: macOS ${row.darwin}, Linux ${row.linux}: ${row.reason ?? ""}`);
    for (const note of NOTED) console.info(`parity (noted): ${note}`);
    if (!online)
      console.info("parity: this host is offline, so the granted-host row is skipped and the ungranted one shows only the proxy's refusal");
  });
  afterAll(async () => {
    delete process.env["TAVI_PARITY_TOKEN"];
    await sandbox.close?.();
    temp.cleanup();
  });

  const policy = (): SandboxPolicy => ({
    filesystem: {
      allowRead: [paths.WORK],
      allowWrite: [paths.WORK],
      denyRead: [join(root, "home"), paths.OWNER_TMP],
      protectedNames: [{ root: paths.WORK, names: [".git", ".git/hooks", ".git/config", ".bashrc"], rootNames: ["HEAD"] }],
    },
    network: { allow: false },
    resources: { timeoutMs: 30_000, maxOutputBytes: 16_384 },
  });

  for (const row of ROWS) {
    const have = { python3, network: online, curl };
    const unmet = (row.needs ?? []).some((need) => !have[need]);
    it.skipIf(unmet)(
      `${row.id}: ${row[platform]}`,
      async () => {
        const result = await sandbox.run(row.policy?.(policy()) ?? policy(), {
          command: "/bin/sh",
          // The marker proves the sandbox started, so a refusal is the sandbox's, never a run that did not happen.
          args: ["-c", `echo TAVI-PARITY-RAN; ${row.attempt} && echo ${OPEN}`],
          cwd: paths.WORK,
          env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin", HOME: join(paths.WORK, ".tmp"), TMPDIR: join(paths.WORK, ".tmp"), ...paths },
          // A denyEnv row inherits the owner's environment, where the variable is set; every other row gets exactly its own.
          ...(row.denyEnv === undefined ? { inheritEnv: false } : { inheritEnv: true, denyEnv: [...row.denyEnv] }),
        });
        expect(result.stdout, result.stderr).toContain("TAVI-PARITY-RAN");
        expect(result.stdout).not.toContain(SECRET);
        // Allowed only when the attempt itself got through; a refusal is the attempt failing inside a sandbox that ran.
        expect(result.stdout.includes(OPEN) ? "allowed" : "refused", `${row.id}: ${result.stderr.slice(0, 300)}`).toBe(row[platform]);
      },
      60_000,
    );
  }
});
