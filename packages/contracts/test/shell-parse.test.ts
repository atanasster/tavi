import { describe, expect, it } from "vitest";

import { parseShellScript, readShellScript, shellParsesAgree, splitShellCommands } from "../src/shell-commands.js";

/** Each simple command's words, quotes removed; `undefined` for a script the grammar does not read. */
const words = (script: string) => {
  const parsed = parseShellScript(script);
  return parsed.ok ? parsed.commands.map((command) => command.words.map((word) => word.text)) : undefined;
};

describe("parseShellScript", () => {
  it("reads lists, pipelines, subshells, groups and [[ … ]] into their simple commands", () => {
    expect(words("ls -la && rm -rf build; echo done | tee log 2>&1 &")).toEqual([
      ["ls", "-la"],
      ["rm", "-rf", "build"],
      ["echo", "done"],
      ["tee", "log"],
    ]);
    expect(words("(cd dir && make) || { echo failed; exit 1; }")).toEqual([["cd", "dir"], ["make"], ["echo", "failed"], ["exit", "1"]]);
    expect(words("! grep -q x f |& wc")).toEqual([["grep", "-q", "x", "f"], ["wc"]]);
    // `&&` inside [[ … ]] is the conditional's own operand.
    expect(words("[[ -f a && -d b ]] && echo yes")).toEqual([
      ["[[", "-f", "a", "&&", "-d", "b", "]]"],
      ["echo", "yes"],
    ]);
    // A brace expansion, find's `{}` and a `}` mid-command are words.
    expect(words("mkdir -p src/{a,b}; find . -exec rm {} +; echo }")).toEqual([
      ["mkdir", "-p", "src/{a,b}"],
      ["find", ".", "-exec", "rm", "{}", "+"],
      ["echo", "}"],
    ]);
  });

  it("lifts command substitutions, quoted or not, as commands of their own", () => {
    expect(words('echo "$(curl x -o y; sh y)" `whoami`')?.sort()).toEqual([
      ["curl", "x", "-o", "y"],
      ["echo", "$SUB", "$SUB"],
      ["sh", "y"],
      ["whoami"],
    ]);
    // A quoted `)` does not end the substitution.
    expect(words(`git log $(echo ")"; rm -rf x)`)?.sort()).toEqual([
      ["echo", ")"],
      ["git", "log", "$SUB"],
      ["rm", "-rf", "x"],
    ]);
    expect(words("echo ${x:-$(uname)} $((1 + $(id -u)))")?.sort()).toEqual([
      ["echo", "${x:-$SUB}", "$((1 + $SUB))"],
      ["id", "-u"],
      ["uname"],
    ]);
  });

  it("reads quoting, continuations and ${…} as /bin/sh does", () => {
    expect(words(String.raw`echo $'\'' ; touch /tmp/x ; echo \'`)).toEqual([
      ["echo", String.raw`\'`],
      ["touch", "/tmp/x"],
      ["echo", "'"],
    ]);
    expect(words("r\\\nm -rf /")).toEqual([["rm", "-rf", "/"]]);
    expect(words("echo \\\\\nsudo ls")).toEqual([
      ["echo", "\\"],
      ["sudo", "ls"],
    ]);
    expect(words("echo ${#}; sudo ls")).toEqual([
      ["echo", "${#}"],
      ["sudo", "ls"],
    ]);
    expect(words("echo 'a;b' \"c && d\" e\\;f # g; h\nls")).toEqual([["echo", "a;b", "c && d", "e;f"], ["ls"]]);
  });

  it("lists every redirection, a group's included, apart from the words", () => {
    const parsed = parseShellScript("FOO=1 cmd a 2>&1 >out <in; { ls; } >>log; npm test &>/dev/null 3<>rw");
    expect(parsed.ok && parsed.redirects.map((each) => `${each.operator}${each.target.raw}`)).toEqual([
      "2>&1",
      ">out",
      "<in",
      ">>log",
      "&>/dev/null",
      "3<>rw",
    ]);
    expect(parsed.ok && parsed.commands[0]).toEqual({
      assignments: [{ raw: "FOO=1", text: "FOO=1" }],
      words: [
        { raw: "cmd", text: "cmd" },
        { raw: "a", text: "a" },
      ],
    });
    // A `>` inside quotes is no redirection.
    expect(parseShellScript("grep 'a>/etc/x' f")).toMatchObject({ ok: true, redirects: [] });
  });

  it("does not read here-documents, control flow, functions or broken syntax", () => {
    for (const script of [
      "cat <<EOF\nhi\nEOF",
      "for x in a; do echo $x; done",
      "if true; then ls; fi",
      "f() { ls; }",
      "echo 'open",
      'echo "open',
      "echo $(ls",
      "echo ${x",
      "ls &&",
      "; ls",
      "ls ;; wc",
      "{ ls }",
      "cat >",
      `echo ${"$(".repeat(40)}x${")".repeat(40)}`,
    ]) {
      expect(parseShellScript(script).ok, script).toBe(false);
    }
  });
});

describe("shellParsesAgree", () => {
  it("agrees with the splitter on ordinary lines", () => {
    for (const script of [
      "git status && git diff --stat",
      "npm test -- --watch=false 2>&1 | tail -50",
      `grep -rn "foo bar" --include='*.ts' .`,
      "find . -name '*.o' -exec rm {} +",
      "sed -i 's/[;&|]/x/g' f && python3 -c 'import sys; print(sys.argv)'",
      "mkdir -p src/{a,b,c} && cp config{,.bak}",
      "{ echo a; echo b; } > out.txt",
      "[[ -f x ]] && echo yes",
      "[[ -f a && -d b ]] && make",
      "[[ $x == y || -z $z ]]",
      "! [[ ( -n a && -n b ) || x < y ]] && ls",
      "echo $(rm -rf x) `whoami`",
      "FOO=1 make -j8 all >build.log 2>&1 || echo failed",
    ]) {
      expect(shellParsesAgree(script, splitShellCommands(script)), script).toBe(true);
    }
  });

  // The splitter's readings before it read `/bin/sh` quoting, each of which hid a command: the grammar finds it.
  it("catches a splitter that loses a command", () => {
    expect(shellParsesAgree("echo ${#}; sudo rm -rf /tmp/x", ["echo $"])).toBe(false);
    const ansi = String.raw`echo $'\'' ; touch /tmp/x ; echo \'`;
    expect(shellParsesAgree(ansi, [ansi])).toBe(false);
    expect(shellParsesAgree("r\\\nm -rf /", ["r\\ m -rf /"])).toBe(false);
    expect(shellParsesAgree("ls; uname", ["ls"])).toBe(false);
    // The same program with other words is another command.
    expect(shellParsesAgree("rm -rf x", ["rm -rf y"])).toBe(false);
    expect(shellParsesAgree("FOO=1 make", ["FOO=2 make"])).toBe(false);
    // A script the grammar cannot read never agrees.
    expect(shellParsesAgree("for x in a; do ls; done", ["for x in a", "do ls", "done"])).toBe(false);
  });

  it("lets a splitter that reads more than the grammar agree: each extra subject still needs a rule", () => {
    expect(shellParsesAgree("[[ a && b ]]", ["[[ a", "b ]]", "[[ a && b ]]"])).toBe(true);
    expect(shellParsesAgree("ls", ["ls", "rm -rf x"])).toBe(true);
  });
});

describe("nesting", () => {
  it("is bounded: ten thousand levels fail closed, never overflow the stack", () => {
    for (const script of [
      `${"(".repeat(10_000)}ls${")".repeat(10_000)}`,
      `${"{ ".repeat(10_000)}ls; ${"} ".repeat(10_000)}`,
      `echo ${'"${x:-'.repeat(10_000)}${'}"'.repeat(10_000)}`,
      `${"$(".repeat(10_000)}ls${")".repeat(10_000)}`,
    ]) {
      expect(parseShellScript(script).ok).toBe(false);
      expect(shellParsesAgree(script, splitShellCommands(script))).toBe(false);
    }
    // The splitter stops reading too deep a substitution: it adds a subject no rule covers.
    expect(readShellScript(`${"$(".repeat(10_000)}ls${")".repeat(10_000)}`).commands.at(-1)).toMatch(/^\u0000unparsed /);
    expect(words(`${"$(".repeat(8)}ls${")".repeat(8)}`)?.length).toBe(9);
  });
});

describe("readShellScript reads braces as /bin/sh does", () => {
  it("groups commands with { and } only where a command starts", () => {
    expect(splitShellCommands("mkdir -p src/{a,b}")).toEqual(["mkdir -p src/{a,b}"]);
    expect(splitShellCommands("find . -name '*.o' -exec rm {} +")).toEqual(["find . -name '*.o' -exec rm {} +"]);
    expect(splitShellCommands("{ ls; wc; } > out")).toEqual(["ls", "wc", "> out"]);
    expect(splitShellCommands("! { ls; }")).toEqual(["!", "ls"]);
    // bash, the macOS /bin/sh, times a group; before anything else `time` is a program's name.
    expect(splitShellCommands("time -p { sudo ls; }")).toEqual(["time -p", "sudo ls"]);
    expect(splitShellCommands("time npm test")).toEqual(["time npm test"]);
    expect(shellParsesAgree("time { sudo ls; }", splitShellCommands("time { sudo ls; }"))).toBe(true);
    expect(readShellScript("echo {a,b}}; uname").commands).toEqual(["echo {a,b}}", "uname"]);
  });
});

describe("readShellScript reads [[ … ]] as one test", () => {
  it("keeps &&, ||, <, > and parentheses inside the test", () => {
    expect(splitShellCommands("[[ a && b ]] && cmd")).toEqual(["[[ a && b ]]", "cmd"]);
    expect(splitShellCommands("[[ $x == y || -z $z ]]")).toEqual(["[[ $x == y || -z $z ]]"]);
    expect(splitShellCommands("([[ ( a < b ) ]]) || ls")).toEqual(["[[ ( a < b ) ]]", "ls"]);
    // Only where a command starts: elsewhere `[[` is a word.
    expect(splitShellCommands("echo [[ a && b ]]")).toEqual(["echo [[ a", "b ]]"]);
  });

  it("still lifts what a test runs, and splits after it", () => {
    expect(splitShellCommands("[[ $(rm -rf ~) ]]")).toEqual(["[[ $SUB ]]", "rm -rf ~"]);
    expect(splitShellCommands("[[ -f x ]] && rm -rf ~")).toEqual(["[[ -f x ]]", "rm -rf ~"]);
    const process = readShellScript("[[ -n <(rm -rf ~) ]]");
    expect(process.commands).toContain("rm -rf ~");
    expect(process.opaque).toContain("uses process substitution");
    expect(words("[[ -n <(uname) ]]")?.sort()).toEqual([["[[", "-n", "<", "$SUB", "]]"], ["uname"]]);
  });

  it("reads a [[ that never closes as a word, and never agrees with the grammar on it", () => {
    for (const script of ["[[ -f a && rm -rf ~", "[[ a ]"]) {
      expect(parseShellScript(script).ok, script).toBe(false);
      expect(shellParsesAgree(script, splitShellCommands(script)), script).toBe(false);
    }
    expect(splitShellCommands("[[ -f a && rm -rf ~")).toEqual(["[[ -f a", "rm -rf ~"]);
    // A `;` ends a test early for the splitter, not for the grammar: the two disagree.
    expect(shellParsesAgree("[[ a ; b ]]", splitShellCommands("[[ a ; b ]]"))).toBe(false);
  });
});
