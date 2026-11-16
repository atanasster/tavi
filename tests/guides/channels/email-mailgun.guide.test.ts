import { expect } from "vitest";

import { allowPerson, allowYourAddress, connection, opened, optionalAccount } from "../support/rooms.js";
import { dismissChecklist } from "../support/steps.js";
import { account, secretPath } from "../support/user.js";
import { walkGuide } from "../support/walk.js";

const GUIDE = "channels/email-mailgun";
/** The listener's port, as the page gives it: fixed, so the pictures do not change from run to run. */
const PORT = 48734;
/** The https address in front of this computer, when the person has one for the walk: inbound mail needs it. */
const publicUrl = optionalAccount("mailgunPublicUrl");
const NO_PUBLIC_URL = "mail coming in: Mailgun's route needs an https address that reaches this computer (mailgunPublicUrl)";

let connectionId = "";

walkGuide(GUIDE, {
  configured: true,
  model: true,
  steps: {
    "add-the-mailgun-connection": async (walk) => {
      walk.needsUser("mailgun");
      const screen = await walk.terminal({
        title: "tavi channels add",
        args: [
          ...["channels", "add", "mailgun", "--domain", account("mailgunDomain")],
          ...["--secret-file", `apiKey=${secretPath("mailgun-api.key")}`],
          ...["--secret-file", `webhookSigningKey=${secretPath("mailgun-webhook-signing.key")}`],
        ],
      });
      await opened(walk, "mailgun");
      connectionId = connection(walk, "mailgun").connectionId;
      expect(screen.join("\n")).toContain(connectionId);
    },
    "set-up-the-webhook-listener": async (walk) => {
      if (publicUrl === undefined) walk.unwalked(`the public address: ${NO_PUBLIC_URL}; the listener's port alone is set`);
      const screen = await walk.terminal({
        title: "tavi channels ingress",
        args: ["channels", "ingress", "--port", String(PORT), ...(publicUrl === undefined ? [] : ["--public-url", publicUrl])],
      });
      expect(screen.join("\n")).toContain("saved");
    },
    "route-your-mail-to-tavi": async (walk) => {
      const page = await walk.open("/settings/messaging");
      await dismissChecklist(page);
      // The row names the connection by its address, not its id (step 1 printed that).
      await page
        .locator("li.row", { hasText: connection(walk, "mailgun").accountIdentity })
        .first()
        .waitFor();
      await walk.shot();
    },
    "allow-your-own-address": async (walk) => {
      const { form } = await allowYourAddress(walk, "Email", account("emailSender"));
      await walk.shot(form);
      await allowPerson(walk, form, connectionId);
    },
    "send-yourself-a-test": async (walk) => {
      const screen = await walk.terminal({
        title: "tavi channels test",
        args: ["channels", "test", connectionId, "--to", account("emailSender")],
      });
      expect(screen.join("\n")).toContain("accepted");
    },
  },
});
