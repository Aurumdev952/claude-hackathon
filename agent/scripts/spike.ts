// B10.1 spike: open DuckDB from Node and check what json_serialize_sql reports for the guardrail cases.
import { DuckDBInstance } from "@duckdb/node-api";

const inst = await DuckDBInstance.create(":memory:");
const con = await inst.connect();
await con.run("CREATE TABLE mart_rates (geo_code VARCHAR, period VARCHAR, asr DOUBLE); CREATE TABLE pt_patient (patient_id INT, given_name VARCHAR)");
const cases = [
  "WITH x AS (SELECT * FROM mart_rates) SELECT r.geo_code, x.asr FROM mart_rates r JOIN x USING (geo_code) LIMIT 5",
  "SELECT * FROM read_csv('/etc/passwd')",
  "SELECT 1; SELECT 2",
  "DELETE FROM mart_rates",
  "SELECT getenv('HOME')",
  "SELECT * FROM main.pt_patient",
  "SELECT * FROM mart_rates LIMIT 10 OFFSET 5",
  "SELECT * FROM 'data.csv'",
  "SELECT a.x FROM (SELECT 1 AS x) a UNION ALL SELECT 2",
  "COPY mart_rates TO 'x.csv'",
  "PRAGMA database_list",
];
for (const sql of cases) {
  const r = await con.runAndReadAll("SELECT json_serialize_sql(?::VARCHAR) AS j", [sql]);
  const j = JSON.parse(String(r.getRowObjects()[0].j));
  console.log("\n==", sql, "\n", JSON.stringify(j).slice(0, 900));
}
