import type { AppClientSetupStep } from "@tavi/contracts";
import { coreEnglish, type CoreT } from "@tavi/contracts/locales/core";

/**
 * Tavi's own steps for making a provider's shared OAuth client, by provider: what the connect sheet's
 * *Set up* step shows, each with the console page it opens and the values to type. Google's were
 * walked in the console on 2026-11-08 (a personal Gmail account, no organisation): re-check them
 * before each release, as presets are. The words are `t`'s (English by default); a value to type stays as it is.
 */

/** Tavi's public repository: a true home page and privacy policy for a personal app that is never submitted for verification. */
const REPOSITORY = "https://github.com/atanasster/tavi";

const CONSOLE = "https://console.cloud.google.com";

export interface ClientSetup {
  readonly title: string;
  readonly steps: readonly AppClientSetupStep[];
}

const google = (t: CoreT): ClientSetup => ({
  title: t("app.clientSetup.google.title"),
  steps: [
    {
      text: t("app.clientSetup.google.project"),
      link: { label: t("app.clientSetup.google.project.link"), url: `${CONSOLE}/projectcreate` },
    },
    {
      text: t("app.clientSetup.google.apis"),
      link: {
        label: t("app.clientSetup.google.apis.link"),
        url: `${CONSOLE}/flows/enableapi?apiid=calendar-json.googleapis.com,gmail.googleapis.com`,
      },
    },
    {
      text: t("app.clientSetup.google.signIn"),
      link: { label: t("app.clientSetup.google.signIn.link"), url: `${CONSOLE}/auth/overview/create` },
      values: [{ label: t("app.clientSetup.google.signIn.appName"), value: "Tavi (personal)" }],
    },
    {
      text: t("app.clientSetup.google.branding"),
      link: { label: t("app.clientSetup.google.branding.link"), url: `${CONSOLE}/auth/branding` },
      values: [
        { label: t("app.clientSetup.google.branding.homePage"), value: REPOSITORY },
        { label: t("app.clientSetup.google.branding.privacy"), value: `${REPOSITORY}/blob/main/docs/PRIVACY.md` },
        { label: t("app.clientSetup.google.branding.domain"), value: "github.com" },
      ],
    },
    {
      text: t("app.clientSetup.google.client"),
      link: { label: t("app.clientSetup.google.client.link"), url: `${CONSOLE}/auth/clients/create` },
    },
    {
      text: t("app.clientSetup.google.download"),
    },
  ],
});

const SETUPS: Readonly<Record<string, (t: CoreT) => ClientSetup>> = { google };

/** The steps for `provider`'s shared client, when Tavi has some, in `t`'s words. */
export function clientSetupOf(provider: string, t: CoreT = coreEnglish): ClientSetup | undefined {
  return Object.hasOwn(SETUPS, provider) ? SETUPS[provider]?.(t) : undefined;
}
