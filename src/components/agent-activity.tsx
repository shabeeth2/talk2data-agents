"use client";
import { Check, CircleAlert } from "lucide-react";
import type { Result } from "@/lib/api";
const labels: Record<string, string> = {
  getSchema: "Inspected schema",
  runAnalysis: "Queried and analyzed data",
  investigateChange: "Checked change evidence",
  createDashboard: "Built dashboard",
  addUserQuestions: "Requested clarification",
};
export function AgentActivity({ agent }: { agent: Result["agent"] }) {
  if (!agent) return null;
  return (
    <details className="analysis-trace">
      <summary>
        <Check size={13} />
        {agent.name === "dashboard" ? "Dashboard" : "Analysis"}{" "}
        {agent.mode === "model" ? "agent" : "starter"} · {agent.steps.length}{" "}
        {agent.steps.length === 1 ? "step" : "steps"}
      </summary>
      <ol>
        {agent.steps.map((step, index) => (
          <li key={index}>
            {step.status === "review" && (
              <CircleAlert size={12} aria-label="Needs review" />
            )}{" "}
            {labels[step.tool] || step.tool}
            {step.status === "review" ? " · Retried or needs review" : ""}
          </li>
        ))}
      </ol>
    </details>
  );
}
