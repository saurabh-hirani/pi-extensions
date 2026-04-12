/**
 * Minimal vim-mode extension for pi.
 *
 * Supports:
 *   - Escape / ctrl+[: insert → normal mode
 *   - i: normal → insert mode, a: insert after cursor
 *   - w: jump word forward, b: jump word backward
 *   - dw: delete word forward
 *   - D (shift+d): delete to end of line
 *   - h/j/k/l: basic navigation
 *   - 0/$: line start/end, x: delete char
 */

import { CustomEditor, type ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";

type Mode = "normal" | "insert";

class PiVimEditor extends CustomEditor {
	private mode: Mode = "insert";
	private pendingOperator: string | null = null;

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+[")) {
			if (this.pendingOperator) {
				this.pendingOperator = null;
				return;
			}
			if (this.mode === "insert") {
				this.mode = "normal";
				return;
			}
			super.handleInput("\x1b");
			return;
		}

		if (this.mode === "insert") {
			super.handleInput(data);
			return;
		}

		if (this.pendingOperator === "d") {
			this.pendingOperator = null;
			if (data === "w") {
				super.handleInput("\x1bd");
			}
			return;
		}

		switch (data) {
			case "i": this.mode = "insert"; return;
			case "a": this.mode = "insert"; super.handleInput("\x1b[C"); return;
			case "w": super.handleInput("\x1b[1;3C"); return;
			case "b": super.handleInput("\x1b[1;3D"); return;
			case "D": super.handleInput("\x0b"); return;
			case "d": this.pendingOperator = "d"; return;
			case "h": super.handleInput("\x1b[D"); return;
			case "j": super.handleInput("\x1b[B"); return;
			case "k": super.handleInput("\x1b[A"); return;
			case "l": super.handleInput("\x1b[C"); return;
			case "0": super.handleInput("\x01"); return;
			case "$": super.handleInput("\x05"); return;
			case "x": super.handleInput("\x1b[3~"); return;
		}

		if (data.length === 1 && data.charCodeAt(0) >= 32) return;
		super.handleInput(data);
	}

	render(width: number): string[] {
		const lines = super.render(width);
		if (lines.length === 0) return lines;
		const label = this.mode === "normal"
			? (this.pendingOperator ? " d… " : " NORMAL ")
			: " INSERT ";
		const last = lines.length - 1;
		if (visibleWidth(lines[last]!) >= label.length) {
			lines[last] = truncateToWidth(lines[last]!, width - label.length, "") + label;
		}
		return lines;
	}
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		ctx.ui.setEditorComponent((tui, theme, kb) => new PiVimEditor(tui, theme, kb));
		ctx.ui.setStatus("pi-vim", ctx.ui.theme.fg("accent", "vim"));
	});
}
