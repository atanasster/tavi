export default {
  register({ z, secret, registerTool }) {
    registerTool({
      name: "rate",
      inputSchema: z.object({ base: z.string().regex(/^[A-Z]{3}$/), quote: z.string().regex(/^[A-Z]{3}$/) }),
      handler: async ({ base, quote }, { signal }) => {
        const key = await secret("apiKey");
        if (key === null) throw new Error("set the acme.fx apiKey credential first");
        const url = `https://api.example-fx.com/latest?base=${base}&symbols=${quote}`;
        const response = await fetch(url, { headers: { Authorization: `Bearer ${key}` }, signal });
        if (!response.ok) throw new Error(`example-fx answered ${response.status}`);
        const body = await response.json();
        return { base, quote, rate: body.rates?.[quote] ?? null };
      },
    });
  },
};
