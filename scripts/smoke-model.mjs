import { loadEnv } from "./load-env.mjs";
loadEnv();
const { generateText, activeProvider, modelLabel } = await import("../lib/model.ts");
console.log("provider:", activeProvider(), "| model:", modelLabel("ranking"));
const t0 = Date.now();
const out = await generateText({ system: "Reply with exactly one word and nothing else.", prompt: "Say OK.", maxTokens: 50 });
console.log(`response in ${Date.now() - t0}ms:`, JSON.stringify(out.slice(0, 200)));
