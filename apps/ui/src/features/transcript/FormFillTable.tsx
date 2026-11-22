import type { ReactNode } from "react";

import { useT } from "../../lib/i18n.js";

/**
 * A form fill's table: its Field, Value, Source and Checked columns, with
 * the caller's `<tbody>` rows — the approval card's grouped by page, the review
 * panel's as one list.
 */
export function FormFillTable({ children }: { readonly children: ReactNode }) {
  const t = useT();
  return (
    <table className="form-fill-table">
      <thead>
        <tr>
          <th scope="col">{t("transcript.fill.field")}</th>
          <th scope="col">{t("transcript.fill.value")}</th>
          <th scope="col">{t("transcript.fill.source")}</th>
          <th scope="col">{t("transcript.fill.checked")}</th>
        </tr>
      </thead>
      {children}
    </table>
  );
}
