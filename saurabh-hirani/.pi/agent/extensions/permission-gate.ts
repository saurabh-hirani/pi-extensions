/**
 * Permission Gate Extension
 *
 * Prompts for confirmation before write/edit/delete operations.
 * Read operations (read, grep, find, ls) are allowed automatically.
 * Supports granular session allowances: per-file, per-directory, or all.
 *
 * Writes inside allowedDirs are auto-allowed. Everything else prompts.
 * Edit the allowedDirs array below to match your setup.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { resolve, dirname } from "node:path";
import { readFileSync, existsSync, writeFileSync, mkdtempSync, unlinkSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";

interface Config {
	allowedDirs: string[];
	destructiveBashCommands: string[];
}

function stripJsoncComments(text: string): string {
	return text.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
}

function loadConfig(extensionDir: string): Config {
	try {
		const raw = readFileSync(`${extensionDir}/permission-gate.jsonc`, "utf-8");
		return JSON.parse(stripJsoncComments(raw));
	} catch {
		return { allowedDirs: [], destructiveBashCommands: [] };
	}
}

function buildPatterns(commands: string[]): { pattern: RegExp; label: string }[] {
	return commands.map((cmd) => {
		if (cmd === ">") return { pattern: />/, label: "redirect" };
		if (cmd.includes(" ")) {
			const escaped = cmd.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
			return { pattern: new RegExp(`\\b${escaped}`), label: cmd };
		}
		return { pattern: new RegExp(`\\b${cmd}\\b`), label: cmd };
	});
}

/**
 * Build the proposed new content for a file based on the tool operation.
 * For "write", returns the new content directly.
 * For "edit", applies all edits to the existing file content.
 */
function buildProposedContent(toolName: string, input: Record<string, unknown>, absPath: string): string {
	let existing = "";
	try {
		if (existsSync(absPath)) {
			existing = readFileSync(absPath, "utf-8");
		}
	} catch {}

	if (toolName === "write") {
		return (input.content as string) ?? "";
	}

	if (toolName === "edit") {
		const edits = (input.edits as Array<{ oldText: string; newText: string }>) ?? [];
		let result = existing;
		for (const edit of edits) {
			result = result.replace(edit.oldText, edit.newText);
		}
		return result;
	}

	return existing;
}

/**
 * Open vimdiff with the original file and proposed content, then return.
 */
function showVimdiff(absPath: string, proposedContent: string): void {
	const tmpDir = mkdtempSync(join(tmpdir(), "pi-gate-"));
	const ext = absPath.includes(".") ? absPath.slice(absPath.lastIndexOf(".")) : "";
	const originalFile = existsSync(absPath) ? absPath : join(tmpDir, `empty${ext}`);
	const proposedFile = join(tmpDir, `proposed${ext}`);

	try {
		if (!existsSync(absPath)) {
			writeFileSync(originalFile, "");
		}
		writeFileSync(proposedFile, proposedContent);
		execSync(`nvim -d -R "${originalFile}" "${proposedFile}"`, { stdio: "inherit" });
	} finally {
		try { unlinkSync(proposedFile); } catch {}
		if (!existsSync(absPath)) {
			try { unlinkSync(originalFile); } catch {}
		}
		try { rmdirSync(tmpDir); } catch {}
	}
}

export default function (pi: ExtensionAPI) {
	const home = process.env.HOME ?? "";
	const extDir = dirname(new URL(import.meta.url).pathname);
	const config = loadConfig(extDir);
	const allowedDirs = config.allowedDirs.map((d) => d.replace(/^~/, home));
	const destructiveBashPatterns = buildPatterns(config.destructiveBashCommands);

	const sessionAllowedTools = new Set<string>();
	const sessionAllowedDirs = new Map<string, Set<string>>();
	const sessionAllowedFiles = new Map<string, Set<string>>();

	function isInAllowedDir(path: string): boolean {
		const abs = resolve(path);
		return allowedDirs.some((dir) => abs.startsWith(dir + "/") || abs === dir);
	}

	function isSessionAllowed(toolName: string, path: string): boolean {
		if (sessionAllowedTools.has(toolName)) return true;

		const abs = resolve(path);
		const files = sessionAllowedFiles.get(toolName);
		if (files?.has(abs)) return true;

		const dirs = sessionAllowedDirs.get(toolName);
		if (dirs) {
			for (const dir of dirs) {
				if (abs.startsWith(dir + "/") || abs === dir) return true;
			}
		}
		return false;
	}

	function addSessionFile(toolName: string, path: string) {
		const abs = resolve(path);
		if (!sessionAllowedFiles.has(toolName)) sessionAllowedFiles.set(toolName, new Set());
		sessionAllowedFiles.get(toolName)!.add(abs);
	}

	function addSessionDir(toolName: string, path: string) {
		const abs = dirname(resolve(path));
		if (!sessionAllowedDirs.has(toolName)) sessionAllowedDirs.set(toolName, new Set());
		sessionAllowedDirs.get(toolName)!.add(abs);
	}

	pi.on("session_start", async () => {
		sessionAllowedTools.clear();
		sessionAllowedDirs.clear();
		sessionAllowedFiles.clear();
	});

	// /permissions — view and manage session allowances
	pi.registerCommand("permissions", {
		description: "View and manage session permission allowances",
		handler: async (_args, ctx) => {
			const lines: string[] = [];

			if (sessionAllowedTools.size > 0) {
				lines.push("Session-wide:");
				for (const t of sessionAllowedTools) lines.push(`  ${t}`);
			}
			if (sessionAllowedDirs.size > 0) {
				lines.push("Directories:");
				for (const [tool, dirs] of sessionAllowedDirs) {
					for (const d of dirs) lines.push(`  ${tool}: ${d}`);
				}
			}
			if (sessionAllowedFiles.size > 0) {
				lines.push("Files:");
				for (const [tool, files] of sessionAllowedFiles) {
					for (const f of files) lines.push(`  ${tool}: ${f}`);
				}
			}

			if (lines.length === 0) {
				ctx.ui.notify("No session allowances set.", "info");
				return;
			}

			const choice = await ctx.ui.select(
				`Current allowances:\n\n${lines.join("\n")}`,
				["Keep all", "Reset all", "Remove one"]
			);

			if (choice === "Reset all") {
				sessionAllowedTools.clear();
				sessionAllowedDirs.clear();
				sessionAllowedFiles.clear();
				ctx.ui.notify("All session allowances cleared.", "info");
			} else if (choice === "Remove one") {
				const items: string[] = [];
				for (const t of sessionAllowedTools) items.push(`session: ${t}`);
				for (const [tool, dirs] of sessionAllowedDirs) {
					for (const d of dirs) items.push(`dir: ${tool}: ${d}`);
				}
				for (const [tool, files] of sessionAllowedFiles) {
					for (const f of files) items.push(`file: ${tool}: ${f}`);
				}

				const pick = await ctx.ui.select("Remove which allowance?", items);
				if (pick?.startsWith("session: ")) {
					sessionAllowedTools.delete(pick.slice(9));
				} else if (pick?.startsWith("dir: ")) {
					const rest = pick.slice(5);
					const [tool, ...parts] = rest.split(": ");
					const dir = parts.join(": ");
					sessionAllowedDirs.get(tool)?.delete(dir);
				} else if (pick?.startsWith("file: ")) {
					const rest = pick.slice(6);
					const [tool, ...parts] = rest.split(": ");
					const file = parts.join(": ");
					sessionAllowedFiles.get(tool)?.delete(file);
				}
				if (pick) ctx.ui.notify("Allowance removed.", "info");
			}
		},
	});

	pi.on("tool_call", async (event, ctx) => {
		if (["read", "grep", "find", "ls"].includes(event.toolName)) return undefined;

		if (event.toolName === "write" || event.toolName === "edit") {
			const path = (event.input as { path?: string }).path ?? "unknown";

			if (isInAllowedDir(path)) return undefined;
			if (isSessionAllowed(event.toolName, path)) return undefined;

			if (!ctx.hasUI) {
				return { block: true, reason: `${event.toolName} blocked (no UI for confirmation)` };
			}

			// Show vimdiff of original vs proposed
			const absPath = resolve(path);
			const proposedContent = buildProposedContent(event.toolName, event.input, absPath);
			showVimdiff(absPath, proposedContent);

			const dir = dirname(absPath);
			const choice = await ctx.ui.select(
				`✏️  ${event.toolName}: ${path}\n\nAllow?`,
				["Yes", `Yes for ${path}`, `Yes for ${dir}`, "Yes for this session", "No"]
			);

			if (choice === `Yes for ${path}`) {
				addSessionFile(event.toolName, path);
				return undefined;
			}
			if (choice === `Yes for ${dir}`) {
				addSessionDir(event.toolName, path);
				return undefined;
			}
			if (choice === "Yes for this session") {
				sessionAllowedTools.add(event.toolName);
				return undefined;
			}
			if (choice !== "Yes") {
				return { block: true, reason: "Blocked by user" };
			}
			return undefined;
		}

		if (event.toolName === "bash") {
			const command = event.input.command as string;
			const matched = destructiveBashPatterns.filter((p) => p.pattern.test(command));

			if (matched.length === 0) return undefined;
			if (sessionAllowedTools.has("bash-all")) return undefined;

			// Check if all matched commands are individually allowed
			const unallowed = matched.filter((m) => !sessionAllowedTools.has(`bash:${m.label}`));
			if (unallowed.length === 0) return undefined;

			if (!ctx.hasUI) {
				return { block: true, reason: "Destructive bash command blocked (no UI for confirmation)" };
			}

			const labels = unallowed.map((m) => m.label).join(", ");
			const choice = await ctx.ui.select(
				`⚠️  bash (${labels}): ${command}\n\nAllow?`,
				["Yes", `Yes for ${labels} this session`, "Yes for all bash this session", "No"]
			);

			if (choice === `Yes for ${labels} this session`) {
				for (const m of unallowed) sessionAllowedTools.add(`bash:${m.label}`);
				return undefined;
			}
			if (choice === "Yes for all bash this session") {
				sessionAllowedTools.add("bash-all");
				return undefined;
			}
			if (choice !== "Yes") {
				return { block: true, reason: "Blocked by user" };
			}
			return undefined;
		}

		return undefined;
	});
}
