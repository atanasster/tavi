import { useMemo, useRef } from "react";

import type { ClientState, TaviClient } from "@tavi/client/browser";

import { offeredSections } from "../center/CenterNav.js";
import type { CenterSection } from "./route.js";

/** What the owner offers — the Command Center and its sections, Ideas, setup — as last seen while connected. */
export function useOwnerFeatures(
  client: Partial<Pick<TaviClient, "features">>,
  connection: ClientState,
  pageSection: CenterSection | undefined,
) {
  /**
   * The Command Center is offered only by an owner that advertises `center`:
   * the canvas and the owner can be different builds. `features` is empty while the client is not connected, so what was
   * last seen while ready is kept: a reconnect must not tear the Center down
   * and lose its search, filters and loaded pages. The feed retries meanwhile.
   */
  const readyFeatures = useRef<readonly string[]>([]);
  if (connection === "ready") readyFeatures.current = client.features ?? [];
  const centered = readyFeatures.current.includes("center");
  /**
   * An owner without `center` that still offers routines or schedules keeps
   * them reachable: the Center tab holds its Schedule section alone, with no
   * rail and no feed, and every other section is hidden.
   */
  const scheduleOnly = !centered && readyFeatures.current.some((feature) => feature === "routines" || feature === "schedules");
  /** The sections the owner offers: each needs the command its lists come from. */
  const features = readyFeatures.current;
  const sections = useMemo<readonly CenterSection[]>(
    () => (centered ? offeredSections(features) : scheduleOnly ? ["schedule"] : []),
    [centered, scheduleOnly, features],
  );
  /** Where an address naming a section this owner does not offer lands. */
  const landing: CenterSection = centered ? "activity" : "schedule";
  const section: CenterSection = pageSection !== undefined && sections.includes(pageSection) ? pageSection : landing;
  /**
   * Reminders fired in the app and not yet seen: read while the owner offers them, again on each reminder change,
   * shown in the rail, and — once the reader turned notifications on — as one
   * browser notification each while the canvas is open, on any route.
   */
  const offersReminders = readyFeatures.current.includes("reminders");
  /** The Ideas tab, offered by an owner whose bridge lets a page reach `ideas`. */
  const offersIdeas = readyFeatures.current.includes("ideas");
  /** Setup's Welcome, offered by an owner that advertises `onboarding`. */
  const offersOnboarding = readyFeatures.current.includes("onboarding");
  return { features, centered, scheduleOnly, sections, section, offersReminders, offersIdeas, offersOnboarding };
}
