// index.mjs
const RATES = { "km>mi": 0.621371, "mi>km": 1.609344, "kg>lb": 2.204623, "lb>kg": 0.453592 };

export default {
  register({ z, registerTool }) {
    registerTool({
      name: "convert",
      inputSchema: z.object({
        value: z.number(),
        from: z.enum(["km", "mi", "kg", "lb", "C", "F"]),
        to: z.enum(["km", "mi", "kg", "lb", "C", "F"]),
      }),
      handler: async ({ value, from, to }) => {
        if (from === to) return { value };
        if (from === "C" && to === "F") return { value: (value * 9) / 5 + 32 };
        if (from === "F" && to === "C") return { value: ((value - 32) * 5) / 9 };
        const rate = RATES[`${from}>${to}`];
        if (rate === undefined) throw new Error(`cannot convert ${from} to ${to}`);
        return { value: value * rate };
      },
    });
  },
};
