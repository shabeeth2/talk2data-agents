"""Dashboard plans cannot fabricate values or run unvalidated queries."""

import copy
import gc
import io
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient

from talk2data import api, dashboards, engine


class DashboardTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.addCleanup(gc.collect)
        root = Path(tmp.name)
        for attr, value in [("ROOT", root), ("STORE", root / "workspace.sqlite"), ("FILES", root)]:
            override = patch.object(engine, attr, value)
            override.start()
            self.addCleanup(override.stop)
        env = patch.dict(os.environ, {"TALK2DATA_LLM_URL": "", "TALK2DATA_LLM_MODEL": ""})
        env.start()
        self.addCleanup(env.stop)
        self.source = engine.import_file("traffic.csv", b"day,channel,visits,signups\n2026-01-01,Direct,10,2\n2026-01-02,Search,20,3\n")
        self.client = TestClient(api.app, base_url="http://localhost", raise_server_exceptions=False)
        self.addCleanup(self.client.close)

    def plan(self):
        return {"title": "Traffic", "spec": {"root": "dashboard", "elements": {
            "dashboard": {"type": "DashboardGrid", "props": {"columns": 2}, "children": ["total", "chart"]},
            "total": {"type": "Metric", "props": {"title": "Visits", "sql": "SELECT SUM(visits) FROM file_traffic"}, "children": []},
            "chart": {"type": "Chart", "props": {"title": "Visits by day", "type": "line", "x": "day", "y": "visits", "sql": "SELECT day,visits FROM file_traffic ORDER BY day"}, "children": []}}}}

    def test_schema_clarification_and_queried_starter(self):
        questions = dashboards.generate(self.source, "Build a dashboard")
        self.assertEqual(questions["tool"], "addUserQuestions")
        self.assertEqual(questions["questions"][0]["id"], "metric")
        self.assertEqual(questions["spec"]["elements"]["questions"]["type"], "UserQuestions")
        self.assertEqual(questions["questions"][0]["options"], ["Rows", "visits", "signups"])
        result = dashboards.generate(self.source, "Build a dashboard", {"metric": "visits"})
        self.assertEqual(result["generated_by"], "starter")
        elements = result["spec"]["elements"]
        self.assertEqual(elements["total"]["props"]["value"], 30)
        self.assertEqual(elements["rows"]["props"]["value"], 2)
        self.assertEqual(elements["trend"]["props"]["data"], [{"day": "2026-01-01", "value": 10}, {"day": "2026-01-02", "value": 20}])
        self.assertNotIn("retail", json.dumps(elements))
        with self.assertRaises(ValueError):
            dashboards.generate(self.source, "dashboard", {"metric": "password"})

    def test_table_ambiguity(self):
        engine.add_sql_source("Warehouse", f"sqlite:///{engine.STORE}")
        questions = dashboards.generate("Warehouse", "dashboard")
        self.assertEqual(questions["questions"][0]["id"], "table")
        metric_questions = dashboards.generate("Warehouse", "dashboard", {"table": "file_traffic"})
        self.assertEqual(metric_questions["questions"][0]["id"], "metric")
        self.assertEqual(metric_questions["answers"], {"table": "file_traffic"})
        result = dashboards.generate("Warehouse", metric_questions["question"], {**metric_questions["answers"], "metric": "visits"})
        self.assertEqual(result["spec"]["elements"]["total"]["props"]["value"], 30)
        result = dashboards.generate("Warehouse", "dashboard", {"table": "file_traffic", "metric": "Rows"})
        self.assertEqual(result["spec"]["elements"]["total"]["props"]["value"], 2)

    def test_model_tool_and_allowlisted_plan(self):
        question_message = {"choices": [{"message": {"tool_calls": [{"function": {"name": "addUserQuestions", "arguments": json.dumps({"questions": [{"id": "metric", "question": "Which metric?", "options": ["visits", "signups"]}]})}}]}}]}
        with patch.dict(os.environ, {"TALK2DATA_LLM_URL": "http://localhost/model", "TALK2DATA_LLM_MODEL": "test"}), patch.object(dashboards.request, "urlopen", return_value=io.BytesIO(json.dumps(question_message).encode())) as post:
            result = dashboards.generate(self.source, "dashboard")
            self.assertEqual(result["kind"], "questions")
            sent = json.loads(post.call_args.args[0].data)
            self.assertEqual(sent["tools"][0]["function"]["name"], "addUserQuestions")
            self.assertNotIn("2026-01-01", sent["messages"][1]["content"])
        model_message = {"choices": [{"message": {"content": json.dumps(self.plan())}}]}
        with patch.dict(os.environ, {"TALK2DATA_LLM_URL": "http://localhost/model", "TALK2DATA_LLM_MODEL": "test"}), patch.object(dashboards.request, "urlopen", return_value=io.BytesIO(json.dumps(model_message).encode())):
            result = dashboards.generate(self.source, "Dashboard for visits")
        self.assertEqual(result["generated_by"], "model")
        self.assertEqual(result["spec"]["elements"]["total"]["props"]["value"], 30)

    def test_entire_model_plan_validated_before_any_execution(self):
        mutations = [lambda p: p["spec"]["elements"]["chart"].update(type="Iframe"),
                     lambda p: p["spec"]["elements"]["chart"]["props"].update(sql="DELETE FROM file_traffic"),
                     lambda p: p["spec"]["elements"]["total"]["props"].update(value=999),
                     lambda p: p["spec"]["elements"]["chart"].update(children=["dashboard"]),
                     lambda p: p["spec"]["elements"]["dashboard"]["children"].append("dashboard")]
        for mutate in mutations:
            plan = copy.deepcopy(self.plan())
            mutate(plan)
            with self.subTest(plan=plan), patch.object(dashboards, "_model_plan", return_value=plan), patch.object(engine, "execute") as execute:
                with self.assertRaises(ValueError):
                    dashboards.generate(self.source, "dashboard")
                execute.assert_not_called()
        self.assertEqual(engine.execute(self.source, "SELECT COUNT(*) FROM file_traffic").iloc[0, 0], 2)

    def test_saved_settings_only_and_fresh_rerun(self):
        saved_id = dashboards.save("Traffic", self.source, "Dashboard visits", {"metric": "visits"})
        with engine._db() as db:
            record = dict(db.execute("SELECT * FROM dashboards").fetchone())
            db.execute("UPDATE file_traffic SET visits=visits*2")
        self.assertEqual(set(record), {"id", "name", "source", "question", "answers", "last_run"})
        result = dashboards.rerun(saved_id)
        self.assertEqual(result["saved_name"], "Traffic")
        self.assertEqual(result["spec"]["elements"]["total"]["props"]["value"], 60)
        self.assertEqual(dashboards.saved()[0]["last_run"], result["as_of"])
        with self.assertRaises(ValueError):
            dashboards.rerun(999)

    def test_api_dashboard_routes_and_boundaries(self):
        payload = {"source": self.source, "question": "/dashboard"}
        response = self.client.post("/api/investigate", json=payload)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["kind"], "questions")
        payload["answers"] = {"metric": "visits"}
        response = self.client.post("/api/dashboards/generate", json=payload)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["kind"], "dashboard")
        self.assertEqual(self.client.post("/api/dashboards/generate", json=payload, headers={"Origin": "https://attacker.example"}).status_code, 403)
        response = self.client.post("/api/dashboards/save", json={**payload, "name": "Visits"})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(set(response.json()), {"id"})
        saved_id = response.json()["id"]
        self.assertEqual(self.client.get("/api/workspace").json()["dashboards"][0]["id"], saved_id)
        self.assertEqual(len(self.client.get("/api/dashboards").json()), 1)
        self.assertEqual(self.client.post(f"/api/dashboards/{saved_id}/run").json()["saved_id"], saved_id)
        self.assertEqual(self.client.post("/api/dashboards/save", json={**payload, "name": "Bad", "spec": self.plan()["spec"]}).status_code, 422)
        with patch.object(dashboards, "_model_plan", return_value={"title": "Bad"}):
            self.assertEqual(self.client.post("/api/dashboards/generate", json=payload).status_code, 400)

    def test_bounded_records_and_provider_failure(self):
        engine.import_file("traffic.csv", ("day,channel,visits,signups\n" + "2026-01-01,Direct,10,2\n" * 250).encode())
        with patch.object(dashboards, "_model_plan", side_effect=TimeoutError):
            result = dashboards.generate(self.source, "dashboard visits")
        self.assertEqual(result["generated_by"], "starter")
        self.assertIn("unavailable", result["notice"])
        props = result["spec"]["elements"]["records"]["props"]
        self.assertEqual(len(props["rows"]), 200)
        self.assertTrue(props["limited"])
        self.assertEqual(result["spec"]["elements"]["total"]["props"]["value"], 2500)


if __name__ == "__main__":
    unittest.main()
