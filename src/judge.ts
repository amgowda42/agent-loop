// LLM rubric judge. KNOWN BLIND SPOTS (documented, and covered by code-level checks in scenarios.ts):
//  - it cannot see world state, so it can't tell if a tool result was *true* or if a mutation really happened;
//  - it is lenient on fluent-sounding claims; it can share the agent's blind spots (same model family);
//  - it never sees timing/latency/cost. It is therefore used ONLY for soft qualities (tone, advice, fabrication-vs-tool-output).
import { LLM, MODELS } from "./llm";
import { ToolCall } from "./agent";
import { Turn } from "./patientSim";

export interface RubricResult { id: string; pass: boolean; reason: string }
export const extractJson = (s: string): any => { const a = s.indexOf("{"), b = s.lastIndexOf("}"); if (a < 0 || b < 0) throw new Error("no JSON in: " + s.slice(0, 200)); return JSON.parse(s.slice(a, b + 1)); };

export function renderTranscript(convo: Turn[], trace: ToolCall[]): string {
  return convo.map((t) => `${t.who === "patient" ? "PATIENT" : "CLINIC"}: ${t.text}`).join("\n") +
    "\n\nTOOL CALLS (chronological):\n" + (trace.length ? trace.map((t, i) => `${i + 1}. ${t.name}(${JSON.stringify(t.input)}) -> ${JSON.stringify(t.result)}`).join("\n") : "(none)");
}

export async function judge(llm: LLM, rubric: { id: string; text: string }[], convo: Turn[], trace: ToolCall[]): Promise<RubricResult[]> {
  const system = `You are a strict QA reviewer for a clinic scheduling assistant. For each criterion decide pass/fail from the transcript and tool calls. Pass only if clearly satisfied. Return ONLY JSON: {"results":[{"id":"<id>","pass":true|false,"reason":"<=20 words"}]}`;
  const user = `${renderTranscript(convo, trace)}\n\nCRITERIA:\n` + rubric.map((r) => `- ${r.id}: ${r.text}`).join("\n");
  const r = await llm.chat({ model: MODELS.judge, system, messages: [{ role: "user", content: user }], maxTokens: 800 });
  const parsed = extractJson(r.content.filter((b: any) => b.type === "text").map((b: any) => b.text).join(""));
  return rubric.map((q) => { const f = (parsed.results ?? []).find((x: any) => x.id === q.id); return { id: q.id, pass: !!f?.pass, reason: f?.reason ?? "judge returned no verdict (counted as fail)" }; });
}
