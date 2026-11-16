import { z } from "zod";

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
export function describeOnboardingDeclaration(onboarding: z.input<typeof PluginOnboardingDeclarationSchema>): string {
  const detail = onboarding.receives?.includes("status-detail") === true;
  return `Onboarding flow: it receives which setup steps are done (${detail ? "with their details: the provider and model names, account labels and rows each step shows" : "never their details"}), what Tavi can do here and the ids of the providers, channels and apps available, nothing of yours. It chooses the steps and their words; Tavi checks the flow and makes every change itself.${onboarding.disclosure === undefined ? "" : ` It says: ${onboarding.disclosure}`}`;
}
