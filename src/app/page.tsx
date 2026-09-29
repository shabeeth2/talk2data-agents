"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import {
  ArrowRight,
  ChartNoAxesCombined,
  ChevronDown,
  CircleHelp,
  Database,
  FlaskConical,
  LayoutDashboard,
  History,
  Leaf,
  Loader2,
  Menu,
  MessageSquare,
  PanelLeftClose,
  Plus,
  Search,
  Settings2,
  ShieldCheck,
  SlidersHorizontal,
  X,
} from "lucide-react";
import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation";
import { Message, MessageContent } from "@/components/ai-elements/message";
import {
  PromptInput,
  PromptInputFooter,
  PromptInputTextarea,
  PromptInputTools,
  PromptInputSubmit,
} from "@/components/ai-elements/prompt-input";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { WorkspaceDialogs, type Panel } from "@/components/workspace-dialogs";
import { ThemeToggle } from "@/components/theme-provider";
import {
  api,
  type DashboardResult,
  type Result,
  type Workspace,
} from "@/lib/api";
type Entry = { id: string; question: string; result: Result };
const AnalysisResult = dynamic(
  () => import("@/components/result").then((m) => m.AnalysisResult),
  { loading: () => <p className="loading-inline">Preparing result…</p> },
);
const DashboardView = dynamic(
  () => import("@/components/dashboard").then((m) => m.DashboardView),
  { loading: () => <p className="loading-inline">Preparing dashboard…</p> },
);
const starters = [
  {
    icon: ChartNoAxesCombined,
    label: "Visualize a trend",
    prompt: "Show revenue over time",
  },
  {
    icon: FlaskConical,
    label: "Investigate a change",
    prompt: "Why did revenue drop?",
  },
  {
    icon: LayoutDashboard,
    label: "Build a dashboard",
    prompt: "/dashboard",
  },
];
function IconButton({
  label,
  children,
  onClick,
}: {
  label: string;
  children: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          aria-label={label}
          onClick={onClick}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}
export default function Workbench() {
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [source, setSource] = useState("");
  const [tables, setTables] = useState<{ table: string; columns: string[] }[]>(
    [],
  );
  const [entries, setEntries] = useState<Entry[]>([]);
  const [dashboard, setDashboard] = useState<DashboardResult | null>(null);
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [panel, setPanel] = useState<Panel>(null);
  const [sidebar, setSidebar] = useState(true);
  const [mobileNav, setMobileNav] = useState(false);
  const [search, setSearch] = useState<string | null>(null);
  const [help, setHelp] = useState(false);
  const [schemaVersion, setSchemaVersion] = useState(0);
  const composer = useRef<HTMLTextAreaElement>(null);
  const busyRef = useRef(false);
  const refresh = useCallback(async () => {
    const data = await api<Workspace>("/workspace");
    setWorkspace(data);
    setSchemaVersion((v) => v + 1);
    setSource((current) => current || data.sources[0]?.name || "");
  }, []);
  useEffect(() => {
    refresh().catch((e) => setError(e.message));
  }, [refresh]);
  useEffect(() => {
    if (!source) return;
    let current = true;
    setTables([]);
    api<typeof tables>(`/schema?source=${encodeURIComponent(source)}`)
      .then((data) => {
        if (current) setTables(data);
      })
      .catch((e) => {
        if (current) setError(e.message);
      });
    return () => {
      current = false;
    };
  }, [source, schemaVersion]);
  function newChat() {
    if (busyRef.current) return;
    setEntries([]);
    setDashboard(null);
    setDraft("");
    setError("");
    setMobileNav(false);
    composer.current?.focus();
  }
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (
        (e.ctrlKey || e.metaKey) &&
        e.shiftKey &&
        e.key.toLowerCase() === "o"
      ) {
        e.preventDefault();
        newChat();
      }
      if (e.key === "Escape") {
        setMobileNav(false);
        setHelp(false);
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, []);
  async function action(
    question: string,
    operation: () => Promise<Result>,
    replace = false,
  ) {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setPending(question);
    setError("");
    setMobileNav(false);
    try {
      const result = await operation();
      const entry = { id: crypto.randomUUID(), question, result };
      if (result.kind === "dashboard" || result.kind === "questions")
        setDashboard(result as DashboardResult);
      else {
        setDashboard(null);
        setEntries((old) => (replace ? [entry] : [...old, entry]));
      }
      setSource(result.source);
      await refresh();
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      busyRef.current = false;
      setBusy(false);
      setPending("");
    }
  }
  async function ask(text: string) {
    const question = text.trim();
    if (!question || !source || busyRef.current) return;
    setDraft("");
    if (
      !(await action(question, () =>
        dashboard && !question.startsWith("/")
          ? api<Result>("/agent", {
              source,
              question: `${dashboard.question}\nUpdate: ${question}`,
              mode: "dashboard",
              answers: dashboard.answers || {},
            })
          : api<Result>("/agent", {
              source,
              question,
              history: entries
                .filter((e) => e.result.source === source)
                .slice(-4)
                .map((e) => ({
                  question: e.question,
                  summary: (e.result.summary || "").slice(0, 2000),
                  sql: e.result.sql || "",
                })),
            }),
      ))
    )
      setDraft(question);
  }
  function selectSource(next: string) {
    setSource(next);
    setDashboard(null);
    setError("");
    setMobileNav(false);
  }
  function configuredResult(result: Result) {
    setDashboard(null);
    setEntries((old) => [
      ...old,
      {
        id: crypto.randomUUID(),
        question: `Investigate ${result.settings?.measure} change`,
        result,
      },
    ]);
  }
  const history =
    workspace?.runs.filter(
      (r) =>
        search === null ||
        r.question.toLowerCase().includes(search.toLowerCase()),
    ) || [];
  const navigation = (
    <>
      <div className="brand-row">
        <button className="brand" onClick={newChat} aria-label="Talk2Data home">
          <span className="brand-icon">
            <ChartNoAxesCombined size={20} />
          </span>
          <span>
            talk<span className="brand-two">2</span>data
          </span>
        </button>
        <IconButton
          label="Close sidebar"
          onClick={() => {
            setSidebar(false);
            setMobileNav(false);
          }}
        >
          <PanelLeftClose size={17} />
        </IconButton>
      </div>
      <Button
        className="new-chat"
        variant="outline"
        onClick={newChat}
        disabled={busy}
      >
        <Plus size={17} />
        New chat<span className="shortcut">⇧ O</span>
      </Button>
      <button
        className="nav-item"
        onClick={() => setSearch(search === null ? "" : null)}
      >
        <Search size={17} />
        <span>Search</span>
      </button>
      {search !== null && (
        <input
          className="history-search"
          autoFocus
          aria-label="Search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search by question…"
        />
      )}
      <div className="sidebar-scroll">
        <section className="source-section">
          <div className="section-label">
            <span>Data sources</span>
            <button
              aria-label="Connect a source"
              onClick={() => setPanel("connect")}
            >
              <Plus size={14} />
            </button>
          </div>
          {workspace?.sources.map((s) => (
            <button
              className={`source-item ${s.name === source ? "selected" : ""}`}
              key={s.name}
              disabled={busy}
              onClick={() => selectSource(s.name)}
            >
              <Database size={16} />
              <span>
                {s.name}
                <small>
                  {s.kind === "demo"
                    ? "Demo dataset"
                    : s.kind === "file"
                      ? "Uploaded file"
                      : "SQL database"}
                </small>
              </span>
              {s.name === source && <span className="source-dot" />}
            </button>
          ))}
          {!workspace && (
            <p className="sidebar-empty">
              {error ? "Engine unavailable" : "Loading sources…"}
            </p>
          )}
          <button
            className="nav-item connect-item"
            onClick={() => setPanel("connect")}
          >
            <Plus size={16} />
            Connect data
          </button>
        </section>
        <section>
          <div className="section-label">
            <span>Dashboards</span>
            <button
              aria-label="New dashboard"
              disabled={busy || !source}
              onClick={() =>
                void action("/dashboard", () =>
                  api<Result>("/agent", {
                    source,
                    question: "/dashboard",
                  }),
                )
              }
            >
              <Plus size={14} />
            </button>
          </div>
          {workspace?.dashboards?.map((d) => (
            <button
              className="history-item"
              key={d.id}
              disabled={busy}
              onClick={() =>
                void action(d.name, () =>
                  api<Result>("/agent", {
                    source: d.source,
                    question: d.question,
                    mode: "dashboard",
                    saved_id: d.id,
                  }),
                )
              }
            >
              <LayoutDashboard size={15} />
              <span>{d.name}</span>
            </button>
          ))}
        </section>
        {Boolean(workspace?.saved_changes.length) && (
          <section>
            <div className="section-label">
              <span>Saved checks</span>
            </div>
            {workspace?.saved_changes.map((c) => (
              <button
                className="history-item"
                disabled={busy}
                key={c.id}
                onClick={() =>
                  void action(
                    c.name,
                    () => api<Result>(`/change/${c.id}/run`, {}),
                    true,
                  )
                }
              >
                <ShieldCheck size={15} />
                <span>{c.name}</span>
              </button>
            ))}
          </section>
        )}
        <section>
          <div className="section-label">
            <span>Recent</span>
            <History size={13} />
          </div>
          {history.length ? (
            history.map((r) => (
              <button
                className="history-item"
                key={r.id}
                disabled={busy}
                onClick={() =>
                  void action(
                    r.question,
                    () => api<Result>(`/runs/${r.id}`),
                    true,
                  )
                }
              >
                <MessageSquare size={14} />
                <span>{r.question}</span>
              </button>
            ))
          ) : (
            <p className="sidebar-empty">
              {search ? "No matching investigations" : "No questions yet."}
            </p>
          )}
        </section>
      </div>
      <div className="sidebar-footer">
        <button className="nav-item" onClick={() => setPanel("extensions")}>
          <Settings2 size={17} />
          Skills & connections
        </button>
        <div className="workspace-profile">
          <div className="profile-icon">
            <Leaf size={17} />
          </div>
          <div>
            <strong>Local workspace</strong>
            <span>Talk2Data</span>
          </div>
          <span
            className={`health-dot ${workspace ? "online" : ""}`}
            title={workspace ? "Engine connected" : "Engine unavailable"}
          />
        </div>
      </div>
    </>
  );
  useEffect(() => {
    if (panel) setMobileNav(false);
  }, [panel]);
  return (
    <TooltipProvider delayDuration={250}>
      <div
        className={`workbench ${!sidebar ? "sidebar-collapsed" : ""} ${dashboard ? "dashboard-active" : ""}`}
      >
        <aside className="sidebar" aria-label="Workspace navigation">
          {navigation}
        </aside>
        <Dialog open={mobileNav} onOpenChange={setMobileNav}>
          <DialogContent
            className="mobile-sidebar"
            aria-describedby={undefined}
          >
            <DialogTitle className="sr-only">Workspace navigation</DialogTitle>
            {navigation}
          </DialogContent>
        </Dialog>
        <main className="main">
          <header className="topbar">
            <div className="topbar-start">
              <button
                className="mobile-menu"
                aria-label="Open navigation"
                onClick={() => setMobileNav(true)}
              >
                <Menu size={19} />
              </button>
              {!sidebar && (
                <span className="desktop-menu">
                  <IconButton
                    label="Open sidebar"
                    onClick={() => setSidebar(true)}
                  >
                    <Menu size={18} />
                  </IconButton>
                </span>
              )}
              <span className="workspace-name">
                {dashboard ? "Dashboard" : "Workspace"}
                <ChevronDown size={13} />
              </span>
            </div>
            <div className="topbar-end">
              <span className="read-only">
                <ShieldCheck size={13} />
                Read-only
              </span>
              <ThemeToggle />
              <IconButton label="Workspace help" onClick={() => setHelp(!help)}>
                <CircleHelp size={17} />
              </IconButton>
            </div>
          </header>
          {help && (
            <div className="help-panel">
              <button aria-label="Close help" onClick={() => setHelp(false)}>
                <X size={15} />
              </button>
              <h3>Start with a question</h3>
              <p>Choose a source. Ask a question or build a dashboard.</p>
              <p>
                <code>/forecast</code> · <code>/anomaly</code> ·{" "}
                <code>/profile</code> · <code>/sql SELECT …</code>
              </p>
              <p>New chat: Ctrl / ⌘ + Shift + O</p>
            </div>
          )}
          <div
            className={`conversation-layout ${entries.length || busy || dashboard ? "has-conversation" : ""}`}
          >
            {dashboard ? (
              <DashboardView
                key={`${dashboard.question}-${dashboard.saved_id || "new"}-${dashboard.as_of || dashboard.kind}`}
                result={dashboard}
                busy={busy}
                onAnswer={(answers) =>
                  void action(dashboard.question, () =>
                    api<Result>("/agent", {
                      source: dashboard.source,
                      question: dashboard.question,
                      answers: { ...dashboard.answers, ...answers },
                      mode: dashboard.agent?.name || "dashboard",
                      ...(dashboard.saved_id
                        ? { saved_id: dashboard.saved_id }
                        : {}),
                    }),
                  )
                }
                onRefresh={() =>
                  void action(dashboard.question, () =>
                    dashboard.saved_id
                      ? api<Result>("/agent", {
                          source: dashboard.source,
                          question: dashboard.question,
                          mode: "dashboard",
                          saved_id: dashboard.saved_id,
                        })
                      : api<Result>("/agent", {
                          source: dashboard.source,
                          question: dashboard.question,
                          answers: dashboard.answers || {},
                        }),
                  )
                }
                onSaved={async (id, name) => {
                  setDashboard((current) =>
                    current
                      ? { ...current, saved_id: id, saved_name: name }
                      : current,
                  );
                  await refresh();
                }}
              />
            ) : !entries.length && !busy ? (
              <div className="welcome">
                <div className="welcome-symbol">
                  <ChartNoAxesCombined size={29} strokeWidth={1.5} />
                </div>
                <h1>What’s in your data?</h1>
                <div className="source-context">
                  <span className="source-dot" />
                  {source || "Connecting to your workspace…"}
                  {tables.length > 0 && (
                    <>
                      <span className="context-divider">/</span>
                      <button onClick={() => setPanel("schema")}>
                        {tables.length}{" "}
                        {tables.length === 1 ? "table" : "tables"}
                        <ArrowRight size={12} />
                      </button>
                    </>
                  )}
                </div>
              </div>
            ) : (
              <Conversation className="conversation">
                <ConversationContent className="conversation-content">
                  {entries.map((entry) => (
                    <div className="conversation-turn" key={entry.id}>
                      <Message from="user">
                        <MessageContent>{entry.question}</MessageContent>
                      </Message>
                      <Message from="assistant">
                        <MessageContent>
                          <AnalysisResult
                            key={`${entry.id}-${entry.result.sql}`}
                            result={entry.result}
                            onRerun={(result) =>
                              setEntries((old) =>
                                old.map((e) =>
                                  e.id === entry.id ? { ...e, result } : e,
                                ),
                              )
                            }
                            onSaved={() => {
                              void refresh().catch((e) => setError(e.message));
                            }}
                          />
                        </MessageContent>
                      </Message>
                    </div>
                  ))}
                  {busy && (
                    <div className="pending-turn">
                      <Message from="user">
                        <MessageContent>{pending}</MessageContent>
                      </Message>
                      <p role="status">
                        <Loader2 size={17} className="spin" />
                        Inspecting your data…
                      </p>
                    </div>
                  )}
                </ConversationContent>
                <ConversationScrollButton aria-label="Scroll to latest answer" />
              </Conversation>
            )}
            <div className="composer-section">
              {error && (
                <div className="workspace-error" role="alert">
                  <span>{error}</span>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setError("");
                      void refresh().catch((e) => setError(e.message));
                    }}
                  >
                    Retry connection
                  </Button>
                  <button
                    aria-label="Dismiss error"
                    onClick={() => setError("")}
                  >
                    <X size={15} />
                  </button>
                </div>
              )}
              <PromptInput
                onSubmit={(message) => {
                  if (message.files.length) {
                    setError(
                      "Use + to import a data file before asking about it.",
                    );
                    return;
                  }
                  return ask(message.text);
                }}
                className="composer"
              >
                <PromptInputTextarea
                  ref={composer}
                  aria-label="Ask a question about your data"
                  placeholder={
                    dashboard
                      ? "Describe your dashboard…"
                      : "Ask about your data…"
                  }
                  value={draft}
                  disabled={busy || !source}
                  onChange={(e) => setDraft(e.target.value)}
                />
                <PromptInputFooter>
                  <PromptInputTools>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label="Upload or connect data"
                          onClick={() => setPanel("connect")}
                          disabled={busy}
                        >
                          <Plus size={19} />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>Upload or connect data</TooltipContent>
                    </Tooltip>
                    <div className="composer-source">
                      <Database size={13} />
                      <select
                        aria-label="Active data source"
                        value={source}
                        disabled={busy || !workspace}
                        onChange={(e) => selectSource(e.target.value)}
                      >
                        {workspace?.sources.map((s) => (
                          <option key={s.name}>{s.name}</option>
                        ))}
                      </select>
                    </div>
                  </PromptInputTools>
                  <PromptInputSubmit
                    aria-label={busy ? "Investigating" : "Send question"}
                    status={busy ? "submitted" : "ready"}
                    disabled={busy || !draft.trim() || !source}
                  />
                </PromptInputFooter>
              </PromptInput>
              {!entries.length && !busy && !dashboard && (
                <div className="starters">
                  {starters.map((s, i) => (
                    <button
                      key={s.label}
                      disabled={!source}
                      onClick={() => {
                        if (i === 1) setPanel("change");
                        else {
                          setDraft(s.prompt);
                          composer.current?.focus();
                        }
                      }}
                    >
                      <s.icon size={17} />
                      <strong>{s.label}</strong>
                    </button>
                  ))}
                </div>
              )}
              {Boolean(entries.length) && !dashboard && (
                <div className="followups">
                  <button disabled={busy} onClick={() => setPanel("change")}>
                    <SlidersHorizontal size={13} />
                    Investigate a change
                  </button>
                  <button
                    disabled={busy}
                    onClick={() => {
                      setDraft("/profile");
                      composer.current?.focus();
                    }}
                  >
                    Check data quality
                  </button>
                  <button disabled={busy} onClick={() => setPanel("schema")}>
                    <Database size={13} />
                    View schema
                  </button>
                </div>
              )}
              <p className="composer-note">
                {workspace?.model_configured
                  ? "Tool-using agents"
                  : "Starter analysis"}
              </p>
            </div>
          </div>
          <footer className="main-footer">
            <span>
              <span className={`health-dot ${workspace ? "online" : ""}`} />
              {workspace ? "Engine connected" : "Connecting to engine"}
            </span>
          </footer>
        </main>
        <WorkspaceDialogs
          panel={panel}
          close={() => setPanel(null)}
          source={source}
          tables={tables}
          workspace={workspace}
          refresh={refresh}
          selectSource={selectSource}
          onResult={configuredResult}
        />
      </div>
    </TooltipProvider>
  );
}
