# Design: Fix empty-turn token starvation + surface any that still happen

- **Backlog item**: [`docs/backlog.md`](../backlog.md) — Bug # 15
- **Status**: implemented — unit-tested (`codegen-agent` fires
  `empty_turn` with the real `finishReason`; `orchestrator`'s
  `formatEmptyTurn` covers both the `"length"` and generic cases) and
  live-verified: a fresh `/proceed` run with the raised `maxTokens`
  completed its exploration phase with real tool-call activity and no
  empty turns observed in that run.

## Summary

`runCodegenLoop`'s "empty turn" case — a model turn with neither text
content nor a tool call — fires only an `assistant_message` event with
`content: null`, which the orchestrator's `forward()` correctly has
nothing to relay for. The loop silently nudges the model and retries:
real tokens spent (visible in the token-usage footer), zero visible
signal in chat. This makes a genuinely still-working `/proceed`/`/debug`
run indistinguishable from a stuck one — exactly what bug #14 already
fixed for the *tool-call* case, but not for this distinct code path (no
tool call happened at all).

Root-caused, not just papered over: `codegen-agent`'s completion budget
(`DEFAULT_MAX_TOKENS = 4096`) is half of `intake-agent`'s (`8192`),
despite both going through the same model, and `intake-agent`'s ceiling
was already raised once for exactly this failure mode (see bug #2 —
"this model spends tokens on hidden reasoning before visible output...
observed completion-token usage varies widely (500-2600 tokens) purely
from this model's hidden reasoning"). A codegen/debug turn is typically
*more* demanding than Intake's one-shot brief: a `write_file` tool call
carries a full file's content as an argument, competing with any
reasoning tokens for the same budget. An empty turn (no content, no tool
call) is the classic signature of hitting that ceiling mid-generation.
This can't be proven retroactively for turns that already happened (no
per-call `finishReason` was logged), but the mechanism is the same one
already fixed once in this codebase for this model — worth fixing at the
source rather than guessing further. The visibility fix is kept as a
safety net for whenever a turn still comes back empty despite the higher
ceiling, now including the turn's actual `finishReason` so a future
occurrence is diagnosable instead of guessed at.

## Feature-set impact

- Fewer empty turns in the first place: `codegen-agent`'s (and therefore
  `debug-agent`'s, which reuses its loop directly) completion budget per
  turn is raised to match `intake-agent`'s.
- When a turn still comes back empty, `/proceed` and `/debug` post a
  short line to chat — `"→ empty turn — ran out of token budget, nudging
  model to continue"` when the model's own `finishReason` was `"length"`,
  or `"→ empty turn (finishReason: <reason>) — nudging model to
  continue"` otherwise — using the same compact, non-bubble rendering
  already applied to tool-call summaries (bug #16). No other visible
  change: this doesn't alter when/whether the loop gives up (the
  existing iteration cap and convergence logic are untouched).

## Architecture impact

No new components. `codegen-agent/src/agent.ts`'s `DEFAULT_MAX_TOKENS`
constant changes value. `AgentEvent` gains one new variant, carrying the
turn's `finishReason`, fired from the loop's existing empty-turn branch.
`packages/orchestrator/src/app.ts`'s two `forward()` functions (used by
`defaultRunCodegenPhase` and `defaultRunDebugPhase`) each gain one more
branch, following the exact same shape as the `tool_call` branch bug #14
added.

## Components affected

- `packages/codegen-agent` — [`src/agent.ts`](../../packages/codegen-agent/src/agent.ts):
  `DEFAULT_MAX_TOKENS` raised from 4096 to 8192; new `AgentEvent`
  variant, fired once per empty turn with the turn's `finishReason`.
  [component blueprint](../blueprints/components/codegen-agent.md)
- `packages/orchestrator` — [`src/app.ts`](../../packages/orchestrator/src/app.ts):
  both `forward()` functions handle the new event.
  [component blueprint](../blueprints/components/orchestrator.md)
- `packages/debug-agent` — no code change; it reuses `runCodegenLoop`
  directly, so it gets this for free the same way it already gets
  `tool_call` relaying for free. [component blueprint](../blueprints/components/debug-agent.md)

## Design

**`packages/codegen-agent/src/agent.ts`**:

```ts
// Matches intake-agent's ceiling — same model, same "spends tokens on
// hidden reasoning before visible output" behavior (see bug #2), and a
// codegen/debug turn is typically more demanding per turn than Intake's
// one-shot brief (a write_file tool call carries a full file's content
// as an argument, competing with any reasoning tokens for this same
// budget). See docs/backlog.md bug #15.
const DEFAULT_MAX_TOKENS = 8192;
```

Extend `AgentEvent`:

```ts
export type AgentEvent =
  | { type: "assistant_message"; content: string | null }
  | { type: "tool_call"; name: string; args: unknown }
  | { type: "tool_result"; name: string; result: string }
  | { type: "empty_turn"; finishReason: FinishReason };
```

Fire it in the existing branch, right before the nudge is pushed:

```ts
if (!hasToolCalls && !hasContent) {
  // Empty turn — the model neither acted nor said anything meaningful.
  // Don't treat this as "done"; nudge it and keep going. Still fire an
  // event (with the real finishReason, for diagnosability) so the
  // caller isn't left with total silence — see bug #15.
  onEvent?.({ type: "empty_turn", finishReason: result.finishReason });
  messages.push({ role: "user", content: EMPTY_RESPONSE_NUDGE });
  continue;
}
```

(`FinishReason` is already exported from `@app-builder/llm-client` and
already imported in this file for `ChatMessage`/`LLMClient`/etc.)

**`packages/orchestrator/src/app.ts`** — both `forward()` functions gain:

```ts
if (event.type === "empty_turn") {
  onProgress(
    event.finishReason === "length"
      ? "→ empty turn — ran out of token budget, nudging model to continue"
      : `→ empty turn (finishReason: ${event.finishReason}) — nudging model to continue`,
  );
}
```

No changes to `RunOptions`, `RunIntakePhase`/`RunCodegenPhase`/`RunDebugPhase`'s
signatures, or the client (`"→ "`-prefixed lines already render compactly
per bug #16).

## Out of scope

- Any change to the iteration cap, convergence detection, or the nudge
  text itself — this is purely a visibility fix.
- Rate-limiting or deduplicating repeated empty-turn lines if a model
  gets stuck in a long empty-turn streak — each one still posts its own
  line, same as every other progress event; collapsing repeats is a
  separate concern not requested here.
