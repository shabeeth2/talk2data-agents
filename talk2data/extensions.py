"""User-defined analysis skills and explicitly approved MCP calls."""

from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Any

from .engine import ROOT

CONFIG = ROOT / "extensions.json"
BUILTIN_SKILLS = [
    {"name": "Visualize", "command": "/visualize", "description": "Build a chart from a query result."},
    {"name": "Forecast", "command": "/forecast", "description": "Compare a baseline with observed history."},
    {"name": "Anomaly", "command": "/anomaly", "description": "Flag unusual values for investigation."},
    {"name": "Data quality", "command": "/profile", "description": "Inspect missing values and ranges."},
    {"name": "ML investigation", "command": "/ml", "description": "Review task, labels, leakage, split, and a baseline before training."},
]


def config() -> dict[str, Any]:
    if CONFIG.exists():
        return json.loads(CONFIG.read_text())
    return {"servers": [], "skills": []}


def save_config(data: dict[str, Any]) -> None:
    CONFIG.write_text(json.dumps(data, indent=2))
    try:
        CONFIG.chmod(0o600)
    except OSError:
        pass


def add_server(name: str, url: str) -> None:
    if not name.strip() or not url.startswith(("http://127.0.0.1:", "http://localhost:", "https://")):
        raise ValueError("Enter a name and a localhost or HTTPS MCP URL.")
    data = config()
    if any(s["name"] == name for s in data["servers"]):
        raise ValueError("A server with that name already exists.")
    data["servers"].append({"name": name.strip(), "url": url.strip(), "enabled": True})
    save_config(data)


def add_skill(name: str, command: str, instruction: str) -> None:
    """A skill guides an investigation; it never grants new tool permissions."""
    if not name.strip() or not command.startswith("/") or len(instruction.strip()) < 10:
        raise ValueError("Enter a name, /command, and an instruction of at least 10 characters.")
    data = config()
    if command in [s["command"] for s in BUILTIN_SKILLS + data["skills"]]:
        raise ValueError("That command is already in use.")
    data["skills"].append({"name": name.strip(), "command": command.strip(), "description": instruction.strip(), "enabled": True})
    save_config(data)


def skill_for(question: str) -> dict[str, Any] | None:
    command = question.strip().split(" ", 1)[0]
    return next((s for s in config()["skills"] if s["command"] == command and s.get("enabled")), None)


async def list_mcp_tools(server_name: str) -> list[dict[str, str]]:
    from mcp import ClientSession
    from mcp.client.streamable_http import streamable_http_client

    server = next((s for s in config()["servers"] if s["name"] == server_name and s.get("enabled")), None)
    if not server:
        raise ValueError("Choose an enabled MCP server.")
    async with streamable_http_client(server["url"]) as (read, write, _):
        async with ClientSession(read, write) as session:
            await session.initialize()
            result = await session.list_tools()
            return [{"name": t.name, "description": t.description or "No description supplied"} for t in result.tools]


async def call_mcp_tool(server_name: str, tool_name: str, arguments: dict[str, Any], approved: bool = False) -> str:
    """The UI must show exact tool and arguments and receive a click before this call."""
    if not approved:
        raise PermissionError("Review and approve the MCP tool call first.")
    from mcp import ClientSession
    from mcp.client.streamable_http import streamable_http_client

    server = next((s for s in config()["servers"] if s["name"] == server_name and s.get("enabled")), None)
    if not server:
        raise ValueError("Choose an enabled MCP server.")
    async with streamable_http_client(server["url"]) as (read, write, _):
        async with ClientSession(read, write) as session:
            await session.initialize()
            tools = await session.list_tools()
            if tool_name not in {t.name for t in tools.tools}:
                raise ValueError("The server does not expose that tool.")
            result = await session.call_tool(tool_name, arguments)
            return "\n".join(getattr(c, "text", str(c)) for c in result.content)[:20_000]
