/**
 * One place that talks to a model. Two providers are supported so the ranking
 * and drafting calls can run on whichever key is available.
 *
 * The brief specifies the Claude API. Gemini is here because that is the key
 * available on this machine; set MODEL_PROVIDER=anthropic to switch back with
 * no code change.
 */

export type Provider = "anthropic" | "gemini";

const GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/interactions";

export function activeProvider(): Provider {
  const forced = process.env.MODEL_PROVIDER?.toLowerCase();
  if (forced === "anthropic" || forced === "gemini") return forced;
  if (process.env.ANTHROPIC_API_KEY) return "anthropic";
  if (process.env.GEMINI_API_KEY) return "gemini";
  return "anthropic";
}

export function hasKey(provider: Provider = activeProvider()): boolean {
  return provider === "anthropic"
    ? !!process.env.ANTHROPIC_API_KEY
    : !!process.env.GEMINI_API_KEY;
}

type Tier = "ranking" | "drafting";

export function modelName(tier: Tier, provider: Provider = activeProvider()): string {
  if (provider === "anthropic") {
    return tier === "ranking"
      ? (process.env.ANTHROPIC_MODEL ?? "claude-opus-5")
      : (process.env.ANTHROPIC_DRAFT_MODEL ?? "claude-sonnet-5");
  }
  return tier === "ranking"
    ? (process.env.GEMINI_MODEL ?? "gemini-3.8-flash")
    : (process.env.GEMINI_DRAFT_MODEL ?? process.env.GEMINI_MODEL ?? "gemini-3.8-flash");
}

/** What actually ran, recorded in the run file so a result is attributable. */
export function modelLabel(tier: Tier, provider: Provider = activeProvider()): string {
  return `${provider}:${modelName(tier, provider)}`;
}

async function callAnthropic(
  system: string,
  prompt: string,
  maxTokens: number,
  tier: Tier,
): Promise<string> {
  const Anthropic = (await import("@anthropic-ai/sdk")).default;
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const res = await client.messages.create({
    model: modelName(tier, "anthropic"),
    max_tokens: maxTokens,
    system,
    messages: [{ role: "user", content: prompt }],
  });
  return res.content
    .map((b) => (b.type === "text" ? b.text : ""))
    .join("");
}

/**
 * Gemini's Interactions API takes a single `input` string and has no separate
 * system field, so the system prompt is prepended. No tools are passed: this
 * task reads the CVs it is given and must not go looking for candidates online.
 */
async function callGemini(system: string, prompt: string): Promise<string> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY is not set.");

  const body = JSON.stringify({
    model: modelName("ranking", "gemini"),
    input: `${system}\n\n---\n\n${prompt}`,
    tools: [],
  });

  let lastError = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(GEMINI_URL, {
      method: "POST",
      headers: { "x-goog-api-key": key, "Content-Type": "application/json" },
      body,
    });

    if (res.ok) {
      const data = (await res.json()) as {
        steps?: { type?: string; content?: { type?: string; text?: string }[] }[];
      };
      const text = (data.steps ?? [])
        .filter((s) => s.type === "model_output")
        .flatMap((s) => s.content ?? [])
        .filter((c) => c.type === "text")
        .map((c) => c.text ?? "")
        .join("\n")
        .trim();
      if (text) return text;
      throw new Error("Gemini returned no model_output text.");
    }

    lastError = `HTTP ${res.status}: ${(await res.text().catch(() => "")).slice(0, 400)}`;
    if (![429, 500, 502, 503, 504].includes(res.status)) break;
    await new Promise((r) => setTimeout(r, 4000 * (attempt + 1)));
  }
  throw new Error(`Gemini call failed. ${lastError}`);
}

export async function generateText(opts: {
  system: string;
  prompt: string;
  maxTokens?: number;
  tier?: Tier;
}): Promise<string> {
  const { system, prompt, maxTokens = 16000, tier = "ranking" } = opts;
  const provider = activeProvider();
  if (!hasKey(provider)) {
    throw new Error(
      provider === "anthropic" ? "ANTHROPIC_API_KEY is not set." : "GEMINI_API_KEY is not set.",
    );
  }
  return provider === "anthropic"
    ? callAnthropic(system, prompt, maxTokens, tier)
    : callGemini(system, prompt);
}
