import type { WorkspaceSettingsAnswer } from "@tavi/contracts";

import type { Outcome } from "../../lib/ipc.js";

/** The busy key and runner a settings section takes from its page's `useAction`. */
export interface SettingActionProps {
  readonly busy: string | undefined;
  readonly run: (key: string, work: () => Promise<Outcome<string | undefined>>) => Promise<void>;
}

/** A settings section's props: the owner's settings answer, and the page's busy key and runner. */
export interface SettingSectionProps extends SettingActionProps {
  readonly answer: WorkspaceSettingsAnswer;
}
