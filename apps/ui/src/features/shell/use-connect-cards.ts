import { useMemo } from "react";

import type { CanvasStore } from "../chat/store/types.js";
import type { SettingsClient } from "../../lib/ipc.js";
import type { Navigate } from "./route.js";

/**
 * What a chat's connect card does: *Continue* is the person's message in the
 * chat on screen, *Discover* opens Apps on the app named, and, where the
 * owner offers setup, *Set up* opens the step it finishes.
 */
export function useConnectCards({
  client,
  workspaceId,
  store,
  currentTaskId,
  navigate,
  offersOnboarding,
}: {
  readonly client: SettingsClient;
  readonly workspaceId: string;
  readonly store: CanvasStore;
  /** The chat on screen. */
  readonly currentTaskId: string | undefined;
  readonly navigate: Navigate;
  readonly offersOnboarding: boolean;
}) {
  return useMemo(
    () => ({
      client,
      workspaceId,
      onContinue: (text: string) => store.submit(text, { asPrompt: true, viewing: currentTaskId }),
      onDiscover: (name: string) =>
        navigate((now) => ({
          ...now,
          route: "settings",
          view: "apps",
          appsTab: "discover",
          appId: undefined,
          appConnect: undefined,
          appsQuery: name,
        })),
      // A connect card names the setup step it finishes, where the owner offers setup.
      ...(offersOnboarding
        ? { onSetup: (stepId: string) => navigate((now) => ({ ...now, route: "welcome", stepId, welcomeAll: undefined })) }
        : {}),
    }),
    [client, workspaceId, store, currentTaskId, navigate, offersOnboarding],
  );
}
