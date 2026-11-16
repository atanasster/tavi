import { useState } from "react";

import type { MemoryItem } from "@tavi/contracts";

import type { Outcome, SettingsClient } from "../../lib/ipc.js";
import { useReveal } from "./MemoryRecord.js";
import { useWorkspace } from "../shell/Workspace.js";

/** A failed decision's words: the refusal's own, unless the caller says it better. */
type Refusal = (outcome: Extract<Outcome<unknown>, { readonly ok: false }>) => string;

/**
 * One waiting memory's decision: `decide` runs the work, busy meanwhile, and calls
 * `onDecided` when it went through — or when the item was decided elsewhere or
 * expired (`CONFLICT`), gone either way; any other refusal is the `failure`.
 * A sensitive item is read before it is decided, so its reveal comes with it.
 */
export function useMemoryDecision(
  item: MemoryItem,
  onDecided: (recordId: string) => void,
  refusal: Refusal = (outcome) => outcome.message,
) {
  const { client, workspaceId } = useWorkspace();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string>();
  const reveal = useReveal(client, workspaceId, item);
  const shown = reveal.revealed ?? item;
  const decide = (work: (client: SettingsClient, workspaceId: string) => Promise<Outcome<unknown>>): void => {
    setBusy(true);
    setFailure(undefined);
    void work(client, workspaceId).then((outcome) => {
      setBusy(false);
      if (outcome.ok || outcome.code === "CONFLICT") onDecided(item.recordId);
      else setFailure(refusal(outcome));
    });
  };
  return { busy, failure, reveal, shown, decide };
}
