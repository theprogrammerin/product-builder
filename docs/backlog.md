# Backlog

The phased roadmap this project follows, plus the intake queue for new
feature requests — kept separate from the
[architecture blueprint](./blueprints/architecture.md) since this is a
living plan, not a description of the system as it stands. For what's
actually built today, see [`blueprints/features.md`](./blueprints/features.md);
for what shipped when, see [`CHANGELOG.md`](../CHANGELOG.md).

## Phased roadmap

| Phase | Status | Scope |
|-------|--------|-------|
| 0 | done | Stack & Guidelines Spec + `LLMClient` |
| 0.5 | done | Orchestrator + Web chat UI (direct GLM passthrough), project tracking |
| 0.75 | done | Project scaffolding — static template copy on project creation (feature request #1) |
| 1 | done | Codegen Agent (CLI-driven) — minimal single-resource pilot first, Docker-based execution (feature request #2) |
| 2 | not started | Intake Agent (NL → structured build spec) |
| 3 | not started | Wire Intake/Codegen into the Orchestrator; accounts, persistence, streaming, delivery |
| 4 | not started | Follow-up iteration + live preview |
| deferred | — | Cloud IaC (Terraform/CDK) for AWS/GCP |

## Feature requests

Every new feature request lands here first, in status `proposed`, and
moves through the stages below in order. See the mandatory workflow in
[`CLAUDE.md`](../CLAUDE.md) for what each status transition requires.

Status values: `proposed` → `prioritized` → `in design` → `building` → `done`.

| # | Feature | Status | Priority | Design doc |
|---|---------|--------|----------|------------|
| 1 | Project scaffolding: every new project gets the same starting structure (locked stack), via a static template copy — no LLM involved | done | before Phase 1 | [project-scaffolding.md](designs/project-scaffolding.md) |
| 2 | Codegen Agent: sandboxed LLM tool-calling loop that writes and runs code against a scaffolded project until it works. First milestone: one CRUD resource, Docker-based execution, no auth/Mongo/Sidekiq yet | done | next (Phase 1) | [codegen-agent-milestone-1.md](designs/codegen-agent-milestone-1.md) |
| 3 | Show the GLM chat conversation in the web UI's chat history persistently — likely needs chat history moved from in-memory to a real database | done | now (ahead of finishing Phase 1) | [chat-history-persistence.md](designs/chat-history-persistence.md) |
| 4 | Codegen Agent tools: recursive file listing + grep-style content search, to cut down exploration iterations in the agentic coding loop | done | fold into Phase 1 | [codegen-agent-milestone-1.md](designs/codegen-agent-milestone-1.md) (amended) |
