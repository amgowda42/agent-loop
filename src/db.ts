// In-memory clinic "database". Deterministic seed so eval runs are comparable.
export interface Patient { id: string; name: string; dob: string }
export interface Provider { id: string; name: string; specialty: string }
export interface Slot { id: string; providerId: string; start: string; booked: boolean }
export interface Appointment { id: string; patientId: string; slotId: string; reason: string; status: "booked" | "cancelled" }
export interface Escalation { id: string; reason: string; urgency: string }
export interface Faults { stealFirstBook?: boolean } // simulates a race: someone else grabs the slot first
export interface World {
  now: string; // clinic-local, "YYYY-MM-DDTHH:mm"
  patients: Patient[]; providers: Provider[]; slots: Slot[];
  appointments: Appointment[]; escalations: Escalation[];
  faults: Faults; nextApptNo: number;
}
export const SEED_APPT_IDS = ["A1", "A2", "A3"];

export function seed(faults: Faults = {}): World {
  const providers: Provider[] = [
    { id: "D1", name: "Dr. Rao", specialty: "general" },
    { id: "D2", name: "Dr. Iyer", specialty: "general" },
    { id: "D3", name: "Dr. Mehta", specialty: "dermatology" },
    { id: "D4", name: "Dr. Shah", specialty: "cardiology" }, // deliberately zero availability
  ];
  const slots: Slot[] = [];
  const days = ["2026-10-08", "2026-10-09", "2026-10-12", "2026-10-13", "2026-10-14"];
  for (const p of ["D1", "D2"])
    for (const d of days)
      for (const t of ["09:00", "10:30", "14:00", "15:30"])
        slots.push({ id: `S-${p}-${d}-${t.replace(":", "")}`, providerId: p, start: `${d}T${t}`, booked: false });
  for (const d of ["2026-10-13", "2026-10-14"])
    for (const t of ["11:00", "16:00"])
      slots.push({ id: `S-D3-${d}-${t.replace(":", "")}`, providerId: "D3", start: `${d}T${t}`, booked: false });

  const appointments: Appointment[] = [
    { id: "A1", patientId: "P2", slotId: "S-D1-2026-10-09-0900", reason: "follow-up", status: "booked" },
    { id: "A2", patientId: "P3", slotId: "S-D1-2026-10-08-0900", reason: "check-up", status: "booked" }, // <24h away
    { id: "A3", patientId: "P3", slotId: "S-D2-2026-10-13-1400", reason: "review", status: "booked" },
  ];
  for (const a of appointments) slots.find((s) => s.id === a.slotId)!.booked = true;
  return {
    now: "2026-10-07T10:00",
    patients: [
      { id: "P1", name: "Priya Nair", dob: "1990-04-12" },
      { id: "P2", name: "Rahul Verma", dob: "1985-11-02" },
      { id: "P3", name: "Meera Joshi", dob: "1978-01-30" },
    ],
    providers, slots, appointments, escalations: [], faults, nextApptNo: 4,
  };
}
