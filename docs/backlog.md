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
| 2 | done | Intake Agent (NL → markdown build brief), CLI-driven, chained by hand into the Codegen Agent (feature request #5) |
| 3 | in progress | Wire Intake/Codegen into the Orchestrator (milestone 1 done, feature request #7); accounts, real streaming, delivery still ahead |
| 4 | in progress | Follow-up iteration + live preview — live preview delivered early via the Run Agent (feature #10); follow-up iteration on an already-built project still ahead |
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
| 5 | Intake Agent: turns a free-text product description into a markdown build brief for the Codegen Agent, asking a clarifying question where needed | done | next (Phase 2) | [intake-agent-milestone-1.md](designs/intake-agent-milestone-1.md) |
| 6 | Multi-resource support: Intake Agent can describe an arbitrary number of related resources (not just two), and the Codegen Agent can build all of them plus their associations | done | next (Phase 2 extension) | [multi-resource-support.md](designs/multi-resource-support.md) |
| 7 | Wire the Intake + Codegen Agents into the orchestrator's chat flow: a `/build` chat message triggers Intake then Codegen against the project's workspace, with interim progress + final result posted back in chat. No accounts, real streaming, or delivery yet — later Phase 3 work | done | next (Phase 3, milestone 1) | [wire-agents-into-chat.md](designs/wire-agents-into-chat.md) |
| 8 | Frontend generation: the Codegen Agent builds real Expo/React Native UI (screens wired to the backend API it already generates), not just backend resources. `/build` gains a human review gate (`/proceed`) between the Intake plan and actually building it | building — implementation complete, live verification in progress, see design doc's Verification status | next (Phase 3 extension) | [frontend-generation.md](designs/frontend-generation.md) |
| 9 | Must-pass vs. nice-to-have test tiering for the Codegen Agent's frontend phase — a test failure that's purely an accessibility-query mismatch with a third-party component (not a real functional bug) may be `it.skip()`'d after one real fix attempt, instead of blocking completion indefinitely | done | requested during frontend-generation's live verification | [frontend-generation.md](designs/frontend-generation.md) (amended) |
| 10 | Run/Deploy Agent: a new component whose job is to stand up Docker containers for a generated project's backend + frontend, wire them together (network, env vars, ports), and hand back a live endpoint — plus start/stop control and a persisted record of each project's running instance(s). Once the app is written and buildable, running it and verifying it happen in parallel, not sequentially | done | now, ahead of bug #5 and finishing feature #8's verification (folded bug #5's fix in as a hard prerequisite) | [run-deploy-agent.md](designs/run-deploy-agent.md) |

## Bugs

Bugs follow the same mandatory workflow as feature requests — see the
"Bug workflow" in [`CLAUDE.md`](../CLAUDE.md) — reported here first, then
prioritized, root-caused, design-recorded, and fixed.

Status values: `reported` → `prioritized` → `in design` → `fixing` → `fixed`.

| # | Bug | Status | Priority | Design doc |
|---|-----|--------|----------|------------|
| 1 | Asking the web chat to build/create an app gets a canned refusal ("app generation isn't wired into this tool... I don't want to hand you a fake URL") instead of anything happening | fixed | now, before Phase 2 (small fix) | — (skipped, small fix) |
| 2 | Intake Agent CLI sometimes fails outright with `EmptyIntakeResponseError` and a raw stack trace on a legitimate description, instead of a clean result — model occasionally spends its whole token budget on hidden reasoning with nothing left for visible output, and the one-shot design has no retry | fixed | now (small fix) | — (skipped, small fix) |
| 3 | Backend template's generated `spec/rails_helper.rb` ships with the `spec/support/**/*.rb` require commented out (RSpec's own generator default) — every backend run had to rediscover and debug this from scratch (missing FactoryBot::Syntax::Methods) before it could even start on real work, burning iteration budget on a solved problem | fixed | now, found during frontend-generation live verification (small fix) | — (skipped, small fix) |
| 4 | Codegen Agent's final verification always reported a generic "`<command>` exited N" message for the frontend phase instead of the real pass/fail counts — two compounding causes: Jest colorizes its summary line (`CI=true` alone didn't suppress it, needed `FORCE_COLOR=0`), and separately the summary regex only ever searched `stdout`, but Jest's own summary reporter writes to `stderr` | fixed | now, found during frontend-generation live verification (small fix) | — (skipped, small fix) |
| 5 | Generated frontend template never installs `react-dom`/`react-native-web` — `expo start --web` fails immediately with a missing-dependency error, so the web target (one of the three locked platforms) can't actually be run/verified even though iOS/Android tooling isn't needed to at least boot it | fixed | now, folded into feature #10 as a hard prerequisite | [run-deploy-agent.md](designs/run-deploy-agent.md) |
| 6 | `docker compose up -d` returns once a dependency container *starts*, not once the process inside is ready — the Run Agent's migration step raced MySQL's first-boot initialization and failed with `Can't connect to server on 'mysql' (115)` | fixed | now, found during feature #10's live verification (small fix) | [run-deploy-agent.md](designs/run-deploy-agent.md) |
| 7 | Generated backend's `Gemfile` never included a web server gem (`puma`) — `rails server` failed immediately with "Could not find a server gem," unnoticed until now because verification only ever runs `bundle exec rspec`, never actually boots the server | fixed | now, found during feature #10's live verification (small fix) | [run-deploy-agent.md](designs/run-deploy-agent.md) |
