import { mkdirSync, realpathSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { temporaryDirectories } from "@tavi/test-support";

import { guardCheck } from "../src/index.js";
import { check, next } from "./support/check.js";

/** `tavi.guard`'s hook. */

describe("guardCheck", () => {
  it.each([
    [
      { command: "rm", args: ["-rf", "/tmp/tavi-guard-missing/build"] },
      "deletes files and folders recursively: /tmp/tavi-guard-missing/build",
    ],
    [{ command: "git reset --hard HEAD~1" }, "discards uncommitted work"],
    [{ command: "git", args: ["clean", "-fdx"] }, "deletes untracked files"],
    [{ command: "psql -c 'x'; psql -c x && DROP TABLE users" }, "drops database objects"],
    [{ command: "dd if=/dev/zero of=/dev/disk2" }, "overwrites a file or device: /dev/disk2"],
    [
      { command: "sh", args: ["-c", "rm -rf build"], cwd: "/tmp/tavi-guard-cwd" },
      "deletes files and folders recursively: /tmp/tavi-guard-cwd/build",
    ],
    [{ command: "sh -c \"psql -c 'DROP TABLE users'\"" }, "drops database objects"],
    [
      { command: "rm -rf node_modules; git push --dry-run", cwd: "/tmp/tavi-guard-cwd" },
      "deletes files and folders recursively: /tmp/tavi-guard-cwd/node_modules",
    ],
    [{ command: "rm -Rf dist" }, "deletes files and folders recursively"],
    [{ command: "/bin/rm -r -f dist" }, "deletes files and folders recursively"],
    [{ command: "git clean -d -f" }, "deletes untracked files"],
    [{ command: "cd /tmp/tavi-guard-elsewhere && rm -rf x" }, "deletes files and folders recursively: /tmp/tavi-guard-elsewhere/x"],
    // Evasions it still catches: a substitution inside an echo, a newline, a backslash or empty quotes, `&`.
    [{ command: "sh", args: ["-c", "echo $(rm -rf build)"] }, "deletes files and folders recursively"],
    [{ command: "sh", args: ["-c", "echo `rm -rf build`"] }, "deletes files and folders recursively"],
    [{ command: "sh", args: ["-c", "true; echo x\nrm -rf build"] }, "deletes files and folders recursively"],
    [{ command: "\\rm -rf build" }, "deletes files and folders recursively"],
    [{ command: "r''m -rf build" }, "deletes files and folders recursively"],
    [{ command: "sleep 1 & rm -rf build" }, "deletes files and folders recursively"],
    [{ command: "find /tmp/tavi-guard-find -name '*.log' -delete" }, "deletes the files it finds: /tmp/tavi-guard-find"],
    [{ command: "truncate -s 0 /tmp/tavi-guard-notes.md" }, "cuts files short: /tmp/tavi-guard-notes.md"],
    [{ command: "echo hi > /tmp/tavi-guard-notes.md" }, "overwrites a file: /tmp/tavi-guard-notes.md"],
    // More evasions it still catches.
    [{ command: "find . -exec rm -rf {} \\;" }, "deletes files and folders recursively"],
    [{ command: "find /tmp/tavi-guard-find \\( -name a -o -name b \\) -delete" }, "deletes the files it finds: /tmp/tavi-guard-find"],
    [{ command: "(rm -rf build)" }, "deletes files and folders recursively"],
    [{ command: "rm \\\n -rf build" }, "deletes files and folders recursively"],
    [{ command: "echo hi>/tmp/tavi-guard-a.md" }, "overwrites a file: /tmp/tavi-guard-a.md"],
    [{ command: "make &> /tmp/tavi-guard-log" }, "overwrites a file: /tmp/tavi-guard-log"],
    [{ command: "echo x >| /tmp/tavi-guard-b" }, "overwrites a file: /tmp/tavi-guard-b"],
    [{ command: "make >/dev/null 2>/tmp/tavi-guard-err.log" }, "overwrites a file: /tmp/tavi-guard-err.log"],
    // A `--dry-run` only stops a command that has one: BSD rm reads it as a file once an operand is given.
    [{ command: "rm -rf build --dry-run" }, "deletes files and folders recursively"],
    [{ command: "find . -delete --dry-run" }, "deletes the files it finds"],
    [{ command: "chmod -R 777 x -n" }, "opens every file to everyone"],
    [{ command: "git reset --hard --dry-run" }, "discards uncommitted work"],
    // git's subcommand stands after its global options.
    [{ command: "git -C /tmp/tavi-guard-repo reset --hard" }, "discards uncommitted work"],
    [{ command: "git -c core.x=y clean -fdx" }, "deletes untracked files"],
    [{ command: "git --git-dir=.git reset --hard" }, "discards uncommitted work"],
    [{ command: "git --git-dir .git --work-tree . reset --hard" }, "discards uncommitted work"],
    [{ command: "git --no-pager -C /tmp/tavi-guard-repo clean -f out" }, "deletes untracked files: /tmp/tavi-guard-repo/out"],
    [{ command: "chmod --recursive 777 /tmp/tavi-guard-open" }, "opens every file to everyone: /tmp/tavi-guard-open"],
    // The commands after a heredoc's delimiter line are still judged; a body a shell runs is commands.
    [{ command: "cat <<EOF > /dev/null\nhello\nEOF\nrm -rf build" }, "deletes files and folders recursively"],
    [{ command: "cat <<-EOF\n\thello\n\tEOF\nrm -rf build" }, "deletes files and folders recursively"],
    [{ command: "cat <<'A' <<\"B\"\none\nA\ntwo\nB\ngit reset --hard" }, "discards uncommitted work"],
    [{ command: "cat <<EOF\nhello\nEOF\necho x > /tmp/tavi-guard-after.md" }, "overwrites a file: /tmp/tavi-guard-after.md"],
    [{ command: "bash <<EOF\nrm -rf build\nEOF" }, "deletes files and folders recursively"],
    [{ command: "cat <<EOF | sh\nrm -rf build\nEOF" }, "deletes files and folders recursively"],
    // In the form the sandbox runs a script in: a comment or an escape opens no heredoc.
    [{ command: "sh", args: ["-c", "true\ncat x # <<EOF\nrm -rf build\nEOF"] }, "deletes files and folders recursively"],
    [{ command: "sh", args: ["-c", "true\ncat \\<<EOF\nrm -rf build\nEOF"] }, "deletes files and folders recursively"],
    // A quoted target is still a target, and quotes never pair across words.
    [{ command: "sh", args: ["-c", 'echo hi > "notes.md"'] }, "overwrites a file"],
    [{ command: "sh", args: ["-c", "echo hi > 'notes.md'"] }, "overwrites a file"],
    [{ command: "sh", args: ["-c", 'echo hi > "$HOME/.bashrc"'] }, "overwrites a file"],
    [{ command: "env", args: ["X='", "sh", "-c", "echo x > notes.md", "'"] }, "overwrites a file"],
    // A comment after what cuts a command, a quoted target touching its `>`, and one with a space.
    [{ command: "sh", args: ["-c", "true ;#<<EOF\necho x > important.txt\nEOF"] }, "overwrites a file"],
    [{ command: "sh", args: ["-c", 'echo "key=">config.txt'] }, "overwrites a file"],
    [
      { command: "sh", args: ["-c", 'echo hi > "/tmp/tavi-guard-missing/my notes.md"'] },
      "overwrites a file: /tmp/tavi-guard-missing/my notes.md",
    ],
    [{ command: "sh", args: ["-c", "true\nif find . -delete; then echo; fi"] }, "deletes the files it finds"],
    [{ command: "sh", args: ["-c", "flock /tmp/l find . -delete"] }, "deletes the files it finds"],
    [{ command: "sh", args: ["-c", "chroot /mnt find . -delete"] }, "deletes the files it finds"],
    [{ command: "bash", args: ["-lc", "truncate -s 0 notes.md"] }, "cuts files short"],
    // find -delete and truncate wherever a command starts.
    ...[
      "if true; then find . -delete; fi",
      "for f in a; do truncate -s 0 $f; done",
      "{ find . -delete; }",
      "! find . -delete",
      "FOO=1 find . -delete",
      "timeout 5 find . -delete",
      "nice -n 5 find . -delete",
      "sudo -u root find . -delete",
      "cat <(find . -delete)",
    ].map((script): [{ command: string; args: string[] }, string] => [
      { command: "sh", args: ["-c", script] },
      script.includes("truncate") ? "cuts files short" : "deletes the files it finds",
    ]),
    // A body a program reads may run what it holds: only text readers' bodies pass.
    [{ command: "psql <<EOF\nDROP TABLE users;\nEOF" }, "drops database objects"],
    [{ command: "python3 - <<EOF\nimport os\nos.system('rm -rf build')\nEOF" }, "deletes files and folders recursively"],
    [{ command: "sudo -s <<EOF\nrm -rf build\nEOF" }, "deletes files and folders recursively"],
    [{ command: "tcsh <<EOF\nrm -rf build\nEOF" }, "deletes files and folders recursively"],
    // git's other valued global options, and a pattern that looks like a flag.
    [{ command: "git --attr-source HEAD reset --hard" }, "discards uncommitted work"],
    [{ command: "git --config-env core.x=Y clean -fd" }, "deletes untracked files"],
    [{ command: "git clean -fd -e -node" }, "deletes untracked files"],
    [{ command: "git clean -fd -- -n" }, "deletes untracked files"],
    [{ command: "cat <<EOF\nrm -rf build" }, "deletes files and folders recursively"],
    [{ command: "cat <<< x\nrm -rf build\nx" }, "deletes files and folders recursively"],
    [{ command: "echo $((1<<2))\nrm -rf build\n2" }, "deletes files and folders recursively"],
  ])("asks about %j, saying what it does", async (input, does) => {
    const answer = await guardCheck(check(input), next);
    expect(answer.decision).toBe("ask");
    expect(answer.reason).toContain(does);
  });

  it.each([
    [{ command: 'echo "rm -rf /"' }],
    [{ command: "printf 'git reset --hard'" }],
    [{ command: "ls -la" }],
    [{ command: "rm build/out.txt" }],
    [{ command: "git push --dry-run" }],
    [{ command: "ls git" }],
    [{ command: "echo hi >> notes.md" }],
    [{ command: "make 2>&1" }],
    [{ command: "ls > /dev/null" }],
    [{ command: "find . -name '*.ts'" }],
    [{ command: "rg -n truncate src" }],
    [{ command: "git commit -m 'speed up > 2x'" }],
    [{ command: "awk '$3 > 100' data.txt" }],
    [{ command: "python3 - <<EOF\nif x > 0:\n    print(x)\nEOF" }],
    [{ command: "node -e 'const f = (a) => a'" }],
    [{ command: "git clean -n -fdx" }],
    [{ command: "git clean -fdxn" }],
    [{ command: "git clean --dry-run -f" }],
    [{ command: "git -C /tmp/tavi-guard-repo clean --dry-run --force" }],
    [{ command: "git -C reset status" }],
    [{ command: "git -c alias.reset=x log --hard" }],
    [{ command: "chmod --recursive 755 x" }],
    [{ command: "cat <<EOF\nrm -rf /\nEOF" }],
    [{ command: "cat <<-EOF\n\trm -rf /\n\tEOF" }],
    [{ command: "cat <<'EOF' > /dev/null\ngit reset --hard\nEOF\nls" }],
    [{ command: 'cat <<"EOF"\necho x > notes.md\nEOF' }],
  ])("leaves %j to the gate", async (input) => {
    expect(await guardCheck(check(input), next)).toEqual({ decision: "ask" });
  });

  it("names a path as the command reaches it, through a symlink", async () => {
    const root = dirs.create("tavi-guard-link-");
    mkdirSync(join(root, "real"));
    symlinkSync(join(root, "real"), join(root, "link"));
    const answer = await guardCheck(check({ command: "rm -rf link", cwd: root }), next);
    expect(answer.reason).toContain(realpathSync(join(root, "real")));
  });

  it("reads a command's paths from the chat's working folder, as sandbox.run runs it, and names them relative to it", async () => {
    expect((await guardCheck(check({ command: "rm -rf build" }), next)).reason).toBe(
      "This command deletes files and folders recursively: build.",
    );
    expect((await guardCheck(check({ command: "rm -rf build", cwd: "src" }), next)).reason).toContain(": src/build.");
    expect((await guardCheck(check({ command: "cd src/app && rm -rf ../build" }), next)).reason).toContain(": src/build.");
    expect((await guardCheck(check({ command: "rm -rf build", cwd: "/tmp/tavi-guard-cwd" }), next)).reason).toContain(
      "/tmp/tavi-guard-cwd/build",
    );
  });

  it("never resolves a relative path against this process's own folder", async () => {
    const answer = await guardCheck(check({ command: "rm -rf node_modules" }), next);
    expect(answer.reason).toContain(": node_modules.");
    expect(answer.reason).not.toContain(process.cwd());
  });

  it("refuses where nobody can answer an ask", async () => {
    const answer = await guardCheck(check({ command: "rm -rf build" }, { attended: false, source: "schedule" }), next);
    expect(answer.decision).toBe("deny");
    expect(answer.reason).toContain("Nobody can approve it in this run");
  });
});

const dirs = temporaryDirectories();
afterEach(() => dirs.cleanup());
