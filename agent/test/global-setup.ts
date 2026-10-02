/** Builds the fixture serve DuckDB once per test run. */
import { buildFixture, FIXTURE_DB } from "./fixtures/build-duck.js";

export default async function setup() {
  await buildFixture(FIXTURE_DB);
}
