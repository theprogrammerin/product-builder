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
| 1 | not started | Codegen Agent (CLI-driven) — proves feature-complete generation on the locked stack |
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
