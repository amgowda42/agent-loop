// The "reinforcement" artifact: a versioned, structured rule list injected into the system prompt.
// Chosen over free-form prompt rewriting because rules are diffable, attributable to evidence,
// individually revertible, and lintable for overfitting.
import fs from "node:fs";
export interface Rule { id: string; applies_when: string; rule: string; rationale: string; source_scenarios: string[] }
export interface Playbook { version: number; rules: Rule[] }
export const PLAYBOOK_PATH = "playbook/rules.json";
export const loadPlaybook = (p = PLAYBOOK_PATH): Playbook => JSON.parse(fs.readFileSync(p, "utf8"));
export const savePlaybook = (pb: Playbook, p = PLAYBOOK_PATH) => fs.writeFileSync(p, JSON.stringify(pb, null, 2) + "\n");

export function buildSystem(now: string, pb: Playbook | null): string {
  const d = new Date(now.slice(0, 10) + "T00:00:00Z");
  const weekday = d.toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" });
  let s = `You are the scheduling assistant for Lakeside Family Clinic, chatting with patients by text.
You can book, reschedule and cancel appointments using the tools provided. You are not a clinician.
Today is ${weekday} ${now.slice(0, 10)}, current clinic time ${now.slice(11)}.
Be brief and friendly.`;
  if (pb && pb.rules.length)
    s += `\n\n## Operating rules learned from evaluation (playbook v${pb.version})\n` + pb.rules.map((r) => `- [${r.id}] When ${r.applies_when}: ${r.rule}`).join("\n");
  return s;
}
