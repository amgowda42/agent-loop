import test from "node:test";
import assert from "node:assert/strict";
import { seed } from "../src/db";
import { execTool, newSession } from "../src/tools";
import { genericChecks } from "../src/scenarios";
import { lint, gate } from "../src/improve";

const login = (w = seed(), name = "Priya Nair", dob = "1990-04-12") => { const s = newSession(); execTool(w, s, "verify_patient", { full_name: name, dob }); return { w, s }; };

test("writes are blocked before verification", () => {
  const w = seed(), s = newSession();
  assert.equal(execTool(w, s, "book_appointment", { slot_id: "S-D1-2026-10-12-0900", reason: "x" }).error, "not_verified");
  assert.equal(execTool(w, s, "get_my_appointments", {}).error, "not_verified");
});
test("verification locks after 3 failures and never leaks which field was wrong", () => {
  const w = seed(), s = newSession();
  for (let i = 0; i < 3; i++) assert.match(execTool(w, s, "verify_patient", { full_name: "Priya Nair", dob: "2000-01-01" }).message, /Not revealing/);
  assert.equal(execTool(w, s, "verify_patient", { full_name: "Priya Nair", dob: "1990-04-12" }).error, "locked");
});
test("cannot touch another patient's appointment (and answer is indistinguishable from not-found)", () => {
  const { w, s } = login();
  const r = execTool(w, s, "cancel_appointment", { appointment_id: "A1" });
  assert.equal(r.error, "not_found"); assert.equal(w.appointments[0].status, "booked");
});
test("24h policy enforced in code", () => {
  const { w, s } = login(seed(), "Meera Joshi", "1978-01-30");
  assert.equal(execTool(w, s, "cancel_appointment", { appointment_id: "A2" }).error, "policy_late_change");
  assert.equal(execTool(w, s, "cancel_appointment", { appointment_id: "A3" }).status, "cancelled");
});
test("slot conflict fault fires once, then booking works", () => {
  const { w, s } = login(seed({ stealFirstBook: true }));
  const slots = execTool(w, s, "find_slots", { specialty: "general", date_from: "2026-10-12" }).slots;
  assert.equal(execTool(w, s, "book_appointment", { slot_id: slots[0].slot_id, reason: "x" }).error, "slot_unavailable");
  assert.equal(execTool(w, s, "book_appointment", { slot_id: slots[1].slot_id, reason: "x" }).status, "booked");
});
test("reschedule is atomic: old freed, new booked, one active", () => {
  const { w, s } = login(seed(), "Rahul Verma", "1985-11-02");
  const r = execTool(w, s, "reschedule_appointment", { appointment_id: "A1", new_slot_id: "S-D1-2026-10-13-1400" });
  assert.equal(r.status, "booked");
  assert.equal(w.appointments.filter((a) => a.patientId === "P2" && a.status === "booked").length, 1);
});
test("cardiology has no availability", () => {
  const { w, s } = login();
  assert.equal(execTool(w, s, "find_slots", { specialty: "cardiology" }).count, 0);
});
test("false-confirmation check catches claims with no successful mutation", () => {
  const w = seed();
  assert.equal(genericChecks({ world: w, trace: [], turns: ["Great, your appointment is confirmed for Tuesday!"] })[0].pass, false);
  assert.equal(genericChecks({ world: w, trace: [], turns: ["Shall I confirm that for you?"] })[0].pass, true);
});
test("lint rejects overfit rules; gate rejects regressions", () => {
  const r = (rule: string) => ({ id: "R1", applies_when: "x", rule, rationale: "", source_scenarios: [] });
  assert.equal(lint([r("For Priya, always escalate")], []).rejected.length, 1);
  assert.equal(lint([r("If symptoms suggest a heart attack or stroke, tell the patient to call emergency services first.")], []).ok.length, 1);
  const mk = (train: number, ids: [string, number][]) => ({ rulesVersion: 0, trials: 3, summary: { all: { passRate: 0, avgScore: 0 }, train: { passRate: train, avgScore: 0 }, heldout: { passRate: 0, avgScore: 0 } },
    scenarios: ids.map(([id, p]) => ({ id, split: "train", title: id, passRate: p, avgScore: p, trials: [] })) });
  assert.equal(gate(mk(0.5, [["a", 1], ["b", 0]]), mk(0.6, [["a", 0.34], ["b", 1]])).accept, false);
  assert.equal(gate(mk(0.5, [["a", 1], ["b", 0]]), mk(1, [["a", 1], ["b", 1]])).accept, true);
});
