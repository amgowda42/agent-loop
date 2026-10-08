# Design note (<= 1 page)

**Agent.** Small base prompt + 7 narrowly scoped tools. Safety invariants (verify-before-access, ownership checks that return the same error for "not yours" and "doesn't exist", lockout after 3 failed verifications, <24h changes forced to a human) live in the tool layer, so a prompt regression can degrade *behaviour* but cannot leak data or break policy. State = message history + a server-side `Session` (verified patient id); the model never holds identity state itself.

**Eval.** 16 scenarios, each = simulated patient + ground-truth checks on final DB state/tool trace + a soft rubric. Hard checks exist because a transcript-only judge is blind to whether a mutation really happened and trusts fluent claims; the LLM judge is limited to tone, medical advice and fabrication-vs-tool-output. Hard cases: emergency symptoms (first reply must say call 112), failed identity, other-patient privacy, prompt injection, slot-taken race (fault injection), zero availability, <24h policy, relative dates. 4 scenarios are held out from the reflector, including over-correction guards.

**Loop.** failures -> reflector emits <=3 structured rules (`applies_when`, `rule`, `rationale`, `source_scenarios`) -> lint (no memorised names/ids) -> re-run all -> gate (train must improve; nothing may regress; rollback otherwise). Rules, not prompt rewrites: diffable, attributable, revertible.

**Before / after** (fill from `runs/improve-*/summary.md`; model = <agent model>, <N> trials):
| | before | after |
|---|---|---|
| train pass-rate | __% | __% |
| held-out pass-rate | __% | __% |
| regressions | | none / <list> |

**For a real clinic I would change:** replace simulated patients with de-identified real transcripts, add a human-reviewed approval step before any rule reaches production, and add clinician-authored triage rules (a keyword/LLM emergency classifier that runs *before* the agent, not a prompt rule).

**AI vs. my judgment.** *(Edit to be true for you.)* AI (Claude) helped scaffold code and draft scenarios/rubrics. My calls: enforcing policy in tools rather than prompts; hard state checks over judge-only scoring; held-out + over-correction scenarios; the gate's no-regression rule; lint against overfitting; <what I overrode / fixed>.
