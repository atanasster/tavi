import { Fragment } from "react";

/**
 * A command shown inline, as `tavi reset --yes`: it wraps only between its
 * words, never at the hyphen of a flag, and reads and copies as typed.
 */
export function Command({ children }: { readonly children: string }) {
  return (
    <code className="command">
      {children.split(" ").map((word, index) => (
        // A command's words are positional: the index is the word's identity.
        <Fragment key={index}>
          {index === 0 ? "" : " "}
          <span className="command-word">{word}</span>
        </Fragment>
      ))}
    </code>
  );
}
