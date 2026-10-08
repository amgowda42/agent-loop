import { LLM, MODELS } from "./llm";
export interface Turn { who: "patient" | "clinic"; text: string }

/** Simulated patient. Returns null when the persona is done. */
export async function patientReply(llm: LLM, persona: string, convo: Turn[]): Promise<string | null> {
  const system = `You are role-playing a patient texting a clinic's scheduling assistant.
Persona: ${persona}
Rules: reply with ONLY the patient's next chat message (1-2 sentences, natural, in character). Share personal details only when asked. Never help the assistant do its job or hint at correct behaviour. If your goal is complete, or the assistant has clearly refused and you have nothing more to ask, reply exactly: <END>`;
  const text = "Conversation so far:\n" + convo.map((t) => `${t.who === "patient" ? "Patient" : "Clinic"}: ${t.text || "(no reply)"}`).join("\n") + "\n\nWrite the patient's next message.";
  const r = await llm.chat({ model: MODELS.patient, system, messages: [{ role: "user", content: text }], maxTokens: 200 });
  const out = r.content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("").trim();
  return !out || out.includes("<END>") ? null : out;
}
