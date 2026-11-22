import { useT } from "../../lib/i18n.js";
import { AppLink } from "../shell/AppLink.js";
import { withParts } from "../../ui/with-parts.js";

/**
 * The channel a pairing was refused for because it isn't running, from the
 * refusal's facts (`notListening`), or `undefined` for any other refusal. The
 * owner's message is the terminal's (it names `tavi channels list` and the
 * connector's raw error), so the canvas says it in its own words.
 */
export function notRunningChannel(refusal: { readonly details?: Readonly<Record<string, unknown>> | undefined }): string | undefined {
  const details = refusal.details;
  return details?.["notListening"] === true && typeof details["label"] === "string" ? details["label"] : undefined;
}

/** Why a code cannot be handed out, and where to fix it: Settings → Channels, which says what went wrong. */
export function ChannelNotRunning({ label }: { readonly label: string }) {
  const t = useT();
  return (
    <>
      {withParts(t("settings.channels.notRunning", { label }), {
        link: (
          <AppLink href="/settings/messaging" onFollow={undefined}>
            {t("settings.channels.notRunningLink")}
          </AppLink>
        ),
      })}
    </>
  );
}
