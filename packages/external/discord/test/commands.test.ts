import { describe, expect, it } from "vitest";

import { ROOM_DROP_REASONS, type MessagingIngestReceipt } from "@tavi/contracts";

import { commandAnswer, discordCommands, shapeOf } from "../src/commands.js";

/** The commands' Bulgarian words, and the private answers in the workspace's language. */

interface Command {
  readonly name: string;
  readonly type?: number;
  readonly description?: string;
  readonly name_localizations?: Readonly<Record<string, string>>;
  readonly description_localizations?: Readonly<Record<string, string>>;
  readonly options?: readonly Command[];
}

const everyCommand = (commands: readonly Command[]): Command[] =>
  commands.flatMap((command) => [command, ...everyCommand(command.options ?? [])]);

describe("command payload", () => {
  const all = everyCommand(discordCommands as readonly Command[]);

  it("gives every slash command and option a Bulgarian description within Discord's limits", () => {
    const described = all.filter((command) => command.description !== undefined);
    expect(described.map((command) => command.name)).toEqual(["tavi", "ask", "question", "new"]);
    for (const command of described) {
      const bg = command.description_localizations?.["bg"];
      expect(bg, command.name).toBeDefined();
      expect(bg?.length).toBeGreaterThan(0);
      expect(bg?.length).toBeLessThanOrEqual(100);
      expect(bg).not.toBe(command.description);
      // Slash names stay lowercase and unlocalized: `/tavi ask` in every language.
      expect(command.name).toMatch(/^[a-z]{1,32}$/);
      expect(command.name_localizations).toBeUndefined();
    }
  });

  it("names the message menu in Bulgarian within Discord's limits", () => {
    const menu = (discordCommands as readonly Command[]).find((command) => command.type === 3);
    expect(menu?.name).toBe("Ask Tavi about this");
    expect(menu?.name_localizations).toEqual({ bg: "Попитай Tavi за това" });
    expect(Array.from(menu?.name_localizations?.["bg"] ?? "").length).toBeLessThanOrEqual(32);
  });
});

describe("shapeOf", () => {
  const command = {
    name: "tavi",
    type: 1,
    description: "Ask Tavi",
    description_localizations: { bg: "Попитай Tavi" },
    options: [{ type: 1, name: "new", description: "New", description_localizations: { bg: "Нов" } }],
  };
  const same = (a: unknown, b: unknown): boolean => JSON.stringify(shapeOf(a)) === JSON.stringify(shapeOf(b));

  it("changes when a localization changes, is added or goes", () => {
    expect(same(command, { ...command, description_localizations: { bg: "Друго" } })).toBe(false);
    expect(same(command, { ...command, description_localizations: { bg: "Попитай Tavi", de: "Frag" } })).toBe(false);
    expect(same(command, { ...command, description_localizations: undefined })).toBe(false);
    expect(same(command, { ...command, options: [{ ...command.options[0], description_localizations: { bg: "Друг" } }] })).toBe(false);
    const menu = { name: "Ask Tavi about this", type: 3, name_localizations: { bg: "Попитай Tavi за това" } };
    expect(same(menu, { ...menu, name_localizations: { bg: "Питай Tavi" } })).toBe(false);
  });

  it("stays the same for an unchanged one, as Discord answers it", () => {
    // Discord's answer: ids, versions, and `null` for a map it has none of.
    expect(
      same(command, {
        ...command,
        id: "750000000000000001",
        version: "2",
        name_localizations: null,
        options: [{ ...command.options[0], name_localizations: null }],
      }),
    ).toBe(true);
    expect(
      same(
        { ...command, description_localizations: { de: "Frag", bg: "Б" } },
        { ...command, description_localizations: { bg: "Б", de: "Frag" } },
      ),
    ).toBe(true);
    for (const registered of discordCommands) expect(same(registered, JSON.parse(JSON.stringify(registered)))).toBe(true);
  });
});

describe("commandAnswer", () => {
  const receipts: readonly (MessagingIngestReceipt | undefined)[] = [
    undefined,
    { accepted: true, duplicate: false },
    { accepted: true, duplicate: false, resolvedPrincipalId: "operator" },
    ...ROOM_DROP_REASONS.map((dropped) => ({ accepted: true, duplicate: false, dropped })),
  ];

  it("answers in English, byte for byte, for English, an unknown locale or none", () => {
    const english = receipts.map((receipt) => commandAnswer(receipt));
    expect(english.slice(0, 3)).toEqual([
      "Tavi could not take that just now: try again.",
      "Tavi doesn't know you yet: ask its owner to allow you.",
      "Got it: Tavi answers in this chat.",
    ]);
    expect(commandAnswer({ accepted: true, duplicate: false, dropped: "unbound" })).toBe(
      "Tavi answers only people its owner allowed here.",
    );
    for (const locale of ["en", "en-GB", "de", ""]) expect(receipts.map((receipt) => commandAnswer(receipt, locale))).toEqual(english);
  });

  it("answers in Bulgarian for a Bulgarian workspace", () => {
    const english = receipts.map((receipt) => commandAnswer(receipt));
    const bulgarian = receipts.map((receipt) => commandAnswer(receipt, "bg"));
    expect(bulgarian.slice(0, 3)).toEqual([
      "Tavi не успя да приеме това. Опитай пак.",
      "Tavi още не те познава. Помоли собственика на Tavi да ти даде достъп.",
      "Прието. Tavi ще отговори в този чат.",
    ]);
    bulgarian.forEach((answer, index) => {
      expect(answer).not.toBe(english[index]);
      expect(answer).toMatch(/[а-я]/);
    });
    expect(receipts.map((receipt) => commandAnswer(receipt, "bg-BG"))).toEqual(bulgarian);
  });
});
