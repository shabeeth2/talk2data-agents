# Talk2Data — ask, inspect, repeat

## Planning rubric
1. App: a local data investigation workbench with tool-using analysis and dashboard agents.
2. Specific strength: results come from validated read-only queries, with SQL exposed beside each widget.
3. Strongest visual: the sage-on-charcoal revenue chart and paired metric cards.
4. Audience: people investigating local files and SQL data.
5. Tone: polished, quiet, precise; minimal UI reflects the product.
6. Claim: ask a question, clarify a metric, inspect a dashboard and its query.
7. Hook: “What’s in your data?” over the actual prompt-input pattern.
8. Share line: “Talk2Data turns questions into dashboards you can inspect. Ask, clarify, query, and keep the evidence.”
9. User flow: select Sample retail data → request a dashboard → choose revenue → inspect totals, chart and SQL.

## Angle and visual identity
Show the workbench doing a small, useful job. Recreate its working UI from src/app/page.tsx, src/components/dashboard.tsx and src/app/globals.css. Use seeded sample data queried through the running API; no private data or live model recording.

Background #181b19, cards #222723, foreground #e9ede7, muted #abb6a7, accent #95bea1, borders #384039. Geist throughout. Landscape 1280×720, 22 seconds, 30 fps.

## Storyboard
1. **Ask (0–4 s, 4 s):** brand in the corner; “What’s in your data?” above a composer containing “Build a dashboard”. Prompt rises quickly, then holds. Sparse selection tick at submission.
2. **Clarify (4–8 s, 4 s):** “Choose your data” card; “Which metric?” with Rows, revenue, orders. Revenue becomes selected at 5.5 s; “Build dashboard” is highlighted. All copy holds at least two seconds.
3. **Inspect (8–17 s, 9 s):** revenue overview with actual total, actual row count, and actual daily revenue chart. Metric cards arrive 0.4 s apart, then hold together. At 12 s expose SQL beneath chart; keep query readable until the cut. Quiet soft landing accent on dashboard reveal.
4. **Repeat (17–22 s, 5 s):** “Ask. Inspect. Repeat.” and Talk2Data wordmark, then “Your data. Your evidence.” A restrained slide and long settled hold.

Durations: 4 + 4 + 9 + 5 = 22 seconds. Fast entrances (0.4–0.6 s), generous reading holds. No unsupported speed, accuracy, or causality claims.

## Audio and music cue guidance
Original sustained three-note ambient bed, synthesized locally, with 1-second fade-in and 3-second fade-out. No voiceover. Bundled music has unspecified redistribution terms, so it is replaced by this original sound bed. Two Kenney CC0 accents accompany the simulated selection and dashboard arrival. No beat claims; scene timing is driven by readability. No audio-reactive effects: typography and queried chart remain still once settled.

## Share copy
Talk2Data turns questions into dashboards you can inspect. Ask, clarify, query, and keep the evidence.
