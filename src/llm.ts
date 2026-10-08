import Anthropic from "@anthropic-ai/sdk";
import { OpenAICompatLLM } from "./openai";
export type Block = any;
export type Msg = { role: "user" | "assistant"; content: string | Block[] };
export interface ChatParams { model: string; system: string; messages: Msg[]; tools?: any[]; maxTokens?: number }
export interface ChatResult { content: Block[]; stopReason: string | null }
export interface LLM { chat(p: ChatParams): Promise<ChatResult> }

// Agent is deliberately a smaller model than judge/reflector: a stronger reviewer than the thing reviewed.
export const MODELS = {
  agent: process.env.AGENT_MODEL ?? "claude-haiku-4-5-20251001",
  patient: process.env.PATIENT_MODEL ?? "claude-haiku-4-5-20251001",
  judge: process.env.JUDGE_MODEL ?? "claude-sonnet-5-5",
  reflector: process.env.REFLECTOR_MODEL ?? "claude-sonnet-5-5",
};

export class AnthropicLLM implements LLM {
  private client = new Anthropic({ maxRetries: 6 });
  async chat(p: ChatParams): Promise<ChatResult> {
    const r = await this.client.messages.create({
      model: p.model, max_tokens: p.maxTokens ?? 1024, system: p.system,
      messages: p.messages as any, ...(p.tools ? { tools: p.tools as any } : {}),
    });
    // normalise blocks so we only ever replay fields the API accepts
    const content: Block[] = (r.content as any[]).flatMap((b: any): Block[] =>
      b.type === "text" ? [{ type: "text", text: b.text }] :
      b.type === "tool_use" ? [{ type: "tool_use", id: b.id, name: b.name, input: b.input }] : []);
    return { content, stopReason: r.stop_reason };
  }
}

/** PROVIDER=anthropic (default) | openai  (OpenAI-compatible: Groq / Gemini / OpenRouter / Ollama via LLM_BASE_URL + LLM_API_KEY) */
export function makeLLM(): LLM {
  if ((process.env.PROVIDER ?? "anthropic") === "openai") {
    const base = process.env.LLM_BASE_URL, key = process.env.LLM_API_KEY ?? "none";
    if (!base) throw new Error("PROVIDER=openai requires LLM_BASE_URL (and LLM_API_KEY, except for local Ollama). See README.");
    return new OpenAICompatLLM(base, key);
  }
  return new AnthropicLLM();
}
