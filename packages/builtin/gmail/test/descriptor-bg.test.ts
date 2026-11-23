import { describeDescriptorInBulgarian } from "@tavi/channel-kit/conformance";
import { expect } from "vitest";

import { GMAIL_CHANNEL_DESCRIPTOR, gmailChannelDescriptor } from "../src/connector.js";

/** The channel's setup words in Bulgarian, for channel setup and Connected apps; everything else as in English. */

describeDescriptorInBulgarian({
  english: GMAIL_CHANNEL_DESCRIPTOR,
  descriptor: gmailChannelDescriptor,
  says: (bg) => {
    expect(bg.settings.map((field) => field.label)).toEqual(["Етикет за четене", "Пиши на Tavi по имейл"]);
    expect(bg.app?.scopes.map((scope) => scope.says)[0]).toBe("Вижда имейл адреса на акаунта ти в Google");
  },
});
