/** Unit tests for the props contract and the deterministic scene / message rules (no API, no browser). */
import assert from "node:assert/strict";
import { test } from "node:test";
import { assertNoNames, keyMessages, normaliseMinistryParams, stripIdentifiers } from "../src/build-props";
import { ministryScenes } from "../src/compositions/ministryScenes";
import { organGroups, patientScenes } from "../src/compositions/patientScenes";
import { MinistryReelPropsSchema, PatientVideoPropsSchema } from "../src/props";
import { SAMPLE_MINISTRY, SAMPLE_PATIENT } from "../src/samples";

test("patient schema strips identifying keys", () => {
  const p = PatientVideoPropsSchema.parse({ ...SAMPLE_PATIENT, given_name: "Ann", family_name: "Doe", birthdate: "1960-01-01" });
  assert.equal("given_name" in p, false);
  assert.equal("birthdate" in p, false);
  assert.doesNotThrow(() => assertNoNames(p, ["Ann Doe"]));
});

test("assertNoNames catches a name anywhere in the props", () => {
  const leaked = { ...SAMPLE_PATIENT, facility: "Clinic of Ann Doe" };
  assert.throws(() => assertNoNames(leaked, ["Ann Doe"]));
  assert.throws(() => assertNoNames({ x: { given_name: "A" } }));
});

test("stripIdentifiers removes nested name fields", () => {
  const out = stripIdentifiers({ header: { given_name: "A", family_name: "B", display_id: "X-1", phone: "1" }, rows: [{ birthdate: "x", v: 1 }] });
  assert.deepEqual(out, { header: { display_id: "X-1" }, rows: [{ v: 1 }] });
});

test("patient scenes skip care and journey when null, and organ groups merge equal findings", () => {
  const ids = patientScenes(SAMPLE_PATIENT).map((s) => s.id);
  assert.ok(!ids.includes("care") && !ids.includes("journey"));
  assert.equal(ids[0], "title");
  assert.equal(ids[ids.length - 1], "summary");
  const p = { ...SAMPLE_PATIENT, organs: [
    { id: "duodenum", label: "Duodenum", score: 0.9, conditions: [{ name: "Melaena", date: "2026-06-04", severity: 0.9 }], labs: [] },
    { id: "large_intestine", label: "Large intestine", score: 0.9, conditions: [{ name: "Melaena", date: "2026-06-04", severity: 0.9 }], labs: [] },
    { id: "skin", label: "Skin", score: 0.5, conditions: [], labs: [] },
  ] };
  const g = organGroups(p);
  assert.equal(g.length, 1);
  assert.deepEqual(g[0].ids, ["duodenum", "large_intestine"]);
});

test("ministry scenes skip null data and messages are deterministic", () => {
  const p = MinistryReelPropsSchema.parse({ ...SAMPLE_MINISTRY, forecast: null, care: null });
  const ids = ministryScenes(p).map((s) => s.id);
  assert.ok(!ids.includes("forecast") && !ids.includes("care") && !ids.includes("map"));
  const a = keyMessages(p), b = keyMessages(structuredClone(p));
  assert.deepEqual(a, b);
  assert.ok(a.length <= 3 && a.length > 0);
});

test("ministry params are normalised to the API's allowed values", () => {
  assert.deepEqual(normaliseMinistryParams({ from: "2026", to: "2015", sex: "X", age: "<50", def: "nope" }),
    { from: 2015, to: 2026, sex: "ALL", age: "<50", def: "CONFIRMED_PROBABLE" });
});
