import { PLAN_MARKS, type PlanItem } from "@tavi/contracts";

import { useT } from "../../lib/i18n.js";

/** A plan the model keeps, as a checklist: in the chat panel's Activity tab, and in a worker's view, which has no panel. */
export function PlanCard({ plan }: { readonly plan: readonly PlanItem[] }) {
  const t = useT();
  return (
    <section className="plan-card" aria-label={t("chat.plan.label")}>
      <h4>{t("chat.plan.heading")}</h4>
      <ul className="list-reset">
        {plan.map((item, index) => (
          <li key={index} className={`plan-${item.status}`}>
            {PLAN_MARKS[item.status]} {item.content}
          </li>
        ))}
      </ul>
    </section>
  );
}
