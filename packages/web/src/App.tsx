import { useEffect, useState, type FormEvent } from "react";

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

const NEW_PROJECT_OPTION = "__new__";
const BUILD_POLL_INTERVAL_MS = 4000;
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

  useEffect(() => {
    fetch("/api/projects")
      .then((res) => res.json())
      .then((body: { projects: Project[] }) => {
        setProjects(body.projects);
        if (body.projects.length > 0) setSelectedProjectId(body.projects[0].id);
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
        setMessagesByProject((prev) => ({ ...prev, [projectId]: toDisplayMessages(body.messages) }));
        setLoadedHistoryFor((prev) => new Set(prev).add(projectId));
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
    if (!selectedProjectId || !buildingProjects[selectedProjectId]) return;
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

          const buildPending =
            fresh.some((m) => BUILD_PROGRESS_PATTERN.test(m.content)) &&
            !fresh.some((m) => BUILD_TERMINAL_PATTERN.test(m.content));
          const runPending =
            fresh.some((m) => RUN_PENDING_PATTERN.test(m.content)) &&
            !fresh.some((m) => RUN_TERMINAL_PATTERN.test(m.content));
          const debugPending =
            fresh.some((m) => DEBUG_PROGRESS_PATTERN.test(m.content)) &&
            !fresh.some((m) => DEBUG_TERMINAL_PATTERN.test(m.content));

          if (!buildPending && !runPending && !debugPending) {
            setBuildingProjects((prev) => ({ ...prev, [projectId]: false }));
          }
        })
        .catch((error) => {
          setLoadError(error instanceof Error ? error.message : "Failed to poll build progress");
        });
    }, BUILD_POLL_INTERVAL_MS);

    return () => clearInterval(interval);
  }, [selectedProjectId, buildingProjects, messagesByProject]);

  const selectedProject = projects.find((p) => p.id === selectedProjectId) ?? null;
  const messages = selectedProjectId ? (messagesByProject[selectedProjectId] ?? []) : [];

  function appendMessage(projectId: string, message: Message) {
    setMessagesByProject((prev) => ({
      ...prev,
      [projectId]: [...(prev[projectId] ?? []), message],
    }));
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
      </header>

      <div className="chat-log">
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
    </div>
  );
}

export default App;
