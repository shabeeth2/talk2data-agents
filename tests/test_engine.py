import gc
import io
import os
import tempfile
import unittest


class EngineTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        os.environ["TALK2DATA_HOME"] = cls.tmp.name
        from talk2data import engine
        from pathlib import Path
        engine.ROOT = Path(cls.tmp.name)
        engine.STORE = engine.ROOT / "workspace.sqlite"
        engine.FILES = engine.ROOT / "uploads"
        engine.FILES.mkdir(exist_ok=True)
        cls.engine = engine

    @classmethod
    def tearDownClass(cls):
        gc.collect()
        cls.tmp.cleanup()

    def test_demo_and_investigation(self):
        engine = self.engine
        self.assertIn("Sample retail data", [s["name"] for s in engine.sources()])
        result = engine.investigate("Which region has most revenue?", "Sample retail data")
        self.assertEqual(result["chart"]["type"], "bar")
        self.assertEqual(result["row_count"], 4)
        self.assertIn("SELECT", result["sql"])
        self.assertIn("Starter analysis", result["summary"])
        self.assertEqual(len(engine.recent_runs()), 1)

    def test_sql_permissions(self):
        for sql in ("DELETE FROM retail_orders", "SELECT * FROM retail_orders; DROP TABLE retail_orders", "WITH x AS (DELETE FROM retail_orders RETURNING *) SELECT * FROM x", "PRAGMA table_info(retail_orders)"):
            with self.assertRaises(ValueError):
                self.engine.validate_sql(sql)
        self.assertEqual(len(self.engine.execute("Sample retail data", "SELECT * FROM retail_orders", limit=3)), 3)

    def test_upload_and_methods(self):
        engine = self.engine
        name = engine.import_file("visits.csv", b"day,visits\n2026-01-01,10\n2026-01-02,12\n2026-01-03,8\n2026-01-04,15\n2026-01-05,11\n2026-01-06,13\n2026-01-07,14\n2026-01-08,17\n2026-01-09,15\n2026-01-10,18\n2026-01-11,16\n2026-01-12,20\n2026-01-13,19\n2026-01-14,21\n")
        self.assertEqual(name, "visits.csv")
        self.assertEqual(engine.schema(name)[0]["table"], "file_visits")
        result = engine.investigate("/forecast visits", name)
        self.assertEqual(result["kind"], "forecast")
        self.assertEqual(result["row_count"], 14)
        self.assertIn("Holdout mean absolute error", result["summary"])

    def test_mcp_requires_approval(self):
        from talk2data.extensions import call_mcp_tool
        with self.assertRaises(PermissionError):
            import asyncio
            asyncio.run(call_mcp_tool("any", "tool", {}, approved=False))


if __name__ == "__main__":
    unittest.main()
