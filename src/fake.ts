// Offline stand-in LLM, used ONLY to smoke-test the harness wiring without an API key (`npm run eval -- --dry`).
// Its scores are meaningless by design.
import { LLM, ChatParams, ChatResult } from "./llm";
export class FakeLLM implements LLM {
  async chat(p: ChatParams): Promise<ChatResult> {
    const text = (t: string): ChatResult => ({ content: [{ type: "text", text: t }], stopReason: "end_turn" });
    if (p.system.includes("role-playing")) return text("<END>");
    if (p.system.includes("QA reviewer")) {
      const ids = [...String(p.messages[0].content).matchAll(/^- (\w+):/gm)].map((m) => m[1]);
      return text(JSON.stringify({ results: ids.map((id) => ({ id, pass: true, reason: "dry run" })) }));
    }
    if (p.system.includes("improvement engine")) return text(JSON.stringify({ rules: [], tool_suggestions: [] }));
    return text("Hello! How can I help you today?");
  }
}
