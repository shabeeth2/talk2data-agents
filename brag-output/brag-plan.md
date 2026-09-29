# Talk2Data — ask, verify, rerun

## Planning rubric
1. App: local analyst workbench for files and SQL data.
2. Strength: a query-backed metric with visible calculation, unit, scope and SQL.
3. Visual: synthetic retail dashboard and before/after saved rerun.
4. Audience: working analysts with a real data question.
5. Tone: polished, quiet, precise; the interface stays minimal.
6. Claim: saved calculations can be rerun when the source file changes.
7. Hook: a specific question grounded in retail.csv.
8. Share line: “Ask a question, verify the calculation, rerun it on fresh data.”
9. Flow: import → ask → define metric → inspect result/SQL → reimport → saved rerun.

## Evidence
Two synthetic CSVs in `composition/assets/data/` contain six rows dated January 1–3, 2026. `build-demo-data.py` imports and queries them using the actual starter dashboard engine. SUM(revenue) is 800 USD before and 870 USD after; the saved rerun reports +70 USD. Both use the same table, SQL, unit, and full-table calculation scope. The illustration makes no live model or real-world usability claim.

## Storyboard
1. **Connect and ask (0–5 s):** retail.csv and file_retail are visible beside the import control; the question is “How did retail performance change by region?”
2. **Define (5–9 s):** distinguish record count from the `orders` column, select `revenue`, supply USD and the definition.
3. **Inspect (9–17 s):** show the queried 800 USD, six rows, Jan 1–3 period, full-table scope, scale-labelled chart and SQL.
4. **Rerun (17–22 s):** reimport the changed retail.csv and rerun the saved dashboard. Show 800 → 870 USD and +70 USD.
5. **Close (22–25 s):** “Ask. Verify. Rerun.”

Landscape 1280×720, 30 fps, 25 seconds. Geist on charcoal with a restrained sage accent. No voiceover; original ambient audio and sparse CC0 interface accents. Each scene enters quickly and holds for reading.
