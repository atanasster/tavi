import type { ClientEvent } from "@tavi/contracts";
import type { IpcClient } from "@tavi/runtime";

/**
 * Send a request whose response names a subscription (`run`, `subscribe`), and
 * collect that subscription's events as they arrive — registered from the
 * response itself, since the owner writes the subscription's held events right
 * behind it. `off` stops collecting.
 */
export async function requestWithSubscription(
  client: IpcClient,
  command: string,
  payload: unknown,
  requestId: string,
  timeoutMs = 15_000,
): Promise<{ readonly response: Awaited<ReturnType<IpcClient["request"]>>; readonly events: ClientEvent[]; readonly off: () => void }> {
  const events: ClientEvent[] = [];
  let subscriptionId: string | undefined;
  const off = client.onEvent((frame) => {
    if (frame.subscriptionId === subscriptionId) events.push(frame.event);
  });
  const response = await client.request(command, payload, requestId, {
    timeoutMs,
    onResponse: (answer) => {
      subscriptionId = (answer.result as { subscriptionId?: string } | undefined)?.subscriptionId;
    },
  });
  return { response, events, off };
}

/** Whether a stream has reached its terminal event. */
export const ended = (events: readonly ClientEvent[]): boolean =>
  events.some((event) => event.kind === "task.completed" || event.kind === "task.failed" || event.kind === "task.stopped");
