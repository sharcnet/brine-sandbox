// Pi extension, loaded read-only from this repo. Registers Brine against this launch's nono
// proxy route, so nothing launch-specific is written to disk and concurrent launches don't
// clash. BRINE_BASE_URL is the route and BRINE_API_KEY a per-session token, not the real key.
import { existsSync, writeFileSync } from "node:fs";

const preferred = "Qwen3.8-27B";

export default async function (pi) {
  const baseUrl = process.env.BRINE_BASE_URL;
  const res = await fetch(baseUrl + "/models", { headers: { Authorization: "Bearer " + process.env.BRINE_API_KEY } });
  if (!res.ok) throw new Error(`Brine returned ${res.status} for /models. Check your key.`);
  const models = (await res.json()).data.map((m) => m.id).filter((id) => !/embed|whisper/i.test(id));

  pi.registerProvider("brine", {
    name: "Brine",
    baseUrl,
    apiKey: "$BRINE_API_KEY",
    api: "openai-completions",
    // The same defaults Pi applies to models.json entries.
    models: models.map((id) => ({
      id,
      name: id,
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128000,
      maxTokens: 16384,
    })),
  });

  // Only on a project's first run, so a model picked later with /model sticks.
  const settings = process.env.PI_CODING_AGENT_DIR + "/settings.json";
  if (!existsSync(settings)) {
    const defaultModel = models.includes(preferred) ? preferred : models[0];
    writeFileSync(settings, JSON.stringify({ defaultProvider: "brine", defaultModel }, null, 2));
  }
}
