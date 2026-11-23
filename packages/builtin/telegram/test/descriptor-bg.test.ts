import { ChannelDescriptorSchema } from "@tavi/contracts";
import { coreEnglish } from "@tavi/contracts/locales/core";
import { coreIn } from "@tavi/contracts/locales/core-server";
import { describe, expect, it } from "vitest";

import { TELEGRAM_CHANNEL_DESCRIPTOR, telegramChannelDescriptor } from "../src/connector.js";

/** The channel's setup words in Bulgarian, for channel setup and Connected apps; everything else as in English. */

const bg = telegramChannelDescriptor(coreIn("bg"));

/** The descriptor with every text a person reads left out: what runs. */
const behaviour = (value: unknown): unknown =>
  JSON.parse(
    JSON.stringify(value, (key, field: unknown) =>
      ["label", "help", "description", "summary", "says", "setupHelp", "openLabel", "name"].includes(key) ? undefined : field,
    ),
  );

describe("the descriptor in Bulgarian", () => {
  it("is English byte for byte by default", () => {
    expect(telegramChannelDescriptor()).toEqual(TELEGRAM_CHANNEL_DESCRIPTOR);
    expect(telegramChannelDescriptor(coreEnglish)).toEqual(TELEGRAM_CHANNEL_DESCRIPTOR);
  });

  it("says its setup in Bulgarian and changes nothing that runs", () => {
    expect(ChannelDescriptorSchema.safeParse(bg).success).toBe(true);
    expect(bg.description).toMatch(/\p{Script=Cyrillic}/u);
    expect(bg.setupHelp).toMatch(/^Създай бот с @BotFather/);
    expect(bg.pairing?.openLabel).toBe("Отвори в Telegram");
    expect(bg.setupLinks?.[0]?.label).toBe("Отвори @BotFather");
    expect(behaviour(bg)).toEqual(behaviour(TELEGRAM_CHANNEL_DESCRIPTOR));
  });
});
