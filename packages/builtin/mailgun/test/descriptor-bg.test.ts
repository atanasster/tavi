import { describeDescriptorInBulgarian } from "@tavi/channel-kit/conformance";
import { expect } from "vitest";

import { MAILGUN_CHANNEL_DESCRIPTOR, mailgunChannelDescriptor } from "../src/connector.js";

/** The channel's setup words in Bulgarian, for channel setup and Connected apps; everything else as in English. */

describeDescriptorInBulgarian({
  english: MAILGUN_CHANNEL_DESCRIPTOR,
  descriptor: mailgunChannelDescriptor,
  says: (bg) => {
    expect(bg.app?.name).toBe("Имейл (Mailgun)");
    expect(bg.auth.kind === "secrets" ? bg.auth.fields?.map((field) => field.label) : []).toEqual([
      "API ключ",
      "Ключ за подписване на уебхукове",
    ]);
  },
});
