/**
 * A replacement for the built-in daily brief (`tavi.collectors`, whose
 * `collect.daily` and `reports.generate` read configured projects'
 * providers): `acme.dailybrief.brief` takes the figures it is given and
 * writes the day's brief from them — each figure's change, the largest
 * movers first — as text and as a small HTML report. It reads and sends
 * nothing (`sink: "none"`).
 */

const escape = (text) =>
  String(text).replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);

const percent = (now, before) => (before === 0 ? undefined : Math.round(((now - before) / Math.abs(before)) * 1000) / 10);

export default {
  register({ z, registerTool }) {
    registerTool({
      name: "brief",
      inputSchema: z.object({
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        figures: z
          .array(z.object({ name: z.string().min(1).max(80), today: z.number(), yesterday: z.number() }))
          .min(1)
          .max(50),
      }),
      handler: async ({ date, figures }) => {
        const rows = figures
          .map((figure) => ({ ...figure, change: figure.today - figure.yesterday, percent: percent(figure.today, figure.yesterday) }))
          .sort((left, right) => Math.abs(right.percent ?? Infinity) - Math.abs(left.percent ?? Infinity));
        const line = (row) =>
          `${row.name}: ${row.today} (${row.change >= 0 ? "+" : ""}${row.change}${row.percent === undefined ? "" : `, ${row.percent >= 0 ? "+" : ""}${row.percent}%`})`;
        const text = [`Daily brief for ${date}`, ...rows.map((row) => `- ${line(row)}`)].join("\n");
        const html = `<h1>Daily brief for ${escape(date)}</h1><ul>${rows.map((row) => `<li>${escape(line(row))}</li>`).join("")}</ul>`;
        return { date, text, html, figures: rows };
      },
    });
  },
};
