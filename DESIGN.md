# Talk2Data UI

The user requested a minimal ChatGPT-style interface specialized for data investigation. The workbench uses semantic light neutral and dark charcoal palettes with a restrained green accent. Use Geist for UI text and Geist Mono for SQL, schema, and measurements. Theme preference persists and defaults to the system setting.

Keep one conversation and one composer as the primary workspace. A quiet sidebar contains source selection, recent investigations, and saved checks. Hide advanced source, schema, and extension tasks behind named controls. Reveal chart, table, SQL, and evidence details through tabs and disclosure; never hide limitations or imply causality from contributions.

Use installed Vercel AI Elements for conversation, message Markdown, and prompt input. Use shadcn/Radix primitives for dialogs and controls, Lucide for icons, and Recharts for plots. Avoid custom replacements for dependency-owned behaviors. The Python engine remains the source of truth for analysis.

Use json-render for validated dashboard layouts with metrics, charts, tables, notes, and compact clarification cards. Dashboard widgets expose SQL in disclosures. Save requests and answers for fresh reruns; keep starter scope and query limits visible. Dashboard cards stack on phones.

On phones the sidebar opens as a dismissible drawer, the composer stays reachable, and tables scroll horizontally. Keep visible keyboard focus, accessible names, polite busy status, clear recovery on errors, and reduced-motion support.
