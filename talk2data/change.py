"""Reproducible, bounded investigations of a metric change."""

from __future__ import annotations

import json
import sqlite3
from datetime import date, datetime, timedelta, timezone
from typing import Any

import pandas as pd
from sqlalchemy import create_engine, inspect, text

from . import engine


def _db() -> sqlite3.Connection:
    db = engine._db()
    db.execute("""CREATE TABLE IF NOT EXISTS change_investigations (
        id INTEGER PRIMARY KEY, name TEXT NOT NULL, source TEXT NOT NULL,
        settings TEXT NOT NULL, last_run TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP)""")
    db.commit()
    return db


def saved() -> list[dict[str, Any]]:
    with _db() as db:
        rows = [dict(row) for row in db.execute(
            "SELECT id, name, source, last_run FROM change_investigations ORDER BY id DESC LIMIT 20"
        )]
    return [{**row, "command": f"/check_{row['id']}"} for row in rows]


def save(name: str, settings: dict[str, Any], investigation_id: int | None = None) -> int:
    name = name.strip()
    if not name:
        raise ValueError("Name this investigation before saving it.")
    # Persist a validated specification, never a SQL string supplied by the model.
    source = settings["source"]
    validate_settings(settings)
    with _db() as db:
        if investigation_id is None:
            cur = db.execute("INSERT INTO change_investigations (name, source, settings) VALUES (?, ?, ?)",
                             (name, source, json.dumps(settings)))
            return int(cur.lastrowid)
        cur = db.execute("UPDATE change_investigations SET name=?, source=?, settings=? WHERE id=?",
                         (name, source, json.dumps(settings), investigation_id))
        if cur.rowcount != 1:
            raise ValueError("Saved investigation no longer exists.")
        return investigation_id


def load(investigation_id: int) -> tuple[str, dict[str, Any]]:
    with _db() as db:
        row = db.execute("SELECT name, settings FROM change_investigations WHERE id=?", (investigation_id,)).fetchone()
    if row is None:
        raise ValueError("Saved investigation no longer exists.")
    return row["name"], json.loads(row["settings"])


def mark_run(investigation_id: int, timestamp: str) -> None:
    with _db() as db:
        db.execute("UPDATE change_investigations SET last_run=? WHERE id=?", (timestamp, investigation_id))


def choices(source: str) -> list[dict[str, Any]]:
    """Offer useful default fields, while leaving the user's final choices visible."""
    from sqlalchemy.sql.sqltypes import Date, DateTime, Integer, Numeric

    url = engine.source_url(source).split("#", 1)[0]
    only = engine.source_url(source).split("#", 1)[1] if "#" in engine.source_url(source) else None
    db = create_engine(url)
    try:
        catalog = inspect(db)
        result = []
        for table in catalog.get_table_names():
            if only and table != only:
                continue
            columns = catalog.get_columns(table)
            dates = [c["name"] for c in columns if isinstance(c["type"], (Date, DateTime))
                     or any(token in c["name"].lower() for token in ("date", "day", "time"))]
            numbers = [c["name"] for c in columns if isinstance(c["type"], (Numeric, Integer))
                       or any(token in c["name"].lower() for token in ("revenue", "amount", "sales", "value", "orders"))]
            dimensions = [c["name"] for c in columns if c["name"] not in set(dates + numbers)]
            if dates and numbers:
                result.append({"table": table, "dates": dates, "measures": numbers,
                               "dimensions": dimensions, "default_date": dates[0],
                               "default_measure": numbers[0]})
        return result[:30]
    finally:
        db.dispose()


def validate_settings(settings: dict[str, Any]) -> None:
    allowed = next((t for t in choices(settings["source"]) if t["table"] == settings["table"]), None)
    if not allowed:
        raise ValueError("Select a table with a date and a numeric measure.")
    if settings["date"] not in allowed["dates"] or settings["measure"] not in allowed["measures"]:
        raise ValueError("The selected date or measure no longer exists in this source.")
    if settings["dimension"] and settings["dimension"] not in allowed["dimensions"]:
        raise ValueError("The selected breakdown field no longer exists in this source.")
    if settings["window_days"] not in (7, 14, 28):
        raise ValueError("Choose a 7, 14, or 28 day comparison window.")


def _format(value: float) -> str:
    return f"{value:,.2f}"


def _evidence(title: str, finding: str, interpretation: str, limitation: str, sql: str,
              status: str = "checked") -> dict[str, str]:
    return {"title": title, "finding": finding, "interpretation": interpretation,
            "limitation": limitation, "sql": sql, "status": status}


def run(settings: dict[str, Any]) -> dict[str, Any]:
    """Run the same deterministic checks on a source's latest two full windows.

    Aggregations occur in the database. Dimensions with more than 40 distinct
    values are skipped rather than silently truncating a contribution ranking.
    """
    validate_settings(settings)
    source, table, day, measure = (settings[k] for k in ("source", "table", "date", "measure"))
    dimension = settings["dimension"]
    days = settings["window_days"]
    db = create_engine(engine.source_url(source).split("#", 1)[0], pool_pre_ping=True)
    q = db.dialect.identifier_preparer.quote
    t, d, m = (q(item) for item in (table, day, measure))
    dialect = db.dialect.name
    if dialect == "sqlite":
        day_expr = f"SUBSTR({d}, 1, 10)"
    elif dialect == "oracle":
        day_expr = f"TRUNC({d})"
    else:
        day_expr = f"CAST({d} AS DATE)"
    queries: list[str] = []
    evidence: list[dict[str, str]] = []
    try:
        with db.connect() as conn:
            latest_query = f"SELECT MAX({d}) AS latest FROM {t}"
            latest = conn.execute(text(latest_query)).scalar()
            if latest is None:
                raise ValueError("No dated records found in this table.")
            latest_day = pd.to_datetime(latest, errors="coerce")
            if pd.isna(latest_day):
                raise ValueError("The date column needs readable dates in ISO format.")
            end = latest_day.date() + timedelta(days=1)
            middle = end - timedelta(days=days)
            start = middle - timedelta(days=days)
            params = {"start": start.isoformat(), "middle": middle.isoformat(), "end": end.isoformat()}
            def documented(sql: str) -> str:
                return f"-- Parameters: {json.dumps(params)}\n{sql}"
            # One bounded, aggregated query provides comparable totals and data checks.
            total_sql = f"""SELECT
                CASE WHEN {d} >= :middle THEN 'current' ELSE 'previous' END AS period,
                COALESCE(SUM({m}), 0) AS total, COUNT(*) AS rows,
                COUNT({m}) AS measured_rows, COUNT(DISTINCT {day_expr}) AS observed_dates
                FROM {t} WHERE {d} >= :start AND {d} < :end
                GROUP BY CASE WHEN {d} >= :middle THEN 'current' ELSE 'previous' END"""
            totals = {r["period"]: dict(r) for r in conn.execute(text(total_sql), params).mappings()}
            queries.append(total_sql)
            previous = totals.get("previous", {"total": 0, "rows": 0, "measured_rows": 0, "observed_dates": 0})
            current = totals.get("current", {"total": 0, "rows": 0, "measured_rows": 0, "observed_dates": 0})
            if not previous["rows"] or not current["rows"]:
                raise ValueError("Both comparison windows need records. Pick a shorter window or another source.")
            old, new = float(previous["total"]), float(current["total"])
            delta = new - old
            pct = (delta / abs(old) * 100) if old else None
            direction = "rose" if delta > 0 else "fell" if delta < 0 else "was unchanged"
            headline = (f"{measure} {direction} by {_format(abs(delta))}"
                        + (f" ({abs(pct):.1f}%)" if pct is not None else "")
                        + f" over the latest {days} days")
            evidence.append(_evidence("Verified change",
                f"{_format(old)} → {_format(new)} ({delta:+,.2f}). {start}–{middle - timedelta(days=1)} versus {middle}–{end - timedelta(days=1)}.",
                "The two windows have the same length and matching weekday mix.",
                "This is the sum of the selected field; a business metric definition may differ.", documented(total_sql)))

            row_old, row_new = int(previous["rows"]), int(current["rows"])
            measured_old, measured_new = int(previous["measured_rows"]), int(current["measured_rows"])
            coverage = (int(previous["observed_dates"]), int(current["observed_dates"]))
            missing = (row_old - measured_old, row_new - measured_new)
            quality_warning = missing != (0, 0) or min(coverage) < days
            evidence.append(_evidence("Check data completeness",
                f"Dates present: {coverage[0]}/{days} before, {coverage[1]}/{days} now. Missing {measure}: {missing[0]} before, {missing[1]} now.",
                "Gaps or newly missing values can distort the comparison." if quality_warning else "No missing dates or measure values appeared in either window.",
                "A date can be present even if some expected records have not arrived; the latest date may be partial.", documented(total_sql),
                "review" if quality_warning else "checked"))
            avg_old = old / row_old
            avg_new = new / row_new
            evidence.append(_evidence("Separate volume from value per row",
                f"Rows: {row_old:,} → {row_new:,}; average {measure} per row: {_format(avg_old)} → {_format(avg_new)}.",
                "A stable row count with a lower average points to a value change in recorded rows."
                if abs(row_new - row_old) <= max(1, row_old * .02) and avg_new < avg_old else
                "Both the number of rows and value per row should be considered.",
                "One row may summarize several events; row count is not necessarily a customer or order count.", documented(total_sql)))

            older_start = start - timedelta(days=2 * days)
            earlier_start = start - timedelta(days=days)
            history_params = {"older_start": older_start.isoformat(), "earlier_start": earlier_start.isoformat(), "start": start.isoformat()}
            history_sql = f"""SELECT
                CASE WHEN {d} >= :earlier_start THEN 'near' ELSE 'far' END AS period,
                COALESCE(SUM({m}), 0) AS total, COUNT(DISTINCT {day_expr}) AS observed_dates
                FROM {t} WHERE {d} >= :older_start AND {d} < :start
                GROUP BY CASE WHEN {d} >= :earlier_start THEN 'near' ELSE 'far' END"""
            historical = {r["period"]: dict(r) for r in conn.execute(text(history_sql), history_params).mappings()}
            queries.append(history_sql)
            if all(p in historical and int(historical[p]["observed_dates"]) == days for p in ("far", "near")):
                previous_movement = float(historical["near"]["total"]) - float(historical["far"]["total"])
                same_direction = previous_movement * delta > 0
                interpretation = ("A similar direction appeared in the earlier windows; inspect longer-term trend before calling this a new event."
                                  if same_direction else "The prior pair moved in another direction or stayed flat; this change merits closer inspection.")
                evidence.append(_evidence("Check earlier windows",
                    f"Previous equal-window change: {previous_movement:+,.2f}; latest change: {delta:+,.2f}.",
                    interpretation, "Four windows do not establish seasonality or statistical significance.",
                    f"-- Parameters: {json.dumps(history_params)}\n{history_sql}"))
            else:
                evidence.append(_evidence("Check earlier windows",
                    "There are not two additional complete windows of history.",
                    "No longer-term comparison was made.",
                    "Do not describe the latest movement as unprecedented without more history.",
                    f"-- Parameters: {json.dumps(history_params)}\n{history_sql}", "review"))

            segments: list[dict[str, Any]] = []
            if dimension:
                dim = q(dimension)
                cardinality_sql = f"SELECT COUNT(DISTINCT {dim}) FROM {t} WHERE {d} >= :start AND {d} < :end"
                n_categories = int(conn.execute(text(cardinality_sql), params).scalar() or 0)
                queries.append(cardinality_sql)
                if n_categories > 40:
                    evidence.append(_evidence("Segment breakdown needs narrowing",
                        f"{dimension} has {n_categories} distinct values across these windows.",
                        "Choose a lower-cardinality field for a complete, readable breakdown.",
                        "No category ranking was computed, so no contributor is inferred.", documented(cardinality_sql), "review"))
                else:
                    segment_sql = f"""SELECT
                        CASE WHEN {d} >= :middle THEN 'current' ELSE 'previous' END AS period,
                        {dim} AS segment, COALESCE(SUM({m}), 0) AS total, COUNT(*) AS rows
                        FROM {t} WHERE {d} >= :start AND {d} < :end
                        GROUP BY CASE WHEN {d} >= :middle THEN 'current' ELSE 'previous' END, {dim}"""
                    segment_rows = [dict(r) for r in conn.execute(text(segment_sql), params).mappings()]
                    queries.append(segment_sql)
                    by_segment: dict[str, dict[str, Any]] = {}
                    for row in segment_rows:
                        key = str(row["segment"]) if row["segment"] is not None else "(missing)"
                        by_segment.setdefault(key, {"segment": key, "previous": 0.0, "current": 0.0})[row["period"]] = float(row["total"])
                    segments = list(by_segment.values())
                    for item in segments:
                        item["change"] = round(item["current"] - item["previous"], 2)
                    segments.sort(key=lambda item: abs(item["change"]), reverse=True)
                    reconciles = (abs(sum(x["previous"] for x in segments) - old) < .02 and
                                  abs(sum(x["current"] for x in segments) - new) < .02)
                    if not reconciles:
                        raise ValueError("The segment totals did not reconcile to the metric total. No breakdown was reported.")
                    if segments:
                        aligned = [s for s in segments if s["change"] * delta > 0]
                        lead = max(aligned, key=lambda x: abs(x["change"])) if aligned else segments[0]
                        share = abs(lead["change"] / delta * 100) if delta else 0
                        evidence.append(_evidence(f"Largest contributing {dimension}",
                            f"{lead['segment']}: {_format(lead['previous'])} → {_format(lead['current'])} ({lead['change']:+,.2f}); {share:.1f}% of the net change.",
                            "This segment contributes to the arithmetic change. Opposing movements elsewhere can make the share exceed 100%.",
                            "Contribution does not establish the cause. Compare its underlying records and external events.", documented(segment_sql)))

            daily_sql = f"SELECT {day_expr} AS day, COALESCE(SUM({m}), 0) AS value FROM {t} WHERE {d} >= :start AND {d} < :end GROUP BY {day_expr} ORDER BY {day_expr}"
            daily = [{"day": str(r["day"])[:10], "value": float(r["value"])}
                     for r in conn.execute(text(daily_sql), params).mappings()]
            queries.append(daily_sql)
            evidence.append(_evidence("What remains unproven",
                "These checks show a measured difference and where it appears in the data.",
                "Next, inspect the leading segment's records and relevant operational events.",
                "No causal test or external context was performed. Do not treat a coincident event as a cause.", documented(segment_sql if segments else daily_sql), "review"))

            as_of = datetime.now(timezone.utc).isoformat(timespec="seconds")
            freshness = (datetime.now(timezone.utc).date() - latest_day.date()).days
            if freshness > 2:
                evidence.append(_evidence("Source freshness",
                    f"Latest recorded date is {latest_day.date()}, {freshness} days before today.",
                    "This investigation compares the latest available records, not today's activity.",
                    "A stale source can hide more recent changes.", latest_query, "review"))
            result = {"kind": "change", "title": headline, "source": source, "settings": settings,
                      "as_of": as_of, "latest_date": str(latest_day.date()), "start": str(start),
                      "middle": str(middle), "end": str(end), "previous": old, "current": new,
                      "delta": round(delta, 2), "percentage": round(pct, 1) if pct is not None else None,
                      "evidence": evidence, "segments": segments, "daily": daily, "queries": queries,
                      "caveat": "This is a contribution analysis. It does not prove why the change happened."}
            with _db() as local:
                local.execute("INSERT INTO runs (question, source, kind, payload) VALUES (?, ?, 'change', ?)",
                              (f"Investigate {measure} change", source, json.dumps(result)))
            return result
    finally:
        db.dispose()
