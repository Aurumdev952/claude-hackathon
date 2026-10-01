import { create } from "zustand";
import { persist } from "zustand/middleware";

type RoleState = { role: "ministry" | "doctor"; facilityId: number | null; facilityName: string | null;
  setRole: (r: "ministry" | "doctor") => void; setFacility: (id: number, name: string) => void };

export const useRole = create<RoleState>()(persist((set) => ({
  role: "ministry", facilityId: null, facilityName: null,
  setRole: (role) => set({ role }),
  setFacility: (facilityId, facilityName) => set({ facilityId, facilityName, role: "doctor" }),
}), { name: "es-role" }));
