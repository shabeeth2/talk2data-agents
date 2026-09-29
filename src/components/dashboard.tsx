"use client";

import { createContext, useContext, useState, type CSSProperties } from "react";
import { defineCatalog, validateSpec } from "@json-render/core";
import { defineRegistry, JSONUIProvider, Renderer } from "@json-render/react";
import { schema } from "@json-render/react/schema";
import { z } from "zod";
import { ArrowDownRight, ArrowUpRight, Check, Info, Loader2, RotateCw, Save } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DataChart, DataTable } from "@/components/result";
import { AgentActivity } from "@/components/agent-activity";
import { api, type DashboardResult, type UserQuestion } from "@/lib/api";

const row = z.record(
  z.string(),
  z.union([z.string(), z.number(), z.boolean(), z.null()]),
);
const questions = z.array(
  z.object({
    id: z.string(),
    question: z.string(),
    options: z.array(z.string()),
  }),
);
export const dashboardCatalog = defineCatalog(schema, {
  components: {
    DashboardGrid: {
      props: z.object({ columns: z.number().int().min(1).max(3) }),
      slots: ["default"],
    },
    Metric: {
      props: z.object({
        title: z.string(),
        value: z.number().nullable(),
        sql: z.string(),
      }),
    },
    Chart: {
      props: z.object({
        title: z.string(),
        type: z.enum(["line", "bar"]),
        x: z.string(),
        y: z.string(),
        data: z.array(row),
        sql: z.string(),
        limited: z.boolean(),
      }),
    },
    DataTable: {
      props: z.object({
        title: z.string(),
        columns: z.array(z.string()),
        rows: z.array(row),
        sql: z.string(),
        limited: z.boolean(),
      }),
    },
    Note: { props: z.object({ text: z.string() }) },
    UserQuestions: { props: z.object({ questions }) },
  },
  actions: {},
});

const QuestionContext = createContext<{
  busy: boolean;
  label?: string;
  answer: (answers: Record<string, string>) => void;
}>({ busy: false, answer: () => {} });
function UserQuestions({ questions }: { questions: UserQuestion[] }) {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const { busy, answer, label } = useContext(QuestionContext);
  return (
    <form
      className="user-questions"
      onSubmit={(event) => {
        event.preventDefault();
        answer(answers);
      }}
    >
      {questions.map((q) => (
        <fieldset key={q.id} disabled={busy}>
          <legend>{q.question}</legend>
          <div className="question-options">
            {q.options.map((option) => (
              <button
                type="button"
                className={answers[q.id] === option ? "selected" : ""}
                aria-pressed={answers[q.id] === option}
                key={option}
                onClick={() => setAnswers({ ...answers, [q.id]: option })}
              >
                {option === "Rows" ? "Record count (table rows)" : option}
              </button>
            ))}
          </div>
          <input
            aria-label={q.question}
            placeholder="Your answer"
            value={answers[q.id] || ""}
            onChange={(event) =>
              setAnswers({ ...answers, [q.id]: event.target.value })
            }
            required
          />
        </fieldset>
      ))}
      {questions.some((q) => q.id === "metric") && (
        <div className="metric-context-fields">
          <label>Unit <span>optional</span><input aria-label="Metric unit" placeholder="e.g. USD, orders, kg" maxLength={40} value={answers.unit || ""} onChange={(event) => setAnswers({ ...answers, unit: event.target.value })} /></label>
          <label>Metric definition <span>optional</span><input aria-label="Metric definition" placeholder="What does this measure include?" maxLength={300} value={answers.definition || ""} onChange={(event) => setAnswers({ ...answers, definition: event.target.value })} /></label>
        </div>
      )}
      <Button
        type="submit"
        disabled={busy || questions.some((q) => !answers[q.id]?.trim())}
      >
        {busy && <Loader2 className="spin" size={15} />}
        {label || "Build dashboard"}
      </Button>
    </form>
  );
}
function Evidence({ sql, limited }: { sql: string; limited?: boolean }) {
  return (
    <details className="dashboard-evidence">
      <summary>SQL{limited ? " · Limited rows" : ""}</summary>
      <pre>{sql}</pre>
    </details>
  );
}
const { registry } = defineRegistry(dashboardCatalog, {
  components: {
    DashboardGrid: ({ props, children }) => (
      <div
        className="dashboard-grid"
        style={{ "--dashboard-columns": props.columns } as CSSProperties}
      >
        {children}
      </div>
    ),
    Metric: ({ props }) => (
      <section className="dashboard-widget dashboard-metric">
        <h3>{props.title}</h3>
        <strong>
          {props.value === null
            ? "—"
            : new Intl.NumberFormat("en", { maximumFractionDigits: 20 }).format(
                props.value,
              )}
        </strong>
        <Evidence sql={props.sql} />
      </section>
    ),
    Chart: ({ props }) => (
      <section className="dashboard-widget dashboard-chart">
        <h3>{props.title}</h3>
        <DataChart chart={props} />
        <Evidence sql={props.sql} limited={props.limited} />
      </section>
    ),
    DataTable: ({ props }) => (
      <section className="dashboard-widget dashboard-table">
        <h3>{props.title}</h3>
        <DataTable rows={props.rows} columns={props.columns} />
        <Evidence sql={props.sql} limited={props.limited} />
      </section>
    ),
    Note: ({ props }) => <p className="dashboard-notice">{props.text}</p>,
    UserQuestions: ({ props }) => <UserQuestions questions={props.questions} />,
  },
});

export function DashboardView({
  result,
  busy,
  onAnswer,
  onRefresh,
  onSaved,
}: {
  result: DashboardResult;
  busy: boolean;
  onAnswer: (answers: Record<string, string>) => void;
  onRefresh: () => void;
  onSaved: (id: number, name: string, answers: Record<string, string>) => Promise<void>;
}) {
  const [name, setName] = useState(
    result.saved_name || result.title || "Dashboard",
  );
  const [savedId, setSavedId] = useState(result.saved_id);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [unit, setUnit] = useState(result.answers?.unit || "");
  const [definition, setDefinition] = useState(result.answers?.definition || "");
  const valid =
    dashboardCatalog.validate(result.spec).success &&
    validateSpec(result.spec).valid;
  async function save() {
    setSaving(true);
    setError("");
    try {
      const answers = { ...result.answers, unit: unit.trim(), definition: definition.trim() };
      const saved = await api<{ id: number }>("/dashboards/save", {
        name: name.trim(),
        source: result.source,
        question: result.question,
        answers,
        ...(savedId ? { id: savedId } : {}),
      });
      setSavedId(saved.id);
      await onSaved(saved.id, name.trim(), answers);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }
  return (
    <div className="dashboard-view" aria-busy={busy}>
      <header className="dashboard-header">
        <div>
          <h1>
            {result.kind === "questions"
              ? "Choose your data"
              : result.title || "Dashboard"}
          </h1>
          <p>
            {result.source}
            {result.generated_by
              ? ` · ${result.generated_by === "model" ? "AI layout" : "Starter layout"}`
              : ""}
            {result.as_of
              ? ` · ${new Date(result.as_of).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`
              : ""}
          </p>
        </div>
        {result.kind === "dashboard" && (
          <Button
            variant="outline"
            size="sm"
            disabled={busy || saving}
            onClick={onRefresh}
          >
            {busy ? (
              <Loader2 className="spin" size={14} />
            ) : (
              <RotateCw size={14} />
            )}
            Refresh
          </Button>
        )}
      </header>
      <div className="dashboard-question"><span>Original question</span><p>{result.question}</p></div>
      {result.kind === "dashboard" && (
        <div className="dashboard-context">
          <p><strong>Calculation</strong> {result.scope?.aggregation && result.scope?.metric ? `${result.scope.aggregation} of ${result.scope.metric === "Rows" ? "table rows" : result.scope.metric}` : "See each widget’s SQL"}</p>
          <p><strong>Source and scope</strong> {result.scope?.table ? `${result.source} / ${result.scope.table} · ${result.scope.coverage}` : result.scope?.coverage || "Scope unspecified; inspect SQL"}</p>
          <p><strong>Period</strong> {result.scope?.min_date && result.scope?.max_date ? `${result.scope.min_date} to ${result.scope.max_date}` : "Unspecified"}</p>
          <p><strong>Unit</strong> {result.metric_context?.unit || "Unspecified"} <span>·</span> <strong>Definition</strong> {result.metric_context?.definition || "Unspecified"}</p>
          {result.summary && <p className="dashboard-factual-summary">{result.summary}</p>}
        </div>
      )}
      {result.kind === "dashboard" && result.saved_id && (
        <div className={`dashboard-comparison is-${result.comparison?.status || "unavailable"}`} role="status">
          <strong>Saved rerun</strong>
          {result.comparison?.status === "unavailable" || !result.comparison ? (
            <p><Info size={14} aria-hidden="true" />{result.comparison?.reason || "No preceding saved run to compare."}</p>
          ) : (
            <p>{result.comparison.status === "same" ? <Check size={14} aria-hidden="true" /> : result.comparison.delta! > 0 ? <ArrowUpRight size={14} aria-hidden="true" /> : <ArrowDownRight size={14} aria-hidden="true" />}{result.comparison.status === "same" ? "No change" : `${result.comparison.delta! > 0 ? "Increased by" : "Decreased by"} ${new Intl.NumberFormat("en", { maximumFractionDigits: 2 }).format(Math.abs(result.comparison.delta!))} ${result.metric_context?.unit || "(unit unspecified)"}`} · {new Date(result.comparison.previous_at!).toLocaleString()} → {new Date(result.comparison.current_at!).toLocaleString()}</p>
          )}
        </div>
      )}
      {result.notice && (
        <p className="dashboard-notice" role="status">
          {result.notice}
        </p>
      )}
      {error && (
        <p className="dashboard-error" role="alert">
          {error}
        </p>
      )}
      {valid ? (
        <QuestionContext.Provider
          value={{
            busy,
            answer: onAnswer,
            label:
              result.agent?.name === "analysis"
                ? "Continue"
                : "Build dashboard",
          }}
        >
          <JSONUIProvider registry={registry}>
            <Renderer spec={result.spec} registry={registry} />
          </JSONUIProvider>
        </QuestionContext.Provider>
      ) : (
        <p role="alert">
          This dashboard could not be rendered. Try a new request.
        </p>
      )}
      <AgentActivity agent={result.agent} />
      {result.kind === "dashboard" && (
        <form
          className="dashboard-save"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <div className="metric-context-fields">
            <label>Unit <span>optional</span><input aria-label="Metric unit" placeholder="e.g. USD" maxLength={40} value={unit} onChange={(event) => setUnit(event.target.value)} /></label>
            <label>Metric definition <span>optional</span><input aria-label="Metric definition" placeholder="What does this measure include?" maxLength={300} value={definition} onChange={(event) => setDefinition(event.target.value)} /></label>
          </div>
          <input
            aria-label="Dashboard name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={100}
            required
          />
          <Button
            variant="outline"
            size="sm"
            disabled={saving || busy || !name.trim()}
            type="submit"
          >
            {saving ? (
              <Loader2 className="spin" size={14} />
            ) : (
              <Save size={14} />
            )}
            {savedId ? "Update dashboard" : "Save dashboard"}
          </Button>
        </form>
      )}
    </div>
  );
}
