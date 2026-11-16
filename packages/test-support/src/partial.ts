/**
 * A port of which a test implements only the members it exercises. The
 * members given are checked against `T`; any other is absent, as on a
 * hand-written object, so the code under test calling one fails the test
 * where an `as unknown as` cast would also have let a wrong member through.
 */
export function partialFake<T extends object>(members: Partial<T>): T {
  return members as T;
}
