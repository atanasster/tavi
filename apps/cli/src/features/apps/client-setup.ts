import type { AppClientSetupStep } from "@tavi/contracts";

/**
 * Tavi's own steps for making a provider's shared OAuth client, by provider: what the connect sheet's
 * *Set up* step shows, each with the console page it opens and the values to type. Google's were
 * walked in the console on 2026-11-08 (a personal Gmail account, no organisation): re-check them
 * before each release, as presets are.
 */

/** Tavi's public repository: a true home page and privacy policy for a personal app that is never submitted for verification. */
const REPOSITORY = "https://github.com/atanasster/tavi";

const CONSOLE = "https://console.cloud.google.com";

export interface ClientSetup {
  readonly title: string;
  readonly steps: readonly AppClientSetupStep[];
}

const GOOGLE: ClientSetup = {
  title: "Set up Google",
  steps: [
    {
      text: "Create a Google Cloud project of your own, named, for example, tavi.",
      link: { label: "Create a project", url: `${CONSOLE}/projectcreate` },
    },
    {
      text: "Enable the Google Calendar and Gmail APIs in it: choose Next, then Enable.",
      link: { label: "Enable the APIs", url: `${CONSOLE}/flows/enableapi?apiid=calendar-json.googleapis.com,gmail.googleapis.com` },
    },
    {
      text: "Set up sign-in: give the app a name, your email as its support and contact email, choose External, agree to Google's policy, and Create.",
      link: { label: "Set up sign-in", url: `${CONSOLE}/auth/overview/create` },
      values: [{ label: "App name", value: "Tavi (personal)" }],
    },
    {
      text: "On Branding, add a home page, a privacy policy and the authorized domain github.com, and Save. Then on Audience, choose Publish app and Confirm: an app left in Testing signs you out every 7 days.",
      link: { label: "Open Branding", url: `${CONSOLE}/auth/branding` },
      values: [
        { label: "Home page", value: REPOSITORY },
        { label: "Privacy policy", value: `${REPOSITORY}/blob/main/docs/PRIVACY.md` },
        { label: "Authorized domain", value: "github.com" },
      ],
    },
    {
      text: "Create an OAuth client of type Desktop app. No redirect address is needed: a Desktop client comes back to this computer on any port.",
      link: { label: "Create a client", url: `${CONSOLE}/auth/clients/create` },
    },
    {
      text: "In the dialog that shows the new client, choose Download JSON before you close it (Google shows its secret only there), and drop the file here.",
    },
  ],
};

const SETUPS: Readonly<Record<string, ClientSetup>> = { google: GOOGLE };

/** The steps for `provider`'s shared client, when Tavi has some. */
export function clientSetupOf(provider: string): ClientSetup | undefined {
  return SETUPS[provider];
}
