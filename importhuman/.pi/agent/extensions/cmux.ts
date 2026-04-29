/**
 * cmux — Push pi agent state into the cmux sidebar.
 *
 * Uses three readable grouped status pills and updates them as a single
 * snapshot burst for the current workspace.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const CMUX_SOCKET = process.env.CMUX_SOCKET_PATH;
const GREEN = "#22C55E";
const AMBER = "#F59E0B";
const PURPLE = "#8B5CF6";
const BLUE = "#3B82F6";

type State = "Idle" | "Working";
type StatusEntry = { key: string; value: string; icon: string; color: string };

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 10_000) return `${Math.round(n / 1000)}k`;
  if (n >= 1_000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

function formatCost(n: number): string {
  return `$${n.toFixed(2)}`;
}

function shortModel(id?: string): string {
  if (!id) return "—";
  return id.replace(/^claude-/, "").replace(/-\d{8}$/, "");
}

export default function (pi: ExtensionAPI) {
  if (!CMUX_SOCKET) return;

  let sessionCost = 0;
  let hasUI = false;
  let workspaceId = process.env.CMUX_WORKSPACE_ID;
  let lastSnapshot = "";
  let currentTool = "—";
  let currentState: State = "Idle";

  function run(args: string[]) {
    if (!hasUI) return Promise.resolve();
    return pi
      .exec("cmux", workspaceId ? [...args, "--workspace", workspaceId] : args, { timeout: 2000 })
      .catch(() => {});
  }

  function buildSnapshot(ctx: { model?: { id: string } | undefined; getContextUsage: () => { tokens?: number } | undefined }): StatusEntry[] {
    const thinking = pi.getThinkingLevel();
    const usage = ctx.getContextUsage();

    return [
      {
        key: "pi_model_thinking",
        value: `${shortModel(ctx.model?.id)} / ${thinking === "off" ? "off" : thinking}`,
        icon: "brain",
        color: PURPLE,
      },
      {
        key: "pi_cost_tokens",
        value: `${formatCost(sessionCost)} / ${formatTokens(usage?.tokens ?? 0)}`,
        icon: "chart.bar",
        color: BLUE,
      },
      {
        key: "pi_state_tool",
        value: `${currentState} / ${currentTool}`,
        icon: currentState === "Working" ? "arrow.circlepath" : "checkmark.circle",
        color: currentState === "Working" ? AMBER : GREEN,
      },
    ];
  }

  async function render(ctx: { model?: { id: string } | undefined; getContextUsage: () => { tokens?: number } | undefined }) {
    if (!hasUI) return;
    const entries = buildSnapshot(ctx);
    const snapshot = JSON.stringify(entries);
    if (snapshot === lastSnapshot) return;
    lastSnapshot = snapshot;
    await Promise.all(
      [...entries].reverse().map((entry) =>
        run(["set-status", entry.key, entry.value, "--icon", entry.icon, "--color", entry.color])
      )
    );
  }

  pi.on("session_start", async (_event, ctx) => {
    hasUI = ctx.hasUI;
    workspaceId = process.env.CMUX_WORKSPACE_ID;
    lastSnapshot = "";
    currentState = "Idle";
    currentTool = "—";
    if (!hasUI) return;

    sessionCost = 0;
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type === "message" && entry.message.role === "assistant" && (entry.message as any).usage?.cost?.total) {
        sessionCost += (entry.message as any).usage.cost.total;
      }
    }

    await render(ctx);
  });

  pi.on("agent_start", async (_event, ctx) => {
    if (!ctx.hasUI) return;
    currentState = "Working";
    await render(ctx);
  });

  pi.on("agent_end", async (_event, ctx) => {
    if (!ctx.hasUI) return;
    currentState = "Idle";
    currentTool = "—";
    await render(ctx);
    run(["notify", "--title", "Needs attention"]);
  });

  pi.on("turn_end", async (event, ctx) => {
    if (!ctx.hasUI) return;
    if (event.message?.role === "assistant" && (event.message as any).usage?.cost?.total) {
      sessionCost += (event.message as any).usage.cost.total;
    }
    currentState = ctx.isIdle() ? "Idle" : "Working";
    if (ctx.isIdle()) currentTool = "—";
    await render(ctx);
  });

  pi.on("model_select", async (_event, ctx) => {
    if (!ctx.hasUI) return;
    await render(ctx);
  });

  pi.on("tool_execution_start", async (event, ctx) => {
    if (!ctx.hasUI) return;
    currentState = "Working";
    currentTool = event.toolName;
    await render(ctx);
  });

  pi.on("tool_execution_end", async (_event, ctx) => {
    if (!ctx.hasUI) return;
    currentTool = "—";
    currentState = ctx.isIdle() ? "Idle" : "Working";
    await render(ctx);
  });
}
