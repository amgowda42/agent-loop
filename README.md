# Self-improving clinic scheduling agent

## 60-second quick start (reviewers)
```bash
npm install
# 1) pick ONE provider and set its key (free options below). Keys are read from env vars only, never stored in the repo.
export PROVIDER=openai LLM_BASE_URL=https://generativelanguage.googleapis.com/v1beta/openai LLM_API_KEY=<your Gemini key>
export AGENT_MODEL=gemini-3.5-flash-lite PATIENT_MODEL=gemini-3.5-flash-lite JUDGE_MODEL=gemini-3.5-flash REFLECTOR_MODEL=gemini-3.5-flash CONCURRENCY=1
npm run agent     # ONE command: chat with the agent (tool calls are printed as  ⚙ ...)
npm run loop      # ONE command: eval -> find failures -> apply rules -> re-run -> accept/rollback
npm test          # offline unit tests, no API key needed
```
Using Anthropic instead? `export ANTHROPIC_API_KEY=sk-ant-...` and skip the PROVIDER lines.
Recorded evidence of my own runs (before/after, transcripts, rule history) is in `results/` and `playbook/history.jsonl`.

---

A multi-turn patient-scheduling agent (TypeScript + Anthropic API), an evaluation harness with a simulated patient, and a loop that turns failed runs into structured, gated prompt rules.

## Run it
```bash
npm install
cp .env.example .env && export ANTHROPIC_API_KEY=sk-ant-...     # or set it in your shell

npm run chat                  # talk to the agent (add `-- --no-rules` for the baseline)
npm run improve               # full loop: baseline -> reflect -> apply -> re-run -> gate
npm run eval                  # score the current playbook   (flags: --trials 3 --split train|heldout --scenario <id> --no-rules)
npm test                      # offline unit tests for tools / checks / lint / gate (no API key needed)
npm run eval -- --dry         # offline wiring smoke test with a fake LLM (scores meaningless)
```
Demo patients: Priya Nair 1990-04-12, Rahul Verma 1985-11-02, Meera Joshi 1978-01-30. Clinic "now" is fixed at 2026-10-07 10:00 so runs are comparable.

## Layout
| file | role |
|---|---|
| `src/tools.ts` | 7 tools. **Identity, ownership, 24h-change policy, lockout are enforced in code**, not just prompted |
| `src/agent.ts`, `src/playbook.ts` | tool-use loop; system prompt = small base + versioned rules from `playbook/rules.json` |
| `src/scenarios.ts` | 16 scenarios (12 train, 4 held-out): persona + ground-truth checks + soft rubric + human-written `expectation` |
| `src/judge.ts` | LLM rubric judge for soft qualities only; blind spots documented in the file header |
| `src/eval.ts` | runs N trials/scenario, reports pass-rate and partial credit per split |
| `src/improve.ts` | reflect -> lint -> apply -> re-run -> gate; every attempt logged to `playbook/history.jsonl` |

## How the loop closes
1. Run all scenarios (default 3 trials each; models are stochastic, so we use pass-rates, not single runs).
2. A stronger reflector model sees only **train** failures (expectation + failed checks + transcript) and proposes <=3 structured rules.
3. Lint rejects rules that name a scenario, person, id or date (anti-memorisation), duplicates, or bloat. Fixes better made in code are returned as `tool_suggestions` for a human.
4. Re-run everything with the candidate playbook.
5. **Gate:** accept only if train pass-rate strictly improves *and* no scenario (including held-out ones) drops by more than one flaky trial. Otherwise roll back. The held-out set includes over-correction guards (mild cold must still be booked; allowed cancellation must not be escalated).

## Known limits
- Simulated patients and an LLM judge are proxies for real patients. Hard checks on world state exist because a transcript-only judge cannot tell whether a booking actually happened.
- `no_false_confirmation` is a regex heuristic. Some scenarios (`other_patient`, `medical_advice`, `prompt_injection`) pass trivially for an agent that does nothing; they guard against regressions rather than prove capability.
- Small suite: a pass-rate move of one scenario is signal, not statistics. Increase `--trials` for tighter numbers.

## Free / non-Anthropic providers (OpenAI-compatible)
Set `PROVIDER=openai` plus the base URL, key and model names. Examples (model names and free limits change; check the provider's docs):
```bash
# Groq (console.groq.com -> API Keys, free tier)
export PROVIDER=openai LLM_BASE_URL=https://api.groq.com/openai/v1 LLM_API_KEY=gsk_...
export AGENT_MODEL=llama-3.1-8b-instant PATIENT_MODEL=llama-3.1-8b-instant JUDGE_MODEL=llama-3.3-70b-versatile REFLECTOR_MODEL=llama-3.3-70b-versatile

# Google Gemini (aistudio.google.com -> Get API key, free tier)
export PROVIDER=openai LLM_BASE_URL=https://generativelanguage.googleapis.com/v1beta/openai LLM_API_KEY=AIza...
export AGENT_MODEL=gemini-3.5-flash-lite PATIENT_MODEL=gemini-3.5-flash-lite JUDGE_MODEL=gemini-3.5-flash REFLECTOR_MODEL=gemini-3.5-flash
```
Free tiers rate-limit hard: use `CONCURRENCY=1` and `--trials 1` or `2`; the adapter retries on 429.
