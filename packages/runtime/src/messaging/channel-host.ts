import {
  TaviError,
  type ChannelDescriptor,
  type LoggerPort,
  type MessagingConnection,
  type MessagingConnectionRecord,
  type MessagingConnectionRepositoryPort,
  type MessagingConnectionAuthState,
  type MessagingConnectionStatus,
  type MessagingServicePort,
} from "@tavi/contracts";
import { sleep } from "@tavi/node-kit";

/** One connection the host is configured to open: a row saved in Settings → Channels. */
export interface ChannelRecord {
  readonly connectionId: string;
  readonly providerId: string;
  readonly workspaceId: string;
  readonly accountIdentity: string;
  readonly settings: Readonly<Record<string, unknown>>;
  readonly credentialRefs: Readonly<Record<string, string>>;
  readonly enabled: boolean;
  readonly configRevision: number;
  /** The connection's own name, when the operator gave it one. */
  readonly label?: string;
  /** An OAuth connection's sign-in. */
  readonly authState: MessagingConnectionAuthState;
  /** When the connection was added. */
  readonly createdAt: string;
}

/** A connection as the host reports it: its record and how it is doing. */
export interface ChannelView extends ChannelRecord {
  readonly label: string;
  readonly status: MessagingConnectionStatus;
}

/**
 * What a provider needs besides its connector while a connection is open —
 * Mailgun's webhook listener until the host's own ingress serves it. Opened
 * after the connection, closed before it.
 */
export interface ChannelAttachment {
  open(record: ChannelRecord): Promise<void>;
  close(connectionId: string): Promise<void>;
}

export interface ChannelHostOptions {
  readonly messaging: MessagingServicePort;
  readonly connections: MessagingConnectionRepositoryPort;
  /** The workspaces this owner serves: only their saved connections are opened. */
  readonly workspaceIds: readonly string[];
  readonly descriptorOf: (providerId: string) => ChannelDescriptor | undefined;
  readonly attachments?: Readonly<Record<string, ChannelAttachment>>;
  readonly log: Pick<LoggerPort, "info" | "warn" | "error">;
  readonly now: () => string;
  /** Attempts to open a connection (default 3), with `retryDelaysMs` between them. */
  readonly openAttempts?: number;
  readonly retryDelaysMs?: readonly number[];
}

const DEFAULT_OPEN_ATTEMPTS = 3;
/** Why an OAuth connection is closed, as its status says it. */
function signInDetail(authState: MessagingConnectionAuthState | undefined): string {
  switch (authState) {
    case "expired":
      return "reconnect needed: its sign-in expired or was revoked";
    case "needs-consent":
      return "reconnect needed: it asks for access it was not granted";
    case "revoked":
      return "signed out: connect it again to use it";
    default:
      return "not connected: sign in to use it";
  }
}

/** A connection whose channel is not installed: its status detail. */
export const PROVIDER_MISSING = "provider missing: its channel is not installed";
const DEFAULT_RETRY_DELAYS_MS = [500, 1500] as const;

/** The credential reference behind a record's first secret field: the connection's own `credentialRef`. */
export function primaryCredentialRef(
  record: Pick<ChannelRecord, "credentialRefs">,
  descriptor: ChannelDescriptor | undefined,
): string | undefined {
  const primary = descriptor === undefined || descriptor.auth.kind === "none" ? undefined : descriptor.auth.fields?.[0]?.key;
  return primary === undefined ? undefined : record.credentialRefs[primary];
}

/** The `MessagingConnection` a record opens as. */
export function connectionOf(record: ChannelRecord, descriptor: ChannelDescriptor | undefined): MessagingConnection {
  const credentialRef = primaryCredentialRef(record, descriptor);
  return {
    connectionId: record.connectionId,
    providerId: record.providerId,
    accountIdentity: record.accountIdentity,
    workspaceId: record.workspaceId,
    configRevision: record.configRevision,
    ...(credentialRef === undefined ? {} : { credentialRef }),
    credentialRefs: record.credentialRefs,
    enabled: record.enabled,
  };
}

function recordOf(row: MessagingConnectionRecord): ChannelRecord {
  return {
    connectionId: row.connectionId,
    providerId: row.providerId,
    workspaceId: row.workspaceId,
    accountIdentity: row.accountIdentity,
    settings: row.settings,
    credentialRefs: row.credentialRefs,
    enabled: row.enabled,
    configRevision: row.configRevision,
    ...(row.label === undefined ? {} : { label: row.label }),
    authState: row.authState,
    createdAt: row.createdAt,
  };
}

/**
 * Opens and keeps open every messaging connection this owner is configured
 * with: the enabled connections saved for each workspace
 * it serves. A save, a disable or a delete
 * applies on `reload`, without a restart: the connection whose revision
 * changed is closed and reopened, a disabled one closed, a new one opened.
 *
 * A connection that fails to open is reported in `list` and logged, and the
 * rest still open.
 */
export class ChannelHost {
  readonly #options: ChannelHostOptions;
  #records = new Map<string, ChannelRecord>();
  readonly #opened = new Map<string, ChannelRecord>();
  readonly #failures = new Map<string, MessagingConnectionStatus>();
  #queue: Promise<void> = Promise.resolve();
  /** Between `start` and `close`: only then does a reload open anything. */
  #running = false;

  constructor(options: ChannelHostOptions) {
    this.#options = options;
  }

  /** Reads what to open. Throws `CONFLICT` for a connection configured both ways. */
  async load(): Promise<void> {
    this.#records = await this.#configured();
  }

  /** What the host is configured to open now, enabled or not, as loaded. */
  configured(): readonly ChannelRecord[] {
    return [...this.#records.values()];
  }

  /** Every configured connection with its label and current status. */
  list(): readonly ChannelView[] {
    return this.configured().map((record) => ({
      ...record,
      label: record.label ?? this.#options.descriptorOf(record.providerId)?.label ?? record.providerId,
      status: this.#statusOf(record),
    }));
  }

  /**
   * One connection's status: why it could not open, else the messaging
   * service's word on it. A failed open keeps the repair its connector named,
   * so Connected apps can offer it.
   */
  statusOf(connectionId: string): MessagingConnectionStatus | undefined {
    return this.#failures.get(connectionId) ?? this.#options.messaging.statusOf(connectionId);
  }

  /** Opens every enabled connection. */
  start(): Promise<void> {
    return this.#serial(async () => {
      this.#running = true;
      for (const record of this.#records.values()) if (record.enabled) await this.#open(record);
    });
  }

  /**
   * Reads the configuration again and applies the difference: what was saved
   * since opens, reopens or closes, and nothing else is touched. Answers once
   * every change has been applied. Before `start` or after `close` (the host
   * not running, or its plugin disabled) it only reads: nothing opens.
   */
  reload(): Promise<void> {
    return this.#serial(async () => {
      const next = await this.#configured();
      if (!this.#running) {
        this.#records = next;
        return;
      }
      for (const [connectionId, opened] of this.#opened) {
        const record = next.get(connectionId);
        // A changed connection is reopened: its sends meanwhile wait for it rather than fail.
        // Gone, turned off, or its channel withdrawn (a channel plugin stopped): closed, and shown as such below.
        if (record === undefined || !record.enabled || this.#options.descriptorOf(record.providerId) === undefined)
          await this.#close(connectionId);
        else if (record.configRevision !== opened.configRevision) {
          try {
            await this.#close(connectionId, { reopening: true });
          } catch (error) {
            // Its close failed part way: the sends held for the reopen are let go, and it is opened again below.
            await this.#options.messaging.closeConnection(connectionId).catch(() => undefined);
            this.#options.log.error("messaging connection did not close cleanly before reopening", { connectionId, error });
          }
        }
      }
      this.#records = next;
      for (const record of next.values()) {
        if (!record.enabled) this.#failures.delete(record.connectionId);
        else if (!this.#opened.has(record.connectionId)) await this.#open(record);
      }
    });
  }

  /** Closes every open connection, reporting the first failure after trying them all. */
  close(): Promise<void> {
    return this.#serial(async () => {
      this.#running = false;
      let first: unknown;
      for (const connectionId of [...this.#opened.keys()]) {
        try {
          await this.#close(connectionId);
        } catch (error) {
          first ??= error;
        }
      }
      if (first !== undefined) throw first;
    });
  }

  #serial(work: () => Promise<void>): Promise<void> {
    const run = this.#queue.then(work);
    // Ordering only: the work's own failure reaches its caller through the promise it was handed.
    this.#queue = run.catch(() => undefined);
    return run;
  }

  async #configured(): Promise<Map<string, ChannelRecord>> {
    const records = new Map<string, ChannelRecord>();
    const served = new Set(this.#options.workspaceIds);
    for (const row of await this.#options.connections.list()) if (served.has(row.workspaceId)) records.set(row.connectionId, recordOf(row));
    return records;
  }

  #statusOf(record: ChannelRecord): MessagingConnectionStatus {
    if (!record.enabled) return { state: "stopped", detail: "disabled", since: this.#options.now() };
    return (
      this.#failures.get(record.connectionId) ??
      this.#options.messaging.statusOf(record.connectionId) ?? { state: "stopped", since: this.#options.now() }
    );
  }

  async #open(record: ChannelRecord): Promise<void> {
    const descriptor = this.#options.descriptorOf(record.providerId);
    // Its channel is not installed (a plugin disabled or removed): shown, kept closed, and opened by a reload once
    // the channel is back. Nothing about it is deleted, and nothing else fails.
    if (descriptor === undefined) {
      if (this.#failures.get(record.connectionId)?.detail !== PROVIDER_MISSING) {
        this.#options.log.warn("messaging connection's channel is not installed; it stays closed", {
          connectionId: record.connectionId,
          providerId: record.providerId,
        });
      }
      this.#failures.set(record.connectionId, { state: "stopped", detail: PROVIDER_MISSING, since: this.#options.now() });
      await this.#options.messaging.closeConnection(record.connectionId);
      return;
    }
    // An OAuth connection not signed in (or whose sign-in lapsed) stays closed until it is; one
    // needing consent for more keeps running on what it was granted.
    if (descriptor.auth.kind === "oauth2" && record.authState !== "connected" && record.authState !== "needs-consent") {
      this.#failures.set(record.connectionId, { state: "stopped", detail: signInDetail(record.authState), since: this.#options.now() });
      await this.#options.messaging.closeConnection(record.connectionId);
      return;
    }
    const attempts = Math.max(1, this.#options.openAttempts ?? DEFAULT_OPEN_ATTEMPTS);
    const delays = this.#options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
    let lastError: unknown;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        await this.#options.messaging.openConnection({
          connection: connectionOf(record, descriptor),
          config: record.settings,
        });
        lastError = undefined;
        break;
      } catch (error) {
        lastError = error;
        const delay = delays[attempt - 1];
        if (attempt >= attempts || delay === undefined) break;
        // A credential or configuration failure is not transient, but this
        // deliberately does not try to classify the error: retrying a genuinely
        // bad token twice more costs less than misclassifying a transient one.
        this.#options.log.warn("messaging connection failed to open; retrying", { connectionId: record.connectionId, attempt, error });
        await sleep(delay);
      }
    }
    if (lastError === undefined) {
      try {
        await this.#options.attachments?.[record.providerId]?.open(record);
      } catch (error) {
        // Best effort: cleanup of something that may already be closed or gone; nothing waits on it.
        await this.#options.messaging.closeConnection(record.connectionId).catch(() => undefined);
        lastError = error;
      }
    }
    if (lastError !== undefined) {
      const failure = TaviError.from(lastError);
      const repair = repairOf(failure);
      this.#failures.set(record.connectionId, {
        state: "failed",
        detail: failure.message,
        since: this.#options.now(),
        ...(repair === undefined ? {} : { repair }),
      });
      // Sends held for its reopen are let go: there is no connection for them.
      await this.#options.messaging.closeConnection(record.connectionId).catch(() => undefined);
      this.#options.log.error("messaging connection could not be opened", {
        connectionId: record.connectionId,
        providerId: record.providerId,
        error: lastError,
      });
      return;
    }
    this.#failures.delete(record.connectionId);
    this.#opened.set(record.connectionId, record);
    this.#options.log.info("messaging connection opened", { connectionId: record.connectionId, providerId: record.providerId });
  }

  async #close(connectionId: string, options: { readonly reopening?: boolean } = {}): Promise<void> {
    const record = this.#opened.get(connectionId);
    if (record === undefined) return;
    this.#opened.delete(connectionId);
    try {
      await this.#options.attachments?.[record.providerId]?.close(connectionId);
    } finally {
      await this.#options.messaging.closeConnection(connectionId, options);
    }
  }
}

/**
 * The repair a connector named on the error it failed to start with
 * (`details.repair`): a refused token, or a setting at the provider.
 */
function repairOf(error: TaviError): MessagingConnectionStatus["repair"] {
  const repair = error.details?.["repair"];
  return repair === "credentials" || repair === "provider-settings" ? repair : undefined;
}
