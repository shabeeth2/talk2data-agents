"use client";
import { useId, useState } from "react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  Check,
  CircleAlert,
  Code2,
  Download,
  ListChecks,
  Play,
  Save,
} from "lucide-react";
import { MessageResponse } from "@/components/ai-elements/message";
import { AgentActivity } from "@/components/agent-activity";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  api,
  download,
  type ChartData,
  type Result,
  type Row,
} from "@/lib/api";
const number = (n: number) =>
  new Intl.NumberFormat("en", { maximumFractionDigits: 2 }).format(n);
export function DataChart({ chart }: { chart: ChartData }) {
  if (!chart.x || !chart.y || !chart.data.length)
    return (
      <p className="empty-result">
        No chartable values. Open the table to inspect the result.
      </p>
    );
  const axis = (
    <>
      <CartesianGrid stroke="var(--chart-grid)" vertical={false} />
      <XAxis
        dataKey={chart.x}
        axisLine={false}
        tickLine={false}
        tick={{ fill: "var(--chart-axis)", fontSize: 11 }}
        minTickGap={30}
        tickMargin={12}
      />
      <YAxis
        axisLine={false}
        tickLine={false}
        tick={{ fill: "var(--chart-axis)", fontSize: 11 }}
        width={52}
        tickFormatter={(n) =>
          Math.abs(n) >= 1000 ? `${number(n / 1000)}k` : number(n)
        }
      />
      <Tooltip
        contentStyle={{
          background: "var(--popover)",
          color: "var(--popover-foreground)",
          borderRadius: 10,
          border: "1px solid var(--border)",
          fontSize: 12,
        }}
        formatter={(v) => number(Number(v))}
      />
    </>
  );
  return (
    <div
      className="chart"
      role="img"
      aria-label={`${chart.y} by ${chart.x}. Exact values available in the table.`}
    >
      <ResponsiveContainer
        initialDimension={{ width: 320, height: 240 }}
        width="100%"
        height="100%"
        minWidth={1}
        minHeight={240}
      >
        {chart.type === "bar" ? (
          <BarChart
            data={chart.data}
            margin={{ top: 12, right: 12, left: 0, bottom: 6 }}
          >
            {axis}
            <Bar
              isAnimationActive={false}
              dataKey={chart.y}
              fill="var(--chart-1)"
              radius={[4, 4, 0, 0]}
              maxBarSize={56}
            />
          </BarChart>
        ) : (
          <AreaChart
            data={chart.data}
            margin={{ top: 12, right: 12, left: 0, bottom: 6 }}
          >
            {axis}
            <Area
              isAnimationActive={false}
              type="monotone"
              dataKey={chart.y}
              stroke="var(--chart-1)"
              strokeWidth={2}
              fill="var(--chart-fill)"
            />
          </AreaChart>
        )}
      </ResponsiveContainer>
    </div>
  );
}
export function DataTable({
  rows,
  columns,
}: {
  rows: Row[];
  columns: string[];
}) {
  return rows.length ? (
    <div className="table-scroll">
      <table>
        <caption className="sr-only">Query result values</caption>
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c}>{c}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              {columns.map((c) => (
                <td key={c}>
                  {r[c] === null ? (
                    <span className="muted">null</span>
                  ) : typeof r[c] === "number" ? (
                    new Intl.NumberFormat("en", {
                      maximumFractionDigits: 20,
                    }).format(r[c])
                  ) : (
                    String(r[c] ?? "")
                  )}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  ) : (
    <p className="empty-result">
      No rows returned. Try a different question or date range.
    </p>
  );
}
export function AnalysisResult({
  result,
  onRerun,
  onSaved,
}: {
  result: Result;
  onRerun: (result: Result) => void;
  onSaved: () => void;
}) {
  const [sql, setSql] = useState(result.sql || "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(Boolean(result.saved_id));
  const [name, setName] = useState(result.saved_name || "");
  const [savedId, setSavedId] = useState(result.saved_id);
  const sqlId = useId();
  const isChange = result.kind === "change";
  const rows = isChange ? result.daily || [] : result.rows || [];
  const columns = isChange ? ["day", "value"] : result.columns || [];
  const rawChart: ChartData = isChange
    ? { type: "line", x: "day", y: "value", data: rows }
    : result.chart || { type: "none", data: [] };
  const chart =
    rawChart.type === "line" && rawChart.x
      ? {
          ...rawChart,
          data: [...rawChart.data].sort((a, b) =>
            String(a[rawChart.x!]).localeCompare(String(b[rawChart.x!])),
          ),
        }
      : rawChart;
  async function rerun() {
    setBusy(true);
    setError("");
    try {
      onRerun(
        await api<Result>("/investigate", {
          source: result.source,
          question: result.question || "SQL query",
          sql,
        }),
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function save() {
    setBusy(true);
    setError("");
    try {
      const response = await api<{ id: number }>("/change/save", {
        name: name.trim() || result.title,
        settings: result.settings,
        id: savedId,
        as_of: result.as_of,
      });
      setSavedId(response.id);
      setSaved(true);
      onSaved();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  function csv() {
    const cell = (value: unknown) =>
      `"${String(value ?? "").replaceAll('"', '""')}"`;
    // Prefix spreadsheet formulas so exported source strings stay inert on open.
    const value = (v: unknown) =>
      typeof v === "string" && /^[=+@\-\t\r]/.test(v) ? `'${v}` : v;
    download(
      "talk2data_result.csv",
      [
        columns.map(cell).join(","),
        ...rows.map((r) => columns.map((c) => cell(value(r[c]))).join(",")),
      ].join("\r\n"),
      "text/csv;charset=utf-8",
    );
  }
  return (
    <div className="analysis-result">
      <div className="answer-heading">
        <span className="answer-mark">
          <ListChecks size={16} />
        </span>
        <span>
          {isChange
            ? "Change investigation"
            : `${result.kind.charAt(0).toUpperCase() + result.kind.slice(1)} analysis`}
        </span>
        <span className="result-source">{result.source}</span>
      </div>
      {isChange ? (
        <>
          <h2>{result.title}</h2>
          <p className="period">
            {result.settings?.window_days}-day windows ·{" "}
            {result.start?.slice(0, 10)} – {result.middle?.slice(0, 10)}{" "}
            compared with {result.middle?.slice(0, 10)} –{" "}
            {result.end?.slice(0, 10)} (end excluded)
          </p>
          <div className="metric-strip">
            <div>
              <span>Previous</span>
              <strong>{number(result.previous || 0)}</strong>
            </div>
            <div>
              <span>Current</span>
              <strong>{number(result.current || 0)}</strong>
            </div>
            <div>
              <span>Net change</span>
              <strong
                className={(result.delta || 0) < 0 ? "negative" : "positive"}
              >
                {(result.delta || 0) > 0 ? "+" : ""}
                {number(result.delta || 0)}{" "}
                <small>
                  {result.percentage === null
                    ? "No baseline %"
                    : `${result.percentage}%`}
                </small>
              </strong>
            </div>
          </div>
          <p className="caveat">
            <CircleAlert size={14} />
            {result.caveat}
          </p>
        </>
      ) : (
        <details className="summary">
          <summary>Summary</summary>
          <MessageResponse>{result.summary || ""}</MessageResponse>
        </details>
      )}
      <Tabs
        defaultValue={
          isChange ? "evidence" : chart.type === "none" ? "table" : "chart"
        }
      >
        <div className="result-toolbar">
          <TabsList>
            <TabsTrigger value="chart">Chart</TabsTrigger>
            <TabsTrigger value="table">Table</TabsTrigger>
            {isChange ? (
              <TabsTrigger value="evidence">
                Evidence{" "}
                <span className="tab-count">{result.evidence?.length}</span>
              </TabsTrigger>
            ) : (
              <TabsTrigger value="sql">SQL</TabsTrigger>
            )}
          </TabsList>
          <Button
            variant="ghost"
            size="sm"
            aria-label={
              isChange
                ? "Export evidence as JSON"
                : "Export visible rows as CSV"
            }
            onClick={
              isChange
                ? () =>
                    download(
                      "talk2data_evidence.json",
                      JSON.stringify(result, null, 2),
                    )
                : csv
            }
          >
            <Download size={14} />
            <span className="export-label">
              Export {isChange ? "JSON" : "CSV"}
            </span>
          </Button>
        </div>
        <TabsContent value="chart">
          <DataChart chart={chart} />
          <p className="result-note">
            Showing {chart.data.length} chart points from{" "}
            {isChange ? rows.length : result.row_count} analysis rows.
          </p>
        </TabsContent>
        <TabsContent value="table">
          <DataTable rows={rows} columns={columns} />
          {!isChange && (
            <p className="result-note">
              Showing {rows.length} of {result.row_count} analysis rows. CSV
              exports the visible rows.
            </p>
          )}
        </TabsContent>
        <TabsContent value="sql">
          <label className="sr-only" htmlFor={sqlId}>
            Read-only SQL query
          </label>
          <textarea
            id={sqlId}
            disabled={busy}
            className="sql-editor"
            value={sql}
            onChange={(e) => setSql(e.target.value)}
            spellCheck={false}
          />
          <div className="sql-actions">
            <span>Single, bounded SELECT query</span>
            <Button
              size="sm"
              variant="outline"
              disabled={busy || !sql.trim()}
              onClick={rerun}
            >
              <Play size={13} />
              {busy ? "Running…" : "Run query"}
            </Button>
          </div>
        </TabsContent>
        <TabsContent value="evidence">
          <div className="evidence-list">
            {result.evidence?.map((e, i) => (
              <details key={i} className="evidence-item">
                <summary>
                  <span
                    className={`evidence-status ${e.status === "review" ? "review" : ""}`}
                  >
                    {e.status === "review" ? (
                      <CircleAlert size={15} />
                    ) : (
                      <Check size={15} />
                    )}
                  </span>
                  <div>
                    <strong>{e.title}</strong>
                    <p>{e.finding}</p>
                  </div>
                  <span className="evidence-label">
                    {e.status === "review" ? "Review" : "Checked"}
                  </span>
                </summary>
                <div className="evidence-detail">
                  <p>{e.interpretation}</p>
                  <p className="muted">{e.limitation}</p>
                  <details className="query-details">
                    <summary>
                      <Code2 size={14} /> SQL & parameters
                    </summary>
                    <pre>{e.sql}</pre>
                  </details>
                </div>
              </details>
            ))}
          </div>
          {Boolean(result.segments?.length) && (
            <div className="segment-table">
              <h3>Segment contributions</h3>
              <p className="muted">
                Arithmetic contributions to the net change.
              </p>
              <DataTable
                rows={result.segments || []}
                columns={["segment", "previous", "current", "change"]}
              />
            </div>
          )}
        </TabsContent>
      </Tabs>
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
      {isChange && (
        <div className="save-check">
          <input
            aria-label="Investigation name"
            disabled={busy}
            placeholder="Name this check to run it again"
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              setSaved(false);
            }}
          />
          <Button
            size="sm"
            variant="outline"
            disabled={busy || saved}
            onClick={save}
          >
            {saved ? <Check size={14} /> : <Save size={14} />}
            {saved ? "Saved" : "Save check"}
          </Button>
        </div>
      )}
      <AgentActivity agent={result.agent} />
      {!isChange && !result.agent && (
        <details className="analysis-trace">
          <summary>
            <Check size={13} /> {result.trace?.length || 0} analysis steps ·
            Read-only
          </summary>
          <ol>
            {result.trace?.map((t) => (
              <li key={t}>{t}</li>
            ))}
          </ol>
        </details>
      )}
    </div>
  );
}
