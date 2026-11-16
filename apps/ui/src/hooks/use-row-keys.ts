import { useRef } from "react";

/**
 * Stable keys for a list's rows when nothing in a row can be its key: each
 * object gets a number on first sight, kept for as long as it is in the list,
 * and `carry` hands it on to an edited copy. A removed row's key goes with it,
 * so the rows after it keep their own controls — which an index would not.
 */
export function useRowKeys<T extends object>(): { readonly keyOf: (row: T) => number; readonly carry: (from: T, to: T) => T } {
  const keys = useRef<{ next: number; readonly of: WeakMap<T, number> }>({ next: 0, of: new WeakMap() }).current;
  const keyOf = (row: T): number => {
    let key = keys.of.get(row);
    if (key === undefined) {
      key = keys.next;
      keys.next += 1;
      keys.of.set(row, key);
    }
    return key;
  };
  const carry = (from: T, to: T): T => {
    keys.of.set(to, keyOf(from));
    return to;
  };
  return { keyOf, carry };
}
