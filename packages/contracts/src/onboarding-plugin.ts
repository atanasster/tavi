import { z } from "zod";

import { coreEnglish, type CoreT } from "./locales/core.js";
import { ONBOARDING_ABI } from "./onboarding.js";

/**
 * A plugin's onboarding flow as its manifest declares it, reviewed before
 * its code runs. A flow only chooses steps and
 * their words: it receives each step's kind and state, the capability census and the ids of
 * the presets, channels and apps available, never memory, chats or values,
 * and the host validates what it answers and owns every write.
 */
export const PluginOnboardingDeclarationSchema = z.strictObject({
  abi: z.literal(ONBOARDING_ABI),
  /** What the person is told at approval about the flow. */
  disclosure: z.string().max(1_000).optional(),
  /**
   * What it asks to receive beyond each step's kind and state: `status-detail`, each step's words as Tavi shows
   * them (a provider and model name, an account label, when it was verified, its rows), reviewed at approval.
   */
  receives: z
    .array(z.enum(["status-detail"]))
    .max(1)
    .optional(),
});
export type PluginOnboardingDeclaration = z.infer<typeof PluginOnboardingDeclarationSchema>;

/** What the person is shown when they review an onboarding flow: what it receives, and that it only chooses steps. */
export function describeOnboardingDeclaration(
  onboarding: z.input<typeof PluginOnboardingDeclarationSchema>,
  t: CoreT = coreEnglish,
): string {
  const details = t(
    onboarding.receives?.includes("status-detail") === true ? "plugin.onboarding.withDetails" : "plugin.onboarding.noDetails",
  );
  return onboarding.disclosure === undefined
    ? t("plugin.onboarding.describe", { details })
    : t("plugin.onboarding.describeSays", { details, disclosure: onboarding.disclosure });
}
