// Runs inside the sandbox before Pi starts. BRINE_BASE_URL is this session's nono proxy route
// and BRINE_API_KEY is a per-session token, not the real key.
import { existsSync, writeFileSync } from "node:fs";

const dir = process.env.PI_CODING_AGENT_DIR;
const baseUrl = process.env.BRINE_BASE_URL;
const preferred = "Qwen3.8-27B";

const res = await fetch(baseUrl + "/models", { headers: { Authorization: "Bearer " + process.env.BRINE_API_KEY } });
if (!res.ok) {
  console.error(`brine-sandbox: Brine returned ${res.status} for /models. Check your key.`);
  process.exit(1);
}
const models = (await res.json()).data.map((m) => m.id).filter((id) => !/embed|whisper/i.test(id));

const provider = { baseUrl, apiKey: "$BRINE_API_KEY", api: "openai-completions", models: models.map((id) => ({ id })) };
writeFileSync(dir + "/models.json", JSON.stringify({ providers: { brine: provider } }, null, 2));

// Only on first run, so a model picked later with /model sticks.
if (!existsSync(dir + "/settings.json")) {
  const defaultModel = models.includes(preferred) ? preferred : models[0];
  writeFileSync(dir + "/settings.json", JSON.stringify({ defaultProvider: "brine", defaultModel }, null, 2));
}
