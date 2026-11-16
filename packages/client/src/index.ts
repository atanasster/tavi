/**
 * `@tavi/client` — the attached client of a tavi owner.
 *
 * The root entry is React- and Node-free, so a browser bundle can carry it: the
 * frame transport, the handshake, subscription cursors, reconnect and pure
 * reducers live here, over the contracts' own frame codec, so a client and the
 * owner cannot disagree about what a frame is. A host's transport lives in its
 * own entry: `@tavi/client/node` (the Unix socket and discovery) and
 * `@tavi/client/browser` (the WebSocket `tavi ui` bridges). What the root needs from its host,
 * such as time and a way to reach the owner, it takes as a parameter
 * (`Scheduler`, `Dialer`).
 */
import { CLIENT_PROTOCOL_VERSION, IPC_PROTOCOL_VERSION } from "@tavi/contracts";

// Recognising the refusal of an owner of another protocol is part of using the
// client: re-exported so a consumer needs no second package for it.
export { isProtocolMismatch } from "@tavi/contracts";

export type { Scheduler } from "./scheduler.js";
export { frameTransport, type ByteChannel, type FrameTransport } from "./transport.js";
export {
  CLIENT_DISCONNECTED,
  CLIENT_TIMEOUT,
  HANDSHAKE_TIMEOUT_MS,
  REQUEST_TIMEOUT_MS,
  handshakeFailure,
  openConnection,
  type ClientResponse,
  type Connection,
  type ConnectionOptions,
  type HandshakeFailure,
  type LiveFrame,
  type OrphanResponse,
  type OwnerCredentials,
  type RequestOptions,
  type SubscriptionEvent,
} from "./connection.js";
export { alreadyDelivered, memoryCursorStore, type CursorStore } from "./cursors.js";
export {
  ADMISSION_COMMANDS,
  isAdmission,
  ADMISSION_TIMEOUT_MS,
  RECONNECT_DELAY_MS,
  RETRY_DELAY_MS,
  createClient,
  isResendable,
  type ClientOptions,
  type ClientRequestOptions,
  type ClientState,
  type Dialer,
  type LiveWatch,
  type LiveWatchOptions,
  type LiveWatchOpened,
  type Opened,
  type OwnerAddress,
  type RunOptions,
  type SubscribeOptions,
  type Subscription,
  type TaviClient,
} from "./client.js";

// The pure reducers a front end renders from.
export {
  initialRunState,
  isEventOrderError,
  reduceRun,
  replayRun,
  resumeFrom,
  seedSuspension,
  turnEnded,
  type ApprovalRequest,
  type AttemptBoundary,
  type PendingRound,
  type RunState,
  type RunStatus,
  type SettledRound,
  type SettledWait,
  type BrowserControlReceipt,
  type SteerEntry,
  type TextBlock,
  type ToolCard,
  type TranscriptEntry,
} from "./reduce-run.js";

// A task's record and a round's rows, read the same way by every front end.
export {
  endingOfOutcome,
  pendingRoundsOf,
  recordedStateOf,
  taintOfRecorded,
  conversationOfRecorded,
  roundCallIds,
  type Ending,
  type RecordedState,
  type RecordedTask,
} from "./records.js";

/** The protocols this client speaks: the IPC frames, and the events they carry. */
export const CLIENT_PROTOCOLS = { ipc: IPC_PROTOCOL_VERSION, events: CLIENT_PROTOCOL_VERSION } as const;
