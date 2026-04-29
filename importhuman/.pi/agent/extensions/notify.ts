/**
 * Desktop Notification Extension
 *
 * Sends a native desktop notification when the agent finishes and is waiting for input.
 * Uses OSC 777 escape sequence - no external dependencies.
 *
 * Supported terminals: Ghostty, iTerm2, WezTerm, rxvt-unicode
 * Not supported: Kitty (uses OSC 99), Terminal.app, Windows Terminal, Alacritty
 * Base taken from `@mitsuhiko`. Extended to notify when paused for user input.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Markdown, type MarkdownTheme } from "@mariozechner/pi-tui";

/**
 * Send a desktop notification via OSC 777 escape sequence.
 */
const notify = (title: string, body: string): void => {
	// OSC 777 format: ESC ] 777 ; notify ; title ; body BEL
	process.stdout.write(`\x1b]777;notify;${title};${body}\x07`);
};

const isTextPart = (part: unknown): part is { type: "text"; text: string } =>
	Boolean(part && typeof part === "object" && "type" in part && part.type === "text" && "text" in part);

const extractLastAssistantText = (messages: Array<{ role?: string; content?: unknown }>): string | null => {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message?.role !== "assistant") {
			continue;
		}

		const content = message.content;
		if (typeof content === "string") {
			return content.trim() || null;
		}

		if (Array.isArray(content)) {
			const text = content.filter(isTextPart).map((part) => part.text).join("\n").trim();
			return text || null;
		}

		return null;
	}

	return null;
};

const plainMarkdownTheme: MarkdownTheme = {
	heading: (text) => text,
	link: (text) => text,
	linkUrl: () => "",
	code: (text) => text,
	codeBlock: (text) => text,
	codeBlockBorder: () => "",
	quote: (text) => text,
	quoteBorder: () => "",
	hr: () => "",
	listBullet: () => "",
	bold: (text) => text,
	italic: (text) => text,
	strikethrough: (text) => text,
	underline: (text) => text,
};

const simpleMarkdown = (text: string, width = 80): string => {
	const markdown = new Markdown(text, 0, 0, plainMarkdownTheme);
	return markdown.render(width).join("\n");
};

const formatNotification = (text: string | null): { title: string; body: string } => {
	const simplified = text ? simpleMarkdown(text) : "";
	const normalized = simplified.replace(/\s+/g, " ").trim();
	if (!normalized) {
		return { title: "Ready for input", body: "" };
	}

	const maxBody = 200;
	const body = normalized.length > maxBody ? `${normalized.slice(0, maxBody - 1)}…` : normalized;
	return { title: "π", body };
};

const isAssistantMessage = (message: unknown): message is { role: "assistant"; content?: unknown; stopReason?: string } =>
	Boolean(message && typeof message === "object" && "role" in message && (message as { role?: string }).role === "assistant");

const formatDialogTitle = (title: string): { title: string; body: string } => {
	const normalized = title.replace(/\s+/g, " ").trim();
	if (!normalized) {
		return { title: "π", body: "Waiting for input" };
	}

	const maxBody = 200;
	const body = normalized.length > maxBody ? `${normalized.slice(0, maxBody - 1)}…` : normalized;
	return { title: "π", body };
};

export default function (pi: ExtensionAPI) {
	let dialogsPatched = false;

	pi.on("session_start", async (_event, ctx) => {
		if (dialogsPatched) {
			return;
		}

		const ui = ctx.ui as typeof ctx.ui & {
			__notifyPatched?: boolean;
			select?: (title: string, options: string[], config?: unknown) => Promise<string | undefined>;
			confirm?: (title: string, message: string, config?: unknown) => Promise<boolean>;
			input?: (title: string, prefill?: string, config?: unknown) => Promise<string | undefined>;
			editor?: (title: string, prefill?: string, config?: unknown) => Promise<string | undefined>;
		};

		if (ui.__notifyPatched) {
			dialogsPatched = true;
			return;
		}

		const wrapDialog = <TArgs extends unknown[], TResult>(
			fn: ((...args: TArgs) => Promise<TResult>) | undefined,
			getTitle: (...args: TArgs) => string,
		) => {
			if (!fn) {
				return fn;
			}

			return async (...args: TArgs): Promise<TResult> => {
				const { title, body } = formatDialogTitle(getTitle(...args));
				notify(title, body);
				return fn(...args);
			};
		};

		ui.select = wrapDialog(ui.select, (title) => title);
		ui.confirm = wrapDialog(ui.confirm, (title, message) => `${title} ${message}`);
		ui.input = wrapDialog(ui.input, (title) => title);
		ui.editor = wrapDialog(ui.editor, (title) => title);
		ui.__notifyPatched = true;
		dialogsPatched = true;
	});

	pi.on("message_end", async (event) => {
		if (!isAssistantMessage(event.message) || event.message.stopReason !== "pause_turn") {
			return;
		}

		const lastText = extractLastAssistantText([event.message]);
		const { title, body } = formatNotification(lastText);
		notify(title, body);
	});

	pi.on("agent_end", async (event) => {
		const lastText = extractLastAssistantText(event.messages ?? []);
		const { title, body } = formatNotification(lastText);
		notify(title, body);
	});
}