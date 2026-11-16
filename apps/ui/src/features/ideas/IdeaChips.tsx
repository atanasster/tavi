import type { IdeaChip } from "@tavi/contracts";
import { useEffect, useRef, useState } from "react";

import { useLoaded } from "../../hooks/use-loaded.js";
import { ideaChips, tryIdea } from "./ideas-api.js";
import { Button } from "../../ui/Button.js";
import { useWorkspace } from "../shell/Workspace.js";

/**
 * The empty chat's suggested prompts: up to
 * three, from the person's ideas or, with none, from what Tavi can do here,
 * and "Continue" for a chat summarised in the last three days. A chip fills
 * the composer and sends nothing; "Continue" opens its chat. None
 * are shown while the owner offers none, or the person turned them off.
 *
 * While something is typed the row is hidden, not removed: clearing the box
 * brings the same chips back without asking the owner for them again.
 */
export function IdeaChips({
  ideas = true,
  hidden = false,
  onFill,
  onOpenTask,
  onMore,
}: {
  /**
   * Whether an idea's own chips are offered: only where the message starts a
   * new chat. Home is no new chat, so the idea would be marked tried and never
   * linked to what came of it; there only capability and Continue chips show.
   */
  readonly ideas?: boolean;
  /** Something is typed: the row steps aside. */
  readonly hidden?: boolean;
  /** Put `prompt` in the composer, its first [part] selected to type over; `ideaId` when it is an idea's. */
  readonly onFill: (prompt: string, ideaId?: string) => void;
  readonly onOpenTask: (taskId: string) => void;
  /** The Ideas tab, when the owner offers it. */
  readonly onMore?: (() => void) | undefined;
}) {
  const { client, workspaceId } = useWorkspace();
  const chips: readonly IdeaChip[] = useLoaded(() => ideaChips(client, workspaceId), [client, workspaceId]).data?.chips ?? [];
  /** A pick on its way: one at a time, so a double click does not mark the idea tried twice. */
  const [picking, setPicking] = useState(false);
  /**
   * Whether the row is still on screen: a pick that answers after the chat
   * was left fills nothing, since the composer its words were for is gone and
   * the idea would go with whatever is typed there next.
   */
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const shown = ideas ? chips : chips.filter((chip) => chip.ideaId === undefined);
  if (shown.length === 0) return null;
  const pick = async (chip: IdeaChip): Promise<void> => {
    if (picking) return;
    if (chip.taskId !== undefined) {
      onOpenTask(chip.taskId);
      return;
    }
    setPicking(true);
    try {
      // An idea's chip is *Try it*: the idea is marked tried, and its prompt fills the box whatever the owner said.
      // Only an idea the owner took is linked to what comes of it: one it refused (gone, set aside) is the prompt alone.
      const tried = chip.ideaId === undefined ? undefined : await tryIdea(client, workspaceId, chip.ideaId);
      if (!mounted.current) return;
      onFill(chip.prompt, tried?.ok === true ? chip.ideaId : undefined);
    } finally {
      if (mounted.current) setPicking(false);
    }
  };
  return (
    <div className="idea-chips" role="group" aria-label="Suggestions" hidden={hidden}>
      {shown.map((chip) => (
        <Button
          variant="ghost"
          size="sm"
          key={`${chip.ideaId ?? chip.taskId ?? chip.label}`}
          className="idea-chip"
          title={chip.prompt}
          disabled={picking}
          onClick={() => void pick(chip)}
        >
          {chip.label}
        </Button>
      ))}
      {onMore === undefined ? null : (
        <Button variant="link" className="idea-chips-more" onClick={onMore}>
          More ideas →
        </Button>
      )}
    </div>
  );
}
