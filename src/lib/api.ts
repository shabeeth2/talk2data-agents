import type { Spec } from "@json-render/core";
export type Row = Record<string, string | number | boolean | null>;
export type UserQuestion = { id: string; question: string; options: string[] };
export type DashboardResult = Result & {
  kind: "dashboard" | "questions";
  question: string;
  spec: Spec;
  answers?: Record<string, string>;
  generated_by?: "model" | "starter";
  notice?: string;
};
export type ChartData = { type: string; x?: string; y?: string; data: Row[] };
export type Settings = {
  source: string;
  table: string;
  date: string;
  measure: string;
  dimension: string;
  window_days: number;
};
export type Evidence = {
  title: string;
  finding: string;
  interpretation: string;
  limitation: string;
  sql: string;
  status: string;
};
export type Result = {
  agent?: {
    name: "analysis" | "dashboard";
    mode: "model" | "starter";
    steps: { tool: string; status: "checked" | "review" }[];
  };
  kind: string;
  source: string;
  question?: string;
  title?: string;
  summary?: string;
  sql?: string;
  chart?: ChartData;
  columns?: string[];
  rows?: Row[];
  row_count?: number;
  trace?: string[];
  settings?: Settings;
  as_of?: string;
  latest_date?: string;
  start?: string;
  middle?: string;
  end?: string;
  previous?: number;
  current?: number;
  delta?: number;
  percentage?: number | null;
  evidence?: Evidence[];
  segments?: Row[];
  daily?: Row[];
  caveat?: string;
  saved_id?: number;
  saved_name?: string;
  spec?: Spec;
  answers?: Record<string, string>;
  generated_by?: "model" | "starter";
};
export type Skill = { name: string; command: string; description: string };
export type Server = { name: string; url: string; enabled: boolean };
export type Workspace = {
  sources: { name: string; kind: string }[];
  runs: {
    id: number;
    question: string;
    source: string;
    kind: string;
    created_at: string;
  }[];
  saved_changes: {
    id: number;
    name: string;
    source: string;
    command: string;
  }[];
  skills: Skill[];
  servers: Server[];
  model_configured?: boolean;
  dashboards: { id: number; name: string; source: string; question: string }[];
};
export type Choice = {
  table: string;
  dates: string[];
  measures: string[];
  dimensions: string[];
  default_date: string;
  default_measure: string;
};

export async function api<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(
    `/api${path}`,
    body === undefined
      ? { cache: "no-store" }
      : body instanceof FormData
        ? { method: "POST", body }
        : {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          },
  );
  const data = await response.json().catch(() => null);
  if (!response.ok)
    throw new Error(
      typeof data?.detail === "string"
        ? data.detail
        : response.status === 422
          ? "Check the fields and try again."
          : "Could not reach the data engine. Start the API and try again.",
    );
  return data as T;
}

export function download(
  name: string,
  content: string,
  type = "application/json",
) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  URL.revokeObjectURL(url);
}
