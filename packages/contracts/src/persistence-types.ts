/** Lease time is evaluated after queueing. Fixed timestamps support events and fixtures. */
export type DatabaseTime = { readonly execution: true } | { readonly fixed: string };
export type PersistenceData<T> = T extends () => string
  ? DatabaseTime
  : T extends ArrayBufferView | ArrayBuffer | Date
    ? T
    : T extends object
      ? { [K in keyof T]: PersistenceData<T[K]> }
      : T;

export type AsyncRepository<T> = {
  [K in keyof T]: T[K] extends (...args: infer A) => infer R ? (...args: PersistenceData<A>) => Promise<Awaited<R>> : T[K];
};
