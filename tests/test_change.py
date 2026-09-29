import gc
import os
import tempfile
import unittest
from pathlib import Path


class ChangeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        os.environ["TALK2DATA_HOME"] = cls.tmp.name
        from talk2data import engine, change
        engine.ROOT = Path(cls.tmp.name)
        engine.STORE = engine.ROOT / "workspace.sqlite"
        engine.FILES = engine.ROOT / "uploads"
        engine.FILES.mkdir(exist_ok=True)
        cls.engine, cls.change = engine, change

    @classmethod
    def tearDownClass(cls):
        gc.collect()
        cls.tmp.cleanup()

    def test_seeded_change_has_reconciling_evidence(self):
        self.engine.sources()
        settings = {"source": "Sample retail data", "table": "retail_orders",
                    "date": "order_date", "measure": "revenue", "dimension": "region", "window_days": 28}
        result = self.change.run(settings)
        self.assertLess(result["delta"], 0)
        self.assertEqual(result["segments"][0]["segment"], "West")
        self.assertAlmostEqual(sum(s["change"] for s in result["segments"]), result["delta"], places=2)
        self.assertEqual(len(result["daily"]), 56)
        self.assertIn("does not prove", result["caveat"])
        self.assertTrue(any("Parameters" in e["sql"] for e in result["evidence"]))
        self.assertTrue(any(e["title"] == "Check earlier windows" for e in result["evidence"]))

    def test_question_routes_only_when_measure_is_identified(self):
        self.engine.sources()
        from talk2data.api import change_from_question
        selected = change_from_question("Sample retail data", "Why did revenue drop?")
        self.assertEqual(selected["measure"], "revenue")
        self.assertEqual(selected["window_days"], 28)
        self.assertIsNone(change_from_question("Sample retail data", "Which region has the most revenue?"))

    def test_saved_investigation_uses_fresh_uploaded_data(self):
        header = b"event_date,region,amount\n"
        old = header + b"".join(f"2026-07-{i:02d},West,10\n".encode() for i in range(1, 15))
        self.engine.import_file("events.csv", old)
        settings = {"source": "events.csv", "table": "file_events", "date": "event_date",
                    "measure": "amount", "dimension": "region", "window_days": 7}
        before = self.change.run(settings)
        saved_id = self.change.save("Weekly amount", settings)
        self.change.mark_run(saved_id, before["as_of"])
        new = header + b"".join(f"2026-07-{i:02d},West,{10 if i < 8 else 4}\n".encode() for i in range(1, 15))
        self.engine.import_file("events.csv", new)
        name, replay = self.change.load(saved_id)
        after = self.change.run(replay)
        self.assertEqual(name, "Weekly amount")
        self.assertEqual(before["delta"], 0)
        self.assertEqual(after["delta"], -42)
        self.assertEqual(self.change.saved()[0]["name"], "Weekly amount")
        self.assertEqual(self.change.saved()[0]["command"], f"/check_{saved_id}")

    def test_missing_dates_warn_and_bad_field_rejected(self):
        self.engine.import_file("gaps.csv", b"event_date,region,amount\n2026-01-01,A,3\n2026-01-05,A,6\n2026-01-10,A,8\n2026-01-14,A,9\n")
        settings = {"source": "gaps.csv", "table": "file_gaps", "date": "event_date",
                    "measure": "amount", "dimension": "region", "window_days": 7}
        result = self.change.run(settings)
        quality = next(e for e in result["evidence"] if e["title"] == "Check data completeness")
        self.assertEqual(quality["status"], "review")
        settings["measure"] = "missing_column"
        with self.assertRaises(ValueError):
            self.change.run(settings)


if __name__ == "__main__":
    unittest.main()
