import { Fragment, type ReactNode } from "react";

/**
 * A message whose `{name}`s are elements (a command, a link, a code): each
 * in the place its language puts it, the words around it as they are.
 */
export function withParts(message: string, parts: { readonly [name: string]: ReactNode }): ReactNode {
  return message
    .split(/\{([A-Za-z][A-Za-z0-9_]*)\}/)
    .map((piece, index) =>
      index % 2 === 0 ? piece : <Fragment key={index}>{Object.hasOwn(parts, piece) ? parts[piece] : `{${piece}}`}</Fragment>,
    );
}
