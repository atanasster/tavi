import {
  TaviError,
  TaviErrorCodeSchema,
  type ChannelsPayload,
  type CredentialsPayload,
  type HeartbeatPayload,
  type IdeasPayload,
  type MemoryPayload,
  type ModelsPayload,
  type OnboardingPayload,
  type SearchPayload,
  type WorkspaceSettingsPayload,
} from "@tavi/contracts";
import { prefixedId } from "@tavi/node-kit";
import type { IpcClient } from "@tavi/runtime/owner-attach";
import type { IpcAnswer } from "../../shared/ipc-decisions.js";

/**
 * Where `tavi onboard` and `tavi setup` send what they write: a running owner
 * over IPC, as `tavi models` does, or — with none — the data directory opened here, through the same
 * command functions the owner dispatches to. Either way every write is an
 * existing command.
 */

export type OnboardCommand =
  | "onboarding"
  | "models"
  | "credentials"
  | "workspace-settings"
  | "memory"
  | "heartbeat"
  | "ideas"
  | "search"
  | "channels";

export interface OnboardTransport {
  /** A running owner answers: pairing and the service are reachable, and its environment is not this process's. */
  readonly attached: boolean;
  /** The command's answer, or a `TaviError` with the owner's code and words. */
  request<T>(command: "onboarding", payload: OnboardingPayload, timeoutMs?: number): Promise<T>;
  request<T>(command: "models", payload: ModelsPayload, timeoutMs?: number): Promise<T>;
  request<T>(command: "credentials", payload: CredentialsPayload, timeoutMs?: number): Promise<T>;
  request<T>(command: "workspace-settings", payload: WorkspaceSettingsPayload, timeoutMs?: number): Promise<T>;
  request<T>(command: "memory", payload: MemoryPayload, timeoutMs?: number): Promise<T>;
  request<T>(command: "heartbeat", payload: HeartbeatPayload, timeoutMs?: number): Promise<T>;
  request<T>(command: "ideas", payload: IdeasPayload, timeoutMs?: number): Promise<T>;
  request<T>(command: "search", payload: SearchPayload, timeoutMs?: number): Promise<T>;
  /** A running owner's alone: a connection's ingress, its pairing codes and its probe live there. */
  request<T>(command: "channels", payload: ChannelsPayload, timeoutMs?: number): Promise<T>;
}

export const answerOf = <T>(
  answer:
    | IpcAnswer<unknown>
    | { readonly ok: boolean; readonly result?: unknown; readonly error?: { readonly code: string; readonly message: string } },
): T => {
  if (answer.ok) return answer.result as T;
  const code = TaviErrorCodeSchema.safeParse(answer.error?.code);
  throw new TaviError(code.success ? code.data : "UNAVAILABLE", answer.error?.message ?? "the command was refused", {
    details: { code: answer.error?.code },
  });
};

/** A running owner: every request one IPC call, with `models test` and verify given their own deadline. */
export function attachedTransport(client: IpcClient): OnboardTransport {
  return {
    attached: true,
    request: async <T>(command: OnboardCommand, payload: unknown, timeoutMs = 30_000): Promise<T> =>
      answerOf<T>((await client.request(command, payload, prefixedId("onboard"), { timeoutMs })) as never),
  } as OnboardTransport;
}
