"""Integer day helpers: we represent dates as days since 1970-01-01 and datetimes as epoch minutes."""
from __future__ import annotations

import datetime as dt

EPOCH = dt.date(1970, 1, 1)


def d(s: str | dt.date) -> int:
    if isinstance(s, str):
        s = dt.date.fromisoformat(s)
    return (s - EPOCH).days


def to_date(day: int) -> dt.date:
    return EPOCH + dt.timedelta(days=int(day))


def year_of(day: int) -> int:
    return to_date(day).year


def year_start(y: int) -> int:
    return d(dt.date(y, 1, 1))


def month_of(day: int) -> int:
    return to_date(day).month


DAYS_PER_YEAR = 365.25
DAYS_PER_MONTH = 30.44
