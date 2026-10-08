import { LLM, Msg, Block } from "./llm";
import { World } from "./db";
import { TOOL_DEFS, execTool, newSession, Session } from "./tools";

export interface ToolCall { name: string; input: any; result: any }
export class Agent {
  messages: Msg[] = []; trace: ToolCall[] = []; session: Session = newSession();
  constructor(private llm: LLM, private world: World, private system: string, private model: string, private onTool?: (t: ToolCall) => void) {}

  /** One patient turn -> everything the patient sees from the assistant this turn. */
  async respond(userText: string): Promise<string> {
    this.messages.push({ role: "user", content: userText });
    const spoken: string[] = [];
    for (let step = 0; step < 8; step++) {
      const r = await this.llm.chat({ model: this.model, system: this.system, messages: this.messages, tools: TOOL_DEFS });
      this.messages.push({ role: "assistant", content: r.content });
      spoken.push(...r.content.filter((b: Block) => b.type === "text").map((b: Block) => b.text.trim()).filter(Boolean));
      const uses = r.content.filter((b: Block) => b.type === "tool_use");
      if (!uses.length) return spoken.join("\n");
      const results = uses.map((u: Block) => {
        const result = execTool(this.world, this.session, u.name, u.input);
        const tc = { name: u.name, input: u.input, result };
        this.trace.push(tc); this.onTool?.(tc);
        return { type: "tool_result", tool_use_id: u.id, content: JSON.stringify(result) };
      });
      this.messages.push({ role: "user", content: results });
    }
    spoken.push("Sorry, I'm having trouble with that. Please contact our front desk."); // step budget exhausted
    return spoken.join("\n");
  }
}
