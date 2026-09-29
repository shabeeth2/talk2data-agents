"""Loopback HTTP adapter for the local investigation engine.

Run with ``python -m talk2data.api``. The Next.js app proxies /api requests
to this service; the browser never needs a database URL or provider key.
"""

from __future__ import annotations

import logging
import os
import re
from typing import Any, Literal

from fastapi import FastAPI, File, Query, Request, UploadFile
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field
from starlette.middleware.trustedhost import TrustedHostMiddleware

from . import change, dashboards, engine, extensions

app = FastAPI(title="Talk2Data local API")
app.add_middleware(TrustedHostMiddleware, allowed_hosts=["localhost", "127.0.0.1"])
logger = logging.getLogger(__name__)


@app.middleware("http")
async def local_browser_requests(request: Request, call_next):
    # Block cross-site writes and DNS rebinding against the local workbench.
    origin = request.headers.get("origin")
    if origin and origin not in {"http://localhost:3000", "http://127.0.0.1:3000"}:
        return JSONResponse(status_code=403, content={"detail": "Use the local Talk2Data app to access this workspace."})
    return await call_next(request)


@app.exception_handler(ValueError)
async def invalid_request(request: Request, exc: ValueError):
    return JSONResponse(status_code=400, content={"detail": str(exc)})


@app.exception_handler(PermissionError)
async def permission_required(request: Request, exc: PermissionError):
    return JSONResponse(status_code=403, content={"detail": str(exc)})


@app.exception_handler(Exception)
async def operation_failed(request: Request, exc: Exception):
    logger.exception("Local API operation failed", exc_info=exc)
    # Database/connection errors can contain credentials or private records.
    return JSONResponse(status_code=500, content={"detail": "The operation failed. Check your source connection and query, then try again."})


class Input(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)


class Investigation(Input):
    source: str = Field(min_length=1, max_length=300)
    question: str = Field(min_length=1, max_length=10000)
    sql: str = Field(default="", max_length=50000)
    answers: dict[str, str] = Field(default_factory=dict, max_length=4)


class DashboardRequest(Input):
    source: str = Field(min_length=1, max_length=300)
    question: str = Field(min_length=1, max_length=10000)
    answers: dict[str, str] = Field(default_factory=dict, max_length=4)


class SavedDashboard(DashboardRequest):
    name: str = Field(min_length=1, max_length=300)
    id: int | None = Field(default=None, gt=0)


class AgentDashboard(DashboardRequest):
    plan: dict[str, Any]
    saved_id: int | None = Field(default=None, gt=0)


class DashboardAnswers(Input):
    answers: dict[str, str] = Field(default_factory=dict, max_length=4)


class Connection(Input):
    name: str = Field(min_length=1, max_length=300)
    url: str = Field(min_length=1, max_length=4000)


class ChangeSettings(Input):
    source: str = Field(min_length=1, max_length=300)
    table: str = Field(min_length=1, max_length=300)
    date: str = Field(min_length=1, max_length=300)
    measure: str = Field(min_length=1, max_length=300)
    dimension: str = Field(default="", max_length=300)
    window_days: Literal[7, 14, 28] = 28


class SavedChange(Input):
    name: str = Field(min_length=1, max_length=300)
    settings: ChangeSettings
    id: int | None = Field(default=None, gt=0)
    as_of: str | None = Field(default=None, max_length=100)


class Skill(Input):
    name: str = Field(min_length=1, max_length=300)
    command: str = Field(min_length=2, max_length=100, pattern=r"^/[A-Za-z0-9_-]+$")
    instruction: str = Field(min_length=10, max_length=10000)


class ToolCall(Input):
    server: str = Field(min_length=1, max_length=300)
    tool: str = Field(min_length=1, max_length=300)
    arguments: dict[str, Any]
    approved: bool = Field(default=False, strict=True)


def change_from_question(source: str, question: str) -> dict | None:
    """Route a change question only when it identifies a single measure."""
    if not re.search(r"\b(drop|decline|fell|increase|rise|change|spike|dip)\b", question, re.I):
        return None
    for table in change.choices(source):
        matches = [m for m in table["measures"] if re.search(rf"\b{re.escape(m)}\b", question, re.I)]
        if len(matches) == 1:
            return {"source": source, "table": table["table"], "date": table["default_date"],
                    "measure": matches[0], "dimension": table["dimensions"][0] if table["dimensions"] else "",
                    "window_days": 28}
    return None


def extension_info() -> dict:
    data = extensions.config()
    saved_skills = [{"name": item["name"], "command": item["command"],
                     "description": f"Rerun saved change checks on {item['source']}."} for item in change.saved()]
    return {"servers": data["servers"], "skills": extensions.BUILTIN_SKILLS + data["skills"] + saved_skills}


@app.get("/api/workspace")
def workspace():
    return {"sources": engine.sources(), "runs": engine.recent_runs(),
            "saved_changes": change.saved(), "dashboards": dashboards.saved(), **extension_info(),
            "model_configured": bool(os.getenv("TALK2DATA_LLM_URL") and os.getenv("TALK2DATA_LLM_MODEL"))}


@app.get("/api/schema")
def schema(source: str = Query(min_length=1, max_length=300)):
    return engine.schema(source)


@app.get("/api/agent/context")
def agent_context(source: str = Query(min_length=1, max_length=300),
                  question: str = Query(min_length=1, max_length=10000)):
    """Expose only the schema and selected skill needed to plan tool calls."""
    from sqlalchemy import create_engine

    tables = engine.schema(source)
    if not tables:
        raise ValueError("No tables found in this source.")
    connection = create_engine(engine.source_url(source).split("#", 1)[0])
    try:
        dialect = connection.dialect.name
    finally:
        connection.dispose()
    skill = extensions.skill_for(question)
    return {"source": source, "schema": tables, "dialect": dialect,
            "instruction": skill["description"] if skill else ""}


@app.post("/api/agent/dashboard")
def agent_dashboard(body: AgentDashboard):
    saved = None
    if body.saved_id is not None:
        saved = next((item for item in dashboards.saved() if item["id"] == body.saved_id), None)
        if not saved or (saved["source"], saved["question"]) != (body.source, body.question):
            raise ValueError("The saved dashboard settings do not match this request.")
    result = dashboards.materialize(body.source, body.question, body.answers, body.plan)
    if saved:
        result = dashboards.compare_saved_run(body.saved_id, result)
        dashboards.mark_run(body.saved_id, result["as_of"])
        result.update(saved_id=body.saved_id, saved_name=saved["name"])
    return result


@app.get("/api/runs/{run_id}")
def load_run(run_id: int):
    return engine.load_run(run_id)


@app.post("/api/investigate")
def investigate(body: Investigation):
    if body.sql:
        return engine.investigate(body.question, body.source, body.sql)
    if re.search(r"\bdashboard\b", body.question, re.I):
        return dashboards.generate(body.source, body.question, body.answers)
    saved_command = re.fullmatch(r"/check_(\d+)", body.question)
    if saved_command:
        return rerun_saved_change(int(saved_command.group(1)))
    if settings := change_from_question(body.source, body.question):
        return change.run(settings)
    return engine.investigate(body.question, body.source)


@app.post("/api/dashboards/generate")
def generate_dashboard(body: DashboardRequest):
    return dashboards.generate(body.source, body.question, body.answers)


@app.get("/api/dashboards")
def list_dashboards():
    return dashboards.saved()


@app.post("/api/dashboards/save")
def save_dashboard(body: SavedDashboard):
    return {"id": dashboards.save(body.name, body.source, body.question, body.answers, body.id)}


@app.post("/api/dashboards/{dashboard_id}/run")
def run_dashboard(dashboard_id: int, body: DashboardAnswers | None = None):
    return dashboards.rerun(dashboard_id, body.answers if body else None)


@app.post("/api/sources/connect")
def connect(body: Connection):
    engine.add_sql_source(body.name, body.url)
    return {"source": body.name}


@app.post("/api/sources/upload")
async def upload(file: UploadFile = File()):
    try:
        content = await file.read(30 * 1024 * 1024 + 1)
        # import_file enforces the size, column count, and supported formats.
        return {"source": engine.import_file(file.filename or "dataset", content)}
    finally:
        await file.close()


@app.get("/api/change/choices")
def change_choices(source: str = Query(min_length=1, max_length=300)):
    return change.choices(source)


@app.post("/api/change/run")
def run_change(body: ChangeSettings):
    return change.run(body.model_dump())


@app.post("/api/change/save")
def save_change(body: SavedChange):
    investigation_id = change.save(body.name, body.settings.model_dump(), body.id)
    if body.as_of:
        change.mark_run(investigation_id, body.as_of)
    return {"id": investigation_id}


@app.post("/api/change/{investigation_id}/run")
def rerun_saved_change(investigation_id: int):
    name, settings = change.load(investigation_id)
    result = change.run(settings)
    change.mark_run(investigation_id, result["as_of"])
    return {**result, "saved_id": investigation_id, "saved_name": name}


@app.get("/api/extensions")
def get_extensions():
    return extension_info()


@app.post("/api/extensions/skills")
def add_skill(body: Skill):
    extensions.add_skill(body.name, body.command, body.instruction)
    return extension_info()


@app.post("/api/extensions/servers")
def add_server(body: Connection):
    extensions.add_server(body.name, body.url)
    return extension_info()


@app.get("/api/extensions/servers/{name}/tools")
async def list_tools(name: str):
    return await extensions.list_mcp_tools(name)


@app.post("/api/extensions/call")
async def call_tool(body: ToolCall):
    # This is the only path that invokes a tool. The UI displays this exact
    # server, tool, and JSON object before a per-call approval click.
    result = await extensions.call_mcp_tool(body.server, body.tool, body.arguments, approved=body.approved)
    return {"result": result}


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("talk2data.api:app", host="127.0.0.1", port=8000)
