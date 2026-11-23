import { ChannelDescriptorSchema } from "@tavi/contracts";
import { coreEnglish } from "@tavi/contracts/locales/core";
import { coreIn } from "@tavi/contracts/locales/core-server";
import { describe, expect, it } from "vitest";

import { MAILGUN_CHANNEL_DESCRIPTOR, mailgunChannelDescriptor } from "../src/connector.js";

/** The channel's setup words in Bulgarian, for channel setup and Connected apps; everything else as in English. */

const bg = mailgunChannelDescriptor(coreIn("bg"));

/** The descriptor with every text a person reads left out: what runs. */
const behaviour = (value: unknown): unknown =>
  JSON.parse(
    JSON.stringify(value, (key, field: unknown) =>
      ["label", "help", "description", "summary", "says", "setupHelp", "openLabel", "name"].includes(key) ? undefined : field,
    ),
  );

describe("the descriptor in Bulgarian", () => {
  it("is English byte for byte by default", () => {
    expect(mailgunChannelDescriptor()).toEqual(MAILGUN_CHANNEL_DESCRIPTOR);
    expect(mailgunChannelDescriptor(coreEnglish)).toEqual(MAILGUN_CHANNEL_DESCRIPTOR);
  });

  it("says its setup in Bulgarian and changes nothing that runs", () => {
    expect(ChannelDescriptorSchema.safeParse(bg).success).toBe(true);
    expect(bg.description).toMatch(/\p{Script=Cyrillic}/u);
    expect(bg.app?.name).toBe("Имейл (Mailgun)");
    expect(bg.auth.kind === "secrets" ? bg.auth.fields?.map((field) => field.label) : []).toEqual([
      "API ключ",
      "Ключ за подписване на уебхукове",
    ]);
    expect(behaviour(bg)).toEqual(behaviour(MAILGUN_CHANNEL_DESCRIPTOR));
  });
});
