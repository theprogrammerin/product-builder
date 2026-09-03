import { useEffect, useRef, useState, type FormEvent } from "react";

type ProjectStage =
  | "ideation"
  | "product_requirements"
  | "ux"
  | "design"
  | "development"
  | "production";

const STAGE_LABELS: Record<ProjectStage, string> = {
  ideation: "Ideation",
  product_requirements: "Product Requirements",
  ux: "UX",
  design: "Design",
  development: "Development",
  production: "Production",
};

const STAGE_ORDER = Object.keys(STAGE_LABELS) as ProjectStage[];

interface Project {
  id: string;
  name: string;
  stage: ProjectStage;
  createdAt: string;
}

interface Message {
  role: "user" | "assistant" | "error";
  content: string;
}

interface ServerMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
}

interface ProgressSnapshot {
  agentLabel: string;
  totalSentTokens: number;
  totalReceivedTokens: number;
  callStartedAt: number | null;
}

const NEW_PROJECT_OPTION = "__new__";
const SELECTED_PROJECT_STORAGE_KEY = "app-builder:selectedProjectId";
const POLLING_ENABLED_STORAGE_KEY = "app-builder:pollingEnabled";
const POLL_INTERVAL_STORAGE_KEY = "app-builder:pollIntervalMs";
const POLL_INTERVAL_OPTIONS_MS = [2000, 4000, 10000, 30000];
const DEFAULT_POLL_INTERVAL_MS = 4000;
const BUILD_TERMINAL_PATTERN = /^\[build:(done|failed|question|review)\]/;
const BUILD_PROGRESS_PATTERN = /^\[build\]/;
// The Run Agent's outcome is independent of the build's — see
// docs/designs/run-deploy-agent.md — so it can arrive before, after, or
// interleaved with [build:done]/[build:failed]. [run:pending] means one
// is definitely coming; polling can't stop on a [build:...] tag alone
// until that one has landed too (or never fired at all, e.g. the backend
// failed before ever reaching the frontend/run fork).
const RUN_PENDING_PATTERN = /^\[run\] Starting your app/;
const RUN_TERMINAL_PATTERN = /^\[run:(live|failed)\]/;
const DEBUG_PROGRESS_PATTERN = /^\[debug\]/;
const DEBUG_TERMINAL_PATTERN = /^\[debug:(done|failed)\]/;

function formatProgress(progress: ProgressSnapshot): string {
  const totals = `${progress.agentLabel} — sent ${progress.totalSentTokens.toLocaleString()} / received ${progress.totalReceivedTokens.toLocaleString()} tokens`;
  if (progress.callStartedAt === null) return totals;
  const elapsedSeconds = Math.max(0, Math.floor((Date.now() - progress.callStartedAt) / 1000));
  return `${totals} · working... ${elapsedSeconds}s`;
}

// A project's history can span multiple /build, /proceed, and /debug
// rounds over its lifetime — so "pending" must be judged from each
// track's MOST RECENT tag, not from whether a terminal tag has ever
// appeared anywhere in history. Scanning from the end and stopping at the
// first relevant tag (progress or terminal) for a track correctly ignores
// an older, already-resolved round. See bug #11: the original whole-
// history `.some()` check meant any earlier terminal tag (e.g. a prior
// /build's [build:review]) permanently poisoned detection for every
// later round in the same project, typically stopping polling on the
// very first tick after the next /proceed or /debug — reload or not.
function isPendingByLastTag(messages: Message[], progressPattern: RegExp, terminalPattern: RegExp): boolean {
  for (let i = messages.length - 1; i >= 0; i--) {
    const content = messages[i].content;
    if (terminalPattern.test(content)) return false;
    if (progressPattern.test(content)) return true;
  }
  return false;
}

// Shared by the poll tick, the initial history load, and the Auto-refresh
// toggle — a project has work in flight if any track's most recent tag is
// a progress tag rather than a terminal one. See bug #11: buildingProjects
// is otherwise only ever set from a live /build|/proceed|/debug response,
// so nothing previously re-derived it from persisted history after a
// reload.
function hasPendingWork(messages: Message[]): boolean {
  return (
    isPendingByLastTag(messages, BUILD_PROGRESS_PATTERN, BUILD_TERMINAL_PATTERN) ||
    isPendingByLastTag(messages, RUN_PENDING_PATTERN, RUN_TERMINAL_PATTERN) ||
    isPendingByLastTag(messages, DEBUG_PROGRESS_PATTERN, DEBUG_TERMINAL_PATTERN)
  );
}

function toDisplayMessages(serverMessages: ServerMessage[]): Message[] {
  return serverMessages
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => ({ role: m.role as "user" | "assistant", content: m.content ?? "" }));
}

function App() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [isCreatingProject, setIsCreatingProject] = useState(false);
  const [newProjectName, setNewProjectName] = useState("");

  const [messagesByProject, setMessagesByProject] = useState<Record<string, Message[]>>({});
  const [loadedHistoryFor, setLoadedHistoryFor] = useState<Set<string>>(new Set());
  const [input, setInput] = useState("");
  const [isSending, setIsSending] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [buildingProjects, setBuildingProjects] = useState<Record<string, boolean>>({});
  const [progressByProject, setProgressByProject] = useState<Record<string, ProgressSnapshot | null>>({});
  const [pollingEnabled, setPollingEnabled] = useState<boolean>(() => {
    try {
      const stored = localStorage.getItem(POLLING_ENABLED_STORAGE_KEY);
      return stored === null ? true : stored === "true";
    } catch {
      return true;
    }
  });
  const [pollIntervalMs, setPollIntervalMs] = useState<number>(() => {
    try {
      const stored = Number(localStorage.getItem(POLL_INTERVAL_STORAGE_KEY));
      return POLL_INTERVAL_OPTIONS_MS.includes(stored) ? stored : DEFAULT_POLL_INTERVAL_MS;
    } catch {
      return DEFAULT_POLL_INTERVAL_MS;
    }
  });
  const chatLogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    try {
      localStorage.setItem(POLLING_ENABLED_STORAGE_KEY, String(pollingEnabled));
    } catch {
      // localStorage can throw (private browsing, disabled storage) — the
      // toggle itself still works for the current session either way.
    }
  }, [pollingEnabled]);

  useEffect(() => {
    try {
      localStorage.setItem(POLL_INTERVAL_STORAGE_KEY, String(pollIntervalMs));
    } catch {
      // see above
    }
  }, [pollIntervalMs]);

  useEffect(() => {
    if (!selectedProjectId) return;
    try {
      localStorage.setItem(SELECTED_PROJECT_STORAGE_KEY, selectedProjectId);
    } catch {
      // see above
    }
  }, [selectedProjectId]);

  useEffect(() => {
    fetch("/api/projects")
      .then((res) => res.json())
      .then((body: { projects: Project[] }) => {
        setProjects(body.projects);
        if (body.projects.length === 0) return;

        let lastSelectedId: string | null = null;
        try {
          lastSelectedId = localStorage.getItem(SELECTED_PROJECT_STORAGE_KEY);
        } catch {
          // localStorage can throw — falls back to the first project below.
        }
        const stillExists = lastSelectedId && body.projects.some((p) => p.id === lastSelectedId);
        setSelectedProjectId(stillExists ? lastSelectedId! : body.projects[0].id);
      })
      .catch((error) => {
        setLoadError(error instanceof Error ? error.message : "Failed to load projects");
      });
  }, []);

  // Load a project's persisted history the first time it's selected —
  // messages sent afterward are tracked locally via appendMessage, since
  // they're already reflected in what was just sent/received.
  useEffect(() => {
    if (!selectedProjectId || loadedHistoryFor.has(selectedProjectId)) return;
    const projectId = selectedProjectId;

    fetch(`/api/projects/${projectId}/messages`)
      .then((res) => res.json())
      .then((body: { messages: ServerMessage[] }) => {
        const fresh = toDisplayMessages(body.messages);
        setMessagesByProject((prev) => ({ ...prev, [projectId]: fresh }));
        setLoadedHistoryFor((prev) => new Set(prev).add(projectId));
        // Resumes polling after a reload (or first-ever load) if the
        // persisted history shows work still in flight — see bug #11.
        if (hasPendingWork(fresh)) {
          setBuildingProjects((prev) => ({ ...prev, [projectId]: true }));
        }
      })
      .catch((error) => {
        setLoadError(error instanceof Error ? error.message : "Failed to load chat history");
      });
  }, [selectedProjectId, loadedHistoryFor]);

  // While a /build, /proceed, or /run is running for the currently
  // selected project, poll for the interim/result messages it posts —
  // there's no live streaming yet (see docs/designs/wire-agents-into-chat.md),
  // just plain polling scoped to whichever project is on screen. The
  // Run Agent's outcome is independent of the build's (see
  // docs/designs/run-deploy-agent.md) — [run:live]/[run:failed] can land
  // before, after, or interleaved with [build:done]/[build:failed] — so
  // this can't stop on the first terminal tag it sees; it waits for every
  // outcome that was actually announced (a [run] "Starting your app..."
  // message means a [run:live]/[run:failed] is still owed).
  useEffect(() => {
    if (!selectedProjectId || !buildingProjects[selectedProjectId] || !pollingEnabled) return;
    const projectId = selectedProjectId;

    const interval = setInterval(() => {
      fetch(`/api/projects/${projectId}/messages`)
        .then((res) => res.json())
        .then((body: { messages: ServerMessage[] }) => {
          const fresh = toDisplayMessages(body.messages);
          const knownCount = messagesByProject[projectId]?.length ?? 0;
          const newOnes = fresh.slice(knownCount);
          if (newOnes.length === 0) return;

          setMessagesByProject((prev) => ({ ...prev, [projectId]: fresh }));

          if (!hasPendingWork(fresh)) {
            setBuildingProjects((prev) => ({ ...prev, [projectId]: false }));
          }
        })
        .catch((error) => {
          setLoadError(error instanceof Error ? error.message : "Failed to poll build progress");
        });

      fetch(`/api/projects/${projectId}/progress`)
        .then((res) => res.json())
        .then((body: { progress: ProgressSnapshot | null }) => {
          setProgressByProject((prev) => ({ ...prev, [projectId]: body.progress }));
        })
        .catch(() => {
          // Non-critical — the footer just won't update this tick.
        });
    }, pollIntervalMs);

    return () => clearInterval(interval);
  }, [selectedProjectId, buildingProjects, messagesByProject, pollingEnabled, pollIntervalMs]);

  const selectedProject = projects.find((p) => p.id === selectedProjectId) ?? null;
  const messages = selectedProjectId ? (messagesByProject[selectedProjectId] ?? []) : [];
  const selectedProgress = selectedProjectId ? (progressByProject[selectedProjectId] ?? null) : null;

  // Keep the chat log scrolled to the latest message whenever the visible
  // message list changes (new send, poll tick, or switching projects).
  useEffect(() => {
    const node = chatLogRef.current;
    if (!node) return;
    node.scrollTop = node.scrollHeight;
  }, [messages, isSending]);

  function appendMessage(projectId: string, message: Message) {
    setMessagesByProject((prev) => ({
      ...prev,
      [projectId]: [...(prev[projectId] ?? []), message],
    }));
  }

  // Flipping Auto-refresh on doesn't just toggle the flag — it re-checks
  // the current project's real state so polling actually resumes right
  // away if there's work in flight, rather than waiting on the next
  // message send or page reload to notice. See bug #11.
  function handlePollingToggle(enabled: boolean) {
    setPollingEnabled(enabled);
    if (!enabled || !selectedProjectId) return;
    const projectId = selectedProjectId;

    fetch(`/api/projects/${projectId}/messages`)
      .then((res) => res.json())
      .then((body: { messages: ServerMessage[] }) => {
        const fresh = toDisplayMessages(body.messages);
        setMessagesByProject((prev) => ({ ...prev, [projectId]: fresh }));
        setBuildingProjects((prev) => ({ ...prev, [projectId]: hasPendingWork(fresh) }));
      })
      .catch((error) => {
        setLoadError(error instanceof Error ? error.message : "Failed to check build progress");
      });
  }

  function handleProjectSelect(value: string) {
    if (value === NEW_PROJECT_OPTION) {
      setIsCreatingProject(true);
      return;
    }
    setIsCreatingProject(false);
    setSelectedProjectId(value);
  }

  async function handleCreateProject(event: FormEvent) {
    event.preventDefault();
    const name = newProjectName.trim();
    if (!name) return;

    try {
      const response = await fetch("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body?.error?.message ?? "Failed to create project");

      const project = body.project as Project;
      setProjects((prev) => [...prev, project]);
      setMessagesByProject((prev) => ({ ...prev, [project.id]: [] }));
      setLoadedHistoryFor((prev) => new Set(prev).add(project.id));
      setSelectedProjectId(project.id);
      setIsCreatingProject(false);
      setNewProjectName("");
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "Failed to create project");
    }
  }

  async function handleStageChange(stage: ProjectStage) {
    if (!selectedProject) return;
    try {
      const response = await fetch(`/api/projects/${selectedProject.id}/stage`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ stage }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body?.error?.message ?? "Failed to update stage");

      const updated = body.project as Project;
      setProjects((prev) => prev.map((p) => (p.id === updated.id ? updated : p)));
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "Failed to update stage");
    }
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const message = input.trim();
    if (!message || isSending || !selectedProjectId) return;

    appendMessage(selectedProjectId, { role: "user", content: message });
    setInput("");
    setIsSending(true);

    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId: selectedProjectId, message }),
      });
      const body = await response.json();

      if (!response.ok || "error" in body) {
        const errorMessage = "error" in body ? body.error.message : "Request failed";
        appendMessage(selectedProjectId, { role: "error", content: errorMessage });
        return;
      }

      appendMessage(selectedProjectId, {
        role: "assistant",
        content: body.reply ?? "(empty response)",
      });

      // Keyed off the reply's own tag, not which command was typed — works
      // for /proceed, standalone /run, and /debug without special-casing
      // any of them. A [build:review] reply means nothing is running yet,
      // so it correctly does NOT start polling.
      if (
        BUILD_PROGRESS_PATTERN.test(body.reply ?? "") ||
        RUN_PENDING_PATTERN.test(body.reply ?? "") ||
        DEBUG_PROGRESS_PATTERN.test(body.reply ?? "")
      ) {
        setBuildingProjects((prev) => ({ ...prev, [selectedProjectId]: true }));
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Network error";
      appendMessage(selectedProjectId, { role: "error", content: message });
    } finally {
      setIsSending(false);
    }
  }

  return (
    <div className="chat-page">
      <header className="chat-header">
        <h1>App Builder — Chat</h1>
        <p className="chat-subtitle">
          Chat normally, or send <code>/build &lt;description&gt;</code> to
          propose a plan — reply <code>/proceed</code> to actually build it.
          Once it's written, your app starts running automatically;
          <code>/run</code> reports the live URLs and <code>/stop</code>{" "}
          shuts it down. If something's wrong,{" "}
          <code>/debug &lt;description&gt;</code> investigates and fixes it
          (or run it with no description for a general health check).
        </p>

        <div className="project-bar">
          <select
            className="project-select"
            value={isCreatingProject ? NEW_PROJECT_OPTION : (selectedProjectId ?? "")}
            onChange={(event) => handleProjectSelect(event.target.value)}
          >
            {projects.length === 0 && <option value="">No projects yet</option>}
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
            <option value={NEW_PROJECT_OPTION}>+ New project…</option>
          </select>

          {selectedProject && !isCreatingProject && (
            <select
              className="stage-select"
              value={selectedProject.stage}
              onChange={(event) => handleStageChange(event.target.value as ProjectStage)}
            >
              {STAGE_ORDER.map((stage) => (
                <option key={stage} value={stage}>
                  {STAGE_LABELS[stage]}
                </option>
              ))}
            </select>
          )}
        </div>

        {isCreatingProject && (
          <form className="new-project-form" onSubmit={handleCreateProject}>
            <input
              type="text"
              value={newProjectName}
              onChange={(event) => setNewProjectName(event.target.value)}
              placeholder="New project name"
              autoFocus
            />
            <button type="submit" disabled={!newProjectName.trim()}>
              Create
            </button>
            <button type="button" onClick={() => setIsCreatingProject(false)}>
              Cancel
            </button>
          </form>
        )}

        {loadError && <p className="chat-error-banner">{loadError}</p>}

        <div className="polling-bar">
          <label>
            <input
              type="checkbox"
              checked={pollingEnabled}
              onChange={(event) => handlePollingToggle(event.target.checked)}
            />
            Auto-refresh
          </label>
          {pollingEnabled && (
            <select
              className="poll-interval-select"
              value={pollIntervalMs}
              onChange={(event) => setPollIntervalMs(Number(event.target.value))}
            >
              {POLL_INTERVAL_OPTIONS_MS.map((ms) => (
                <option key={ms} value={ms}>
                  Every {ms / 1000}s
                </option>
              ))}
            </select>
          )}
        </div>
      </header>

      <div className="chat-log" ref={chatLogRef}>
        {!selectedProjectId && (
          <p className="chat-empty">Select or create a project to start chatting.</p>
        )}
        {selectedProjectId && messages.length === 0 && (
          <p className="chat-empty">Say something to get started.</p>
        )}
        {messages.map((message, index) => (
          <div key={index} className={`chat-message chat-message--${message.role}`}>
            <span className="chat-message__role">
              {message.role === "user"
                ? "You"
                : message.role === "assistant"
                  ? "Assistant"
                  : "Error"}
            </span>
            <p>{message.content}</p>
          </div>
        ))}
        {isSending && <div className="chat-message chat-message--assistant">…</div>}
      </div>

      <form className="chat-input" onSubmit={handleSubmit}>
        <input
          type="text"
          value={input}
          onChange={(event) => setInput(event.target.value)}
          placeholder={selectedProjectId ? "Type a message" : "Select a project first"}
          disabled={isSending || !selectedProjectId}
          autoFocus
        />
        <button type="submit" disabled={isSending || !input.trim() || !selectedProjectId}>
          Send
        </button>
      </form>

      {selectedProgress && <div className="progress-footer">{formatProgress(selectedProgress)}</div>}
    </div>
  );
}

export default App;
