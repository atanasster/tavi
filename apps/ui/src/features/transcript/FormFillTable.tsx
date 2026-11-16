import type { ReactNode } from "react";

/**
 * A form fill's table: its Field, Value, Source and Checked columns, with
 * the caller's `<tbody>` rows — the approval card's grouped by page, the review
 * panel's as one list.
 */
export function FormFillTable({ children }: { readonly children: ReactNode }) {
  return (
    <table className="form-fill-table">
      <thead>
        <tr>
          <th scope="col">Field</th>
          <th scope="col">Value</th>
          <th scope="col">Source</th>
          <th scope="col">Checked</th>
        </tr>
      </thead>
      {children}
    </table>
  );
}
