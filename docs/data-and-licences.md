# Data, privacy and licences

## Synthetic data only

- All people, facilities and statistics are synthetic. Facility names carry "(Synthetic)". District choices for the
  planted insights are illustrative only (spec §9). Nothing in this repository describes real patients or real
  district statistics.
- The generator is deterministic (`SEED=42`), so every machine builds the same data. Generated data, models and
  databases are not stored in git.
- The risk models are proofs of concept on synthetic data. They are not clinically validated and must not be used for
  clinical decisions.

## Privacy rules built into the system

- Patients are referred to by display ID (for example `NYA-0119453Y`) in reports, logs, agent output and videos.
- The ministry role never receives patient-level fields; counts below 5 are suppressed. The doctor role sees only
  patients linked to its facility. The patient role sees only its own data.
- Nothing reaches a patient before a doctor approves a care plan in the UI. Patient messages never contain a diagnosis
  word; they advise a visit only.
- AI output is labelled as decision support. Insight cards and agent answers cite the numbers they are built from.

## Licences

- **Code:** MIT, see [`LICENSE`](../LICENSE).
- **District boundaries:** geoBoundaries (CC BY 4.0).
- **3D anatomy:** **Z-Anatomy** (CC BY-SA 4.0), which is derived from **BodyParts3D**, © DBCLS (CC BY-SA 2.1 JP). See
  [`frontend/public/models/CREDITS.md`](../frontend/public/models/CREDITS.md). The model files keep their own licence and
  are not covered by MIT.
  - Z-Anatomy's licence file also lists two CC BY-NC sub-sources whose meshes it does not identify. The `brain` and
    kidney nodes may come from them; check before any commercial use.
