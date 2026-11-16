import {
  verificationMatches,
  type AsyncPersistenceRepositories,
  type InvocationContext,
  type ModelConfigPort,
  type ModelConnection,
  type OnboardingVerification,
  LASTING_VERIFY_CODES,
  type VerifyAdviceCode,
} from "@tavi/contracts";
import { errorMessage } from "@tavi/contracts/util";

import { resolveLiveTarget } from "../models/target.js";

/**
 * Verifications from real turns. A turn
 * on a workspace's default `main` or `fast` target that succeeds proves the
 * model when nothing current does — a provider-managed connection, a key
 * fixed outside onboarding; one refused for good (key, model,
 * quota) marks it failed. Transient errors write nothing, and none of this
 * slows or fails the turn.
 */

export interface OnboardingVerificationDependencies {
  readonly repositories: Pick<AsyncPersistenceRepositories, "onboarding">;
  readonly modelConfig: ModelConfigPort;
  readonly credentialRevision: (reference: string) => Promise<string>;
  readonly now: () => Date;
  /** Where a write that failed is said; never the turn's. */
  readonly warn?: (message: string, fields: Readonly<Record<string, unknown>>) => void;
}

interface SettledModelCall {
  readonly connectionId: string;
  readonly model: string;
  /** Only a generation call speaks for the model: a summary, extraction or vision call runs elsewhere, or with other limits. */
  readonly purpose?: string;
  readonly context: InvocationContext | undefined;
  readonly status: "completed" | "failed" | "aborted";
  readonly errorCode?: string;
}

/** Which default role a call was on, with the connection it ran on; undefined for any other target. */
async function roleOf(
  deps: OnboardingVerificationDependencies,
  workspaceId: string,
  call: SettledModelCall,
): Promise<{ readonly role: "main" | "fast"; readonly connection: ModelConnection | undefined } | undefined> {
  const main = await resolveLiveTarget(deps.modelConfig, { workspaceId });
  if (main !== undefined && main.target.connectionId === call.connectionId && main.target.model === call.model)
    return { role: "main", connection: main.connection };
  // No fast role (or one that cannot be read) matches no call: the answer is none.
  const fast = await deps.modelConfig.resolveRole({ workspaceId, role: "fast" }).catch(() => undefined);
  if (fast !== undefined && fast.target.connectionId === call.connectionId && fast.target.model === call.model)
    return { role: "fast", connection: fast.connection };
  return undefined;
}

export interface OnboardingTurnRecorder {
  /** Fire-and-forget: returns at once, whatever the call. */
  record(call: SettledModelCall): void;
  /** After a `credentials` or `models` write: revisions are computed again. */
  invalidate(): void;
  /** Settles when every record started so far has (tests). */
  idle(): Promise<void>;
}

/** The refusals a real turn marks its model failed for (lasting ones; a transient error never marks a model failed): its key, its quota, the model gone. */
const TURN_LASTING_CODES = LASTING_VERIFY_CODES.filter((code) => code !== "invalid_request");

export function onboardingTurnRecorder(deps: OnboardingVerificationDependencies): OnboardingTurnRecorder {
  // The revision is an HMAC over the secret: computed once per reference until a write could change it.
  const revisions = new Map<string, Promise<string>>();
  const pending = new Set<Promise<void>>();
  const revisionOf = (reference: string): Promise<string> => {
    let revision = revisions.get(reference);
    if (revision === undefined) {
      revision = deps.credentialRevision(reference);
      revisions.set(reference, revision);
      revision.catch(() => revisions.delete(reference));
    }
    return revision;
  };
  const write = async (call: SettledModelCall): Promise<void> => {
    const workspaceId = call.context?.workspaceId;
    if (workspaceId === undefined || call.status === "aborted" || (call.purpose !== undefined && call.purpose !== "generation")) return;
    // A real turn's refusal says something of the model only for these: an `invalid_request` there is usually the turn's own
    // (a long history, a big image), never the model's, unlike verify's fixed probe.
    const lasting = call.status === "failed" && (TURN_LASTING_CODES as readonly string[]).includes(call.errorCode ?? "");
    if (call.status === "failed" && !lasting) return;
    const target = await roleOf(deps, workspaceId, call);
    if (target === undefined) return;
    const connection = target.connection;
    const managed = connection?.providerBinding !== undefined;
    const revision = connection === undefined || managed ? undefined : await revisionOf(connection.credentialRef);
    const at = deps.now().toISOString();
    const verification: OnboardingVerification = {
      workspaceId,
      subject: "model",
      role: target.role,
      subjectId: call.connectionId,
      model: call.model,
      ...(connection === undefined ? {} : { baseUrl: connection.baseUrl }),
      ...(revision === undefined ? {} : { credentialRevision: revision }),
      ok: !lasting,
      ...(lasting ? { errorCode: call.errorCode as VerifyAdviceCode } : {}),
      at,
    };
    if (!lasting) {
      // A success writes only when nothing current proves it: a verify's own row, with its tool probe, stays.
      const current = (await deps.repositories.onboarding.verifications(workspaceId, "model")).find(
        (existing) =>
          existing.role === target.role &&
          existing.subjectId === call.connectionId &&
          existing.ok &&
          (revision === undefined || connection === undefined
            ? existing.model === call.model
            : verificationMatches(existing, {
                connectionId: call.connectionId,
                model: call.model,
                baseUrl: connection.baseUrl,
                credentialRevision: revision,
              })),
      );
      if (current !== undefined) return;
    }
    await deps.repositories.onboarding.recordVerification(verification);
  };
  return {
    record: (call) => {
      const run = write(call).catch((error: unknown) =>
        deps.warn?.("onboarding could not record a turn's verification", { error: errorMessage(error) }),
      );
      pending.add(run);
      void run.finally(() => pending.delete(run));
    },
    invalidate: () => revisions.clear(),
    idle: async () => {
      await Promise.all([...pending]);
    },
  };
}
