import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@mariozechner/pi-coding-agent";

// Why sequential gated prompts?
// A single-shot prompt bundling all 3 tasks (fallback, dead code, docs) led to the LLM
// skipping the docs step — it finished the first two, then ran out of attention for the last.
// Each step now gets its own LLM turn with a structured STEP_DONE / STEP_SKIPPED gate check.
// This ensures no step is dropped without an explicit outcome.

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

const MAX_ATTEMPTS = 3;

type Task = (typeof TASKS)[number];
type TaskResult = "done" | "skipped" | "failed";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getMessageText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }

  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .map((part) => {
      if (typeof part === "string") {
        return part;
      }

      if (!part || typeof part !== "object") {
        return "";
      }

      return "type" in part && part.type === "text" && "text" in part
        ? (part.text ?? "")
        : "";
    })
    .join("\n");
}

function buildInstruction(task: Task, attempt: number): string {
  if (attempt === 1) {
    return `${task.prompt}\n\n${VERIFY_PROMPT}`;
  }

  return `Retry the "${task.name}" step. Your previous reply did not include a valid gate result.

You must end with either STEP_DONE or STEP_SKIPPED.
Use STEP_SKIPPED only if there is truly nothing to change for this step.

${task.prompt}\n\n${VERIFY_PROMPT}`;
}

function parseTaskResult(reply: string | undefined): Exclude<TaskResult, "failed"> | undefined {
  if (!reply) {
    return undefined;
  }

  if (reply.includes("STEP_DONE")) {
    return "done";
  }

  if (reply.includes("STEP_SKIPPED")) {
    return "skipped";
  }

  return undefined;
}

function getNewAssistantReply(
  ctx: ExtensionCommandContext,
  seenEntryIds: Set<string>,
): string | undefined {
  const branch = ctx.sessionManager.getBranch();

  for (let index = branch.length - 1; index >= 0; index--) {
    const entry = branch[index];
    if (seenEntryIds.has(entry.id) || entry.type !== "message") {
      continue;
    }

    if (entry.message.role !== "assistant") {
      continue;
    }

    return getMessageText(entry.message.content);
  }

  return undefined;
}

async function waitForTurnToStart(
  ctx: ExtensionCommandContext,
  seenEntryIds: Set<string>,
): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt++) {
    if (!ctx.isIdle()) {
      return;
    }

    const hasNewEntry = ctx.sessionManager
      .getBranch()
      .some((entry) => !seenEntryIds.has(entry.id));

    if (hasNewEntry) {
      return;
    }

    await sleep(10);
  }
}

async function runTask(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  task: Task,
  attempt = 1,
): Promise<TaskResult> {
  if (ctx.hasUI) {
    ctx.ui.setStatus(
      "feature-end",
      `Running cleanup... ${task.name} (${attempt}/${MAX_ATTEMPTS})`,
    );
  }

  await ctx.waitForIdle();

  const seenEntryIds = new Set(
    ctx.sessionManager.getBranch().map((entry) => entry.id),
  );

  pi.sendUserMessage(buildInstruction(task, attempt));

  await waitForTurnToStart(ctx, seenEntryIds);
  await ctx.waitForIdle();

  const reply = getNewAssistantReply(ctx, seenEntryIds);
  const result = parseTaskResult(reply);

  if (result) {
    return result;
  }

  if (attempt >= MAX_ATTEMPTS) {
    return "failed";
  }

  return runTask(pi, ctx, task, attempt + 1);
}

export default function featureEnd(pi: ExtensionAPI) {
  pi.registerCommand("feature-end", {
    description: "Run post-feature cleanup: remove fallback code, dead code, update docs (gated)",
    handler: async (_args, ctx) => {
      if (ctx.hasUI) {
        ctx.ui.setStatus("feature-end", "Running cleanup...");
      }

      const done: string[] = [];
      const skipped: string[] = [];
      const failed: string[] = [];

      try {
        for (const task of TASKS) {
          const result = await runTask(pi, ctx, task);

          if (result === "done") {
            done.push(task.name);
          } else if (result === "skipped") {
            skipped.push(task.name);
          } else {
            failed.push(task.name);
          }
        }
      } catch (error) {
        if (ctx.hasUI) {
          ctx.ui.setStatus("feature-end", "Failed");
        }
        throw error;
      }

      if (!ctx.hasUI) {
        return;
      }

      if (failed.length === 0) {
        const suffix = skipped.length === 0 ? "Done" : `Done (${skipped.length} skipped)`;
        ctx.ui.setStatus("feature-end", suffix);

        if (skipped.length === 0) {
          ctx.ui.notify("feature-end: all steps complete", "info");
        } else {
          ctx.ui.notify(
            `feature-end: done: ${done.join(", ") || "none"}; skipped: ${skipped.join(", ")}`,
            "info",
          );
        }
      } else {
        ctx.ui.setStatus("feature-end", `Failed (${failed.length})`);
        ctx.ui.notify(
          `feature-end: failed steps: ${failed.join(", ")}`,
          "error",
        );
      }
    },
  });
}
