import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

// Why sequential gated prompts?
// A single-shot prompt bundling all 3 tasks (fallback, dead code, docs) led to the LLM
// skipping the docs step — it finished the first two, then ran out of attention for the last.
// Each step now gets its own LLM turn with a structured STEP_DONE / STEP_SKIPPED gate check.
// This ensures no step is dropped without explicit retry.

const TASKS = [
  {
    name: "fallback",
    prompt: `Find and remove overly-defensive code added by AI assistants:
- try/catch blocks that swallow errors silently without re-throwing
- commented-out code blocks left behind
- placeholder "TODO: remove" stubs
- unnecessary default cases that return null/empty/zero
- anything that exists only to "just in case" — not to fix a real bug

Be surgical. Only remove what's provably fallback.`,
  },
  {
    name: "dead-code",
    prompt: `Find and remove code paths that are no longer used:
- unused exports (functions, classes, variables)
- unused imports
- old feature branches that are now superseded
- functions that only call other dead functions
- code guarded by flags/config that are never set to the old value

Be surgical. Only remove what's provably dead.`,
  },
  {
    name: "docs",
    prompt: `Review and update all .md files in the repo:
- Update CHANGELOG if present
- Update README if anything new warrants mention
- Fix any outdated docs you notice
- Add docs for anything new that lacks them
- Remove docs for removed features

Be surgical. Only update what's provably outdated or missing.`,
  },
] as const;

const VERIFY_PROMPT = `Reply with exactly one of:
- STEP_DONE — if you completed the task above
- STEP_SKIPPED — if you skipped or did nothing

Then a brief one-line reason. Example: STEP_DONE — removed 3 try/catch blocks`;

async function runTask(pi: ExtensionAPI, task: (typeof TASKS)[number]): Promise<boolean> {
  await pi.sendUserMessage(task.prompt, { deliverAs: "followUp" });

  const result = await new Promise<string>((resolve) => {
    const handler = (message: { content?: Array<{ type: string; text?: string }> }) => {
      const text = message.content?.[0]?.text ?? "";
      if (text.includes("STEP_DONE") || text.includes("STEP_SKIPPED")) {
        pi.events.off("message_end", handler);
        resolve(text);
      }
    };
    pi.events.on("message_end", handler);
  });

  const done = result.includes("STEP_DONE");
  if (!done) {
    await pi.sendUserMessage(
      `You marked this step as SKIPPED but it was not completed. Please retry: ${task.prompt}`,
      { deliverAs: "followUp" },
    );
    return runTask(pi, task);
  }
  return true;
}

export default function featureEnd(pi: ExtensionAPI) {
  pi.registerCommand("feature-end", {
    description: "Run post-feature cleanup: remove fallback code, dead code, update docs (gated)",
    handler: async (_args, ctx) => {
      if (ctx.hasUI) ctx.ui.setStatus("feature-end", "Running cleanup...");
      for (const task of TASKS) {
        await runTask(pi, task);
      }
      if (ctx.hasUI) {
        ctx.ui.setStatus("feature-end", "Done");
        ctx.ui.notify("feature-end: all steps complete", "success");
      }
    },
  });
}
