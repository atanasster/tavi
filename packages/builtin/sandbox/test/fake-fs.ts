import type { CompileFs } from "../src/policy-compile.js";

/** A fake filesystem for the policy compiler's tests (and the golden configs): Linux's literal expansion checked on any host. */

export type Node =
  | { readonly kind: "file"; readonly text?: string }
  | { readonly kind: "directory" }
  | { readonly kind: "symlink"; readonly to: string };

/** A filesystem of absolute paths; every ancestor of an entry is a directory. */
export function fakeFs(
  entries: Readonly<Record<string, Node>>,
  options: { readonly folding?: readonly string[]; readonly unlistable?: readonly string[] } = {},
): CompileFs & { readonly listed: string[] } {
  const nodes = new Map<string, Node>(Object.entries(entries));
  for (const path of Object.keys(entries)) {
    for (let parent = path.slice(0, path.lastIndexOf("/")); parent.length > 0; parent = parent.slice(0, parent.lastIndexOf("/"))) {
      if (!nodes.has(parent)) nodes.set(parent, { kind: "directory" });
    }
  }
  const listed: string[] = [];
  const realOf = (path: string): string | undefined => {
    const node = nodes.get(path);
    if (node === undefined) return undefined;
    return node.kind === "symlink" ? realOf(node.to) : path;
  };
  return {
    listed,
    kind: (path) => nodes.get(path)?.kind,
    list: (path) => {
      listed.push(path);
      if ((options.unlistable ?? []).includes(path)) return undefined;
      return [...nodes.keys()]
        .filter((candidate) => candidate.startsWith(`${path}/`) && !candidate.slice(path.length + 1).includes("/"))
        .map((candidate) => candidate.slice(path.length + 1));
    },
    link: (path) => {
      const node = nodes.get(path);
      return node?.kind === "symlink" ? node.to : undefined;
    },
    read: (path) => {
      const real = realOf(path);
      const node = real === undefined ? undefined : nodes.get(real);
      return node?.kind === "file" ? node.text : undefined;
    },
    real: realOf,
    foldsCase: (path) => (options.folding ?? []).includes(path),
  };
}
