/**
 * Token Speed Extension
 *
 * Displays real-time output token throughput (mtoks/s) in the status bar
 * during assistant responses. Uses observed usage data when available,
 * falls back to estimated token counts otherwise.
 */

import { estimateTokens, type ExtensionAPI, type ExtensionContext } from "@mariozechner/pi-coding-agent";

const STATUS_KEY = "mtoks";
const STATUS_RATE_REFRESH_MS = 250;
const PENDING_RATE_LABEL = "—";

interface AssistantTiming {
  startedAt: number;
  outputStartedAt: number | null;
  lastStatusAt: number;
  observedOutputTokens: number;
  estimatedOutputTokens: number;
  hasObservedUsage: boolean;
}

type AssistantContentBlock = {
  type?: string;
  text?: unknown;
};

type AssistantMessageLike = {
  role?: string;
  content?: unknown;
  usage?: {
    output?: unknown;
    totalTokens?: unknown;
  };
};

type AssistantUpdateEventLike = {
  type?: unknown;
  partial?: unknown;
};

let currentAssistantTiming: AssistantTiming | null = null;

const TEXT_STREAM_EVENT_TYPES = new Set(["text_start", "text_delta", "text_end"]);

function getUsageOutputTokens(message: unknown): number | null {
  if (!message || typeof message !== "object") return null;

  const candidate = message as AssistantMessageLike;

  if (candidate.role !== "assistant" || !candidate.usage) return null;

  if (typeof candidate.usage.output === "number") {
    return Math.max(0, Math.floor(candidate.usage.output));
  }

  if (typeof candidate.usage.totalTokens === "number") {
    return Math.max(0, Math.floor(candidate.usage.totalTokens));
  }

  return null;
}

function getEstimatedOutputTokens(message: unknown): number {
  if (!message || typeof message !== "object") return 0;

  try {
    return Math.max(0, Math.floor(estimateTokens(message as never)));
  } catch {
    return 0;
  }
}

function hasTextContent(message: unknown): boolean {
  if (!message || typeof message !== "object") return false;

  const { content } = message as AssistantMessageLike;
  if (!Array.isArray(content)) return false;

  return content.some((block) => {
    if (!block || typeof block !== "object") return false;

    const candidate = block as AssistantContentBlock;
    if (candidate.type !== "text") return false;

    return typeof candidate.text === "string" && candidate.text.length > 0;
  });
}

function hasTextUpdate(updateEvent: unknown): boolean {
  if (!updateEvent || typeof updateEvent !== "object") return false;

  const { type } = updateEvent as AssistantUpdateEventLike;
  return typeof type === "string" && TEXT_STREAM_EVENT_TYPES.has(type);
}

function shouldStartOutputTimer(updateEvent: unknown, partialMessage: unknown): boolean {
  if (currentAssistantTiming?.outputStartedAt !== null) return false;

  return hasTextUpdate(updateEvent) || hasTextContent(partialMessage);
}

function formatMtoksPerSecond(outputTokens: number, elapsedMs: number, estimated = false): string {
  if (!Number.isFinite(outputTokens) || outputTokens < 0 || elapsedMs <= 0) {
    return PENDING_RATE_LABEL;
  }

  const tokensPerSecond = outputTokens / (elapsedMs / 1000);
  const mtoksPerSecond = tokensPerSecond / 1000; // 1 mtok = 1,000 tokens
  const suffix = estimated ? " est" : "";

  return `${mtoksPerSecond.toFixed(2)} mtoks/s (${tokensPerSecond.toFixed(1)} tok/s${suffix})`;
}

function getStartTime(message: unknown): number {
  if (!message || typeof message !== "object") return Date.now();

  const candidate = message as { timestamp?: unknown };
  return typeof candidate.timestamp === "number" ? candidate.timestamp : Date.now();
}

function updateStatus(ctx: ExtensionContext, message: unknown, now: number): void {
  if (!ctx.hasUI || !currentAssistantTiming) return;

  if (now - currentAssistantTiming.lastStatusAt < STATUS_RATE_REFRESH_MS) {
    return;
  }

  currentAssistantTiming.lastStatusAt = now;

  const usageOutput = getUsageOutputTokens(message);
  if (usageOutput !== null) {
    currentAssistantTiming.observedOutputTokens = Math.max(currentAssistantTiming.observedOutputTokens, usageOutput);
    currentAssistantTiming.hasObservedUsage = true;
  }

  const tokensForRate =
    currentAssistantTiming.hasObservedUsage
      ? currentAssistantTiming.observedOutputTokens
      : Math.max(currentAssistantTiming.estimatedOutputTokens, getEstimatedOutputTokens(message));

  if (!currentAssistantTiming.hasObservedUsage) {
    currentAssistantTiming.estimatedOutputTokens = tokensForRate;
  }

  const startedAt = currentAssistantTiming.outputStartedAt ?? currentAssistantTiming.startedAt;
  const elapsedMs = Math.max(1, now - startedAt);
  const rate = formatMtoksPerSecond(tokensForRate, elapsedMs, !currentAssistantTiming.hasObservedUsage);

  ctx.ui.setStatus(STATUS_KEY, `mtoks ${rate}`);
}

export default function tokenSpeed(pi: ExtensionAPI) {
  pi.on("message_start", async (event, ctx) => {
    if (!ctx.hasUI) return;

    if (typeof event.message === "object" && event.message?.role === "assistant") {
      const now = Date.now();
      const usageOutput = getUsageOutputTokens(event.message);
      const initialObserved = usageOutput ?? 0;
      const initialEstimated = usageOutput === null ? getEstimatedOutputTokens(event.message) : 0;
      const hasObservedUsage = usageOutput !== null;

      currentAssistantTiming = {
        startedAt: getStartTime(event.message),
        outputStartedAt: null,
        lastStatusAt: 0,
        observedOutputTokens: initialObserved,
        estimatedOutputTokens: initialEstimated,
        hasObservedUsage,
      };

      const initialRate = PENDING_RATE_LABEL;

      ctx.ui.setStatus(STATUS_KEY, `mtoks ${initialRate}`);
      currentAssistantTiming.lastStatusAt = now;
    }
  });

  pi.on("message_update", async (event, ctx) => {
    if (!ctx.hasUI || !currentAssistantTiming) return;
    if (!event.assistantMessageEvent || !event.assistantMessageEvent.partial) return;

    const now = Date.now();

    if (!currentAssistantTiming.outputStartedAt && shouldStartOutputTimer(event.assistantMessageEvent, event.assistantMessageEvent.partial)) {
      currentAssistantTiming.outputStartedAt = now;
      currentAssistantTiming.lastStatusAt = 0;
    }

    if (!currentAssistantTiming.outputStartedAt) {
      return;
    }

    updateStatus(ctx, event.assistantMessageEvent.partial, now);
  });

  pi.on("message_end", async (event, ctx) => {
    if (!ctx.hasUI) return;

    if (event.message?.role !== "assistant") {
      currentAssistantTiming = null;
      return;
    }

    if (!currentAssistantTiming) {
      currentAssistantTiming = {
        startedAt: getStartTime(event.message),
        outputStartedAt: null,
        lastStatusAt: 0,
        observedOutputTokens: 0,
        estimatedOutputTokens: 0,
        hasObservedUsage: false,
      };
    }

    const finalUsageOutput = getUsageOutputTokens(event.message);
    if (finalUsageOutput !== null) {
      currentAssistantTiming.observedOutputTokens = Math.max(currentAssistantTiming.observedOutputTokens, finalUsageOutput);
      currentAssistantTiming.hasObservedUsage = true;
    } else if (currentAssistantTiming.estimatedOutputTokens === 0) {
      currentAssistantTiming.estimatedOutputTokens = getEstimatedOutputTokens(event.message);
    }

    const finalOutputTokens =
      currentAssistantTiming.hasObservedUsage
        ? currentAssistantTiming.observedOutputTokens
        : Math.max(currentAssistantTiming.estimatedOutputTokens, getEstimatedOutputTokens(event.message));

    const messageEndAt = Date.now();
    const startForRate = currentAssistantTiming.outputStartedAt ?? currentAssistantTiming.startedAt;
    const elapsedMs = Math.max(1, messageEndAt - startForRate);
    const finalRate = formatMtoksPerSecond(
      finalOutputTokens,
      elapsedMs,
      !currentAssistantTiming.hasObservedUsage,
    );

    ctx.ui.setStatus(STATUS_KEY, `mtoks ${finalRate}`);
    currentAssistantTiming = null;
  });
}
