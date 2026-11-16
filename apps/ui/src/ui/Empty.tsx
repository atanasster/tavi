import type { ReactNode } from "react";

/** What a list, a tab or a panel says when it has nothing to show; `className` is its place's own class beside `empty`. */
export function Empty({ className, children }: { readonly className?: string; readonly children: ReactNode }) {
  return <p className={className === undefined ? "empty" : `empty ${className}`}>{children}</p>;
}

/** A page with nothing in it yet: what it is for, and what to do first. */
export function EmptyState({ title, children }: { readonly title: string; readonly children: ReactNode }) {
  return (
    <div className="empty-state">
      <h2>{title}</h2>
      {children}
    </div>
  );
}
