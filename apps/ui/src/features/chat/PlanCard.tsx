import { PLAN_MARKS, type PlanItem } from "@tavi/contracts";

/** A plan the model keeps, as a checklist: in the chat panel's Activity tab, and in a worker's view, which has no panel. */
export function PlanCard({ plan }: { readonly plan: readonly PlanItem[] }) {
  return (
    <section className="plan-card" aria-label="plan">
      <h4>Plan</h4>
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
