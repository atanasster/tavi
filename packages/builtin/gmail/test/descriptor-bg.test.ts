import { ChannelDescriptorSchema } from "@tavi/contracts";
import { coreEnglish } from "@tavi/contracts/locales/core";
import { coreIn } from "@tavi/contracts/locales/core-server";
import { describe, expect, it } from "vitest";

import { GMAIL_CHANNEL_DESCRIPTOR, gmailChannelDescriptor } from "../src/connector.js";

/** The channel's setup words in Bulgarian, for channel setup and Connected apps; everything else as in English. */

const bg = gmailChannelDescriptor(coreIn("bg"));

/** The descriptor with every text a person reads left out: what runs. */
const behaviour = (value: unknown): unknown =>
  JSON.parse(
    JSON.stringify(value, (key, field: unknown) =>
      ["label", "help", "description", "summary", "says", "setupHelp", "openLabel", "name"].includes(key) ? undefined : field,
    ),
  );

describe("the descriptor in Bulgarian", () => {
  it("is English byte for byte by default", () => {
    expect(gmailChannelDescriptor()).toEqual(GMAIL_CHANNEL_DESCRIPTOR);
    expect(gmailChannelDescriptor(coreEnglish)).toEqual(GMAIL_CHANNEL_DESCRIPTOR);
  });

  it("says its setup in Bulgarian and changes nothing that runs", () => {
    expect(ChannelDescriptorSchema.safeParse(bg).success).toBe(true);
    expect(bg.description).toMatch(/\p{Script=Cyrillic}/u);
    expect(bg.settings.map((field) => field.label)).toEqual(["Етикет за четене", "Пиши на Tavi по имейл"]);
    expect(bg.app?.scopes.map((scope) => scope.says)[0]).toBe("Вижда имейл адреса на акаунта ти в Google");
    expect(behaviour(bg)).toEqual(behaviour(GMAIL_CHANNEL_DESCRIPTOR));
  });
});
