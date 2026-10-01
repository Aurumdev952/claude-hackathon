"""Mart builders (SPEC §11.4-11.5). Order matters: rates feed joinpoint/spatial/kpis."""
from __future__ import annotations

import time


def build_all(con, sim_time, log=print):
    from . import clinical, cohort, facility, patient, points, rates, surfaces, warning
    steps = [
        ("rates", rates.build_rates), ("joinpoint", rates.build_joinpoint), ("spatial", rates.build_spatial),
        ("stage_mix", clinical.build_stage_mix), ("characteristics", clinical.build_characteristics),
        ("survival", clinical.build_survival), ("cox", clinical.build_cox),
        ("warning", warning.build_warning), ("facility", facility.build_facility_quality),
        ("referral_flows", facility.build_referral_flows),
        ("cohort_funnel", cohort.build_cohort_funnel), ("data_quality", cohort.build_data_quality),
        ("events", cohort.build_events), ("patients", patient.build_patient_tables), ("points", points.build_points),
        ("rate_surface", surfaces.build_rate_surface), ("journey", surfaces.build_journey),
        ("kpis", cohort.build_kpis),
    ]
    for name, fn in steps:
        t = time.time()
        fn(con, sim_time, log)
        log(f"    - {name:16s} {time.time() - t:5.1f}s")
