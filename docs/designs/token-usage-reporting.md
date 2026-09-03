# Design: Per-agent LLM token usage reporting

- **Backlog item**: [`docs/backlog.md`](../backlog.md) — # 13
- **Status**: superseded by the Amendment below (feature #14) — the
  chat-message/appended-content delivery described in this original
  section was replaced by a footer status display before ever being
  live-verified or committed. Kept here for the historical record.
- **Original status note**: `withUsageReporting` unit-tested directly
  (`packages/llm-client/test/usageReporting.test.ts`, 3 tests: fires
  `onUsage` with the result's usage, doesn't fire when usage is absent,
  passes the request/result through unchanged); `defaultRunIntakePhase`'s
  usage-line appending unit-tested directly against a fake `LLMClient`
  (`packages/orchestrator/test/app.test.ts`, 2 tests). `defaultRunCodegenPhase`/
  `defaultRunDebugPhase`'s wrapping was not live-verified end-to-end this
  round — the orchestrator's configured GLM endpoint (`api.sarvam.ai`) is
  the known-broken one (see debug-agent.md's Verification status; the
  working OpenRouter config sits commented out in `.env`), and the user
  opted to skip switching it just for this verification. Confidence
  instead comes from: the change to those two functions is a mechanical
  `llmClient` → `wrappedClient` substitution with no other logic touched,
  `withUsageReporting` itself is fully unit-tested, and the full existing
  llm-client/orchestrator/codegen-agent/intake-agent/debug-agent suites
  (133 tests total) still pass unchanged.

## Summary

Post a progress line for every LLM call an agent makes — `"<Agent Name>:
sent X tokens, received Y tokens"` — into the project's chat, so the user
can see token consumption as it happens during `/build`, `/proceed`, and
`/debug`. Implemented generically at the `@app-builder/llm-client` layer
via a decorator, not inside any individual agent, so a future agent gets
this for free just by being handed a wrapped client.

## Feature-set impact

- During `/proceed` (Codegen Agent) and `/debug` (Debug Agent), every LLM
  call posts its own `[build]`/`[debug]`-tagged chat message in the format
  `"Codegen Agent: sent 812 tokens, received 246 tokens"` /
  `"Debug Agent: sent ...`, at the same cadence as the existing narration
  (one per LLM turn).
- During `/build <description>` (Intake Agent), which is a single
  synchronous request/response with no polling, one line per LLM call
  actually made (normally one, occasionally two if the empty-response
  retry fires — see bug #2) is appended to the end of that single reply,
  rather than posted as separate interim messages.
- Debug Agent's backend and frontend passes both report under the label
  `"Debug Agent"` — the split isn't surfaced to the user.
- Run Agent is unaffected — it makes no LLM calls.

## Architecture impact

No new components.

- **`packages/llm-client`** gains one new export: a `withUsageReporting`
  decorator implementing the existing `LLMClient` interface. This is the
  only place token-usage logic lives.
- **`packages/codegen-agent`, `packages/intake-agent`,
  `packages/debug-agent`** — **unchanged**. Each already receives an
  `LLMClient` as a plain dependency and calls `.chat()` on it; none of them
  need to know this feature exists.
- **`packages/orchestrator/src/app.ts`** — the only other file touched.
  Each of the three `defaultRunXPhase` functions wraps the `llmClient` it
  receives, once, with its own hardcoded agent label, before passing the
  wrapped client into the agent call(s) it already makes.

## Components affected

- `packages/llm-client` — new `withUsageReporting(client, onUsage)`
  export (see Design below). [component blueprint](../blueprints/components/llm-client.md)
- `packages/orchestrator` — `defaultRunIntakePhase`, `defaultRunCodegenPhase`,
  `defaultRunDebugPhase` in [`app.ts`](../../packages/orchestrator/src/app.ts)
  each wrap their `llmClient` before use. [component blueprint](../blueprints/components/orchestrator.md)

## Design

**`packages/llm-client/src/usageReporting.ts`** (new file):

```ts
import type { ChatCompletionRequest, ChatCompletionResult, LLMClient, Usage } from "./types.js";

/**
 * Wraps an LLMClient so every chat() call reports its token usage,
 * without the caller needing to inspect ChatCompletionResult.usage
 * itself. Transparent pass-through otherwise — same request in, same
 * result out. Lets any agent (present or future) get usage reporting for
 * free just by being handed a wrapped client, with zero agent-side code.
 */
export function withUsageReporting(client: LLMClient, onUsage: (usage: Usage) => void): LLMClient {
  return {
    async chat(request: ChatCompletionRequest): Promise<ChatCompletionResult> {
      const result = await client.chat(request);
      if (result.usage) onUsage(result.usage);
      return result;
    },
  };
}
```

Exported from `packages/llm-client/src/index.ts` alongside the existing
exports.

**`packages/orchestrator/src/app.ts`** — one wrap per phase, right after
destructuring `llmClient`:

```ts
// defaultRunIntakePhase — no polling channel, so usage lines are folded
// into the single synchronous reply instead of posted as interim messages.
export const defaultRunIntakePhase: RunIntakePhase = async ({ description, llmClient }) => {
  const usageLines: string[] = [];
  const wrappedClient = withUsageReporting(llmClient, (usage) => {
    usageLines.push(`Intake Agent: sent ${usage.promptTokens} tokens, received ${usage.completionTokens} tokens`);
  });
  const result = await runIntake({ llmClient: wrappedClient, systemPrompt: buildIntakeSystemPrompt(), description });
  const content = usageLines.length > 0 ? `${result.content}\n\n${usageLines.join("\n")}` : result.content;
  return { kind: result.kind, content };
};
```

```ts
// defaultRunCodegenPhase — replace both uses of `llmClient` (backend via
// runCodegenAgent, frontend via runCodegenLoop) with `wrappedClient`.
const wrappedClient = withUsageReporting(llmClient, (usage) =>
  onProgress(`Codegen Agent: sent ${usage.promptTokens} tokens, received ${usage.completionTokens} tokens`),
);
```

```ts
// defaultRunDebugPhase — replace the `llmClient` passed into runDebugAgent
// with `wrappedClient`. Both of Debug Agent's internal passes share the
// same client instance, so both report under "Debug Agent".
const wrappedClient = withUsageReporting(llmClient, (usage) =>
  onProgress(`Debug Agent: sent ${usage.promptTokens} tokens, received ${usage.completionTokens} tokens`),
);
```

No changes to `AgentEvent`, `RunOptions`, `RunIntakeOptions`, or any
agent's own source. The existing `forward` functions in
`defaultRunCodegenPhase`/`defaultRunDebugPhase` (which turn
`assistant_message` events into progress messages) are untouched — usage
reporting runs through a separate path (the wrapped client's own
callback), not through `AgentEvent`.

## Out of scope

- Any cumulative/session-level token total or cost estimate — this is
  per-call reporting only.
- Historical/persisted token-usage records (e.g. a table of usage per
  project) — these are transient chat messages like any other progress
  line, not a new data model.
- Applying this to ordinary (non-`/build`/`/debug`) chat messages — those
  already go straight to the model with a plain request/response; adding
  usage reporting there would be a trivial follow-up (wrap `llmClient`
  once at that call site) but isn't requested here.

## Amendment (feature #14): footer status display, not chat messages

- **Status**: implemented
- **Why**: chat-bubble delta lines (above) don't read as continuous
  progress — they're sparse (one per LLM turn, which can be 10s+ apart)
  and don't accumulate visually. The user wants a persistent status
  readout that feels alive: cumulative totals, plus a signal that
  something is happening *between* deltas, not just when one lands.

This **replaces** the chat-message/appended-content delivery described
above with a persistent footer, polled the same way chat messages already
are (reusing feature #12's toggle/interval). Token counts are still only
ever the real numbers from `ChatCompletionResult.usage` — no estimation —
but a non-token "still working" signal now fills the gap between calls.

### Feature-set impact

- Token usage no longer appears as chat bubbles or appended reply text.
  Instead, a status line lives in the footer near the message input,
  visible whenever `/build`, `/proceed`, or `/debug` is active for the
  selected project:
  - Idle between calls: `"Codegen Agent — sent 4,820 / received 1,140
    tokens"` (cumulative totals so far in the current phase).
  - Mid-call: `"Codegen Agent — sent 4,820 / received 1,140 tokens ·
    working... 14s"` — an elapsed-time heartbeat, no fabricated numbers.
  - Updates on the same poll tick as chat messages; pausing polling
    (feature #12) also freezes the footer.
  - Hidden when nothing has run yet for the selected project.
- Totals are **per phase invocation**, not cumulative across a whole
  `/build`: Intake, Codegen, and Debug each start their own count from
  zero when they begin. Intake's call is fast enough that its footer blip
  may be easy to miss in practice — accepted, not a bug.
- Debug Agent's backend and frontend passes still share one running total
  under the label `"Debug Agent"`.
- Chat messages return to being pure narration — no usage lines mixed in.

### Architecture impact

- **`packages/llm-client`**: `withUsageReporting`'s second parameter
  becomes a hooks object, `{ onCallStart?, onUsage }`, instead of a bare
  `onUsage` function — `onCallStart` fires synchronously before
  delegating to the wrapped client's `chat()`, letting a caller record
  when a call began (needed for the elapsed-time heartbeat). Still the
  only place token-usage/call-timing logic lives; still zero changes to
  any agent package.
- **`packages/orchestrator`**: a new in-memory `progressByProject: Map<string,
  ProgressSnapshot>` in `createApp`'s closure (same lifetime/pattern as
  the existing `buildingProjects` Set) replaces the old
  chat-message/content-append formatting. `RunIntakePhase`, `RunCodegenPhase`,
  and `RunDebugPhase` each gain two new params, `onCallStart: () => void`
  and `onUsage: (usage: Usage) => void`, supplied by the route handler
  (closing over `projectId` and `progressByProject`) the same way
  `onProgress`/`onRunOutcome` already are. New endpoint:
  `GET /api/projects/:id/progress` → `{ progress: ProgressSnapshot | null }`.
- **`packages/web`**: the existing polling `useEffect` (feature #12) also
  fetches `/api/projects/:id/progress` each tick; a new footer UI element
  renders it. The token-usage chat-message rendering from #13 is removed
  (nothing to remove client-side — it was just plain chat text).

### Design

**`packages/llm-client/src/usageReporting.ts`** (revised):

```ts
export interface UsageReportingHooks {
  /** Fires synchronously before delegating to the wrapped client's chat(). */
  onCallStart?: () => void;
  onUsage: (usage: Usage) => void;
}

export function withUsageReporting(client: LLMClient, hooks: UsageReportingHooks): LLMClient {
  return {
    async chat(request: ChatCompletionRequest): Promise<ChatCompletionResult> {
      hooks.onCallStart?.();
      const result = await client.chat(request);
      if (result.usage) hooks.onUsage(result.usage);
      return result;
    },
  };
}
```

**`packages/orchestrator/src/app.ts`**:

```ts
export interface ProgressSnapshot {
  agentLabel: string;
  totalSentTokens: number;
  totalReceivedTokens: number;
  /** epoch ms; null once the in-flight call's usage has been recorded (or before the first call). */
  callStartedAt: number | null;
}
```

`RunIntakePhase`/`RunCodegenPhase`/`RunDebugPhase` each gain:

```ts
onCallStart: () => void;
onUsage: (usage: Usage) => void;
```

Inside each `defaultRunXPhase`, replace the old `withUsageReporting(llmClient, (usage) => ...)`
call with:

```ts
const wrappedClient = withUsageReporting(llmClient, { onCallStart, onUsage });
```

(`defaultRunIntakePhase` drops its `usageLines`/content-append logic
entirely — `result.content` is returned unchanged.)

In `createApp`, alongside `buildingProjects`/`pendingSpecs`/`runningOps`:

```ts
const progressByProject = new Map<string, ProgressSnapshot>();

function resetProgress(projectId: string, agentLabel: string) {
  progressByProject.set(projectId, {
    agentLabel,
    totalSentTokens: 0,
    totalReceivedTokens: 0,
    callStartedAt: null,
  });
}

function markCallStarted(projectId: string) {
  const prev = progressByProject.get(projectId);
  if (prev) progressByProject.set(projectId, { ...prev, callStartedAt: Date.now() });
}

function recordUsage(projectId: string, usage: Usage) {
  const prev = progressByProject.get(projectId);
  if (!prev) return;
  progressByProject.set(projectId, {
    ...prev,
    totalSentTokens: prev.totalSentTokens + usage.promptTokens,
    totalReceivedTokens: prev.totalReceivedTokens + usage.completionTokens,
    callStartedAt: null,
  });
}
```

Each route handler calls `resetProgress(projectId, "<Agent Name>")` right
where it currently does `buildingProjects.add(projectId)` (or, for
`/build`'s Intake step, right before calling `runIntakePhase`), then wires
`onCallStart: () => markCallStarted(projectId)` and
`onUsage: (usage) => recordUsage(projectId, usage)` into the phase call.

New endpoint, alongside `/api/projects/:id/messages`:

```ts
app.get("/api/projects/:id/progress", async (req, res) => {
  const project = await projectStore.get(req.params.id);
  if (!project) {
    res.status(404).json({ error: { code: "not_found", message: "project not found" } });
    return;
  }
  res.json({ progress: progressByProject.get(req.params.id) ?? null });
});
```

**`packages/web/src/App.tsx`**:

- New state: `progressByProject: Record<string, ProgressSnapshot | null>`.
- The existing polling `useEffect` (gated on `selectedProjectId &&
  buildingProjects[selectedProjectId] && pollingEnabled`) also fetches
  `/api/projects/:id/progress` each tick and updates this state — same
  `setInterval`, one more `fetch` alongside the existing one.
- A new footer element, rendered when `progressByProject[selectedProjectId]`
  is non-null:
  ```
  Codegen Agent — sent 4,820 / received 1,140 tokens · working... 14s
  ```
  Elapsed seconds is computed at render/poll time as
  `Math.floor((Date.now() - progress.callStartedAt) / 1000)` — recomputed
  only on each poll tick (no separate 1s ticker), consistent with "updates
  on every poll."

### Verification (2026-09-03)

Live-verified against the real orchestrator (GLM endpoint happened to be
reachable this session) — no mocks, real Docker, real chat/build flow:

- `GET /api/projects/:id/progress` on a fresh project: `{ progress: null }`;
  on an unknown project: `404`.
- A real `/build` (Intake Agent) call: progress correctly showed
  `{ agentLabel: "Intake Agent", totalSentTokens: 854, totalReceivedTokens: 590, callStartedAt: null }`
  immediately after the reply landed.
- A real `/proceed` (Codegen Agent): progress reset to zero under the new
  label, then accumulated for real across iterations
  (`totalSentTokens: 16266` after several backend-exploration turns);
  polled again mid-iteration and caught a genuine non-null `callStartedAt`
  (an epoch timestamp), confirming the heartbeat reflects a real in-flight
  call, not a fabricated one.
- In the actual web UI (not just curl): created a project, sent `/build`
  then `/proceed` through the real input box, and watched the footer
  render live: `"Codegen Agent — sent 15,190 / received 170 tokens ·
  working... 1s"`, right-aligned below the message input, exactly as
  designed.
- One real edge case observed: a transient GLM network error mid-call
  (`fetch failed`) surfaced as `[build:failed]` in chat, and left
  `callStartedAt` frozen at its last value (since `onCallStart` fired but
  `onUsage` never did) rather than clearing — accepted as correct, honest
  behavior per the "no clearing beyond next-phase reset" design choice;
  the footer just shows a stale-but-true elapsed time until the next
  phase starts and calls `resetProgress`.
- Continuous multi-tick footer updates (elapsed seconds ticking across
  several poll cycles in the same browser tab) were not observed directly
  — the tool's own browser pane went into a backgrounded/hidden state
  mid-observation (confirmed via `document.hidden`), which throttles the
  same polling `setInterval` this shares with feature #12's message
  polling. Not a code path specific to this feature.

### Out of scope (amendment)

- A separate client-side ticking timer for smoother (sub-poll-interval)
  elapsed-time display — the elapsed number updates once per poll tick,
  matching the existing polling cadence exactly.
- Persisting `progressByProject` across an orchestrator restart — it's
  ephemeral, same as `buildingProjects`.
- Real token streaming (SSE) for genuinely live received-token counts
  during a single call — considered and explicitly declined in favor of
  this lighter approach.
