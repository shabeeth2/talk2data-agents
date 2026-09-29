"use client";

import { createContext, useContext, useState, type CSSProperties } from "react";
import { defineCatalog, validateSpec } from "@json-render/core";
import { defineRegistry, JSONUIProvider, Renderer } from "@json-render/react";
import { schema } from "@json-render/react/schema";
import { z } from "zod";
import { Loader2, RotateCw, Save } from "lucide-react";
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
                {option}
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
  onSaved: (id: number, name: string) => Promise<void>;
}) {
  const [name, setName] = useState(
    result.saved_name || result.title || "Dashboard",
  );
  const [savedId, setSavedId] = useState(result.saved_id);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const valid =
    dashboardCatalog.validate(result.spec).success &&
    validateSpec(result.spec).valid;
  async function save() {
    setSaving(true);
    setError("");
    try {
      const saved = await api<{ id: number }>("/dashboards/save", {
        name: name.trim(),
        source: result.source,
        question: result.question,
        answers: result.answers || {},
        ...(savedId ? { id: savedId } : {}),
      });
      setSavedId(saved.id);
      await onSaved(saved.id, name.trim());
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
