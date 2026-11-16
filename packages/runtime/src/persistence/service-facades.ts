import { MEMORY_EXPORT_HARD_CAP } from "../memory/limits.js";
import type {
  AccessPolicyPort,
  AsyncPersistencePort,
  ModelConfigPort,
  PersistenceServicesPort,
  PersistenceServiceOptions,
  SkillRolloutServicePort,
  SkillServicePort,
} from "@tavi/contracts";
import { SERVICE_METHODS } from "./service-protocol.js";

interface ServiceOptions {
  readonly now?: () => string;
  readonly newId?: (prefix: string) => string;
  readonly quotas?: PersistenceServiceOptions["quotas"];
  readonly policy?: AccessPolicyPort;
}
function sharedRead(
  policy: AccessPolicyPort | undefined,
  input: unknown,
): { sharedRead?: NonNullable<PersistenceServiceOptions["sharedRead"]> } {
  if (policy === undefined || input === null || typeof input !== "object" || !("actor" in input)) return {};
  const actor = input.actor;
  if (
    actor === null ||
    typeof actor !== "object" ||
    !("workspaceId" in actor) ||
    !("principalId" in actor) ||
    typeof actor.workspaceId !== "string" ||
    typeof actor.principalId !== "string"
  )
    return {};
  const runId = "runId" in actor && typeof actor.runId === "string" ? actor.runId : "";
  const caller = "caller" in actor && typeof actor.caller === "string" ? actor.caller : "memory";
  return {
    sharedRead: {
      workspaceId: actor.workspaceId,
      principalId: actor.principalId,
      allowed:
        policy.missingPermissions({ workspaceId: actor.workspaceId, principalId: actor.principalId, runId, caller }, ["memory:read-shared"])
          .length === 0,
    },
  };
}

/** Allocate the identifiers an operation can need before it enters the worker queue.
 * A rejected or replayed mutation may leave reserved identifiers unused.
 */
function allocateIds(
  newId: (prefix: string) => string,
  operation: string,
  args: readonly unknown[],
): NonNullable<PersistenceServiceOptions["ids"]> {
  const prefixes: Readonly<Record<string, readonly string[]>> = {
    "service.memory.propose": ["mem", "memrev"],
    "service.memory.remember": ["mem", "memrev", "memreview"],
    "service.memory.approve": ["memreview"],
    "service.memory.reject": ["memreview"],
    "service.memory.correct": ["memrev", "memreview"],
    "service.memory.forget": ["memdel"],
    "service.skills.activate": ["skillact"],
    "service.skills.disable": ["skillact"],
    "service.skills.rollback": ["skillact"],
  };
  const ids: Record<string, string[]> = {};
  const input = args[0];
  if (input !== null && typeof input === "object") {
    const taskIds = operation === "service.skillRollout.pinRollout" && "taskIds" in input ? input.taskIds : undefined;
    if (Array.isArray(taskIds)) ids["rollout"] = taskIds.map(() => newId("rollout"));
  }
  if (operation === "service.memory.sweepExpired")
    ids["memdel"] = Array.from({ length: 2 * MEMORY_EXPORT_HARD_CAP }, () => newId("memdel"));
  for (const prefix of prefixes[operation] ?? []) ids[prefix] = [newId(prefix)];
  return ids;
}

function configured(persistence: AsyncPersistencePort, options: ServiceOptions): PersistenceServicesPort {
  return persistence.servicesWith((args, operation) => ({
    ...(options.now === undefined ? {} : { now: options.now() }),
    ...(options.newId === undefined ? {} : { ids: allocateIds(options.newId, operation, args) }),
    ...(options.quotas === undefined ? {} : { quotas: options.quotas }),
    ...sharedRead(options.policy, args[0]),
  }));
}

/** Gives a facade's prototype each method of its service, forwarding to the service `service` reads off the instance. */
function forward<F extends object>(facade: { readonly prototype: F }, methods: readonly string[], service: (instance: F) => object): void {
  for (const method of methods) {
    const forwarded = {
      [method](this: F, ...args: unknown[]): unknown {
        return (service(this) as Record<string, (...args: unknown[]) => unknown>)[method]!(...args);
      },
    }[method];
    Object.defineProperty(facade.prototype, method, { value: forwarded, writable: true, configurable: true });
  }
}

type Quotas = NonNullable<PersistenceServiceOptions["quotas"]>;

interface MemoryServiceFacadeOptions extends ServiceOptions {
  /**
   * The quotas for a write in this workspace, read per call: the
   * workspace's `memory.limits.maxRecords` and the byte quota that follows it.
   * `undefined` falls back to `quotas`, then the service's defaults.
   */
  readonly quotasFor?: (workspaceId: string) => Promise<Quotas | undefined>;
}

/** Declares each method itself: a subclass overrides some, and a method the port type supplies is a property it may not override. */
export class MemoryService {
  readonly #service: PersistenceServicesPort["memory"];
  readonly #persistence: AsyncPersistencePort;
  readonly #options: MemoryServiceFacadeOptions;
  constructor(persistence: AsyncPersistencePort, options: MemoryServiceFacadeOptions = {}) {
    this.#service = configured(persistence, options).memory;
    this.#persistence = persistence;
    this.#options = options;
  }
  /** The service a quota-charged write goes through: configured with the workspace's quotas when it sets any. */
  async #charged(workspaceId: string): Promise<PersistenceServicesPort["memory"]> {
    const quotas = await this.#options.quotasFor?.(workspaceId);
    return quotas === undefined ? this.#service : configured(this.#persistence, { ...this.#options, quotas }).memory;
  }
  async propose(
    ...args: Parameters<PersistenceServicesPort["memory"]["propose"]>
  ): ReturnType<PersistenceServicesPort["memory"]["propose"]> {
    return (await this.#charged(args[0].actor.workspaceId)).propose(...args);
  }
  async remember(
    ...args: Parameters<PersistenceServicesPort["memory"]["remember"]>
  ): ReturnType<PersistenceServicesPort["memory"]["remember"]> {
    return (await this.#charged(args[0].actor.workspaceId)).remember(...args);
  }
  approve(...args: Parameters<PersistenceServicesPort["memory"]["approve"]>): ReturnType<PersistenceServicesPort["memory"]["approve"]> {
    return this.#service.approve(...args);
  }
  reject(...args: Parameters<PersistenceServicesPort["memory"]["reject"]>): ReturnType<PersistenceServicesPort["memory"]["reject"]> {
    return this.#service.reject(...args);
  }
  async correct(
    ...args: Parameters<PersistenceServicesPort["memory"]["correct"]>
  ): ReturnType<PersistenceServicesPort["memory"]["correct"]> {
    return (await this.#charged(args[0].actor.workspaceId)).correct(...args);
  }
  revoke(...args: Parameters<PersistenceServicesPort["memory"]["revoke"]>): ReturnType<PersistenceServicesPort["memory"]["revoke"]> {
    return this.#service.revoke(...args);
  }
  forget(...args: Parameters<PersistenceServicesPort["memory"]["forget"]>): ReturnType<PersistenceServicesPort["memory"]["forget"]> {
    return this.#service.forget(...args);
  }
  get(...args: Parameters<PersistenceServicesPort["memory"]["get"]>): ReturnType<PersistenceServicesPort["memory"]["get"]> {
    return this.#service.get(...args);
  }
  list(...args: Parameters<PersistenceServicesPort["memory"]["list"]>): ReturnType<PersistenceServicesPort["memory"]["list"]> {
    return this.#service.list(...args);
  }
  search(...args: Parameters<PersistenceServicesPort["memory"]["search"]>): ReturnType<PersistenceServicesPort["memory"]["search"]> {
    return this.#service.search(...args);
  }
  eligible(...args: Parameters<PersistenceServicesPort["memory"]["eligible"]>): ReturnType<PersistenceServicesPort["memory"]["eligible"]> {
    return this.#service.eligible(...args);
  }
  resolvePreferences(
    ...args: Parameters<PersistenceServicesPort["memory"]["resolvePreferences"]>
  ): ReturnType<PersistenceServicesPort["memory"]["resolvePreferences"]> {
    return this.#service.resolvePreferences(...args);
  }
  resolveFactConflicts(
    ...args: Parameters<PersistenceServicesPort["memory"]["resolveFactConflicts"]>
  ): ReturnType<PersistenceServicesPort["memory"]["resolveFactConflicts"]> {
    return this.#service.resolveFactConflicts(...args);
  }
  export(...args: Parameters<PersistenceServicesPort["memory"]["export"]>): ReturnType<PersistenceServicesPort["memory"]["export"]> {
    return this.#service.export(...args);
  }
  usage(...args: Parameters<PersistenceServicesPort["memory"]["usage"]>): ReturnType<PersistenceServicesPort["memory"]["usage"]> {
    return this.#service.usage(...args);
  }
  sweepExpired(
    ...args: Parameters<PersistenceServicesPort["memory"]["sweepExpired"]>
  ): ReturnType<PersistenceServicesPort["memory"]["sweepExpired"]> {
    return this.#service.sweepExpired(...args);
  }
  operatorView(
    ...args: Parameters<PersistenceServicesPort["memory"]["operatorView"]>
  ): ReturnType<PersistenceServicesPort["memory"]["operatorView"]> {
    return this.#service.operatorView(...args);
  }
  history(...args: Parameters<PersistenceServicesPort["memory"]["history"]>): ReturnType<PersistenceServicesPort["memory"]["history"]> {
    return this.#service.history(...args);
  }
  related(...args: Parameters<PersistenceServicesPort["memory"]["related"]>): ReturnType<PersistenceServicesPort["memory"]["related"]> {
    return this.#service.related(...args);
  }
  counts(...args: Parameters<PersistenceServicesPort["memory"]["counts"]>): ReturnType<PersistenceServicesPort["memory"]["counts"]> {
    return this.#service.counts(...args);
  }
  principals(
    ...args: Parameters<PersistenceServicesPort["memory"]["principals"]>
  ): ReturnType<PersistenceServicesPort["memory"]["principals"]> {
    return this.#service.principals(...args);
  }
}

export interface SkillService extends SkillServicePort {}
// biome-ignore lint/suspicious/noUnsafeDeclarationMerging: the interface declares the methods the static block forwards onto the class
export class SkillService {
  readonly #service: PersistenceServicesPort["skills"];
  constructor(persistence: AsyncPersistencePort, options: ServiceOptions = {}) {
    this.#service = configured(persistence, options).skills;
  }
  static {
    forward(SkillService, SERVICE_METHODS.skills, (facade) => facade.#service);
  }
}

export interface ModelConfigService extends ModelConfigPort {}
// biome-ignore lint/suspicious/noUnsafeDeclarationMerging: the interface declares the methods the static block forwards onto the class
export class ModelConfigService {
  readonly #service: PersistenceServicesPort["modelConfig"];
  constructor(persistence: AsyncPersistencePort, options: ServiceOptions = {}) {
    this.#service = configured(persistence, options).modelConfig;
  }
  static {
    forward(ModelConfigService, SERVICE_METHODS.modelConfig, (facade) => facade.#service);
  }
}

export interface SkillRolloutService extends SkillRolloutServicePort {}
// biome-ignore lint/suspicious/noUnsafeDeclarationMerging: the interface declares the methods the static block forwards onto the class
export class SkillRolloutService {
  readonly #service: PersistenceServicesPort["skillRollout"];
  constructor(persistence: AsyncPersistencePort, options: ServiceOptions = {}) {
    this.#service = configured(persistence, options).skillRollout;
  }
  static {
    forward(SkillRolloutService, SERVICE_METHODS.skillRollout, (facade) => facade.#service);
  }
}
