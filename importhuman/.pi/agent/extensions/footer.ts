/**
 * Custom Footer Extension
 *
 * Provides a configurable footer and footer settings command:
 *   - installs a multi-line footer showing path, git branch, session, token usage, cost, context usage, model/provider, thinking level, and extension statuses
 *   - registers the `footer` command to customize visible footer components, context usage colors, and thresholds at project or global scope
 *
 * Configuration is loaded from global and project JSON files and merged with defaults.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AssistantMessage } from "@mariozechner/pi-ai";
import {
  DynamicBorder,
  getAgentDir,
  getSettingsListTheme,
  type ExtensionAPI,
  type ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import {
  Container,
  Input,
  type SettingItem,
  SettingsList,
  Spacer,
  Text,
  truncateToWidth,
  visibleWidth,
} from "@mariozechner/pi-tui";

type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
type ColorValue = string;

type FooterComponentKey =
  | "path"
  | "gitBranch"
  | "sessionName"
  | "inputTokens"
  | "outputTokens"
  | "cacheReadTokens"
  | "cost"
  | "subscriptionIndicator"
  | "contextUsage"
  | "model"
  | "provider"
  | "thinking"
  | "extensionStatuses";

interface FooterConfig {
  components: Record<FooterComponentKey, boolean>;
  contextUsage: {
    warningThreshold: number;
    errorThreshold: number;
    colors: {
      normal: ColorValue;
      warning: ColorValue;
      error: ColorValue;
    };
  };
}

const COMPONENT_LABELS: Record<FooterComponentKey, string> = {
  path: "Path",
  gitBranch: "Git branch",
  sessionName: "Session name",
  inputTokens: "Input tokens",
  outputTokens: "Output tokens",
  cacheReadTokens: "Cache read",
  cost: "Cost",
  subscriptionIndicator: "Subscription indicator",
  contextUsage: "Context usage",
  model: "Model",
  provider: "Provider",
  thinking: "Thinking",
  extensionStatuses: "Extension statuses",
};

const DEFAULT_CONFIG: FooterConfig = {
  components: {
    path: true,
    gitBranch: true,
    sessionName: true,
    inputTokens: true,
    outputTokens: true,
    cacheReadTokens: true,
    cost: true,
    subscriptionIndicator: true,
    contextUsage: true,
    model: true,
    provider: true,
    thinking: true,
    extensionStatuses: true,
  },
  contextUsage: {
    warningThreshold: 70,
    errorThreshold: 90,
    colors: {
      normal: "dim",
      warning: "#f9c74f",
      error: "#f94144",
    },
  },
};

function formatTokens(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
  return `${Math.round(count / 1000000)}M`;
}

function sanitizeStatusText(text: string): string {
  return text.replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim();
}

function isValidHexColor(value: string): boolean {
  return /^#[0-9a-fA-F]{6}$/.test(value);
}

function applyColor(theme: any, color: string, text: string): string {
  if (isValidHexColor(color)) {
    return `\x1b[38;2;${parseInt(color.slice(1, 3), 16)};${parseInt(color.slice(3, 5), 16)};${parseInt(color.slice(5, 7), 16)}m${text}\x1b[39m`;
  }
  try {
    return theme.fg(color, text);
  } catch {
    return theme.fg("dim", text);
  }
}

function deepMerge<T>(base: T, override: Partial<T> | undefined): T {
  if (!override) return base;
  if (Array.isArray(base) || Array.isArray(override)) return (override ?? base) as T;
  if (typeof base !== "object" || base === null) return (override ?? base) as T;

  const result: any = { ...base };
  for (const key of Object.keys(override as object)) {
    const overrideValue = (override as any)[key];
    if (overrideValue === undefined) continue;
    const baseValue = (base as any)[key];
    if (
      typeof baseValue === "object" &&
      baseValue !== null &&
      !Array.isArray(baseValue) &&
      typeof overrideValue === "object" &&
      overrideValue !== null &&
      !Array.isArray(overrideValue)
    ) {
      result[key] = deepMerge(baseValue, overrideValue);
    } else {
      result[key] = overrideValue;
    }
  }
  return result;
}

function normalizeConfig(raw: any): FooterConfig {
  const merged = deepMerge(DEFAULT_CONFIG, raw ?? {});
  const warningThreshold = Number(merged.contextUsage.warningThreshold);
  const errorThreshold = Number(merged.contextUsage.errorThreshold);

  return {
    components: { ...DEFAULT_CONFIG.components, ...(merged.components ?? {}) },
    contextUsage: {
      warningThreshold: Number.isFinite(warningThreshold) ? warningThreshold : DEFAULT_CONFIG.contextUsage.warningThreshold,
      errorThreshold: Number.isFinite(errorThreshold) ? errorThreshold : DEFAULT_CONFIG.contextUsage.errorThreshold,
      colors: {
        normal: typeof merged.contextUsage?.colors?.normal === "string" ? merged.contextUsage.colors.normal : DEFAULT_CONFIG.contextUsage.colors.normal,
        warning: typeof merged.contextUsage?.colors?.warning === "string" ? merged.contextUsage.colors.warning : DEFAULT_CONFIG.contextUsage.colors.warning,
        error: typeof merged.contextUsage?.colors?.error === "string" ? merged.contextUsage.colors.error : DEFAULT_CONFIG.contextUsage.colors.error,
      },
    },
  };
}

function readJsonIfExists(path: string): any | undefined {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

function writeJson(path: string, value: any): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function getConfigPaths(cwd: string) {
  return {
    global: join(getAgentDir(), "footer-config.json"),
    project: join(cwd, ".pi", "footer-config.json"),
  };
}

function loadConfig(cwd: string): { effective: FooterConfig; globalRaw: any; projectRaw: any } {
  const paths = getConfigPaths(cwd);
  const globalRaw = readJsonIfExists(paths.global) ?? {};
  const projectRaw = readJsonIfExists(paths.project) ?? {};
  const effective = normalizeConfig(deepMerge(globalRaw, projectRaw));
  return { effective, globalRaw, projectRaw };
}

function setNestedValue(target: any, path: string[], value: any) {
  let current = target;
  for (let i = 0; i < path.length - 1; i++) {
    const segment = path[i]!;
    if (typeof current[segment] !== "object" || current[segment] === null || Array.isArray(current[segment])) {
      current[segment] = {};
    }
    current = current[segment];
  }
  current[path[path.length - 1]!] = value;
}

export default function footerExtension(pi: ExtensionAPI) {
  let currentConfig = loadConfig(process.cwd()).effective;

  function refreshConfig(ctx: ExtensionContext) {
    currentConfig = loadConfig(ctx.cwd).effective;
  }

  function installFooter(ctx: ExtensionContext) {
    ctx.ui.setFooter((tui, theme, footerData) => {
      const unsub = footerData.onBranchChange(() => tui.requestRender());

      return {
        dispose: unsub,
        invalidate() {},
        render(width: number): string[] {
          const state = (ctx as any).sessionManager ? (ctx as any) : ctx;
          let totalInput = 0;
          let totalOutput = 0;
          let totalCacheRead = 0;
          let totalCacheWrite = 0;
          let totalCost = 0;

          for (const entry of ctx.sessionManager.getEntries()) {
            if (entry.type === "message" && entry.message.role === "assistant") {
              const message = entry.message as AssistantMessage;
              totalInput += message.usage.input;
              totalOutput += message.usage.output;
              totalCacheRead += message.usage.cacheRead;
              totalCacheWrite += message.usage.cacheWrite;
              totalCost += message.usage.cost.total;
            }
          }

          const contextUsage = ctx.getContextUsage();
          const contextWindow = contextUsage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
          const contextPercentValue = contextUsage?.percent ?? 0;
          const usedTokens = contextUsage?.tokens ?? 0;

          let pwd = ctx.sessionManager.getCwd();
          const home = process.env.HOME || process.env.USERPROFILE;
          if (home && pwd.startsWith(home)) pwd = `~${pwd.slice(home.length)}`;

          const topParts: string[] = [];
          if (currentConfig.components.path) topParts.push(pwd);
          const branch = footerData.getGitBranch();
          if (currentConfig.components.gitBranch && branch) topParts.push(`(${branch})`);
          const sessionName = ctx.sessionManager.getSessionName();
          if (currentConfig.components.sessionName && sessionName) topParts.push(`• ${sessionName}`);
          const pwdLine = truncateToWidth(theme.fg("dim", topParts.join(" ").trim()), width, theme.fg("dim", "..."));

          const statsParts: string[] = [];
          if (currentConfig.components.inputTokens && totalInput) statsParts.push(`↑${formatTokens(totalInput)}`);
          if (currentConfig.components.outputTokens && totalOutput) statsParts.push(`↓${formatTokens(totalOutput)}`);
          if (currentConfig.components.cacheReadTokens && totalCacheRead) statsParts.push(`R${formatTokens(totalCacheRead)}`);

          const usingSubscription = ctx.model ? ctx.modelRegistry.isUsingOAuth(ctx.model) : false;
          if (currentConfig.components.cost && (totalCost || (usingSubscription && currentConfig.components.subscriptionIndicator))) {
            const suffix = currentConfig.components.subscriptionIndicator && usingSubscription ? " (sub)" : "";
            statsParts.push(`$${totalCost.toFixed(3)}${suffix}`);
          }

          if (currentConfig.components.contextUsage) {
            const display = `${formatTokens(usedTokens)}/${formatTokens(contextWindow)} (${contextPercentValue.toFixed(1)}%)`;
            let color = currentConfig.contextUsage.colors.normal;
            if (contextPercentValue >= currentConfig.contextUsage.errorThreshold) color = currentConfig.contextUsage.colors.error;
            else if (contextPercentValue >= currentConfig.contextUsage.warningThreshold) color = currentConfig.contextUsage.colors.warning;
            statsParts.push(applyColor(theme, color, display));
          }

          let left = statsParts.join(" ");
          let leftWidth = visibleWidth(left);
          if (leftWidth > width) {
            left = truncateToWidth(left, width, "...");
            leftWidth = visibleWidth(left);
          }

          let right = "";
          const modelName = ctx.model?.id || "no-model";
          const providerName = ctx.model?.provider;
          const thinkingLevel = (pi.getThinkingLevel() as ThinkingLevel) || "off";
          const rightParts: string[] = [];
          if (currentConfig.components.provider && providerName) rightParts.push(`(${providerName})`);
          if (currentConfig.components.model) rightParts.push(modelName);
          if (currentConfig.components.thinking && ctx.model?.reasoning) {
            rightParts.push(thinkingLevel === "off" ? "thinking off" : thinkingLevel);
          }
          right = rightParts.join(" • ");

          const rightStyled = theme.fg("dim", right);
          const leftStyled = theme.fg("dim", left);
          const rightWidth = visibleWidth(rightStyled);
          const minPadding = 2;
          let statsLine = leftStyled;
          if (right && leftWidth + minPadding + rightWidth <= width) {
            const padding = " ".repeat(width - leftWidth - rightWidth);
            statsLine = leftStyled + padding + rightStyled;
          }

          const lines = [pwdLine, statsLine];

          if (currentConfig.components.extensionStatuses) {
            const extensionStatuses = footerData.getExtensionStatuses();
            if (extensionStatuses.size > 0) {
              const sortedStatuses = Array.from(extensionStatuses.entries())
                .sort(([a], [b]) => a.localeCompare(b))
                .map(([, text]) => sanitizeStatusText(text));
              lines.push(truncateToWidth(sortedStatuses.join(" "), width, theme.fg("dim", "...")));
            }
          }

          return lines;
        },
      };
    });
  }

  pi.on("session_start", async (_event, ctx) => {
    refreshConfig(ctx);
    installFooter(ctx);
  });

  pi.registerCommand("footer", {
    description: "Configure custom footer",
    handler: async (_args, ctx) => {
      refreshConfig(ctx);
      const paths = getConfigPaths(ctx.cwd);
      const scopeState = { value: "project" as "global" | "project" };

      const saveValue = (pathSegments: string[], value: any) => {
        const targetPath = scopeState.value === "global" ? paths.global : paths.project;
        const raw = readJsonIfExists(targetPath) ?? {};
        setNestedValue(raw, pathSegments, value);
        writeJson(targetPath, raw);
        refreshConfig(ctx);
        installFooter(ctx);
      };

      await ctx.ui.custom((tui, theme, _kb, done) => {
        const container = new Container();
        container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
        container.addChild(new Text(theme.fg("accent", theme.bold("Footer Configuration")), 1, 0));
        container.addChild(new Text(theme.fg("muted", `Scope: ${scopeState.value} (${scopeState.value === "global" ? paths.global : paths.project})`), 1, 0));
        container.addChild(new Spacer(1));

        const items: SettingItem[] = [
          {
            id: "scope",
            label: "Save scope",
            currentValue: scopeState.value,
            values: ["project", "global"],
          },
          ...((Object.keys(COMPONENT_LABELS) as FooterComponentKey[]).map((key) => ({
            id: `component:${key}`,
            label: COMPONENT_LABELS[key],
            currentValue: currentConfig.components[key] ? "shown" : "hidden",
            values: ["shown", "hidden"],
          }))),
          {
            id: "context.colors.normal",
            label: "Context normal color",
            currentValue: currentConfig.contextUsage.colors.normal,
            values: ["dim", "muted", "accent", "success", "warning", "error", "#8caaee", "#a6d189", "#f9c74f", "#f94144"],
          },
          {
            id: "context.colors.warning",
            label: "Context warning color",
            currentValue: currentConfig.contextUsage.colors.warning,
            values: ["warning", "accent", "error", "#f9c74f", "#ffb703", "#fb8500"],
          },
          {
            id: "context.colors.error",
            label: "Context error color",
            currentValue: currentConfig.contextUsage.colors.error,
            values: ["error", "warning", "accent", "#f94144", "#d90429", "#ef476f"],
          },
        ];

        const settingsList = new SettingsList(
          items,
          Math.min(items.length + 2, 20),
          getSettingsListTheme(),
          (id, newValue) => {
            if (id === "scope") {
              scopeState.value = newValue as "global" | "project";
            } else if (id.startsWith("component:")) {
              const key = id.replace("component:", "") as FooterComponentKey;
              saveValue(["components", key], newValue === "shown");
            } else if (id === "context.colors.normal") {
              saveValue(["contextUsage", "colors", "normal"], newValue);
            } else if (id === "context.colors.warning") {
              saveValue(["contextUsage", "colors", "warning"], newValue);
            } else if (id === "context.colors.error") {
              saveValue(["contextUsage", "colors", "error"], newValue);
            }
            tui.requestRender();
          },
          () => done(undefined),
          { enableSearch: true },
        );

        const warningInput = new Input();
        warningInput.setValue(String(currentConfig.contextUsage.warningThreshold));
        const errorInput = new Input();
        errorInput.setValue(String(currentConfig.contextUsage.errorThreshold));
        let focus: "settings" | "warning" | "error" = "settings";
        warningInput.focused = false;
        errorInput.focused = false;

        container.addChild(settingsList);
        container.addChild(new Spacer(1));
        container.addChild(new Text(theme.fg("accent", "Manual thresholds"), 1, 0));
        container.addChild(new Text(theme.fg("muted", "Tab cycles: settings → warning → error. Press Enter in an input to save."), 1, 0));
        container.addChild(new Text(theme.fg("dim", "Warning threshold"), 1, 0));
        container.addChild(warningInput);
        container.addChild(new Text(theme.fg("dim", "Error threshold"), 1, 0));
        container.addChild(errorInput);
        container.addChild(new Spacer(1));
        container.addChild(new Text(theme.fg("dim", "Changes are saved immediately to the selected scope."), 1, 0));
        container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

        const saveThresholdInput = (kind: "warning" | "error") => {
          const input = kind === "warning" ? warningInput : errorInput;
          const raw = input.getValue().trim();
          const parsed = Number(raw);
          if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
            ctx.ui.notify(`${kind} threshold must be an integer`, "warning");
            return;
          }
          if (parsed < 1 || parsed > 100) {
            ctx.ui.notify(`${kind} threshold must be between 1 and 100`, "warning");
            return;
          }

          const warningValue = kind === "warning" ? parsed : Number(warningInput.getValue().trim());
          const errorValue = kind === "error" ? parsed : Number(errorInput.getValue().trim());

          if (Number.isFinite(warningValue) && Number.isFinite(errorValue) && warningValue >= errorValue) {
            ctx.ui.notify("warning threshold must be less than error threshold", "warning");
            return;
          }

          saveValue(["contextUsage", kind === "warning" ? "warningThreshold" : "errorThreshold"], parsed);
          ctx.ui.notify(`${kind} threshold saved`, "info");
        };

        return {
          render(width: number) {
            warningInput.focused = focus === "warning";
            errorInput.focused = focus === "error";
            return container.render(width);
          },
          invalidate() {
            container.invalidate();
          },
          handleInput(data: string) {
            if (data === "\t") {
              focus = focus === "settings" ? "warning" : focus === "warning" ? "error" : "settings";
              tui.requestRender();
              return;
            }

            if (focus === "warning") {
              if (data === "\r") {
                saveThresholdInput("warning");
                tui.requestRender();
                return;
              }
              warningInput.handleInput?.(data);
              tui.requestRender();
              return;
            }

            if (focus === "error") {
              if (data === "\r") {
                saveThresholdInput("error");
                tui.requestRender();
                return;
              }
              errorInput.handleInput?.(data);
              tui.requestRender();
              return;
            }

            settingsList.handleInput?.(data);
            tui.requestRender();
          },
        };
      });
    },
  });
}
