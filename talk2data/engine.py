"""Source access and bounded analysis, independent of the web UI."""

from __future__ import annotations

import csv
import io
import json
import math
import os
import re
import sqlite3
import statistics
import shutil
from dataclasses import dataclass
from datetime import date, timedelta
from pathlib import Path
from typing import Any
from urllib import request

import pandas as pd

ROOT = Path(os.getenv("TALK2DATA_HOME", Path.home() / ".talk2data"))
ROOT.mkdir(parents=True, exist_ok=True)
STORE = ROOT / "workspace.sqlite"
FILES = ROOT / "uploads"
FILES.mkdir(exist_ok=True)


def _db() -> sqlite3.Connection:
    db = sqlite3.connect(STORE)
    db.row_factory = sqlite3.Row
    db.execute("CREATE TABLE IF NOT EXISTS sources (name TEXT PRIMARY KEY, url TEXT NOT NULL, kind TEXT NOT NULL)")
    db.execute("CREATE TABLE IF NOT EXISTS runs (id INTEGER PRIMARY KEY, question TEXT, source TEXT, kind TEXT, payload TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP)")
    db.commit()
    return db


def ensure_demo() -> None:
    with _db() as db:
        found = db.execute("SELECT 1 FROM sources WHERE name='Sample retail data'").fetchone()
        if found:
            # Keep workspace metadata and uploaded tables out of the demo schema.
            db.execute("UPDATE sources SET url=? WHERE name='Sample retail data' AND kind='demo'",
                       (f"sqlite:///{STORE}#retail_orders",))
            return
        db.execute("CREATE TABLE IF NOT EXISTS retail_orders (order_date TEXT, region TEXT, category TEXT, revenue REAL, orders INTEGER)")
        regions = ["North", "South", "East", "West"]
        categories = ["Electronics", "Home", "Wellness"]
        start = date(2026, 1, 1)
        rows = []
        for day in range(180):
            d = start + timedelta(days=day)
            for i, region in enumerate(regions):
                for j, category in enumerate(categories):
                    orders = 10 + i * 3 + j * 2 + day // 24 + ((day * 7 + i * 3 + j * 11) % 9)
                    revenue = round(orders * (24 + j * 11 + i * 2) * (1 + (day % 7) / 30), 2)
                    if day >= 143 and region == "West" and category in {"Electronics", "Home"}:
                        revenue = round(revenue * (0.25 if category == "Electronics" else 0.55), 2)
                    rows.append((d.isoformat(), region, category, revenue, orders))
        db.executemany("INSERT INTO retail_orders VALUES (?, ?, ?, ?, ?)", rows)
        db.execute("INSERT INTO sources VALUES (?, ?, ?)", ("Sample retail data", f"sqlite:///{STORE}#retail_orders", "demo"))


def sources() -> list[dict[str, str]]:
    ensure_demo()
    with _db() as db:
        return [dict(r) for r in db.execute("SELECT name, kind FROM sources ORDER BY name")]


def source_url(name: str) -> str:
    with _db() as db:
        row = db.execute("SELECT url FROM sources WHERE name=?", (name,)).fetchone()
    if not row:
        raise ValueError("Select a connected source first.")
    return str(row["url"])


def add_sql_source(name: str, url: str) -> None:
    from sqlalchemy import create_engine, inspect

    name = name.strip()
    if not name or not url.strip():
        raise ValueError("Enter a connection name and SQLAlchemy URL.")
    engine = create_engine(url, connect_args={"timeout": 5} if url.startswith("sqlite:") else {}, pool_pre_ping=True)
    try:
        with engine.connect() as conn:
            inspect(conn).get_table_names()
    finally:
        engine.dispose()
    with _db() as db:
        db.execute("INSERT OR REPLACE INTO sources VALUES (?, ?, 'sql')", (name, url))


def import_file(filename: str, content: bytes) -> str:
    ext = Path(filename).suffix.lower()
    if len(content) > 30 * 1024 * 1024:
        raise ValueError("File exceeds the 30 MB local import limit.")
    data = io.BytesIO(content)
    if ext == ".csv":
        df = pd.read_csv(data)
    elif ext == ".tsv":
        df = pd.read_csv(data, sep="\t")
    elif ext in {".xlsx", ".xls"}:
        df = pd.read_excel(data)
    elif ext == ".parquet":
        df = pd.read_parquet(data)
    elif ext in {".json", ".jsonl"}:
        df = pd.read_json(data, lines=ext == ".jsonl")
    else:
        raise ValueError("Choose CSV, TSV, Excel, Parquet, JSON, or JSONL.")
    if df.empty or len(df.columns) > 150:
        raise ValueError("The file needs rows and no more than 150 columns.")
    safe = re.sub(r"\W+", "_", Path(filename).stem.lower()).strip("_")[:35] or "dataset"
    table = f"file_{safe}"
    df.columns = [re.sub(r"\W+", "_", str(col).strip().lower()).strip("_") or f"column_{i}" for i, col in enumerate(df.columns)]
    df.columns = _unique_columns(list(df.columns))
    with _db() as db:
        df.to_sql(table, db, if_exists="replace", index=False)
        db.execute("INSERT OR REPLACE INTO sources VALUES (?, ?, 'file')", (filename, f"sqlite:///{STORE}#{table}"))
    return filename


def _unique_columns(cols: list[str]) -> list[str]:
    seen: dict[str, int] = {}
    result = []
    for col in cols:
        seen[col] = seen.get(col, 0) + 1
        result.append(col if seen[col] == 1 else f"{col}_{seen[col]}")
    return result


def schema(name: str) -> list[dict[str, Any]]:
    from sqlalchemy import create_engine, inspect

    url = source_url(name).split("#", 1)[0]
    engine = create_engine(url)
    try:
        inspector = inspect(engine)
        table_filter = source_url(name).split("#", 1)[1] if "#" in source_url(name) else None
        return [{"table": table, "columns": [f"{c['name']} ({c['type']})" for c in inspector.get_columns(table)]}
                for table in inspector.get_table_names() if not table_filter or table == table_filter][:30]
    finally:
        engine.dispose()


DENIED = re.compile(r"\b(insert|update|delete|drop|alter|create|attach|detach|pragma|vacuum|replace|merge|truncate|grant|revoke|execute|exec|copy|call|into|outfile|load_extension)\b", re.I)


def validate_sql(sql: str) -> str:
    sql = sql.strip().rstrip(";").strip()
    clean = re.sub(r"/\*.*?\*/|--[^\n]*", "", sql, flags=re.S)
    if not re.match(r"^\s*(select|with)\b", clean, re.I) or ";" in clean or DENIED.search(clean):
        raise ValueError("Only a single read-only SELECT query is allowed. Use a read-only database account as well.")
    return sql


def execute(name: str, sql: str, limit: int = 500) -> pd.DataFrame:
    from sqlalchemy import create_engine

    sql = validate_sql(sql)
    url = source_url(name).split("#", 1)[0]
    engine = create_engine(url, pool_pre_ping=True)
    try:
        # Outer LIMIT also bounds queries where the model omitted a limit.
        bounded = f"SELECT * FROM ({sql}) AS talk2data_result LIMIT {int(limit)}"
        with engine.connect() as conn:
            return pd.read_sql_query(bounded, conn)
    finally:
        engine.dispose()


def _numeric(df: pd.DataFrame) -> list[str]:
    return list(df.select_dtypes(include="number").columns)


def _date_column(df: pd.DataFrame) -> str | None:
    for col in df.columns:
        if any(word in col.lower() for word in ("date", "time", "month", "day")):
            parsed = pd.to_datetime(df[col], errors="coerce")
            if parsed.notna().mean() > .7:
                return col
    return None


def _chart(df: pd.DataFrame) -> dict[str, Any]:
    if df.empty or len(df.columns) < 2:
        return {"type": "none", "data": []}
    numeric = _numeric(df)
    if not numeric:
        return {"type": "none", "data": []}
    x = next((c for c in df.columns if c not in numeric), df.columns[0])
    y = next((c for c in numeric if c != x), numeric[0])
    kind = "line" if _date_column(df) == x or "date" in x.lower() else "bar"
    frame = df[[x, y]].head(60).copy().fillna(0)
    frame[x] = frame[x].astype(str)
    return {"type": kind, "x": x, "y": y, "data": frame.to_dict("records")}


def _profile(df: pd.DataFrame) -> str:
    facts = [f"{len(df):,} rows and {len(df.columns)} columns in the result."]
    missing = df.isna().sum().sort_values(ascending=False)
    if len(missing) and missing.iloc[0]:
        facts.append(f"Most missing values: {missing.index[0]} ({int(missing.iloc[0])}).")
    for col in _numeric(df)[:2]:
        facts.append(f"{col}: median {df[col].median():,.2f}; range {df[col].min():,.2f}–{df[col].max():,.2f}.")
    return " ".join(facts)


def _anomaly(df: pd.DataFrame) -> tuple[str, pd.DataFrame]:
    cols = _numeric(df)
    if not cols or len(df) < 5:
        return "Need at least five rows and a numeric measure for anomaly detection.", df.head(0)
    col = cols[0]
    values = pd.to_numeric(df[col], errors="coerce")
    med = values.median()
    mad = (values - med).abs().median()
    if not mad or pd.isna(mad):
        return f"No robust spread detected for {col}; try comparing segments or time periods.", df.head(0)
    score = .6745 * (values - med).abs() / mad
    hits = df.loc[score > 3.5].copy()
    hits["anomaly_score"] = score.loc[hits.index].round(2)
    return f"Found {len(hits)} potential outliers in {col} using a median absolute deviation threshold of 3.5. These are leads to inspect, not confirmed faults.", hits.head(100)


def _forecast(df: pd.DataFrame, horizon: int = 14) -> tuple[str, pd.DataFrame]:
    date_col = _date_column(df)
    nums = _numeric(df)
    if not date_col or not nums:
        return "Forecast needs a date column and a numeric measure.", df.head(0)
    col = nums[0]
    frame = df[[date_col, col]].copy()
    frame[date_col] = pd.to_datetime(frame[date_col], errors="coerce")
    frame[col] = pd.to_numeric(frame[col], errors="coerce")
    frame = frame.dropna().groupby(date_col, as_index=False)[col].sum().sort_values(date_col)
    if len(frame) < 14:
        return "Forecast needs at least 14 observed dates; more history improves evaluation.", frame.head(0)
    frequency = pd.infer_freq(frame[date_col]) or "D"
    try:
        future_dates = pd.date_range(frame[date_col].max(), periods=horizon + 1, freq=frequency)[1:]
    except ValueError:
        future_dates = pd.date_range(frame[date_col].max(), periods=horizon + 1, freq="D")[1:]
    season = 7 if len(frame) >= 21 and frequency.upper().startswith("D") else 1
    holdout = min(7, max(2, len(frame) // 5))
    history = frame[col].iloc[:-holdout].tolist()
    actual = frame[col].iloc[-holdout:].tolist()
    pred = [history[(len(history) + i - season) % len(history)] for i in range(holdout)]
    mae = sum(abs(a - b) for a, b in zip(actual, pred)) / holdout
    vals = frame[col].tolist()
    forecast = [vals[(len(vals) + i - season) % len(vals)] for i in range(horizon)]
    provider_note = "Seasonal naive baseline"
    if os.getenv("TALK2DATA_FORECAST_PROVIDER", "baseline").lower() == "timesfm3":
        if os.getenv("TALK2DATA_TIMESFM_NONCOMMERCIAL") != "1":
            raise ValueError("TimesFM 3 weights require noncommercial, nonproduction use. Set TALK2DATA_TIMESFM_NONCOMMERCIAL=1 only if this use qualifies.")
        if shutil.disk_usage(ROOT).free < 2_000_000_000:
            raise ValueError("TimesFM needs at least 2 GB of free disk space before model download.")
        if hasattr(os, "sysconf") and os.sysconf("SC_AVPHYS_PAGES") * os.sysconf("SC_PAGE_SIZE") < 3_000_000_000:
            raise ValueError("TimesFM needs at least 3 GB of available RAM. Use the baseline provider instead.")
        try:
            import numpy as np
            from timesfm3 import ModelConfig, TimesFM3Evaluator
        except ImportError as exc:
            raise ValueError("Install the optional TimesFM 3 dependencies before selecting this provider.") from exc
        device = os.getenv("TALK2DATA_TIMESFM_DEVICE", "cpu")
        forecaster = TimesFM3Evaluator(ModelConfig(checkpoint_path="google/timesfm-3.0-pytorch", per_core_batch_size=1, device=device))
        trial = list(forecaster.predict_batch([np.asarray(history, dtype=np.float32)], horizon=holdout, return_quantiles=False, use_symmetric_averaging=False))[0]
        trial_mae = sum(abs(a - float(b)) for a, b in zip(actual, trial.forecast)) / holdout
        if trial_mae < mae:
            prediction = list(forecaster.predict_batch([np.asarray(vals, dtype=np.float32)], horizon=horizon, return_quantiles=False, use_symmetric_averaging=False))[0]
            forecast = [float(v) for v in prediction.forecast]
            mae = trial_mae
            provider_note = "TimesFM 3 beat the baseline on this holdout"
        else:
            provider_note = "Seasonal naive beat TimesFM 3 on this holdout"
    output = pd.DataFrame({date_col: future_dates.strftime("%Y-%m-%d"), "forecast": forecast,
                           "lower": [max(0, v - 1.96 * mae) for v in forecast], "upper": [v + 1.96 * mae for v in forecast]})
    return f"{horizon}-step forecast for {col}. {provider_note}. Holdout mean absolute error: {mae:,.2f} across {holdout} observations. Band is an error-based guide, not a calibrated prediction interval. Frequency: {frequency}.", output


def _follow_up(source: str, tables: list[dict[str, Any]]) -> str:
    """Check whether a recent aggregate change is concentrated in a segment."""
    if not tables:
        return ""
    table = tables[0]["table"]
    names = [c.split(" (")[0] for c in tables[0]["columns"]]
    date_col = next((c for c in names if "date" in c.lower()), None)
    group = next((c for c in names if c.lower() in ("region", "category", "segment")), None)
    measure = next((c for c in names if c.lower() in ("revenue", "sales", "amount")), None)
    if not all((date_col, group, measure)):
        return "No clear date, segment, and measure columns were found for a follow-up breakdown."
    query = f'SELECT "{date_col}", "{group}", SUM("{measure}") AS value FROM "{table}" GROUP BY "{date_col}", "{group}" ORDER BY "{date_col}" DESC LIMIT 500'
    df = execute(source, query)
    if df.empty:
        return ""
    df[date_col] = pd.to_datetime(df[date_col], errors="coerce")
    last_date = df[date_col].max()
    current = df[df[date_col] > last_date - pd.Timedelta(days=28)].groupby(group)["value"].sum()
    previous = df[(df[date_col] <= last_date - pd.Timedelta(days=28)) & (df[date_col] > last_date - pd.Timedelta(days=56))].groupby(group)["value"].sum()
    delta = current.subtract(previous, fill_value=0).sort_values()
    if delta.empty:
        return ""
    leader = delta.index[0]
    return f"Follow-up: the largest decline in the latest 28 days versus the prior 28 was {group}={leader} ({delta.iloc[0]:+,.2f} {measure}). This is a contribution, not a proven cause."


def _intent(question: str) -> str:
    cmd = re.match(r"^/(\w+)", question.strip())
    if cmd:
        return cmd.group(1).lower()
    lower = question.lower()
    if "forecast" in lower or "predict" in lower:
        return "forecast"
    if "anomal" in lower or "outlier" in lower or "unusual" in lower:
        return "anomaly"
    if "profil" in lower or "missing" in lower or "quality" in lower:
        return "profile"
    if "compar" in lower or "change" in lower or "drop" in lower:
        return "compare"
    return "visualize"


def _default_sql(question: str, tables: list[dict[str, Any]], kind: str) -> str:
    if not tables:
        raise ValueError("No tables found in this source.")
    first = tables[0]
    table = first["table"]
    names = [c.split(" (")[0] for c in first["columns"]]
    date_col = next((c for c in names if "date" in c.lower() or "time" in c.lower()), None)
    numeric = next((c for c in names if any(w in c.lower() for w in ("revenue", "amount", "sales", "total", "price", "orders"))), None)
    group = next((c for c in names if any(w in c.lower() for w in ("region", "category", "segment", "type"))), None)
    if date_col and numeric and kind in {"forecast", "anomaly", "compare"}:
        return f'SELECT "{date_col}", SUM("{numeric}") AS "{numeric}" FROM "{table}" GROUP BY "{date_col}" ORDER BY "{date_col}" DESC LIMIT 180'
    if date_col and numeric and ("trend" in question.lower() or "over time" in question.lower()):
        return f'SELECT "{date_col}", SUM("{numeric}") AS "{numeric}" FROM "{table}" GROUP BY "{date_col}" ORDER BY "{date_col}" DESC LIMIT 180'
    if group and numeric:
        return f'SELECT "{group}", SUM("{numeric}") AS "{numeric}" FROM "{table}" GROUP BY "{group}" ORDER BY "{numeric}" DESC LIMIT 50'
    return f'SELECT * FROM "{table}" LIMIT 100'


def _llm_sql(question: str, tables: list[dict[str, Any]]) -> str | None:
    endpoint = os.getenv("TALK2DATA_LLM_URL")
    model = os.getenv("TALK2DATA_LLM_MODEL")
    if not endpoint or not model:
        return None
    prompt = f"Write one read-only SQL SELECT query. Return ONLY SQL. Dialect matches the connected database. Maximum 200 result rows. Schema: {json.dumps(tables)}. User question: {question}"
    body = json.dumps({"model": model, "messages": [{"role": "user", "content": prompt}], "temperature": 0}).encode()
    headers = {"Content-Type": "application/json"}
    key = os.getenv("TALK2DATA_LLM_KEY")
    if key:
        headers["Authorization"] = f"Bearer {key}"
    req = request.Request(endpoint, body, headers, method="POST")
    with request.urlopen(req, timeout=18) as res:
        response = json.load(res)
    return validate_sql(response["choices"][0]["message"]["content"].strip().strip("`").removeprefix("sql\n"))


def investigate(question: str, source: str, sql_override: str = "") -> dict[str, Any]:
    kind = _intent(question)
    tables = schema(source)
    from .extensions import skill_for
    skill = skill_for(question)
    model_question = f"{question}\nAnalysis instruction: {skill['description']}" if skill else question
    model_note = ""
    sql = sql_override.strip() or (question.strip()[5:].strip() if kind == "sql" else "")
    if not sql:
        try:
            model_sql = _llm_sql(model_question, tables)
            sql = model_sql or _default_sql(question, tables, kind)
            if not model_sql:
                model_note = "Starter analysis based on detected columns; configure a model for detailed natural-language questions. "
        except Exception as exc:
            sql = _default_sql(question, tables, kind)
            model_note = f"Model unavailable ({type(exc).__name__}); showing a starter analysis instead. "
    df = execute(source, sql)
    if df.empty:
        summary = "The query returned no rows. Try a wider date range or another source."
        output = df
    elif kind == "forecast":
        summary, output = _forecast(df.sort_values(_date_column(df)) if _date_column(df) else df)
    elif kind == "anomaly":
        summary, output = _anomaly(df)
    else:
        summary, output = _profile(df), df
        if kind == "ml":
            summary += " ML assessment: identify a target and prediction time, remove leakage, split by time or entity, and compare a simple baseline before fitting a model. No model was trained."
    if kind == "compare" or any(w in question.lower() for w in ("why", "drop", "decline")):
        try:
            summary += " " + _follow_up(source, tables)
        except Exception:
            summary += " A segment follow-up could not be completed with this source."
    summary = model_note + summary
    chart = _chart(output if not output.empty else df)
    rows = json.loads(output.head(100).to_json(orient="records", date_format="iso"))
    result = {"kind": kind, "question": question, "source": source, "sql": sql, "summary": summary,
              "chart": chart, "columns": list(output.columns), "rows": rows, "row_count": len(output),
              "trace": ["Inspected source schema", "Ran bounded read-only query", f"Applied {kind} analysis", "Prepared evidence and visualization"]}
    with _db() as db:
        db.execute("INSERT INTO runs (question, source, kind, payload) VALUES (?, ?, ?, ?)",
                   (question, source, kind, json.dumps(result, default=str)))
    return result


def recent_runs() -> list[dict[str, str]]:
    with _db() as db:
        return [dict(row) for row in db.execute("SELECT id, question, source, kind, created_at FROM runs ORDER BY id DESC LIMIT 12")]


def load_run(run_id: int) -> dict[str, Any]:
    with _db() as db:
        row = db.execute("SELECT payload FROM runs WHERE id=?", (run_id,)).fetchone()
    if not row:
        raise ValueError("That investigation no longer exists.")
    return json.loads(row["payload"])
