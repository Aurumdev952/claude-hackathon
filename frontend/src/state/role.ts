import { create } from "zustand";
import { persist } from "zustand/middleware";

export type AppRole = "ministry" | "doctor" | "patient";

type RoleState = {
  role: AppRole; facilityId: number | null; facilityName: string | null;
  /** Patient app (v3): the EMR patient id the simulated phone belongs to, and its display id. */
  patientId: number | null; patientDisplayId: string | null;
  setRole: (r: AppRole) => void; setFacility: (id: number, name: string) => void;
  setPatient: (id: number, displayId: string) => void;
};

export const useRole = create<RoleState>()(persist((set) => ({
  role: "ministry", facilityId: null, facilityName: null, patientId: null, patientDisplayId: null,
  setRole: (role) => set({ role }),
  setFacility: (facilityId, facilityName) => set({ facilityId, facilityName, role: "doctor" }),
  setPatient: (patientId, patientDisplayId) => set({ patientId, patientDisplayId, role: "patient" }),
}), { name: "es-role" }));
