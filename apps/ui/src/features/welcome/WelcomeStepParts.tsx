import { useEffect, useRef, type ReactNode } from "react";

import type { OnboardingFlowStep, OnboardingStatus, PluginUiPlacement } from "@tavi/contracts";

import type { SettingsClient } from "../../lib/ipc.js";
import type { PluginFrameClient } from "../plugin-host/PluginFrame.js";
import type { ResolvedContribution } from "../plugin-host/slots.js";
import type { SettingsView } from "../shell/route.js";

export interface WelcomeProps {
  readonly client: SettingsClient;
  readonly workspaceId: string;
  /** The step the address names; absent, the first open one. */
  readonly stepId?: string | undefined;
  /** `?all=1`: start at the first step rather than the first still to do (the canvas's `tavi setup`). */
  readonly all?: boolean;
  /** Go to a step; `replace` names the step the page opened on without adding a Back entry. */
  readonly onStep: (stepId: string | undefined, options?: { readonly replace?: boolean }) => void;
  /** Leave for Home: Do this later, Don't show again, or done. */
  readonly onLeave: () => void;
  readonly onSettings: (view: SettingsView) => void;
  /** The model changed: the shell reads its target again. */
  readonly onModelsChanged?: () => void;
  /** The browser's own time zone, for the about step (a test passes one). */
  readonly browserTimeZone?: string;
  /** Where Sign in with OpenRouter comes back to (this page's origin; a test passes one). */
  readonly origin?: string;
  /** Opens OpenRouter's address in a new tab (a test records it). */
  readonly openUrl?: (url: string) => void;
  /** *Try it* on a first idea: a new chat with the prompt in its composer, never sent. */
  readonly onTry?: (prompt: string, ideaId?: string) => void;
  /** The `onboarding.step` contributions the canvas may show, and how frames reach the owner. */
  readonly frames?:
    | { readonly items: readonly (ResolvedContribution & { readonly placement: PluginUiPlacement })[]; readonly client: PluginFrameClient }
    | undefined;
  /** The owner offers memory (`memory` among its features); false, the about step neither reads nor writes it. */
  readonly memory?: boolean | undefined;
}
export interface StepProps extends WelcomeProps {
  readonly step: OnboardingFlowStep;
  readonly status: OnboardingStatus;
  /** The flow's plugin: only its own frame is shown. */
  readonly providerId: string;
  /** The apps connected when Welcome opened; undefined until it read the status. */
  readonly appsBefore: ReadonlySet<string> | undefined;
  readonly onDone: () => void;
  readonly onStatus: (status: OnboardingStatus) => void;
}
/**
 * A stage of a step that replaces the one a person just acted on (a provider
 * chosen, a key connected, *Paste a key instead*): focus moves to its first
 * field, else its primary button — never *Back*, which Enter would then take —
 * so a keyboard walk goes on from there instead of falling back to the page.
 * `stage` names the stage within one component, for one that swaps its own.
 */
export function useFocusOnEnter(stage?: unknown) {
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const within = root.current;
    const target =
      within?.querySelector<HTMLElement>(
        "input:not([disabled]), select:not([disabled]), textarea:not([disabled]), .select-trigger:not([disabled])",
      ) ??
      within?.querySelector<HTMLElement>("button.button-primary:not([disabled])") ??
      within?.querySelector<HTMLElement>("button:not([disabled])");
    target?.focus();
  }, [stage]);
  return root;
}
/** A polite announcement of what is under way, never moving focus. */
export function Working({ children }: { readonly children: ReactNode }) {
  return (
    <p className="welcome-working" role="status" aria-live="polite">
      {children}
    </p>
  );
}
