import { TaviError } from "@tavi/contracts";

/**
 * A port's groups and each group's method names, in the order its client lists
 * them. One table drives the client the owner holds and the worker's dispatch,
 * so a method is named once.
 */
export type MethodTable<P> = { readonly [G in keyof P & string]-?: readonly (keyof P[G] & string)[] };

type Unlisted<P, T extends MethodTable<P>> = { [G in keyof P & string]: Exclude<keyof P[G] & string, T[G][number]> }[keyof P & string];
type Complete<P, T extends MethodTable<P>> = ([Unlisted<P, T>] extends [never] ? unknown : { readonly unlisted: Unlisted<P, T> }) & {
  readonly [G in Exclude<keyof T, keyof P>]: never;
};

/** A method table that names every method of every group of `P`, and nothing else. */
export const methodTable =
  <P>() =>
  <const T extends MethodTable<P>>(table: T & Complete<P, T>): T =>
    table;

type Operation<F> = F extends (...args: infer A) => infer R ? { input: A; output: Awaited<R> } : never;
type OperationName<Prefix extends string, P> = { [G in keyof P & string]: `${Prefix}.${G}.${keyof P[G] & string}` }[keyof P & string];

/** The wire operations of a port's groups: `<prefix>.<group>.<method>`, taking the method's argument tuple. */
export type RpcOperations<Prefix extends string, P> = {
  [K in OperationName<Prefix, P>]: K extends `${Prefix}.${infer G}.${infer M}`
    ? G extends keyof P
      ? M extends keyof P[G]
        ? Operation<NonNullable<P[G][M]>>
        : never
      : never
    : never;
};

/**
 * The operations the worker's target cannot serve as they arrive: a method it
 * may lack, wire arguments it does not take, or a result the port does not promise.
 */
type Unservable<Prefix extends string, P, S> = {
  [G in keyof P & string]: {
    [M in keyof P[G] & string]: G extends keyof S
      ? M extends keyof S[G]
        ? NonNullable<P[G][M]> extends (...args: infer A) => infer R
          ? S[G][M] extends (...args: infer B) => infer T
            ? A extends B
              ? Awaited<T> extends Awaited<R>
                ? never
                : `${Prefix}.${G}.${M}`
              : `${Prefix}.${G}.${M}`
            : `${Prefix}.${G}.${M}`
          : never
        : `${Prefix}.${G}.${M}`
      : `${Prefix}.${G}.${M}`;
  }[keyof P[G] & string];
}[keyof P & string];

type Handler<S, O> = O extends { input: infer I; output: infer R } ? (target: S, args: I) => R | Promise<R> : never;

/**
 * How the worker serves the operations its target cannot take as they are:
 * required for those, allowed for any other.
 */
export type RpcOverrides<Prefix extends string, P, S> = {
  readonly [K in Unservable<Prefix, P, S>]: Handler<S, RpcOperations<Prefix, P>[K]>;
} & { readonly [K in keyof RpcOperations<Prefix, P>]?: Handler<S, RpcOperations<Prefix, P>[K]> };

type Call = (operation: string, args: unknown[]) => Promise<unknown>;

/** The client side of a table: every method sends `<prefix>.<group>.<method>` with its argument tuple through `call`. */
export function rpcClient<P>(prefix: string, table: MethodTable<P>, call: Call): P {
  const groups = Object.entries(table) as [string, readonly string[]][];
  return Object.fromEntries(
    groups.map(([group, methods]) => [
      group,
      Object.fromEntries(
        methods.map((method) => {
          const operation = `${prefix}.${group}.${method}`;
          return [method, (...args: unknown[]) => call(operation, args)];
        }),
      ),
    ]),
  ) as P;
}

/** What a facade built by `rpcGroupClass` sends each of its group's operations through. */
export interface RpcSender {
  send(operation: string, args: unknown[]): Promise<unknown>;
}

/**
 * The client side of one group of a table, as a base class: its prototype has
 * one method per name in `methods`, each sending `<prefix>.<group>.<method>`
 * with its argument tuple through the instance's `send`. For a facade that
 * also keeps state and methods of its own; the subclass defines `send`, which
 * adds what its operations carry beside their arguments.
 */
export function rpcGroupClass<P, G extends keyof P & string>(
  prefix: string,
  group: G,
  methods: readonly (keyof P[G] & string)[],
): abstract new () => P[G] & RpcSender {
  abstract class Group {
    abstract send(operation: string, args: unknown[]): Promise<unknown>;
  }
  for (const method of methods) {
    const operation = `${prefix}.${group}.${method}`;
    Object.defineProperty(Group.prototype, method, {
      value(this: Group, ...args: unknown[]) {
        return this.send(operation, args);
      },
      writable: true,
      configurable: true,
    });
  }
  // The prototype now carries every method of `P[G]`, which the class body cannot declare.
  return Group as unknown as abstract new () => P[G] & RpcSender;
}

/**
 * The worker side of a table: dispatches an operation to the target's method
 * of the same group and name, or to its override. Arguments arrive as a tuple;
 * anything else, or an operation the table does not name, is refused.
 */
export function rpcHandlers<Prefix extends string, P, S>(
  prefix: Prefix,
  table: MethodTable<P>,
  overrides: RpcOverrides<Prefix, P, S>,
  refusals: { readonly tuple: string; readonly unknown: string },
): (target: S, operation: string, input: unknown) => unknown {
  type Served = (target: S, args: unknown[]) => unknown;
  const handlers = new Map<string, Served>();
  const custom = overrides as Readonly<Record<string, Served | undefined>>;
  for (const [group, methods] of Object.entries(table) as [string, readonly string[]][]) {
    for (const method of methods) {
      const operation = `${prefix}.${group}.${method}`;
      handlers.set(
        operation,
        custom[operation] ??
          ((target, args) => {
            const service = (target as Record<string, Record<string, ((...args: unknown[]) => unknown) | undefined> | undefined>)[group];
            const handler = service?.[method];
            // The table names each group's methods; a target without one is served nothing, said so.
            if (service === undefined || handler === undefined) throw new TaviError("UNSUPPORTED", `${operation} is not served here`);
            return handler.apply(service, args);
          }),
      );
    }
  }
  return (target, operation, input) => {
    const handler = handlers.get(operation);
    if (handler === undefined) throw new TaviError("INVALID_INPUT", refusals.unknown);
    if (!Array.isArray(input)) throw new TaviError("INVALID_INPUT", refusals.tuple);
    return handler(target, input);
  };
}
