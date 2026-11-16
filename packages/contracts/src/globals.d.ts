/**
 * Minimal platform-neutral ambient declarations.
 *
 * `contracts` deliberately does not load `lib.dom` or `@types/node`:
 * it must compile without Node or browser ambient types. These two WHATWG
 * globals are the only platform facilities the contracts actually name, so they
 * are declared structurally here rather than pulling in an entire host library.
 */

declare global {
  interface AbortSignal {
    readonly aborted: boolean;
    readonly reason?: unknown;
    addEventListener(type: "abort", listener: () => void, options?: { once?: boolean }): void;
    removeEventListener(type: "abort", listener: () => void): void;
  }

  // eslint-disable-next-line no-var
  var AbortSignal: {
    prototype: AbortSignal;
    new (): AbortSignal;
    abort(reason?: unknown): AbortSignal;
  };

  class TextEncoder {
    encode(input?: string): Uint8Array;
  }

  class TextDecoder {
    /**
     * The label is part of the WHATWG constructor; the shared frame codec names
     * its encoding explicitly rather than relying on a host default.
     */
    constructor(label?: string, options?: { fatal?: boolean; ignoreBOM?: boolean });
    decode(input?: Uint8Array): string;
  }
}

export {};
