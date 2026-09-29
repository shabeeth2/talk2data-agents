import assert from "node:assert/strict";
import test from "node:test";
import { MockLanguageModelV4 } from "ai/test";
import type { LanguageModelV4GenerateResult } from "@ai-sdk/provider";
import { BackendError, runAgent } from "../src/lib/agents.ts";

const source = "demo";
test("saved starter reruns forward new clarification answers while pinning stored context", async () => {
  const previousUrl = process.env.TALK2DATA_LLM_URL;
  delete process.env.TALK2DATA_LLM_URL;
  try {
    const requests: RequestRecord[] = [];
    const result = await runAgent(
      { source: "untrusted source", question: "ignored request", saved_id: 7, answers: { metric: "orders" } },
      { backend: backend((path, body) => {
        requests.push({ path, body });
        if (path === "/dashboards") return [{ id: 7, name: "Retail", source, question: "/dashboard", answers: { table: "orders", metric: "revenue" } }];
        return { kind: "dashboard", saved_id: 7, source, question: "/dashboard" };
      }).call },
    );
    assert.deepEqual(requests[1], { path: "/dashboards/7/run", body: { answers: { table: "orders", metric: "orders" } } });
    assert.equal(result.source, source);
    assert.equal(result.agent?.mode, "starter");
  } finally {
    if (previousUrl === undefined) delete process.env.TALK2DATA_LLM_URL;
    else process.env.TALK2DATA_LLM_URL = previousUrl;
  }
});
const question = "Revenue by region";
const context = {
  source,
  dialect: "sqlite",
  instruction: "Use read-only queries.",
  schema: [
    {
      table: "orders",
      columns: [
        { name: "region", type: "TEXT" },
        { name: "revenue", type: "REAL" },
      ],
    },
  ],
};
const analysis = {
  kind: "analysis",
  source,
  question,
  sql: "SELECT region, SUM(revenue) AS revenue FROM orders GROUP BY region",
  columns: ["region", "revenue"],
  rows: [{ region: "North", revenue: 125.5 }],
  row_count: 1,
  summary: "Queried revenue.",
};

function response(
  toolName?: string,
  input: unknown = {},
  id = "call-1",
): LanguageModelV4GenerateResult {
  return {
    content: toolName
      ? [
          {
            type: "tool-call",
            toolCallId: id,
            toolName,
            input: JSON.stringify(input),
          },
        ]
      : [
          {
            type: "text",
            text: "Revenue is 999999. SELECT secret FROM another_source",
          },
        ],
    finishReason: { unified: toolName ? "tool-calls" : "stop", raw: undefined },
    usage: {
      inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 5, text: 5, reasoning: 0 },
    },
    warnings: [],
  };
}

type RequestRecord = { path: string; body?: unknown };
function backend(handler: (path: string, body?: unknown) => unknown) {
  const requests: RequestRecord[] = [];
  return {
    requests,
    call: async <T>(path: string, body?: unknown): Promise<T> => {
      requests.push({ path, body });
      if (path.startsWith("/agent/context?")) return context as T;
      return (await handler(path, body)) as T;
    },
  };
}

test("analysis agent loops through schema and executes SQL; final text cannot replace evidence", async () => {
  const model = new MockLanguageModelV4({
    doGenerate: [
      response("getSchema"),
      response("runAnalysis", { sql: analysis.sql, method: "query" }, "query"),
      response(),
    ],
  });
  const service = backend((path, body) => {
    assert.equal(path, "/investigate");
    assert.deepEqual(body, { source, question, sql: analysis.sql });
    return analysis;
  });
  const result = await runAgent(
    { source, question },
    { model, backend: service.call },
  );
  assert.deepEqual(result.rows, analysis.rows);
  assert.equal(result.sql, analysis.sql);
  assert.equal(model.doGenerateCalls.length, 3);
  assert.equal(result.agent?.name, "analysis");
  assert.equal(result.agent?.mode, "model");
  assert.deepEqual(result.agent?.steps, [
    { tool: "getSchema", status: "checked" },
    { tool: "runAnalysis", status: "checked" },
  ]);
});

test("dashboard agent sends an unmaterialized plan to the validated backend and stops", async () => {
  const plan = {
    title: "Revenue",
    spec: {
      root: "dashboard",
      elements: {
        dashboard: {
          type: "DashboardGrid",
          props: { columns: 1 },
          children: ["metric"],
        },
        metric: {
          type: "Metric",
          props: {
            title: "Revenue",
            sql: "SELECT SUM(revenue) AS value FROM orders",
          },
          children: [],
        },
      },
    },
  };
  const dashboard = {
    kind: "dashboard",
    source,
    question,
    title: plan.title,
    spec: {
      ...plan.spec,
      elements: {
        ...plan.spec.elements,
        metric: {
          ...plan.spec.elements.metric,
          props: { ...plan.spec.elements.metric.props, value: 125.5 },
        },
      },
    },
  };
  const model = new MockLanguageModelV4({
    doGenerate: [response("getSchema"), response("createDashboard", { plan })],
  });
  const service = backend((path, body) => {
    assert.equal(path, "/agent/dashboard");
    assert.deepEqual(body, {
      source,
      question,
      answers: { metric: "revenue" },
      plan,
    });
    return dashboard;
  });
  const result = await runAgent(
    { source, question, mode: "dashboard", answers: { metric: "revenue" } },
    { model, backend: service.call },
  );
  assert.deepEqual(result.spec, dashboard.spec);
  assert.equal(result.agent?.name, "dashboard");
  assert.equal(model.doGenerateCalls.length, 2);
});

test("addUserQuestions returns a rendered clarification and preserves source, request, and prior answers", async () => {
  const questions = [
    { id: "metric", question: "Which metric?", options: ["Revenue", "Orders"] },
  ];
  const model = new MockLanguageModelV4({
    doGenerate: [
      response("getSchema"),
      response("addUserQuestions", { questions }),
    ],
  });
  const service = backend(() => {
    throw new Error("Clarification must not query or generate values");
  });
  const answers = { table: "orders" };
  const result = await runAgent(
    { source, question, mode: "dashboard", answers },
    { model, backend: service.call },
  );
  assert.equal(result.kind, "questions");
  assert.equal(result.source, source);
  assert.equal(result.question, question);
  assert.deepEqual(result.answers, answers);
  assert.ok(result.spec);
  const element = result.spec.elements[result.spec.root];
  assert.equal(element.type, "UserQuestions");
  assert.deepEqual(element.props.questions, questions);
  assert.equal(model.doGenerateCalls.length, 2);
});

test("change investigation uses explicit settings and preserves deterministic evidence", async () => {
  const settings = {
    table: "orders",
    date: "ordered_at",
    measure: "revenue",
    dimension: "region",
    window_days: 14,
  };
  const evidence = [
    {
      title: "Segment contributions",
      finding: "North contributed 20.",
      interpretation: "Arithmetic contribution.",
      limitation: "This does not establish causation.",
      sql: "SELECT region FROM orders",
      status: "checked",
    },
  ];
  const model = new MockLanguageModelV4({
    doGenerate: [
      response("getSchema"),
      response("investigateChange", settings),
      response(),
    ],
  });
  const service = backend((path, body) => {
    assert.equal(path, "/change/run");
    assert.deepEqual(body, { source, ...settings });
    return {
      kind: "change",
      source,
      question,
      settings: { source, ...settings },
      evidence,
    };
  });
  const result = await runAgent(
    { source, question: "Why did revenue drop?" },
    { model, backend: service.call },
  );
  assert.equal(result.kind, "change");
  assert.deepEqual(result.evidence, evidence);
  assert.equal(result.agent?.steps[1].tool, "investigateChange");
});

test("query failure reaches the model as a tool error so it can correct SQL", async () => {
  const model = new MockLanguageModelV4({
    doGenerate: [
      response("getSchema"),
      response(
        "runAnalysis",
        { sql: "SELECT missing FROM orders", method: "query" },
        "bad",
      ),
      response("runAnalysis", { sql: analysis.sql, method: "query" }, "fixed"),
      response(),
    ],
  });
  let queries = 0;
  const service = backend((path, body) => {
    assert.equal(path, "/investigate");
    queries += 1;
    if (queries === 1) throw new BackendError("Unknown column: missing", 400);
    assert.equal((body as { sql: string }).sql, analysis.sql);
    return analysis;
  });
  const result = await runAgent(
    { source, question },
    { model, backend: service.call },
  );
  assert.deepEqual(result.rows, analysis.rows);
  assert.equal(queries, 2);
  assert.match(
    JSON.stringify(model.doGenerateCalls[2].prompt),
    /Unknown column: missing/,
  );
  assert.deepEqual(result.agent?.steps, [
    { tool: "getSchema", status: "checked" },
    { tool: "runAnalysis", status: "review" },
    { tool: "runAnalysis", status: "checked" },
  ]);
});

test("model cannot override the pinned source by injecting an extra tool argument", async () => {
  const model = new MockLanguageModelV4({
    doGenerate: [
      response("getSchema"),
      response("runAnalysis", {
        sql: analysis.sql,
        method: "query",
        source: "private-database",
      }),
      response(),
    ],
  });
  const service = backend(() => {
    assert.fail("Injected source must be rejected before querying");
  });
  await assert.rejects(
    runAgent({ source, question }, { model, backend: service.call }),
  );
  assert.equal(service.requests.length, 1);
  assert.match(service.requests[0].path, /source=demo/);
});

test("plain model prose without a successful data tool is rejected", async () => {
  const model = new MockLanguageModelV4({
    doGenerate: [response("getSchema"), response()],
  });
  const service = backend(() => {
    throw new Error("Unexpected backend call");
  });
  await assert.rejects(
    runAgent({ source, question }, { model, backend: service.call }),
  );
  assert.equal(service.requests.length, 1);
});

test("unknown tool names cannot reach backend capabilities", async () => {
  const model = new MockLanguageModelV4({
    doGenerate: [
      response("getSchema"),
      response("deleteSource", { source }),
      response(),
    ],
  });
  const service = backend(() => {
    throw new Error("Unknown tools must never reach the backend");
  });
  await assert.rejects(
    runAgent({ source, question }, { model, backend: service.call }),
  );
  assert.equal(service.requests.length, 1);
});

test("agent stops after at most six model steps instead of looping forever", async () => {
  const model = new MockLanguageModelV4({
    doGenerate: async () => response("getSchema", {}, crypto.randomUUID()),
  });
  const service = backend(() => {
    throw new Error("Unexpected backend call");
  });
  await assert.rejects(
    runAgent({ source, question }, { model, backend: service.call }),
  );
  assert.equal(model.doGenerateCalls.length, 6);
  assert.equal(service.requests.length, 6);
});

for (const invalid of [
  { tool: "deleteSource", input: { source } },
  {
    tool: "runAnalysis",
    input: { sql: analysis.sql, method: "query", source: "private-database" },
  },
]) {
  test(`a successful query cannot mask a later rejected ${invalid.tool} call`, async () => {
    const model = new MockLanguageModelV4({
      doGenerate: [
        response("getSchema"),
        response(
          "runAnalysis",
          { sql: analysis.sql, method: "query" },
          "successful",
        ),
        response(invalid.tool, invalid.input, "invalid"),
        response(),
      ],
    });
    let queryCount = 0;
    const service = backend((path) => {
      assert.equal(path, "/investigate");
      queryCount += 1;
      return analysis;
    });
    await assert.rejects(
      runAgent({ source, question }, { model, backend: service.call }),
      /verified result/,
    );
    assert.equal(queryCount, 1);
  });
}

test("a validated data tool can recover after a rejected tool schema", async () => {
  const model = new MockLanguageModelV4({
    doGenerate: [
      response("getSchema"),
      response(
        "runAnalysis",
        { sql: analysis.sql, method: "query", source: "private-database" },
        "invalid",
      ),
      response(
        "runAnalysis",
        { sql: analysis.sql, method: "query" },
        "corrected",
      ),
      response(),
    ],
  });
  const service = backend((path, body) => {
    assert.equal(path, "/investigate");
    assert.deepEqual(body, { source, question, sql: analysis.sql });
    return analysis;
  });
  const result = await runAgent(
    { source, question },
    { model, backend: service.call },
  );
  assert.deepEqual(result.rows, analysis.rows);
  assert.deepEqual(result.agent?.steps, [
    { tool: "getSchema", status: "checked" },
    { tool: "runAnalysis", status: "review" },
    { tool: "runAnalysis", status: "checked" },
  ]);
});
