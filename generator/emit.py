"""Recorder: turns simulated clinical events into OpenMRS-style rows (SPEC §6).

Times are epoch minutes (int). A row is only recorded when the patient is registered in the EMR
(home facility live) and the facility of the event is live — otherwise the event happened on paper.
"""
from __future__ import annotations

from shared.concepts import C, DRUG_ID

VISIT_TYPE_OPD, VISIT_TYPE_IPD, VISIT_TYPE_ER = 1, 2, 3
ENC = {"ADULTINITIAL": 1, "OPD": 2, "RETURN": 3, "LAB": 4, "ENDOSCOPY": 5, "PATHOLOGY": 6, "ONCOLOGY": 7,
       "ADMISSION": 8, "DISCHARGE": 9, "PHARMACY": 10, "ANC": 11, "HIV": 12, "NCD": 13, "DEATH": 14,
       "CARE_COORDINATION": 15, "PATIENT_REPORTED": 16, "CHW_HOME_VISIT": 17}  # 15-17: v3 write-back (D-45)
ORDER_DRUG, ORDER_TEST, ORDER_REFERRAL = 1, 2, 3


class Recorder:
    def __init__(self, chunk_idx: int, go_live: dict[int, int]):
        self.go_live_min = {k: v * 1440 for k, v in go_live.items()}
        self.next_visit = chunk_idx * 10**7 + 1
        self.next_enc = chunk_idx * 10**7 + 1
        self.next_obs = chunk_idx * 10**8 + 1
        self.next_order = chunk_idx * 10**7 + 1
        self.visits: list[tuple] = []     # visit_id, patient_id, visit_type_id, start, stop, location_id
        self.encs: list[tuple] = []       # encounter_id, type, patient_id, location_id, visit_id, t
        self.obs_rows: list[tuple] = []   # obs_id, person, concept, enc, order, t, loc, group, coded, num, text, dtv
        self.orders: list[tuple] = []     # order_id, type, concept, patient, enc, t, stopped, urgency
        self.drug_orders: list[tuple] = []  # order_id, drug_id, dose, dose_units, freq, duration, duration_units, qty
        self.programs: list[tuple] = []   # patient, program, enrolled, completed, location
        self.first_enc: dict[int, int] = {}
        self.emr_start_min = 0
        self.pid = 0

    # ------------------------------------------------------------------ patient context
    def begin_patient(self, pid: int, emr_start_day: int):
        self.pid = pid
        self.emr_start_min = emr_start_day * 1440
        self._marks = (len(self.visits), len(self.encs), len(self.obs_rows), len(self.orders),
                       len(self.drug_orders), len(self.programs))

    def truncate_patient(self, t_max: int):
        """Drop this patient's rows dated after t_max (death). DEATH encounters (type 14) are kept."""
        mv, me, mo, mr, md, mp = self._marks
        drop_enc = {e[0] for e in self.encs[me:] if e[5] > t_max and e[1] != 14}
        if not drop_enc and all(v[3] <= t_max for v in self.visits[mv:]):
            return
        keep_visits = {e[4] for e in self.encs[me:] if e[0] not in drop_enc}
        self.encs[me:] = [e for e in self.encs[me:] if e[0] not in drop_enc]
        self.visits[mv:] = [v for v in self.visits[mv:] if v[0] in keep_visits]
        self.obs_rows[mo:] = [o for o in self.obs_rows[mo:] if o[3] not in drop_enc]
        dropped_orders = {o[0] for o in self.orders[mr:] if o[4] in drop_enc}
        self.orders[mr:] = [o for o in self.orders[mr:] if o[4] not in drop_enc]
        self.drug_orders[md:] = [o for o in self.drug_orders[md:] if o[0] not in dropped_orders]
        self.programs[mp:] = [x for x in self.programs[mp:] if x[2] <= t_max]
        if self.encs[me:]:
            self.first_enc[self.pid] = min(e[5] for e in self.encs[me:])
        else:
            self.first_enc.pop(self.pid, None)

    def recordable(self, t: int, loc: int) -> bool:
        return t >= self.emr_start_min and t >= self.go_live_min.get(loc, 0)

    # ------------------------------------------------------------------ structure
    def visit(self, t: int, loc: int, vtype: int = VISIT_TYPE_OPD, hours: float = 3.0):
        if not self.recordable(t, loc):
            return None
        vid = self.next_visit
        self.next_visit += 1
        self.visits.append((vid, self.pid, vtype, t, t + int(hours * 60), loc))
        return vid

    def encounter(self, t: int, etype: str, loc: int, visit_id=None, vtype: int = VISIT_TYPE_OPD):
        if not self.recordable(t, loc):
            return None
        if visit_id is None:
            visit_id = self.visit(t, loc, vtype)
        eid = self.next_enc
        self.next_enc += 1
        self.encs.append((eid, ENC[etype], self.pid, loc, visit_id, t))
        if self.pid not in self.first_enc or t < self.first_enc[self.pid]:
            self.first_enc[self.pid] = t
        return eid

    # ------------------------------------------------------------------ facts
    def obs(self, enc, t, loc, concept, coded=None, num=None, text=None, group=None, order=None):
        if enc is None:
            return None
        oid = self.next_obs
        self.next_obs += 1
        self.obs_rows.append((oid, self.pid, concept, enc, order, t, loc, group, coded, num, text))
        return oid

    def dx(self, enc, t, loc, dx_concept, confirmed=True, primary=True):
        if enc is None:
            return None
        oid = self.obs(enc, t, loc, C.DIAGNOSIS, coded=dx_concept)
        self.obs(enc, t, loc, C.DX_CERTAINTY, coded=C.CONFIRMED if confirmed else C.PRESUMED, group=oid)
        if not primary:  # DIAGNOSIS ORDER is optional in OpenMRS; absent = primary
            self.obs(enc, t, loc, C.DX_ORDER, coded=C.SECONDARY, group=oid)
        return oid

    def complaint(self, enc, t, loc, concept, weeks=None):
        if enc is None:
            return
        self.obs(enc, t, loc, C.CHIEF_COMPLAINT, coded=concept)
        if weeks is not None:
            self.obs(enc, t, loc, C.SYMPTOM_WEEKS, num=float(weeks))

    def num(self, enc, t, loc, concept, value, nd=1):
        if enc is None or value is None:
            return None
        return self.obs(enc, t, loc, concept, num=round(float(value), nd))

    def coded(self, enc, t, loc, concept, answer, group=None):
        return self.obs(enc, t, loc, concept, coded=answer, group=group)

    def order(self, enc, t, concept, otype=ORDER_TEST, urgency="ROUTINE", stopped=None):
        if enc is None:
            return None
        oid = self.next_order
        self.next_order += 1
        self.orders.append((oid, otype, concept, self.pid, enc, t, stopped, urgency))
        return oid

    def drug(self, enc, t, drug_concept, days: int, dose: float = 1.0, freq: str = "OD", qty: float | None = None):
        if enc is None:
            return None
        oid = self.order(enc, t, drug_concept, ORDER_DRUG, stopped=t + days * 1440)
        per_day = {"OD": 1, "BD": 2, "TDS": 3, "QID": 4}.get(freq, 1)
        self.drug_orders.append((oid, DRUG_ID[drug_concept], dose, None, freq, days, "Days",
                                 qty if qty is not None else float(per_day * days), 0))
        return oid

    def program(self, program_id: int, t: int, loc: int, completed=None):
        if not self.recordable(t, loc):
            return
        self.programs.append((self.pid, program_id, t, completed, loc))
