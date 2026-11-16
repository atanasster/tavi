import type { ChatContextAnswer, ChatMemoryMode } from "@tavi/contracts";
import { useState } from "react";

import { useResetOnChange } from "../../hooks/use-reset-on-change.js";
import { setChatMemory } from "../chat-panel/api.js";
import { Icon } from "../../ui/Icon.js";
import type { Outcome, SettingsClient } from "../../lib/ipc.js";
import { Failure } from "../../ui/Parts.js";
import { useWorkspace } from "../shell/Workspace.js";
import { Button } from "../../ui/Button.js";

/**
 * The chat header's memory control: a button that turns the chat's memory off and back on, its icon
 * crossed out while off, and for a private chat a ghost icon that says so —
 * private is set when a chat is created and never lifted, so it is no
 * button. Each says its words as text, never the icon alone. The mode
 * shown is the chat list's (`memoryMode` on its row), so opening a chat asks
 * the owner nothing; a press asks `chat-context` and shows its answer.
 */

/** What the control says of a chat's memory. */
export function memoryModeLabel(mode: ChatMemoryMode | undefined): string {
  return mode === "private" ? "Private chat" : mode === "off" ? "Memory off" : "Memory on";
}

/** The control's tooltip: what the mode means and what pressing it does. */
function memoryModeTitle(mode: ChatMemoryMode | undefined): string {
  if (mode === "private")
    return "Private chat: memory is off for good, it is left out of past-chat search and Earlier chats, and its saved turns are forgotten about a day after its last.";
  if (mode === "off")
    return "Memory is off in this chat: nothing is recalled here, and nothing said here is remembered. Turn it back on from the next message.";
  return "Memory is on in this chat. Turn it off: nothing recalled or remembered here until you turn it back on.";
}

/** A private chat's mark: never a toggle, its memory is off for good. Shown from before its first message. */
export function PrivateChatMark() {
  return (
    <span className="memory-mode memory-mode-private meta-base" title={memoryModeTitle("private")}>
      <Icon name="ghost" size="sm" /> {memoryModeLabel("private")}
    </span>
  );
}

export function MemoryModeToggle({
  taskId,
  mode,
  save = setChatMemory,
}: {
  readonly taskId: string;
  /** The chat's mode as the chat list last read it: absent while memory is on. */
  readonly mode: ChatMemoryMode | undefined;
  readonly save?: (client: SettingsClient, workspaceId: string, taskId: string, mode: "on" | "off") => Promise<Outcome<ChatContextAnswer>>;
}) {
  const { client, workspaceId } = useWorkspace();
  // What a press here answered, until the list reads the chat again.
  const [pressed, setPressed] = useState<{ readonly mode: ChatMemoryMode | undefined }>();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string>();
  useResetOnChange([mode, taskId], () => setPressed(undefined));
  const shown = pressed === undefined ? mode : pressed.mode;
  const label = memoryModeLabel(shown);
  if (shown === "private") return <PrivateChatMark />;
  const off = shown === "off";
  const toggle = async (): Promise<void> => {
    setBusy(true);
    setFailure(undefined);
    const answer = await save(client, workspaceId, taskId, off ? "on" : "off");
    setBusy(false);
    if (answer.ok) setPressed({ mode: answer.value.memoryMode });
    else setFailure(answer.message);
  };
  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        className={`memory-mode${off ? " memory-mode-off" : ""}`}
        aria-label={`${label}: turn it ${off ? "on" : "off"} for this chat`}
        title={memoryModeTitle(shown)}
        disabled={busy}
        onClick={() => void toggle()}
      >
        <Icon name={off ? "memory-off" : "memory"} size="sm" /> {label}
      </Button>
      {failure === undefined ? null : (
        <Failure as="span" className="meta-base">
          {failure}
        </Failure>
      )}
    </>
  );
}
