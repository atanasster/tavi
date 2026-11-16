import { sep } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The test files with cases that need POSIX, skipped on Windows, each with
 * why. A file asks through `needsPosix(import.meta.url)`, never its own
 * `process.platform` check, and `tests/posix-only.test.ts` holds the list's
 * length: once the first Windows run has named every file that needs POSIX,
 * it only shrinks, as the Windows work brings each case over.
 */
export const POSIX_ONLY: readonly { readonly file: string; readonly reason: string }[] = [
  { file: "apps/cli/test/mcp/mcp-supervisor.test.ts", reason: "per-server networks run under srt, which has no Windows sandbox yet" },
  { file: "apps/cli/test/cli/client-discovery.test.ts", reason: "the owner's endpoint is a Unix socket" },
  { file: "apps/cli/test/cli/client-node.test.ts", reason: "the owner's endpoint is a Unix socket" },
  { file: "apps/cli/test/folders/fs-tools.test.ts", reason: "a FIFO (mkfifo) has no Windows equivalent" },
  { file: "apps/cli/test/run/acceptance.test.ts", reason: "the owner's endpoint is a Unix socket, and a crash is a POSIX signal" },
  { file: "packages/runtime/test/temporary-files.test.ts", reason: "the staging directory is named by uid and held private by its mode" },
  { file: "packages/runtime/test/memory-upgrade.test.ts", reason: "an unreadable file is made by its mode" },
  {
    file: "packages/client/test/node.test.ts",
    reason: "a cookie's privacy is refused by its mode, and a symlink planted by an ordinary account",
  },
  { file: "packages/builtin/browser/test/playwright.real.test.ts", reason: "a browser's process tree is ended by its process group" },
  { file: "tests/release.test.ts", reason: "the clean install runs npm, which Windows has only as a .cmd shim" },
  { file: "tests/terminal.test.ts", reason: "a pseudo-terminal is driven through script(1)" },
];

/**
 * Whether the test file `module` (its `import.meta.url`) skips its POSIX
 * cases here: on Windows. Throws for a file `POSIX_ONLY` does not list, so
 * every skip is named there with its reason.
 */
export function needsPosix(module: string): boolean {
  // By the end of its path, which is the listed path from the repository's root.
  const file = fileURLToPath(module).split(sep).join("/");
  if (!POSIX_ONLY.some((entry) => file.endsWith(`/${entry.file}`)))
    throw new Error(`${file} is not in POSIX_ONLY: add it there, with its reason`);
  return process.platform === "win32";
}
