# Care loop (v3): following the patient past the flag

v3 follows the patient past the flag. A doctor approves a care plan, and the patient gets advice to visit on a simulated
phone. The synthetic EMR records whether they came: the care world decides, with reminders and CHW visits. The outcome
then updates the journey, the marts and a challenger model, and the ministry sees the programme, a 2031 outlook and data
videos. Contracts: [`contracts/v3-loop.md`](contracts/v3-loop.md); decisions D-46 to D-57 in
[`decisions.md`](decisions.md).

| Part | Folder | What it does |
|---|---|---|
| Care engine | `care/`, `config/care_pathways.yaml` | Six pathways (endoscopy referral, H. pylori test and treat, anaemia work-up, oncology, survivorship, palliative), tasks closed by EMR evidence, reminder ladder app -> SMS -> CHW -> doctor |
| Sim clock + care world | `simulator/local.py`, `simulator/care_world.py` | MySQL-free time travel: replay the future, simulate how patients respond, write EMR rows back, re-run the pipeline |
| Learning loop | `ml/retrain.py`, `ml/adherence.py` | IPW challenger on verified outcomes, gates, human Promote in Model Arena |
| Forecasting | `ml/forecast/`, `generator/external/` | Synthetic registry 2000-2026, surveys, projections; APC + ETS forecasts to 2031 with 80/95% bands, drivers, scenarios |
| Patient app | `frontend/src/views/patient` | Phone-frame simulator at `/patient` (PWA screens) |
| Videos | `video/` | Remotion case summary (doctor) and national reel (ministry), MP4 with poster |

## Demo the full loop in 10 steps

The dataset is in `data/v3`; `make` exports `DATA_DIR` from `.env`.

1. **Data and servers.** `make dev-data-next` once (about 15 min), then `make care-seed` (8 demo plans at Musanze 1207 and
   Kayonza 1219) and `make serve` (API :8000, dashboard :5173, agent :8787, video :8790).
2. **Doctor approves.** Switch the role pill to Doctor, facility Musanze District Hospital. In the workspace open a
   HIGH-risk patient's case, click **Approve & plan** on the alert, keep the suggested pathway (for example endoscopy
   referral), check the patient message preview (advice to visit, no diagnosis words) and approve.
3. **Patient phone.** Switch the role to Patient and pick the same display ID at `/patient`: the notification drops in
   on the phone frame, the care plan shows the open task, and the event log explains what happened.
4. **Patient acts.** On the phone tap "I've booked" or send a weekly check-in; it is written to the EMR as a
   `PATIENT_REPORTED` encounter.
5. **Advance time.** Open the **Simulation** popover in the top bar and click +1 week (or run `make advance DAYS=7`).
   The care world decides who attends; reminders, SMS and CHW visits fire for overdue tasks.
6. **Evidence closes tasks.** Back as the doctor, the **Follow-ups** tab lists overdue tasks first (ranked by predicted
   adherence); the patient's task turns COMPLETED with an EMR evidence link once the endoscopy encounter arrives.
7. **Journey.** The case screen's **Journey** tab shows the phase track (Flagged -> Approved -> Notified -> Endoscopy ->
   Diagnosis -> Treatment ...), recovery tiles (weight, B12, Hb, ECOG, chemo cycles) and the survivorship schedule.
8. **Ministry programme and learning loop.** As Ministry, **Follow-up** (`/programme`) shows the funnel flagged ->
   approved -> notified -> attended -> endoscopy, adherence by channel and distance, CHW workload; **Models** shows the
   challenger, its gates and the **Promote** button (`make retrain` trains one now).
9. **Outlook.** `/outlook` shows the 2031 fan chart with 80/95% bands, the drivers (population, ageing, risk) and the
   scenario simulator (for example +50% H. pylori test-and-treat: cases averted and stage shift, associational).
10. **Video and agent.** **Create video** on the case screen (doctor) or on Overview / Outlook (ministry) renders an MP4
    with a poster and download link. Ask the agent "Which follow-ups are overdue?", "Draft an H. pylori plan for
    MUS-00241753" (a preview only: the doctor approves in the UI) or "How many cases do we expect in 2031?".

The daily brief (`make report`) includes care coordination KPIs and the 2031 outlook line.

## Commands

```bash
make advance DAYS=7    # +7 sim days (care world, reconcile, pipeline, publish); make sim-local = auto clock
make care-seed         # ~8 demo care plans
make forecast          # forecasts + backtests; make retrain = challenger + gates; make external-data = ext_* sources
make video-serve       # render server :8790
make video-render KIND=patient ID=<patient_id>    # or KIND=ministry FROM= TO=
```
