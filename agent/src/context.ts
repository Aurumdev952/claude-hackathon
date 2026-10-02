/** X-Role / X-Facility-Id -> request context (same contract as api/deps.py `role`). No auth: demo only. */
import { ApiError } from "./lib/errors.js";

export type Role = "ministry" | "doctor";

export interface AgentContext {
  role: Role;
  facilityId: number | null;
}

type HeaderGetter = (name: string) => string | undefined | null;

export function contextFromHeaders(get: HeaderGetter): AgentContext {
  return parseContext(get("x-role"), get("x-facility-id"));
}

export function parseContext(roleRaw: string | null | undefined, facilityRaw: string | number | null | undefined): AgentContext {
  const role = (roleRaw || "ministry").toString().trim().toLowerCase();
  if (role !== "ministry" && role !== "doctor") {
    throw new ApiError(400, "INVALID_ROLE", "X-Role must be 'ministry' or 'doctor'");
  }
  let facilityId: number | null = null;
  if (facilityRaw !== undefined && facilityRaw !== null && `${facilityRaw}`.trim() !== "") {
    const n = Number(facilityRaw);
    if (!Number.isInteger(n)) throw new ApiError(400, "INVALID_FACILITY", "X-Facility-Id must be an integer");
    facilityId = n;
  }
  if (role === "doctor" && facilityId === null) {
    throw new ApiError(400, "FACILITY_REQUIRED", "Doctor requests need an X-Facility-Id header");
  }
  return { role, facilityId: role === "doctor" ? facilityId : null };
}
