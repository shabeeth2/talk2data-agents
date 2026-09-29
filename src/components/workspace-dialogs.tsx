"use client";

import { useEffect, useState, type FormEvent } from "react";
import {
  Database,
  FileUp,
  Loader2,
  Plus,
  ShieldCheck,
  Terminal,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import {
  api,
  type Choice,
  type Result,
  type Server,
  type Settings,
  type Workspace,
} from "@/lib/api";

export type Panel = "connect" | "schema" | "change" | "extensions" | null;
export function WorkspaceDialogs({
  panel,
  close,
  source,
  tables,
  workspace,
  refresh,
  selectSource,
  onResult,
}: {
  panel: Panel;
  close: () => void;
  source: string;
  tables: { table: string; columns: string[] }[];
  workspace: Workspace | null;
  refresh: () => Promise<void>;
  selectSource: (s: string) => void;
  onResult: (r: Result) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [choices, setChoices] = useState<Choice[]>([]);
  const [settings, setSettings] = useState<Settings>({
    source,
    table: "",
    date: "",
    measure: "",
    dimension: "",
    window_days: 28,
  });
  const [tools, setTools] = useState<{ name: string; description: string }[]>(
    [],
  );
  const [server, setServer] = useState("");
  const [tool, setTool] = useState("");
  const [args, setArgs] = useState("{}");
  const [pending, setPending] = useState<{
    server: string;
    tool: string;
    arguments: Record<string, unknown>;
  } | null>(null);
  const [toolResult, setToolResult] = useState("");
  function defaults(c: Choice): Settings {
    return {
      source,
      table: c.table,
      date: c.default_date,
      measure: c.default_measure,
      dimension: c.dimensions[0] || "",
      window_days: 28,
    };
  }
  useEffect(() => {
    setError("");
    setPending(null);
    setToolResult("");
    if (panel !== "change") return;
    setChoices([]);
    setSettings({
      source,
      table: "",
      date: "",
      measure: "",
      dimension: "",
      window_days: 28,
    });
    let active = true;
    setBusy(true);
    api<Choice[]>(`/change/choices?source=${encodeURIComponent(source)}`)
      .then((data) => {
        if (active) {
          setChoices(data);
          if (data[0]) setSettings(defaults(data[0]));
          else
            setError(
              "This source needs a date column and numeric measure for change checks.",
            );
        }
      })
      .catch((e) => {
        if (active) setError(e.message);
      })
      .finally(() => {
        if (active) setBusy(false);
      });
    return () => {
      active = false;
    };
    // Defaults are derived from the currently selected source.
  }, [panel, source]);
  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  function formData(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    return Object.fromEntries(new FormData(e.currentTarget));
  }
  async function upload(file?: File) {
    if (!file) return;
    if (file.size > 30 * 1024 * 1024) {
      setError("Choose a file smaller than 30 MB.");
      return;
    }
    await run(async () => {
      const form = new FormData();
      form.set("file", file);
      const res = await api<{ source: string }>("/sources/upload", form);
      await refresh();
      selectSource(res.source);
      close();
    });
  }
  const choice = choices.find((c) => c.table === settings.table);
  const titles = {
    connect: "Bring your data",
    schema: "Source schema",
    change: "Investigate a change",
    extensions: "Skills & connections",
  };
  return (
    <Dialog
      open={Boolean(panel)}
      onOpenChange={(open) => {
        if (!open && !busy) close();
      }}
    >
      <DialogContent
        className="workspace-dialog"
        onInteractOutside={(e) => {
          if (busy) e.preventDefault();
        }}
      >
        <DialogHeader>
          <DialogTitle>{panel ? titles[panel] : "Workspace"}</DialogTitle>
          <DialogDescription>
            {panel === "connect"
              ? "Upload a file or connect a database to start exploring."
              : panel === "change"
                ? "Compare equal windows and inspect the evidence behind the change."
                : panel === "schema"
                  ? source
                  : "Add analysis instructions and tools to your workspace."}
          </DialogDescription>
        </DialogHeader>
        <div className="dialog-body">
          {panel === "connect" && (
            <>
              <label className={`upload-zone ${busy ? "disabled" : ""}`}>
                <FileUp size={26} />
                <strong>Choose a data file</strong>
                <span>
                  CSV, TSV, Excel, Parquet, JSON or JSONL · up to 30 MB
                </span>
                <input
                  type="file"
                  aria-label="Upload data file"
                  accept=".csv,.tsv,.xlsx,.xls,.parquet,.json,.jsonl"
                  disabled={busy}
                  onChange={(e) => {
                    void upload(e.target.files?.[0]);
                    e.target.value = "";
                  }}
                />
              </label>
              <div className="divider">
                <span>or connect a database</span>
              </div>
              <form
                onSubmit={(e) => {
                  const data = formData(e);
                  void run(async () => {
                    const res = await api<{ source: string }>(
                      "/sources/connect",
                      data,
                    );
                    await refresh();
                    selectSource(res.source);
                    close();
                  });
                }}
              >
                <label>
                  Connection name
                  <input
                    name="name"
                    required
                    placeholder="e.g. Analytics warehouse"
                    autoComplete="off"
                  />
                </label>
                <label>
                  SQLAlchemy URL
                  <input
                    name="url"
                    type="password"
                    required
                    placeholder="postgresql://user:password@host/database"
                    autoComplete="off"
                  />
                </label>
                <p className="form-hint">
                  Use a read-only database account. Connection credentials are
                  stored in your local workspace.
                </p>
                <Button type="submit" disabled={busy}>
                  <Database size={15} />
                  {busy ? "Connecting…" : "Connect database"}
                </Button>
              </form>
            </>
          )}
          {panel === "schema" && (
            <div className="schema-list">
              {tables.length ? (
                tables.map((t) => (
                  <section key={t.table}>
                    <h3>
                      <Database size={16} />
                      {t.table}
                      <span>{t.columns.length} columns</span>
                    </h3>
                    {t.columns.map((c) => {
                      const [name, ...type] = c.split(" (");
                      return (
                        <div className="schema-column" key={c}>
                          <code>{name}</code>
                          <span>{type.join(" (").replace(/\)$/, "")}</span>
                        </div>
                      );
                    })}
                  </section>
                ))
              ) : (
                <p className="muted">
                  No schema loaded. Close this window and retry from the source
                  selector.
                </p>
              )}
            </div>
          )}
          {panel === "change" && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void run(async () => {
                  onResult(await api<Result>("/change/run", settings));
                  await refresh();
                  close();
                });
              }}
            >
              <label>
                Table
                <select
                  value={settings.table}
                  onChange={(e) => {
                    const c = choices.find((c) => c.table === e.target.value);
                    if (c) setSettings(defaults(c));
                  }}
                >
                  {choices.map((c) => (
                    <option key={c.table}>{c.table}</option>
                  ))}
                </select>
              </label>
              <div className="form-grid">
                <label>
                  Date column
                  <select
                    value={settings.date}
                    onChange={(e) =>
                      setSettings({ ...settings, date: e.target.value })
                    }
                  >
                    {choice?.dates.map((d) => (
                      <option key={d}>{d}</option>
                    ))}
                  </select>
                </label>
                <label>
                  Measure
                  <select
                    value={settings.measure}
                    onChange={(e) =>
                      setSettings({ ...settings, measure: e.target.value })
                    }
                  >
                    {choice?.measures.map((d) => (
                      <option key={d}>{d}</option>
                    ))}
                  </select>
                </label>
              </div>
              <div className="form-grid">
                <label>
                  Break down by
                  <select
                    value={settings.dimension}
                    onChange={(e) =>
                      setSettings({ ...settings, dimension: e.target.value })
                    }
                  >
                    <option value="">No breakdown</option>
                    {choice?.dimensions.map((d) => (
                      <option key={d}>{d}</option>
                    ))}
                  </select>
                </label>
                <label>
                  Window length
                  <select
                    value={settings.window_days}
                    onChange={(e) =>
                      setSettings({
                        ...settings,
                        window_days: Number(e.target.value),
                      })
                    }
                  >
                    {[7, 14, 28].map((d) => (
                      <option value={d} key={d}>
                        {d} days
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <p className="form-hint">
                Windows end at the latest date in your source. Each check
                includes its query, finding, and limitations.
              </p>
              <Button type="submit" disabled={busy || !choice}>
                {busy ? (
                  <Loader2 size={15} className="spin" />
                ) : (
                  <Terminal size={15} />
                )}
                {busy ? "Checking evidence…" : "Run investigation"}
              </Button>
            </form>
          )}
          {panel === "extensions" && (
            <div className="extensions">
              <section>
                <h3>Analysis skills</h3>
                <div className="skill-list">
                  {workspace?.skills.map((s) => (
                    <div key={s.command}>
                      <code>{s.command}</code>
                      <span>{s.name}</span>
                    </div>
                  ))}
                </div>
                <details className="extension-add">
                  <summary>
                    <Plus size={14} /> Add a custom skill
                  </summary>
                  <form
                    onSubmit={(e) => {
                      const data = formData(e);
                      const form = e.currentTarget;
                      void run(async () => {
                        await api("/extensions/skills", data);
                        await refresh();
                        form.reset();
                      });
                    }}
                  >
                    <label>
                      Name
                      <input
                        name="name"
                        required
                        placeholder="Cohort analysis"
                      />
                    </label>
                    <label>
                      Command
                      <input
                        name="command"
                        required
                        pattern="/\w+"
                        placeholder="/cohort"
                      />
                    </label>
                    <label>
                      Analysis instruction
                      <textarea
                        name="instruction"
                        required
                        minLength={10}
                        placeholder="Describe what the analysis should check…"
                      />
                    </label>
                    <Button size="sm" disabled={busy}>
                      Add skill
                    </Button>
                  </form>
                </details>
              </section>
              <section>
                <h3>MCP servers</h3>
                <p className="form-hint">
                  Review and approve the exact arguments before every tool call.
                </p>
                {!workspace?.servers.length && (
                  <p className="muted">No servers connected.</p>
                )}
                {workspace?.servers.map((s: Server) => (
                  <Button
                    key={s.name}
                    variant="outline"
                    disabled={busy}
                    onClick={() => {
                      setTools([]);
                      setTool("");
                      setPending(null);
                      setToolResult("");
                      void run(async () => {
                        setServer(s.name);
                        setTools(
                          await api(
                            `/extensions/servers/${encodeURIComponent(s.name)}/tools`,
                          ),
                        );
                      });
                    }}
                  >
                    {s.name}
                  </Button>
                ))}
                <details className="extension-add">
                  <summary>
                    <Plus size={14} /> Connect a server
                  </summary>
                  <form
                    onSubmit={(e) => {
                      const data = formData(e);
                      const form = e.currentTarget;
                      void run(async () => {
                        await api("/extensions/servers", data);
                        await refresh();
                        form.reset();
                      });
                    }}
                  >
                    <label>
                      Name
                      <input name="name" required placeholder="My tools" />
                    </label>
                    <label>
                      Streamable HTTP URL
                      <input
                        name="url"
                        type="url"
                        required
                        placeholder="http://localhost:8080/mcp"
                      />
                    </label>
                    <Button size="sm" disabled={busy}>
                      Connect server
                    </Button>
                  </form>
                </details>
              </section>
              {tools.length > 0 && (
                <section>
                  <h3>Tools · {server}</h3>
                  <label>
                    Tool
                    <select
                      value={tool}
                      onChange={(e) => {
                        setTool(e.target.value);
                        setPending(null);
                      }}
                    >
                      <option value="">Choose a tool</option>
                      {tools.map((t) => (
                        <option key={t.name}>{t.name}</option>
                      ))}
                    </select>
                  </label>
                  <p className="form-hint">
                    {tools.find((t) => t.name === tool)?.description}
                  </p>
                  <label>
                    Arguments (JSON)
                    <textarea
                      className="mono"
                      value={args}
                      onChange={(e) => {
                        setArgs(e.target.value);
                        setPending(null);
                      }}
                      spellCheck={false}
                    />
                  </label>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={!tool || busy}
                    onClick={() => {
                      setError("");
                      try {
                        const arguments_ = JSON.parse(args);
                        if (
                          !arguments_ ||
                          Array.isArray(arguments_) ||
                          typeof arguments_ !== "object"
                        )
                          throw new Error("Arguments must be a JSON object.");
                        setPending({ server, tool, arguments: arguments_ });
                      } catch (e) {
                        setError((e as Error).message);
                      }
                    }}
                  >
                    Review call
                  </Button>
                </section>
              )}
              {pending && (
                <section className="approval">
                  <h3>
                    <ShieldCheck size={16} />
                    Approve this tool call
                  </h3>
                  <p>
                    {pending.server} / <strong>{pending.tool}</strong>
                  </p>
                  <pre>{JSON.stringify(pending.arguments, null, 2)}</pre>
                  <div className="approval-actions">
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy}
                      onClick={() => setPending(null)}
                    >
                      Cancel
                    </Button>
                    <Button
                      size="sm"
                      disabled={busy}
                      onClick={() => {
                        const call = pending;
                        setPending(null);
                        void run(async () => {
                          const res = await api<{ result: string }>(
                            "/extensions/call",
                            { ...call, approved: true },
                          );
                          setToolResult(res.result);
                        });
                      }}
                    >
                      Approve & run once
                    </Button>
                  </div>
                </section>
              )}
              {toolResult && (
                <section>
                  <h3>Tool response</h3>
                  <pre>{toolResult}</pre>
                </section>
              )}
            </div>
          )}
          {busy && panel !== "change" && (
            <p className="loading-inline" role="status">
              <Loader2 size={14} className="spin" />
              Working…
            </p>
          )}
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
