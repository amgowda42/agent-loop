// The improvement loop:  run -> find failures -> reflect into STRUCTURED rules -> lint -> apply -> re-run -> gate (accept/rollback).
import fs from "node:fs";
import "./config";
import { makeLLM, LLM, MODELS } from "./llm";
import { FakeLLM } from "./fake";
import { runSuite, formatSuite, SuiteResult, ScenarioResult } from "./eval";
import { Playbook, Rule, loadPlaybook, savePlaybook } from "./playbook";
import { SCENARIOS } from "./scenarios";
import { extractJson, renderTranscript } from "./judge";

const MAX_RULES = 12;
const OVERFIT = new RegExp(
  `\\b(P\\d|A\\d|S-D\\d|T\\d)\\b|Priya|Rahul|Meera|Nair|Verma|Joshi|Dr\\.? ?(Rao|Iyer|Mehta|Shah)|${SCENARIOS.map((s) => s.id).join("|")}`,
  "i",
);

export async function reflect(
  llm: LLM,
  base: SuiteResult,
  pb: Playbook,
): Promise<{ rules: Rule[]; suggestions: string[]; rawFailures: string[] }> {
  // Only TRAIN failures are visible to the reflector. Held-out scenarios exist to detect overfitting.
  const failing = base.scenarios
    .filter((s) => s.split === "train" && s.passRate < 1)
    .slice(0, 5);
  const rawFailures = failing.map((s) => s.id);
  if (!failing.length) return { rules: [], suggestions: [], rawFailures };
  const dossier = failing
    .map((s) => {
      const spec = SCENARIOS.find((x) => x.id === s.id)!;
      const t = s.trials.find((x) => !x.pass)!;
      return `### ${s.id} (failed ${Math.round((1 - s.passRate) * s.trials.length)}/${s.trials.length} trials)
EXPECTED BEHAVIOUR: ${spec.expectation}
FAILED CHECKS: ${
        t.checks
          .filter((c) => !c.pass)
          .map((c) => `${c.id} (${c.detail})`)
          .join("; ") || "none"
      }
FAILED JUDGE ITEMS: ${
        t.rubric
          .filter((q) => !q.pass)
          .map((q) => `${q.id}: ${q.reason}`)
          .join("; ") || "none"
      }${t.error ? `\nERROR: ${t.error}` : ""}
TRANSCRIPT:\n${renderTranscript(t.convo, t.trace).slice(0, 5000)}`;
    })
    .join("\n\n");
  const system = `You are the improvement engine for a clinic scheduling agent. You read failed evaluation runs and emit STRUCTURED rules to be injected into the agent's system prompt.
Constraints:
- At most 3 new rules. Each rule: imperative, general, <= 45 words, usable beyond the specific transcript.
- NEVER mention scenario ids, patient/doctor names, slot/appointment/ticket ids, or specific dates. Rules that memorise a test case are rejected.
- Do not duplicate existing rules. Do not contradict hard constraints enforced by tools (identity, 24h policy) - assume tools enforce them.
- Avoid over-correction: a rule must state when it applies AND when it does not (e.g. for mild symptoms behave normally).
- If a failure is better fixed in code/tools than in the prompt, put it in tool_suggestions (not auto-applied).
Return ONLY JSON: {"rules":[{"applies_when":"...","rule":"...","rationale":"<=25 words","source_scenarios":["<id>"]}],"tool_suggestions":["..."]}`;
  const user = `EXISTING RULES:\n${pb.rules.map((r) => `- ${r.rule}`).join("\n") || "(none)"}\n\nFAILURES:\n${dossier}`;
  const r = await llm.chat({
    model: MODELS.reflector,
    system,
    messages: [{ role: "user", content: user }],
    maxTokens: 1500,
  });
  const j = extractJson(
    r.content
      .filter((b: any) => b.type === "text")
      .map((b: any) => b.text)
      .join(""),
  );
  let n = pb.rules.length;
  const rules: Rule[] = (j.rules ?? [])
    .slice(0, 3)
    .filter((x: any) => x?.rule && x?.applies_when)
    .map((x: any) => ({
      id: `R${++n}`,
      applies_when: String(x.applies_when),
      rule: String(x.rule),
      rationale: String(x.rationale ?? ""),
      source_scenarios: x.source_scenarios ?? [],
    }));
  return { rules, suggestions: j.tool_suggestions ?? [], rawFailures };
}

export function lint(
  rules: Rule[],
  existing: Rule[],
): { ok: Rule[]; rejected: { rule: Rule; why: string }[] } {
  const ok: Rule[] = [];
  const rejected: { rule: Rule; why: string }[] = [];
  for (const r of rules) {
    if (OVERFIT.test(r.rule + " " + r.applies_when))
      rejected.push({
        rule: r,
        why: "overfit: references a specific scenario/name/id",
      });
    else if (r.rule.split(/\s+/).length > 60)
      rejected.push({ rule: r, why: "too long" });
    else if (
      [...existing, ...ok].some(
        (e) => e.rule.toLowerCase() === r.rule.toLowerCase(),
      )
    )
      rejected.push({ rule: r, why: "duplicate" });
    else if (existing.length + ok.length >= MAX_RULES)
      rejected.push({ rule: r, why: "playbook full; consolidate first" });
    else ok.push(r);
  }
  return { ok, rejected };
}

/** Accept only if TRAIN pass-rate strictly improves AND no scenario (train or held-out) regresses beyond one flaky trial. */
export function gate(base: SuiteResult, cand: SuiteResult) {
  const tol = base.trials >= 3 ? 1 / base.trials + 1e-9 : 0;
  const regressions = base.scenarios
    .filter((b) => {
      const c = cand.scenarios.find((x) => x.id === b.id)!;
      return c.passRate < b.passRate - tol;
    })
    .map((b) => b.id);
  const improved =
    cand.summary.train.passRate > base.summary.train.passRate + 1e-9;
  return {
    accept: improved && regressions.length === 0,
    improved,
    regressions,
  };
}

function delta(base: SuiteResult, cand: SuiteResult): string {
  const p = (x: number) => (x * 100).toFixed(0) + "%";
  const rows = base.scenarios.map((b) => {
    const c = cand.scenarios.find((x) => x.id === b.id)!;
    const arrow =
      c.passRate > b.passRate ? "▲" : c.passRate < b.passRate ? "▼" : "·";
    return `| ${b.id} | ${b.split} | ${p(b.passRate)} | ${p(c.passRate)} | ${arrow} |`;
  });
  return [
    "| scenario | split | before | after | |",
    "|---|---|---|---|---|",
    ...rows,
    `| **TRAIN** | | ${p(base.summary.train.passRate)} | ${p(cand.summary.train.passRate)} | |`,
    `| **HELD-OUT** | | ${p(base.summary.heldout.passRate)} | ${p(cand.summary.heldout.passRate)} | |`,
  ].join("\n");
}

if (process.argv[1]?.endsWith("improve.ts")) {
  const a = process.argv.slice(2);
  const arg = (k: string, d: number) => {
    const i = a.indexOf(k);
    return i >= 0 ? Number(a[i + 1]) : d;
  };
  const trials = arg("--trials", 3);
  const iters = arg("--iters", 2);
  const dry = a.includes("--dry");
  const llm = dry ? new FakeLLM() : makeLLM();
  const dir = `runs/improve-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  fs.mkdirSync(dir, { recursive: true });
  let pb = loadPlaybook();
  console.log(`Running baseline suite with playbook v${pb.version} ...`);
  let base = await runSuite({ pb, trials, llm });
  console.log(formatSuite(base, "BEFORE"));
  fs.writeFileSync(`${dir}/baseline.json`, JSON.stringify(base, null, 2));
  const first = base;
  const log: string[] = [];
  for (let i = 1; i <= iters; i++) {
    const { rules, suggestions, rawFailures } = await reflect(llm, base, pb);
    if (!rawFailures.length) {
      console.log("\nNo train failures - nothing to improve.");
      break;
    }
    const { ok, rejected } = lint(rules, pb.rules);
    console.log(`\n[iter ${i}] failing: ${rawFailures.join(", ")}`);
    rejected.forEach((r) =>
      console.log(`  ✗ lint rejected "${r.rule.rule}" -> ${r.why}`),
    );
    suggestions.forEach((s) =>
      console.log(`  ℹ tool suggestion (manual): ${s}`),
    );
    if (!ok.length) {
      console.log("  no valid rules proposed; stopping.");
      break;
    }
    ok.forEach((r) =>
      console.log(
        `  + ${r.id} [${r.source_scenarios.join(",")}] When ${r.applies_when}: ${r.rule}`,
      ),
    );
    const candPb: Playbook = {
      version: pb.version + 1,
      rules: [...pb.rules, ...ok],
    };
    const cand = await runSuite({ pb: candPb, trials, llm });
    const g = gate(base, cand);
    console.log(formatSuite(cand, `CANDIDATE v${candPb.version}`));
    console.log(
      `  gate: train improved=${g.improved}, regressions=[${g.regressions.join(", ")}] -> ${g.accept ? "ACCEPT" : "REJECT (rolled back)"}`,
    );
    fs.writeFileSync(
      `${dir}/candidate-${i}.json`,
      JSON.stringify(cand, null, 2),
    );
    fs.appendFileSync(
      "playbook/history.jsonl",
      JSON.stringify({
        ts: new Date().toISOString(),
        iter: i,
        accepted: g.accept,
        newRules: ok,
        rejected,
        suggestions,
        trainBefore: base.summary.train.passRate,
        trainAfter: cand.summary.train.passRate,
        heldoutBefore: base.summary.heldout.passRate,
        heldoutAfter: cand.summary.heldout.passRate,
        regressions: g.regressions,
      }) + "\n",
    );
    log.push(
      `iter ${i}: ${g.accept ? "accepted" : "rejected"}  train ${(base.summary.train.passRate * 100).toFixed(0)}% -> ${(cand.summary.train.passRate * 100).toFixed(0)}%`,
    );
    if (g.accept) {
      pb = candPb;
      base = cand;
      savePlaybook(pb);
    } else break;
  }
  const md = `# Improvement run\n\n${log.join("\n")}\n\n${delta(first, base)}\n`;
  fs.writeFileSync(`${dir}/summary.md`, md);
  console.log("\n" + md + `\nArtifacts: ${dir}/`);
}
