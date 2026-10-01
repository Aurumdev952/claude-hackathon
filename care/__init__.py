"""Care coordination package (v3, docs/contracts/v3-loop.md).

- `care.emr` / `care.emr_rows`: EMR write-back adapter and row builder (track L1).
- engine, store, pathways, evidence, snapshot: care engine (track L2).

Keep this module import-free: the simulator, the API and the pipeline import submodules directly.
"""
