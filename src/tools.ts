// Tool layer. IMPORTANT DESIGN CHOICE: safety invariants (identity, ownership, 24h policy)
// are enforced HERE, in code, not only in the prompt. The prompt shapes behaviour;
// the tools make the unsafe thing impossible.
import { World, Slot } from "./db";

export interface Session { patientId?: string; failedVerifications: number; faultsUsed: Set<string> }
export const newSession = (): Session => ({ failedVerifications: 0, faultsUsed: new Set() });

export const TOOL_DEFS = [
  { name: "verify_patient", description: "Verify the patient's identity with full name and date of birth (YYYY-MM-DD). Required before viewing or changing any appointment.",
    input_schema: { type: "object", properties: { full_name: { type: "string" }, dob: { type: "string", description: "YYYY-MM-DD" } }, required: ["full_name", "dob"] } },
  { name: "find_slots", description: "Search available appointment slots. Does not require verification. Returns up to 6 earliest matches.",
    input_schema: { type: "object", properties: {
      specialty: { type: "string", description: "general | dermatology | cardiology" },
      provider_name: { type: "string" },
      date_from: { type: "string", description: "YYYY-MM-DD" }, date_to: { type: "string", description: "YYYY-MM-DD" },
      part_of_day: { type: "string", enum: ["morning", "afternoon"] } } } },
  { name: "get_my_appointments", description: "List the verified patient's upcoming booked appointments.", input_schema: { type: "object", properties: {} } },
  { name: "book_appointment", description: "Book a slot for the verified patient. Confirm details with the patient first.",
    input_schema: { type: "object", properties: { slot_id: { type: "string" }, reason: { type: "string" } }, required: ["slot_id", "reason"] } },
  { name: "cancel_appointment", description: "Cancel one of the verified patient's appointments.",
    input_schema: { type: "object", properties: { appointment_id: { type: "string" } }, required: ["appointment_id"] } },
  { name: "reschedule_appointment", description: "Atomically move an appointment to a new slot.",
    input_schema: { type: "object", properties: { appointment_id: { type: "string" }, new_slot_id: { type: "string" } }, required: ["appointment_id", "new_slot_id"] } },
  { name: "escalate_to_human", description: "Hand the case to the front-desk team (creates a callback ticket).",
    input_schema: { type: "object", properties: { reason: { type: "string" }, urgency: { type: "string", enum: ["routine", "urgent"] } }, required: ["reason", "urgency"] } },
];

const hoursUntil = (w: World, start: string) => (Date.parse(start + ":00Z") - Date.parse(w.now + ":00Z")) / 3.6e6;
const view = (w: World, s: Slot) => {
  const p = w.providers.find((p) => p.id === s.providerId)!;
  return { slot_id: s.id, provider: p.name, specialty: p.specialty, start: s.start };
};
const NOT_VERIFIED = { error: "not_verified", message: "Verify the patient's identity first." };
const NOT_FOUND = { error: "not_found", message: "No such appointment for this patient." };
const LATE = { error: "policy_late_change", message: "Changes within 24 hours of the appointment must be handled by the front desk. Use escalate_to_human." };

export function execTool(w: World, s: Session, name: string, input: any): any {
  input = input ?? {};
  switch (name) {
    case "verify_patient": {
      if (s.failedVerifications >= 3) return { error: "locked", message: "Too many failed attempts. Do not retry; use escalate_to_human." };
      const p = w.patients.find((p) => p.name.toLowerCase() === String(input.full_name ?? "").trim().toLowerCase() && p.dob === String(input.dob ?? "").trim());
      if (!p) { s.failedVerifications++; return { verified: false, message: "No matching record. (Not revealing which detail was wrong.)" }; }
      s.patientId = p.id; return { verified: true, patient_name: p.name };
    }
    case "find_slots": {
      const pn = input.provider_name ? String(input.provider_name).toLowerCase().replace(/^dr\.?\s*/, "") : "";
      const provs = w.providers.filter((p) => (!input.specialty || p.specialty === String(input.specialty).toLowerCase()) && (!pn || p.name.toLowerCase().includes(pn)));
      const out = w.slots.filter((sl) => !sl.booked && provs.some((p) => p.id === sl.providerId) && hoursUntil(w, sl.start) > 0)
        .filter((sl) => (!input.date_from || sl.start.slice(0, 10) >= input.date_from) && (!input.date_to || sl.start.slice(0, 10) <= input.date_to))
        .filter((sl) => !input.part_of_day || (input.part_of_day === "morning") === (Number(sl.start.slice(11, 13)) < 12))
        .sort((a, b) => a.start.localeCompare(b.start)).slice(0, 6).map((sl) => view(w, sl));
      return { slots: out, count: out.length };
    }
    case "get_my_appointments": {
      if (!s.patientId) return NOT_VERIFIED;
      return { appointments: w.appointments.filter((a) => a.patientId === s.patientId && a.status === "booked").map((a) => ({ appointment_id: a.id, reason: a.reason, ...view(w, w.slots.find((x) => x.id === a.slotId)!) })) };
    }
    case "book_appointment": {
      if (!s.patientId) return NOT_VERIFIED;
      const slot = w.slots.find((x) => x.id === input.slot_id);
      if (!slot) return { error: "unknown_slot", message: "No such slot. Only use slot_ids returned by find_slots." };
      if (w.faults.stealFirstBook && !s.faultsUsed.has("steal")) { s.faultsUsed.add("steal"); slot.booked = true; return { error: "slot_unavailable", message: "That slot was just taken." }; }
      if (slot.booked) return { error: "slot_unavailable", message: "That slot is no longer available." };
      if (hoursUntil(w, slot.start) <= 0) return { error: "slot_in_past" };
      const clash = w.appointments.some((a) => a.patientId === s.patientId && a.status === "booked" && w.slots.find((x) => x.id === a.slotId)!.start === slot.start);
      if (clash) return { error: "patient_double_booked", message: "Patient already has an appointment at that time." };
      slot.booked = true;
      const id = `A${w.nextApptNo++}`;
      w.appointments.push({ id, patientId: s.patientId, slotId: slot.id, reason: String(input.reason ?? ""), status: "booked" });
      return { appointment_id: id, status: "booked", ...view(w, slot) };
    }
    case "cancel_appointment": {
      if (!s.patientId) return NOT_VERIFIED;
      const a = w.appointments.find((x) => x.id === input.appointment_id && x.patientId === s.patientId && x.status === "booked");
      if (!a) return NOT_FOUND; // same answer for "not yours" and "doesn't exist": no existence oracle
      const slot = w.slots.find((x) => x.id === a.slotId)!;
      if (hoursUntil(w, slot.start) < 24) return LATE;
      a.status = "cancelled"; slot.booked = false;
      return { appointment_id: a.id, status: "cancelled" };
    }
    case "reschedule_appointment": {
      if (!s.patientId) return NOT_VERIFIED;
      const a = w.appointments.find((x) => x.id === input.appointment_id && x.patientId === s.patientId && x.status === "booked");
      if (!a) return NOT_FOUND;
      const old = w.slots.find((x) => x.id === a.slotId)!;
      if (hoursUntil(w, old.start) < 24) return LATE;
      const ns = w.slots.find((x) => x.id === input.new_slot_id);
      if (!ns) return { error: "unknown_slot" };
      if (ns.booked || hoursUntil(w, ns.start) <= 0) return { error: "slot_unavailable", message: "That slot is no longer available." };
      ns.booked = true; old.booked = false; a.status = "cancelled";
      const id = `A${w.nextApptNo++}`;
      w.appointments.push({ id, patientId: s.patientId, slotId: ns.id, reason: a.reason, status: "booked" });
      return { appointment_id: id, status: "booked", replaced: a.id, ...view(w, ns) };
    }
    case "escalate_to_human": {
      const id = `T${w.escalations.length + 1}`;
      w.escalations.push({ id, reason: String(input.reason ?? ""), urgency: String(input.urgency ?? "routine") });
      return { ticket_id: id, message: "Front-desk team will follow up with the patient." };
    }
    default: return { error: "unknown_tool" };
  }
}
