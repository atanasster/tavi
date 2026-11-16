import {
  SEND_OUTCOME_STATUSES,
  TaviError,
  type InboundEvent,
  type McpToolDefinition,
  type OutboundMessage,
  type RoutineDeliveryJob,
  type RoutineRunData,
  type SendOutcome,
} from "@tavi/contracts";
import { zodIssues } from "@tavi/contracts/zod-util";
import { z } from "zod";

/**
 * A JSON column read back and checked against `schema`. The store wrote the
 * value from a record it had validated, so one that does not parse or match
 * is a corrupt row, a bug: it fails loudly, naming `what` (`table.column`),
 * rather than reaching a reader as a value of the wrong shape.
 */
export function parseJsonColumn<S extends z.ZodType>(schema: S, text: string, what: string): z.output<S> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    // The parser's own message is left out: V8 quotes the start of the input,
    // and these columns hold private content.
    throw new TaviError("INTERNAL", `${what} holds invalid JSON`, { details: { column: what } });
  }
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  const issues = zodIssues(result.error, "<root>");
  throw new TaviError("INTERNAL", `${what} holds a malformed record: ${issues.join("; ")}`, { details: { column: what, issues } });
}

/**
 * The fields a reader relies on, checked, standing for a record whose full
 * shape its writer validated: every other field is kept as stored.
 */
function recordShape<T>(shape: Parameters<typeof z.looseObject>[0]): z.ZodType<T> {
  return z.looseObject(shape) as unknown as z.ZodType<T>;
}

// The identity a held event is matched, bound and replayed by; its other fields are kept as stored.
export const StoredInboundEventSchema = recordShape<InboundEvent>({
  connectionId: z.string(),
  providerEventId: z.string(),
  externalSenderId: z.string(),
  externalConversationId: z.string(),
});

/**
 * What the held listing reads of an inbox payload: its sender (as the cap's SQL reads it) and its text. A row held
 * from an older or partial writer is still listed by its sender.
 */
export const StoredHeldPayloadSchema = z.looseObject({ externalSenderId: z.string(), content: z.string().optional() });

export const StoredOutboundMessageSchema = recordShape<OutboundMessage>({
  effectId: z.string(),
  connectionId: z.string(),
  parts: z.array(z.looseObject({})),
});

export const StoredSendOutcomeSchema = recordShape<SendOutcome>({
  status: z.enum(SEND_OUTCOME_STATUSES),
  retryable: z.boolean(),
  parts: z.array(z.looseObject({ index: z.number(), status: z.enum(SEND_OUTCOME_STATUSES) })),
});

export const StoredMcpToolDefinitionSchema = recordShape<McpToolDefinition>({ name: z.string() });

/** The fields of a run's data every reader counts on; the rest are kept as stored. */
export const StoredRoutineRunDataSchema = recordShape<RoutineRunData>({
  operationKey: z.string(),
  deadline: z.string(),
  queueExpiresAt: z.string(),
  localDay: z.string(),
  modelCalls: z.number(),
  toolCalls: z.number(),
  tokensReserved: z.number(),
  tokensKnown: z.number(),
  usageComplete: z.boolean(),
  reservations: z.record(z.string(), z.number()),
  stepStarted: z.record(z.string(), z.string()),
});

/** The fields of a delivery job's data its readers count on; the rest are kept as stored. */
export const StoredDeliveryDataSchema = recordShape<RoutineDeliveryJob["data"]>({
  artifactId: z.string(),
  hash: z.string(),
  targetId: z.string(),
  target: z.looseObject({}),
  generation: z.number(),
});
