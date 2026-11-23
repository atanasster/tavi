import { describeDescriptorInBulgarian } from "@tavi/channel-kit/conformance";
import { expect } from "vitest";

import { TELEGRAM_CHANNEL_DESCRIPTOR, telegramChannelDescriptor } from "../src/connector.js";

/** The channel's setup words in Bulgarian, for channel setup and Connected apps; everything else as in English. */

describeDescriptorInBulgarian({
  english: TELEGRAM_CHANNEL_DESCRIPTOR,
  descriptor: telegramChannelDescriptor,
  says: (bg) => {
    expect(bg.setupHelp).toMatch(/^Създай бот с @BotFather/);
    expect(bg.pairing?.openLabel).toBe("Отвори в Telegram");
    expect(bg.setupLinks?.[0]?.label).toBe("Отвори @BotFather");
  },
});
