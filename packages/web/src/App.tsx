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

const NEW_PROJECT_OPTION = "__new__";

function App() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [isCreatingProject, setIsCreatingProject] = useState(false);
  const [newProjectName, setNewProjectName] = useState("");

  const [messagesByProject, setMessagesByProject] = useState<Record<string, Message[]>>({});
  const [input, setInput] = useState("");
  const [isSending, setIsSending] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

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
          Talking directly to the configured GLM endpoint. No app-generation
          logic is wired in yet.
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
