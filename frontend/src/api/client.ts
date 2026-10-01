import { useRole } from "@/state/role";

export type Meta = { run_id: number | null; sim_time: string | null; published_at: string | null };
export type Envelope<T> = { meta: Meta; data: T; [k: string]: unknown };
export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: unknown) { super(message); }
}

const BASE = "/api/v1";

function headers(): HeadersInit {
  const { role, facilityId } = useRole.getState();
  const h: Record<string, string> = { "X-Role": role, "Content-Type": "application/json" };
  if (role === "doctor" && facilityId) h["X-Facility-Id"] = String(facilityId);
  return h;
}

export async function api<T = unknown>(path: string, init?: RequestInit): Promise<Envelope<T>> {
  const res = await fetch(BASE + path, { ...init, headers: { ...headers(), ...(init?.headers ?? {}) } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = body?.error ?? {};
    throw new ApiError(res.status, e.code ?? "HTTP_ERROR", e.message ?? res.statusText, e.details);
  }
  return body as Envelope<T>;
}

export const get = <T,>(path: string) => api<T>(path);
export const post = <T,>(path: string, body: unknown) => api<T>(path, { method: "POST", body: JSON.stringify(body) });
export const patch = <T,>(path: string, body: unknown) => api<T>(path, { method: "PATCH", body: JSON.stringify(body) });

export function qs(params: Record<string, string | number | boolean | null | undefined>) {
  const p = new URLSearchParams();
  Object.entries(params).forEach(([k, v]) => { if (v !== undefined && v !== null && v !== "") p.set(k, String(v)); });
  const s = p.toString();
  return s ? `?${s}` : "";
}
