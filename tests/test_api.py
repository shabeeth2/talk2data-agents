"""Exercise the HTTP boundary with isolated local data and no services."""

import gc
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

from fastapi.testclient import TestClient

from talk2data import api, engine, extensions


class ApiTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        # Engine sqlite contexts commit without closing; release unreachable
        # connection cycles before deleting this temporary Windows workspace.
        self.addCleanup(gc.collect)
        root = Path(self.tmp.name)
        uploads = root / "uploads"
        uploads.mkdir()
        for target, attr, value in [(engine, "ROOT", root), (engine, "STORE", root / "workspace.sqlite"),
                                    (engine, "FILES", uploads), (extensions, "CONFIG", root / "extensions.json")]:
            override = patch.object(target, attr, value)
            override.start()
            self.addCleanup(override.stop)
        llm = patch.object(engine, "_llm_sql", return_value=None)
        llm.start()
        self.addCleanup(llm.stop)
        self.client = TestClient(api.app, base_url="http://localhost", raise_server_exceptions=False)
        self.addCleanup(self.client.close)
        self.source = "Sample retail data"
        engine.ensure_demo()

    def test_investigation_history_and_sql_safety(self):
        workspace = self.client.get("/api/workspace").json()
        self.assertEqual(workspace["sources"], [{"name": self.source, "kind": "demo"}])
        self.assertNotIn("url", workspace["sources"][0])
        payload = {"source": self.source, "question": "Which region has most revenue?"}
        response = self.client.post("/api/investigate", json=payload)
        self.assertEqual(response.status_code, 200)
        result = response.json()
        self.assertEqual(result["row_count"], 4)
        self.assertEqual(result["chart"]["type"], "bar")
        history = self.client.get("/api/workspace").json()["runs"]
        self.assertEqual(self.client.get(f"/api/runs/{history[0]['id']}").json(), result)
        payload["sql"] = "DELETE FROM retail_orders"
        response = self.client.post("/api/investigate", json=payload)
        self.assertEqual(response.status_code, 400)
        self.assertIn("read-only", response.json()["detail"])
        self.assertEqual(len(engine.recent_runs()), 1)
        payload["sql"] = "SELECT COUNT(*) AS count FROM retail_orders"
        response = self.client.post("/api/investigate", json=payload)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["rows"][0]["count"], 2160)

    def test_upload_schema_and_connection(self):
        response = self.client.post("/api/sources/upload", files={"file": ("visits.csv", b"day,visits\n2026-01-01,10\n2026-01-02,12\n", "text/csv")})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["source"], "visits.csv")
        schema = self.client.get("/api/schema", params={"source": "visits.csv"}).json()
        self.assertEqual(schema[0]["table"], "file_visits")
        response = self.client.post("/api/sources/connect", json={"name": "Copy", "url": f"sqlite:///{engine.STORE}"})
        self.assertEqual(response.status_code, 200)
        self.assertIn("Copy", [item["name"] for item in self.client.get("/api/workspace").json()["sources"]])
        response = self.client.post("/api/sources/upload", files={"file": ("invalid.exe", b"unused")})
        self.assertEqual(response.status_code, 400)

    def test_change_routing_saving_and_fresh_rerun(self):
        response = self.client.post("/api/investigate", json={"source": self.source, "question": "Why did revenue decline?"})
        self.assertEqual(response.status_code, 200)
        result = response.json()
        self.assertEqual(result["kind"], "change")
        self.assertTrue(result["evidence"])
        settings = result["settings"]
        response = self.client.post("/api/change/save", json={"name": "Revenue check", "settings": settings, "as_of": result["as_of"]})
        self.assertEqual(response.status_code, 200)
        saved_id = response.json()["id"]
        with engine._db() as db:
            db.execute("UPDATE retail_orders SET revenue = revenue * 2 WHERE order_date >= ?", (result["middle"],))
        rerun = self.client.post("/api/investigate", json={"source": self.source, "question": f"/check_{saved_id}"}).json()
        self.assertEqual(rerun["saved_id"], saved_id)
        self.assertAlmostEqual(rerun["current"], result["current"] * 2, places=2)
        saved = self.client.get("/api/workspace").json()["saved_changes"][0]
        self.assertEqual(saved["last_run"], rerun["as_of"])
        response = self.client.post("/api/change/save", json={"name": "Unsafe", "settings": {**settings, "sql": "DELETE FROM retail_orders"}})
        self.assertEqual(response.status_code, 422)

    def test_mcp_exact_arguments_and_explicit_per_call_approval(self):
        payload = {"server": "Local", "tool": "lookup", "arguments": {"region": "West", "limit": 5}}
        response = self.client.post("/api/extensions/call", json=payload)
        self.assertEqual(response.status_code, 403)
        self.assertIn("approve", response.json()["detail"])
        with patch.object(extensions, "call_mcp_tool", new_callable=AsyncMock, return_value="Found records") as call:
            response = self.client.post("/api/extensions/call", json={**payload, "approved": True})
            self.assertEqual(response.json(), {"result": "Found records"})
            call.assert_awaited_once_with("Local", "lookup", payload["arguments"], approved=True)
        self.assertEqual(self.client.post("/api/extensions/call", json={**payload, "approved": "true"}).status_code, 422)
        self.assertEqual(self.client.post("/api/extensions/call", json={**payload, "arguments": []}).status_code, 422)

    def test_skills_and_local_request_boundary(self):
        response = self.client.post("/api/extensions/skills", json={"name": "Sales", "command": "/sales", "instruction": "Check total revenue by region."})
        self.assertEqual(response.status_code, 200)
        self.assertIn("/sales", [item["command"] for item in response.json()["skills"]])
        response = self.client.post("/api/extensions/servers", json={"name": "Remote", "url": "http://unsafe.example/mcp"})
        self.assertEqual(response.status_code, 400)
        response = self.client.get("/api/workspace", headers={"Origin": "https://other.example"})
        self.assertEqual(response.status_code, 403)
        response = self.client.get("/api/workspace", headers={"Host": "rebind.example"})
        self.assertEqual(response.status_code, 400)
        self.assertEqual(self.client.get("/api/workspace", headers={"Origin": "http://localhost:3000"}).status_code, 200)

    def test_connection_errors_do_not_expose_credentials(self):
        with patch.object(engine, "add_sql_source", side_effect=RuntimeError("private-password")):
            with self.assertLogs(api.logger, level="ERROR"):
                response = self.client.post("/api/sources/connect", json={"name": "Warehouse", "url": "sqlite:///unused"})
        self.assertEqual(response.status_code, 500)
        self.assertNotIn("private-password", response.text)


if __name__ == "__main__":
    unittest.main()
