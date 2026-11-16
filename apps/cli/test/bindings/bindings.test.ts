import { acquireDataDirectoryOwnership } from "@tavi/runtime";
import { capture, temporaryDirectories } from "@tavi/test-support";
import { afterAll, describe, expect, it } from "vitest";

import { EXIT, main } from "../../src/main.js";

/**
 * `tavi bindings`: the CLI surface for explicit,
 * operator-approved channel-identity bindings.
 */

const directories = temporaryDirectories({ prefix: "tavi-bindings-cli-" });

afterAll(() => directories.cleanup());

describe("tavi bindings", () => {
  it("binds, lists, and unbinds a channel identity", async () => {
    const directory = directories.create();

    const bound = capture();
    const bindCode = await main(
      ["bindings", "bind", "--connection", "telegram-conn", "--sender", "tg-42", "--principal", "alice", "--data-dir", directory],
      { io: bound.io },
    );
    expect(bindCode, bound.stderr()).toBe(EXIT.ok);
    // In text (the default), one line says what was bound; the record itself is --format json's.
    expect(bound.stdout()).toBe("bound tg-42 on telegram-conn to alice\n");

    const listed = capture();
    const listCode = await main(["bindings", "list", "--data-dir", directory], { io: listed.io });
    expect(listCode, listed.stderr()).toBe(EXIT.ok);
    expect(listed.stdout()).toBe("telegram-conn\ttg-42\talice\toperator\t-\n");

    const unbound = capture();
    const unbindCode = await main(["bindings", "unbind", "--connection", "telegram-conn", "--sender", "tg-42", "--data-dir", directory], {
      io: unbound.io,
    });
    expect(unbindCode, unbound.stderr()).toBe(EXIT.ok);

    const afterUnbind = capture();
    await main(["bindings", "list", "--data-dir", directory], { io: afterUnbind.io });
    expect(afterUnbind.stdout()).toBe("(no bindings)\n");
  });

  it("lists a sender id and name with no escape sequence or control character in them", async () => {
    const directory = directories.create();
    const bound = capture();
    const sender = "tg-\u001b]52;c;cGF5bG9hZA==\u0007x";
    expect(
      await main(
        [
          "bindings",
          "bind",
          "--connection",
          "telegram-conn",
          "--sender",
          sender,
          "--principal",
          "alice",
          "--name",
          "A\u001b[2Jli\nce",
          "--data-dir",
          directory,
        ],
        { io: bound.io },
      ),
      bound.stderr(),
    ).toBe(EXIT.ok);
    const listed = capture();
    expect(await main(["bindings", "list", "--data-dir", directory], { io: listed.io })).toBe(EXIT.ok);
    expect(listed.stdout()).toBe("telegram-conn\ttg-x\talice\toperator\tAli ce\n");
  });

  it("names the person with --name, and renames them on a second bind", async () => {
    const directory = directories.create();
    const bind = async (name: string) => {
      const bound = capture();
      const code = await main(
        [
          "bindings",
          "bind",
          "--connection",
          "telegram-conn",
          "--sender",
          "tg-42",
          "--principal",
          "alice",
          "--name",
          name,
          "--format",
          "json",
          "--data-dir",
          directory,
        ],
        { io: bound.io },
      );
      expect(code, bound.stderr()).toBe(EXIT.ok);
      return JSON.parse(bound.stdout()) as { displayName?: string };
    };
    expect(await bind("Alice Smith")).toMatchObject({ displayName: "Alice Smith" });
    expect(await bind("Ali")).toMatchObject({ displayName: "Ali" });
    const listed = capture();
    expect(await main(["bindings", "list", "--data-dir", directory], { io: listed.io })).toBe(EXIT.ok);
    expect(listed.stdout()).toBe("telegram-conn\ttg-42\talice\toperator\tAli\n");
    const blank = capture();
    expect(
      await main(["bindings", "bind", "--connection", "c", "--sender", "s", "--principal", "p", "--name", "  ", "--data-dir", directory], {
        io: blank.io,
      }),
    ).toBe(EXIT.usage);
    const elsewhere = capture();
    expect(
      await main(["bindings", "unbind", "--connection", "c", "--sender", "s", "--name", "x", "--data-dir", directory], {
        io: elsewhere.io,
      }),
    ).toBe(EXIT.usage);
  });

  it("turns the trust-unverified override on and off with --trust-unverified, and leaves it alone without the flag", async () => {
    const directory = directories.create();
    const bind = async (...extra: string[]) => {
      const bound = capture();
      const code = await main(
        [
          "bindings",
          "bind",
          "--connection",
          "mailgun-conn",
          "--sender",
          "alice@example.com",
          "--principal",
          "alice",
          ...extra,
          "--format",
          "json",
          "--data-dir",
          directory,
        ],
        { io: bound.io },
      );
      expect(code, bound.stderr()).toBe(EXIT.ok);
      return JSON.parse(bound.stdout()) as { trustUnverified?: { setBy: string } };
    };
    expect(await bind("--trust-unverified", "yes")).toMatchObject({ trustUnverified: { setBy: "operator" } });
    expect(await bind()).toHaveProperty("trustUnverified");
    const listed = capture();
    expect(await main(["bindings", "list", "--data-dir", directory], { io: listed.io })).toBe(EXIT.ok);
    expect(listed.stdout()).toBe("mailgun-conn\talice@example.com\talice\toperator\t-\ttrusts-unverified\n");
    expect(await bind("--trust-unverified", "no")).not.toHaveProperty("trustUnverified");
    const bad = capture();
    expect(
      await main(
        [
          "bindings",
          "bind",
          "--connection",
          "c",
          "--sender",
          "s",
          "--principal",
          "p",
          "--trust-unverified",
          "maybe",
          "--data-dir",
          directory,
        ],
        { io: bad.io },
      ),
    ).toBe(EXIT.usage);
  });

  it("case-folds an email sender, and leaves other sender ids as given", async () => {
    const directory = directories.create();
    const bind = async (sender: string) => {
      const bound = capture();
      expect(
        await main(
          [
            "bindings",
            "bind",
            "--connection",
            "c",
            "--sender",
            sender,
            "--principal",
            "alice",
            "--format",
            "json",
            "--data-dir",
            directory,
          ],
          { io: bound.io },
        ),
      ).toBe(EXIT.ok);
      return (JSON.parse(bound.stdout()) as { externalSenderId: string }).externalSenderId;
    };
    expect(await bind("Alice@Example.com")).toBe("alice@example.com");
    expect(await bind("CaseKept")).toBe("CaseKept");
    // Unbinding with the capitals it was bound with still unbinds it.
    expect(
      await main(["bindings", "unbind", "--connection", "c", "--sender", "Alice@Example.com", "--data-dir", directory], {
        io: capture().io,
      }),
    ).toBe(EXIT.ok);
    const listed = capture();
    await main(["bindings", "list", "--data-dir", directory], { io: listed.io });
    expect(listed.stdout()).not.toContain("alice@example.com");
  });

  it("unbind is idempotent on an already-unbound pair", async () => {
    const directory = directories.create();
    const first = await main(["bindings", "unbind", "--connection", "conn-x", "--sender", "user-x", "--data-dir", directory], {
      io: capture().io,
    });
    expect(first).toBe(EXIT.ok);
  });

  it("refuses to rebind an already-bound sender to a different principal", async () => {
    const directory = directories.create();
    await main(["bindings", "bind", "--connection", "conn-a", "--sender", "user-1", "--principal", "alice", "--data-dir", directory], {
      io: capture().io,
    });

    const rebind = capture();
    const code = await main(
      ["bindings", "bind", "--connection", "conn-a", "--sender", "user-1", "--principal", "bob", "--data-dir", directory],
      { io: rebind.io },
    );
    expect(code).toBe(EXIT.usage);
    expect(rebind.stderr()).toContain("already bound");
  });

  it("the same principal binds identically across two different connections (same-principal-across-bindings gate)", async () => {
    const directory = directories.create();
    await main(
      ["bindings", "bind", "--connection", "telegram-conn", "--sender", "tg-42", "--principal", "alice", "--data-dir", directory],
      { io: capture().io },
    );
    await main(
      [
        "bindings",
        "bind",
        "--connection",
        "mailgun-conn",
        "--sender",
        "alice@example.com",
        "--principal",
        "alice",
        "--data-dir",
        directory,
      ],
      { io: capture().io },
    );

    const listed = capture();
    await main(["bindings", "list", "--data-dir", directory], { io: listed.io });
    expect(listed.stdout()).toContain("telegram-conn\ttg-42\talice");
    expect(listed.stdout()).toContain("mailgun-conn\talice@example.com\talice");
  });

  it("scopes bindings by workspace", async () => {
    const directory = directories.create();
    await main(
      ["bindings", "bind", "--connection", "c", "--sender", "s", "--principal", "alice", "--workspace", "w1", "--data-dir", directory],
      { io: capture().io },
    );

    const otherWorkspace = capture();
    const code = await main(["bindings", "list", "--workspace", "w2", "--format", "json", "--data-dir", directory], {
      io: otherWorkspace.io,
    });
    expect(code, otherWorkspace.stderr()).toBe(EXIT.ok);
    expect(JSON.parse(otherWorkspace.stdout())).toEqual([]);

    const sameWorkspace = capture();
    await main(["bindings", "list", "--workspace", "w1", "--format", "json", "--data-dir", directory], { io: sameWorkspace.io });
    const rows = JSON.parse(sameWorkspace.stdout()) as { connectionId: string }[];
    expect(rows.map((row) => row.connectionId)).toEqual(["c"]);
  });

  it("refuses bindings commands while an owner holds the data directory", async () => {
    const directory = directories.create();
    const owner = await acquireDataDirectoryOwnership({ dataDirectory: directory, sessionId: "live-owner" });
    try {
      const captured = capture();
      const code = await main(["bindings", "list", "--data-dir", directory], { io: captured.io });
      expect(code).toBe(EXIT.alreadyOwned);
      expect(captured.stderr()).toContain("already owns");
    } finally {
      owner.release();
    }
  });

  it("rejects malformed actions and missing required flags with usage output", async () => {
    const directory = directories.create();
    for (const argv of [
      ["bindings", "frobnicate"],
      ["bindings", "bind"],
      ["bindings", "bind", "--connection", "c"],
      ["bindings", "bind", "--connection", "c", "--sender", "s"],
      ["bindings", "unbind"],
      ["bindings", "list", "--unsupported-flag", "x"],
    ]) {
      const captured = capture();
      const code = await main([...argv, "--data-dir", directory], { io: captured.io });
      expect(code, `${argv.join(" ")} => ${captured.stderr()}`).toBe(EXIT.usage);
    }
  });
});
