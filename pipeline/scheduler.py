"""APScheduler loop (SPEC §10.4): one pipeline batch every tick_seconds, never overlapping."""
from __future__ import annotations

import os
import time

from apscheduler.schedulers.blocking import BlockingScheduler
from apscheduler.triggers.interval import IntervalTrigger

from shared.config import pipeline_cfg

from .run import run


def job():
    try:
        run()
    except Exception as e:  # a failed batch never publishes; the next tick retries
        print(f"pipeline run failed: {e}", flush=True)


if __name__ == "__main__":
    cfg = pipeline_cfg()
    secs = int(os.environ.get("PIPELINE_TICK_SECONDS", os.environ.get("TICK_SECONDS", cfg["tick_seconds"])))
    if os.environ.get("DEMO_MODE", "false").lower() == "true":
        secs = int(os.environ.get("PIPELINE_TICK_SECONDS", 60))
    time.sleep(int(os.environ.get("PIPELINE_OFFSET_SECONDS", 0)))
    s = BlockingScheduler()
    s.add_job(job, IntervalTrigger(seconds=secs), max_instances=1, coalesce=True, next_run_time=__import__("datetime").datetime.now())
    print(f"pipeline scheduler: every {secs}s", flush=True)
    s.start()
