import readline from "node:readline/promises";
import { makeLLM, MODELS } from "./llm";
import { seed } from "./db";
import { Agent } from "./agent";
import { buildSystem, loadPlaybook } from "./playbook";

const noRules = process.argv.includes("--no-rules");
const world = seed();
const agent = new Agent(makeLLM(), world, buildSystem(world.now, noRules ? null : loadPlaybook()), MODELS.agent,
  (t) => console.log(`\x1b[2m  ⚙ ${t.name}(${JSON.stringify(t.input)}) -> ${JSON.stringify(t.result)}\x1b[0m`));
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
console.log(`Lakeside Family Clinic assistant${noRules ? " (baseline: no playbook)" : ""}. Demo patients: Priya Nair 1990-04-12 | Rahul Verma 1985-11-02 | Meera Joshi 1978-01-30. Ctrl-C to quit.\n`);
for (;;) {
  const u = await rl.question("you> ");
  try { console.log("\nclinic> " + (await agent.respond(u)) + "\n"); } catch (e: any) { console.error("\n[error] " + e.message + "\n"); }
}
