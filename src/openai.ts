// Adapter for any OpenAI-compatible chat API (Groq, Gemini's OpenAI endpoint, OpenRouter, Ollama...).
// Internally the project speaks Anthropic-style content blocks; this converts both ways.
import type { LLM, ChatParams, ChatResult, Block } from "./llm";

export class OpenAICompatLLM implements LLM {
  constructor(private baseUrl: string, private apiKey: string) {}

  private convert(p: ChatParams): any[] {
    const out: any[] = [{ role: "system", content: p.system }];
    for (const m of p.messages) {
      if (typeof m.content === "string") { out.push({ role: m.role, content: m.content }); continue; }
      if (m.role === "assistant") {
        const text = m.content.filter((b: Block) => b.type === "text").map((b: Block) => b.text).join("\n");
        const calls = m.content.filter((b: Block) => b.type === "tool_use").map((b: Block) => ({ id: b.id, type: "function", function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) }, ...(b.extra_content ? { extra_content: b.extra_content } : {}) }));
        out.push({ role: "assistant", content: text || null, ...(calls.length ? { tool_calls: calls } : {}) });
      } else {
        for (const b of m.content) {
          if (b.type === "tool_result") out.push({ role: "tool", tool_call_id: b.tool_use_id, content: typeof b.content === "string" ? b.content : JSON.stringify(b.content) });
          else if (b.type === "text") out.push({ role: "user", content: b.text });
        }
      }
    }
    return out;
  }

  async chat(p: ChatParams): Promise<ChatResult> {
    const body: any = { model: p.model, messages: this.convert(p), max_tokens: p.maxTokens ?? 1024, temperature: 0 };
    if (p.tools?.length) body.tools = p.tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.input_schema } }));
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(this.baseUrl.replace(/\/$/, "") + "/chat/completions", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.apiKey}` }, body: JSON.stringify(body) });
      if ((res.status === 429 || res.status >= 500) && attempt < 8) { // free tiers rate-limit: back off and retry
        const wait = Number(res.headers.get("retry-after")) * 1000 || Math.min(2000 * 2 ** attempt, 30000);
        await new Promise((r) => setTimeout(r, wait)); continue;
      }
      if (!res.ok) throw new Error(`LLM HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
      const j: any = await res.json(); const msg = j.choices?.[0]?.message ?? {};
      const content: Block[] = [];
      if (msg.content) content.push({ type: "text", text: String(msg.content) });
      for (const tc of msg.tool_calls ?? []) {
        let input: any = {}; try { input = JSON.parse(tc.function.arguments || "{}"); } catch { /* model emitted bad JSON; tool will reject missing fields */ }
        content.push({ type: "tool_use", id: tc.id, name: tc.function.name, input, ...(tc.extra_content ? { extra_content: tc.extra_content } : {}) });
      }
      return { content, stopReason: j.choices?.[0]?.finish_reason ?? null };
    }
  }
}
