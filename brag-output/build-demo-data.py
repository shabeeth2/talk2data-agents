"""Query the two public synthetic CSVs to regenerate the illustrated demo figures."""
import json
import tempfile
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from talk2data import dashboards, engine


assets = Path(__file__).parent / "composition" / "assets"
with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as scratch:
    engine.ROOT = Path(scratch)
    engine.STORE = engine.ROOT / "workspace.sqlite"
    engine.FILES = engine.ROOT
    source = engine.import_file("retail.csv", (assets / "data" / "retail-before.csv").read_bytes())
    question = "How did retail performance change by region?"
    answers = {"metric": "revenue", "unit": "USD", "definition": "Sum of revenue in imported retail rows"}
    first = dashboards.generate(source, question, answers)
    saved_id = dashboards.save("Retail performance", source, question, answers)
    engine.import_file("retail.csv", (assets / "data" / "retail-after.csv").read_bytes())
    second = dashboards.rerun(saved_id)
    assert first["spec"]["elements"]["total"]["props"]["value"] == 800
    assert second["comparison"]["delta"] == 70
    output = {"question": question, "before": first, "after": second,
              "files": ["retail-before.csv", "retail-after.csv"]}
    (assets / "demo-data.js").write_text("window.demoData=" + json.dumps(output, separators=(",", ":")) + ";\n", encoding="utf-8")
