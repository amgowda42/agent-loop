import fs from "node:fs";
import { makeLLM, LLM, MODELS } from "./llm";
import { FakeLLM } from "./fake";
import { seed } from "./db";
import { Agent, ToolCall } from "./agent";
import { buildSystem, loadPlaybook, Playbook } from "./playbook";
import { SCENARIOS, Scenario, Check, genericChecks } from "./scenarios";
import { patientReply, Turn } from "./patientSim";
import { judge, RubricResult } from "./judge";

export interface TrialResult { scenarioId: string; pass: boolean; score: number; checks: Check[]; rubric: RubricResult[]; convo: Turn[]; trace: ToolCall[]; error?: string }
export interface ScenarioResult { id: string; split: string; title: string; passRate: number; avgScore: number; trials: TrialResult[] }
export interface Agg { passRate: number; avgScore: number }
export interface SuiteResult { rulesVersion: number; trials: number; scenarios: ScenarioResult[]; summary: { all: Agg; train: Agg; heldout: Agg } }

export async function runTrial(sc: Scenario, pb: Playbook | null, llm: LLM): Promise<TrialResult> {
  const world = seed(sc.faults ?? {});
  const agent = new Agent(llm, world, buildSystem(world.now, pb), MODELS.agent);
  const convo: Turn[] = []; const turns: string[] = [];
  try {
    let msg: string | null = sc.opening;
    for (let t = 0; t < (sc.maxTurns ?? 8) && msg; t++) {
      convo.push({ who: "patient", text: msg });
      const reply = await agent.respond(msg);
      turns.push(reply); convo.push({ who: "clinic", text: reply });
      msg = await patientReply(llm, sc.persona, convo);
    }
    const checks = [...sc.checks({ world, trace: agent.trace, turns }), ...genericChecks({ world, trace: agent.trace, turns })];
    const rubric = await judge(llm, sc.rubric, convo, agent.trace);
    const items = [...checks.map((c) => c.pass), ...rubric.map((r) => r.pass)];
    return { scenarioId: sc.id, pass: items.every(Boolean), score: items.filter(Boolean).length / items.length, checks, rubric, convo, trace: agent.trace };
  } catch (e: any) {
    return { scenarioId: sc.id, pass: false, score: 0, checks: [], rubric: [], convo, trace: agent.trace, error: String(e?.message ?? e) };
  }
}

async function pool<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k]); } }));
  return out;
}
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const agg = (rs: ScenarioResult[]): Agg => ({ passRate: mean(rs.map((r) => r.passRate)), avgScore: mean(rs.map((r) => r.avgScore)) });

export async function runSuite(opts: { pb: Playbook | null; scenarios?: Scenario[]; trials?: number; llm: LLM; concurrency?: number; quiet?: boolean }): Promise<SuiteResult> {
  const scenarios = opts.scenarios ?? SCENARIOS; const trials = opts.trials ?? 3;
  const jobs = scenarios.flatMap((s) => Array.from({ length: trials }, () => s));
  const results = await pool(jobs, opts.concurrency ?? Number(process.env.CONCURRENCY ?? 4), async (s) => { const r = await runTrial(s, opts.pb, opts.llm); if (!opts.quiet) process.stdout.write(r.pass ? "." : "x"); return r; });
  if (!opts.quiet) process.stdout.write("\n");
  const scen: ScenarioResult[] = scenarios.map((s) => {
    const ts = results.filter((r) => r.scenarioId === s.id);
    return { id: s.id, split: s.split, title: s.title, passRate: mean(ts.map((t) => (t.pass ? 1 : 0))), avgScore: mean(ts.map((t) => t.score)), trials: ts };
  });
  return { rulesVersion: opts.pb?.version ?? -1, trials, scenarios: scen, summary: { all: agg(scen), train: agg(scen.filter((s) => s.split === "train")), heldout: agg(scen.filter((s) => s.split === "heldout")) } };
}

export function formatSuite(r: SuiteResult, label: string): string {
  const pct = (x: number) => (x * 100).toFixed(0).padStart(3) + "%";
  const lines = [`\n=== ${label} (playbook v${r.rulesVersion}, ${r.trials} trials/scenario) ===`];
  for (const s of r.scenarios) {
    const failed = new Set<string>(); s.trials.forEach((t) => { t.checks.filter((c) => !c.pass).forEach((c) => failed.add(c.id)); t.rubric.filter((q) => !q.pass).forEach((q) => failed.add("judge:" + q.id)); if (t.error) failed.add("ERROR"); });
    lines.push(`${s.passRate === 1 ? "PASS" : "FAIL"} ${pct(s.passRate)}  [${s.split.padEnd(7)}] ${s.id.padEnd(18)} ${failed.size ? "<- " + [...failed].join(", ") : ""}`);
  }
  const f = (a: Agg) => `pass ${pct(a.passRate)} | partial-credit ${pct(a.avgScore)}`;
  lines.push(`TRAIN   ${f(r.summary.train)}`, `HELDOUT ${f(r.summary.heldout)}`, `ALL     ${f(r.summary.all)}`);
  return lines.join("\n");
}

if (process.argv[1]?.endsWith("eval.ts")) {
  const a = process.argv.slice(2); const arg = (k: string) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : undefined; };
  const dry = a.includes("--dry"); const trials = Number(arg("--trials") ?? 3); const only = arg("--scenario"); const split = arg("--split");
  const scenarios = SCENARIOS.filter((s) => (!only || s.id === only) && (!split || split === "all" || s.split === split));
  const pb = a.includes("--no-rules") ? null : loadPlaybook();
  const llm = dry ? new FakeLLM() : makeLLM();
  const res = await runSuite({ pb, scenarios, trials, llm });
  console.log(formatSuite(res, a.includes("--no-rules") ? "baseline (no playbook)" : "current playbook"));
  fs.mkdirSync("runs", { recursive: true }); fs.writeFileSync("runs/last-eval.json", JSON.stringify(res, null, 2));
  if (only) for (const t of res.scenarios[0].trials.slice(0, 1)) console.log("\n--- sample transcript ---\n" + t.convo.map((c) => `${c.who}: ${c.text}`).join("\n"));
}
