import type { Page } from "@playwright/test";

export const API = process.env.E2E_API_URL ?? "http://127.0.0.1:8000/api/v1";

/** Start as a ministry user, or as a doctor at the facility with the most diagnosed cases. */
export async function asRole(page: Page, role: "ministry" | "doctor", facilityId?: number) {
  await page.addInitScript(([r, f]) => {
    localStorage.setItem("es-role", JSON.stringify({ state: { role: r, facilityId: f, facilityName: f ? "E2E facility (Synthetic)" : null }, version: 0 }));
  }, [role, facilityId ?? null] as const);
}

export async function busyFacility(page: Page): Promise<number> {
  // the facility list endpoint is public metadata; pick one that has diagnosed patients
  const meta = await (await page.request.get(`${API}/meta/filters`, { headers: { "X-Role": "ministry" } })).json();
  const facs: { location_id: number }[] = meta.data.facilities ?? [];
  for (const f of facs.slice(0, 400)) {
    const r = await page.request.get(`${API}/patients?status=diagnosed&page_size=1`, { headers: { "X-Role": "doctor", "X-Facility-Id": String(f.location_id) } });
    if (r.ok() && (await r.json()).data.length) return f.location_id;
  }
  throw new Error("no facility with diagnosed patients");
}
