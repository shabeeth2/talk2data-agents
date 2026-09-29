"""The agent boundary supplies schema and accepts only safe dashboard plans."""

import copy
import gc
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient

from talk2data import api, dashboards, engine, extensions


class AgentToolTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.addCleanup(gc.collect)
        root = Path(tmp.name)
        for target, attr, value in [(engine, "ROOT", root), (engine, "STORE", root / "workspace.sqlite"),
                                    (engine, "FILES", root), (extensions, "CONFIG", root / "extensions.json")]:
            override = patch.object(target, attr, value)
            override.start()
            self.addCleanup(override.stop)
        self.source = engine.import_file("traffic.csv", b"day,visits\n2026-01-01,10\n2026-01-02,20\n")
        self.client = TestClient(api.app, base_url="http://localhost", raise_server_exceptions=False)
        self.addCleanup(self.client.close)

    def plan(self):
        return {"title": "Traffic", "spec": {"root": "dashboard", "elements": {
            "dashboard": {"type": "DashboardGrid", "props": {"columns": 2}, "children": ["total", "records"]},
            "total": {"type": "Metric", "props": {"title": "Visits", "sql": "SELECT SUM(visits) FROM file_traffic"}, "children": []},
            "records": {"type": "DataTable", "props": {"title": "Records", "sql": "SELECT * FROM file_traffic"}, "children": []}}}}

    def payload(self):
        return {"source": self.source, "question": "Dashboard visits", "answers": {"metric": "visits"}, "plan": self.plan()}

    def test_context_contains_only_schema_dialect_and_selected_skill(self):
        extensions.add_skill("Traffic", "/traffic", "Analyze visits by day.")
        response = self.client.get("/api/agent/context", params={"source": self.source, "question": "/traffic show visits"})
        self.assertEqual(response.status_code, 200)
        context = response.json()
        self.assertEqual(set(context), {"source", "schema", "dialect", "instruction"})
        self.assertEqual(context["schema"], [{"table": "file_traffic", "columns": ["day (TEXT)", "visits (INTEGER)"]}])
        self.assertEqual(context["dialect"], "sqlite")
        self.assertEqual(context["instruction"], "Analyze visits by day.")
        self.assertNotIn(str(engine.STORE), response.text)
        self.assertNotIn("2026-01-01", response.text)
        response = self.client.get("/api/agent/context", params={"source": self.source, "question": "show visits"})
        self.assertEqual(response.json()["instruction"], "")

    def test_agent_dashboard_queries_real_values_and_saves_history_without_model(self):
        plan = self.plan()
        with patch.object(dashboards, "_model_plan", side_effect=AssertionError("Must not call a second model")):
            response = self.client.post("/api/agent/dashboard", json=self.payload())
        self.assertEqual(response.status_code, 200)
        result = response.json()
        self.assertEqual(result["generated_by"], "model")
        self.assertEqual(result["answers"], {"metric": "visits"})
        self.assertEqual(result["spec"]["elements"]["total"]["props"]["value"], 30)
        self.assertEqual(result["spec"]["elements"]["records"]["props"]["rows"], [{"day": "2026-01-01", "visits": 10}, {"day": "2026-01-02", "visits": 20}])
        self.assertEqual(engine.load_run(engine.recent_runs()[0]["id"]), result)
        self.assertEqual(plan, self.plan())
        # The materializer must not mutate a caller's reusable SQL-only plan.
        dashboards.materialize(self.source, "Dashboard visits", {}, plan)
        self.assertEqual(plan, self.plan())

    def test_unsafe_plan_rejected_before_any_execution(self):
        for mutate in [lambda p: p["spec"]["elements"]["records"]["props"].update(sql="DELETE FROM file_traffic"),
                       lambda p: p["spec"]["elements"]["total"]["props"].update(value=999),
                       lambda p: p["spec"]["elements"]["records"].update(type="Iframe"),
                       lambda p: p["spec"]["elements"]["dashboard"]["children"].append("dashboard")]:
            payload = copy.deepcopy(self.payload())
            mutate(payload["plan"])
            with self.subTest(plan=payload["plan"]), patch.object(engine, "execute") as execute:
                response = self.client.post("/api/agent/dashboard", json=payload)
                self.assertEqual(response.status_code, 400)
                execute.assert_not_called()
        self.assertEqual(engine.recent_runs(), [])

    def test_empty_invalid_and_cross_site_requests_are_rejected(self):
        response = self.client.get("/api/agent/context", params={"source": self.source, "question": ""})
        self.assertEqual(response.status_code, 422)
        with patch.object(engine, "schema", return_value=[]):
            self.assertEqual(self.client.get("/api/agent/context", params={"source": self.source, "question": "visits"}).status_code, 400)
        for payload in [{**self.payload(), "question": ""}, {**self.payload(), "source": ""}, {**self.payload(), "plan": []}, {**self.payload(), "url": "private"}]:
            self.assertEqual(self.client.post("/api/agent/dashboard", json=payload).status_code, 422)
        self.assertEqual(self.client.post("/api/agent/dashboard", json={**self.payload(), "plan": {}}).status_code, 400)
        self.assertEqual(self.client.post("/api/agent/dashboard", json={**self.payload(), "source": "missing"}).status_code, 400)
        self.assertEqual(self.client.post("/api/agent/dashboard", json=self.payload(), headers={"Origin": "https://attacker.example"}).status_code, 403)
        self.assertEqual(self.client.get("/api/agent/context", params={"source": self.source, "question": "visits"}, headers={"Host": "rebind.example"}).status_code, 400)

    def test_agent_dashboard_source_is_pinned_and_records_are_bounded(self):
        other = engine.import_file("other.csv", b"visits\n999\n")
        engine.import_file("traffic.csv", ("day,visits\n" + "2026-01-01,10\n" * 250).encode())
        response = self.client.post("/api/agent/dashboard", json=self.payload())
        self.assertEqual(response.status_code, 200)
        elements = response.json()["spec"]["elements"]
        self.assertEqual(elements["total"]["props"]["value"], 2500)
        self.assertEqual(len(elements["records"]["props"]["rows"]), 200)
        self.assertTrue(elements["records"]["props"]["limited"])
        self.assertEqual(response.json()["source"], self.source)
        self.assertNotEqual(response.json()["source"], other)

    def test_saved_agent_dashboard_rerun_checks_settings_and_marks_fresh_run(self):
        payload = self.payload()
        saved_id = dashboards.save("Traffic watch", self.source, payload["question"], payload["answers"])
        payload["saved_id"] = saved_id
        for invalid in [{**payload, "question": "changed"}, {**payload, "source": "missing"}, {**payload, "saved_id": 999}]:
            with patch.object(engine, "execute") as execute:
                self.assertEqual(self.client.post("/api/agent/dashboard", json=invalid).status_code, 400)
                execute.assert_not_called()
        with engine._db() as db:
            db.execute("UPDATE file_traffic SET visits=visits*2")
        response = self.client.post("/api/agent/dashboard", json=payload)
        self.assertEqual(response.status_code, 200)
        result = response.json()
        self.assertEqual(result["spec"]["elements"]["total"]["props"]["value"], 60)
        self.assertEqual(result["saved_id"], saved_id)
        self.assertEqual(result["saved_name"], "Traffic watch")
        self.assertEqual(dashboards.saved()[0]["last_run"], result["as_of"])
        # Fresh schema clarification may differ from saved answers. Only an
        # explicit save should replace the user's persisted settings.
        clarified = self.client.post("/api/agent/dashboard", json={**payload, "answers": {"metric": "Rows"}})
        self.assertEqual(clarified.status_code, 200)
        self.assertEqual(clarified.json()["answers"], {"metric": "Rows"})
        self.assertEqual(dashboards.saved()[0]["answers"], payload["answers"])

    def test_saved_dashboard_fallback_merges_fresh_answers_without_overwriting_settings(self):
        saved_answers = {"table": "file_traffic", "metric": "visits"}
        saved_id = dashboards.save("Traffic watch", self.source, "Dashboard", saved_answers)
        with patch.object(dashboards, "_model_plan", return_value=None):
            response = self.client.post(f"/api/dashboards/{saved_id}/run", json={"answers": {"metric": "Rows"}})
            self.assertEqual(response.status_code, 200)
            result = response.json()
            self.assertEqual(result["answers"], {"table": "file_traffic", "metric": "Rows"})
            self.assertEqual(result["spec"]["elements"]["total"]["props"]["value"], 2)
            self.assertEqual(result["saved_id"], saved_id)
            self.assertEqual(result["saved_name"], "Traffic watch")
            self.assertEqual(dashboards.saved()[0]["answers"], saved_answers)
            # The existing no-body rerun continues using the saved metric.
            response = self.client.post(f"/api/dashboards/{saved_id}/run")
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.json()["spec"]["elements"]["total"]["props"]["value"], 30)
        with patch.object(engine, "execute") as execute:
            response = self.client.post(f"/api/dashboards/{saved_id}/run", json={"answers": {"metric": "x" * 301}})
            self.assertEqual(response.status_code, 400)
            execute.assert_not_called()
        self.assertEqual(self.client.post(f"/api/dashboards/{saved_id}/run", json={"source": "other"}).status_code, 422)


if __name__ == "__main__":
    unittest.main()
