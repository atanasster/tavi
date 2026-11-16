import { useEffect, useRef } from "react";

import type { ClientState } from "@tavi/client/browser";

import type { SettingsClient } from "../../lib/ipc.js";
import type { Navigate, PageRoute } from "../shell/route.js";
import { loadStatus, redirectedThisSession } from "./onboarding-api.js";

/** Welcome, opened once on a first run. */
export function useFirstRunWelcome({
  offersOnboarding,
  connection,
  client,
  workspaceId,
  page,
  navigate,
}: {
  readonly offersOnboarding: boolean;
  readonly connection: ClientState;
  readonly client: SettingsClient;
  readonly workspaceId: string;
  readonly page: PageRoute;
  readonly navigate: Navigate;
}): void {
  // A first run opens Welcome once per browser session: never for an install that had a model before
  // onboarding (`firstRun` is false there), never twice in a session, never away from a page the reader named.
  const firstRunChecked = useRef(false);
  const pageNow = useRef(page);
  useEffect(() => {
    pageNow.current = page;
  }, [page]);
  useEffect(() => {
    if (!offersOnboarding || connection !== "ready" || firstRunChecked.current) return;
    firstRunChecked.current = true;
    const bareChat = (): boolean => pageNow.current.route === "chat" && pageNow.current.taskId === undefined;
    if (!bareChat()) return;
    void loadStatus(client, workspaceId).then((status) => {
      // Asked again: the reader may have opened another page while the status loaded.
      // With no flow at all (`providerId: null`) there is no Welcome to open: Home's notices say what to run.
      if (!status.ok || !status.value.firstRun || status.value.providerId === null || !bareChat()) return;
      let storage: Storage | undefined;
      try {
        storage = window.sessionStorage;
      } catch {
        storage = undefined;
      }
      if (redirectedThisSession(storage)) return;
      navigate((current) => ({ ...current, route: "welcome", stepId: undefined }), { replace: true });
    });
  }, [offersOnboarding, connection, client, workspaceId, navigate]);
}
