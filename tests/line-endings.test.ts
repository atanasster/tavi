import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Text is LF in the repository and in every checkout (`.gitattributes`): a
 * Windows clone with `core.autocrlf` would otherwise turn the dependency
 * patches and shell scripts into CRLF, and `pnpm install` could not apply the
 * patches nor bash run the scripts.
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const git = (args: readonly string[]): string => execFileSync("git", args, { cwd: root, encoding: "utf8" });

describe("line endings", () => {
  it("keeps every tracked text file LF in the index", () => {
    const crlf = git(["ls-files", "--eol"])
      .split("\n")
      .filter((line) => /^i\/(crlf|mixed)\s/.test(line))
      .map((line) => line.split("\t").at(-1));
    expect(crlf).toEqual([]);
  });

  it("checks every text file out LF whatever core.autocrlf says, the patches and shell scripts among them", () => {
    const lines = git(["ls-files", "--eol"])
      .split("\n")
      .filter((line) => line !== "");
    const notLf = lines.filter((line) => !line.startsWith("i/-text") && !/\battr\/[^\t]*\beol=lf\b/.test(line));
    expect(notLf).toEqual([]);
    const paths = lines.map((line) => line.split("\t").at(-1) ?? "");
    expect(paths).toEqual(expect.arrayContaining(["patches/@cantoo__pdf-lib@2.11.1.patch", "scripts/sandbox-matrix.sh"]));
  });
});
