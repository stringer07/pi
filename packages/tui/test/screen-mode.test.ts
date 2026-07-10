import assert from "node:assert";
import { describe, it } from "node:test";
import { Editor } from "../src/components/editor.ts";
import { type Component, type Focusable, TUI } from "../src/tui.ts";
import { visibleWidth } from "../src/utils.ts";
import { defaultEditorTheme } from "./test-themes.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

class Lines implements Component {
	private readonly lines: string[];

	constructor(lines: string[]) {
		this.lines = lines;
	}

	render(): string[] {
		return this.lines;
	}

	invalidate(): void {}
}

class MutableLines implements Component {
	private lines: string[];

	constructor(lines: string[]) {
		this.lines = lines;
	}

	setLines(lines: string[]): void {
		this.lines = lines;
	}

	render(): string[] {
		return this.lines;
	}

	invalidate(): void {}
}

class LoggingVirtualTerminal extends VirtualTerminal {
	private writes: string[] = [];

	override write(data: string): void {
		this.writes.push(data);
		super.write(data);
	}

	getWrites(): string {
		return this.writes.join("");
	}
}

class InputRecorder implements Component {
	readonly inputs: string[] = [];

	render(): string[] {
		return [""];
	}

	handleInput(data: string): void {
		this.inputs.push(data);
	}

	invalidate(): void {}
}

class FocusableInputRecorder implements Component, Focusable {
	focused = false;
	readonly inputs: string[] = [];
	private readonly line: string;

	constructor(line: string) {
		this.line = line;
	}

	render(): string[] {
		return [this.line];
	}

	handleInput(data: string): void {
		this.inputs.push(data);
	}

	invalidate(): void {}
}

describe("TUI Screen mode seam", () => {
	it("keeps Scrollback mode out of Full-screen terminal lifecycle sequences", async () => {
		const terminal = new LoggingVirtualTerminal(40, 10);
		const tui = new TUI(terminal);
		tui.addChild(new Lines(["message", "composer"]));
		assert.strictEqual(tui.getScreenMode(), "scrollback");

		tui.start();
		await terminal.waitForRender();
		tui.stop();

		const writes = terminal.getWrites();
		for (const sequence of [
			"\x1b[?1049h",
			"\x1b[?1049l",
			"\x1b[?1000h",
			"\x1b[?1000l",
			"\x1b[?1002h",
			"\x1b[?1002l",
			"\x1b[?1003h",
			"\x1b[?1003l",
			"\x1b[?1006h",
			"\x1b[?1006l",
			"\x1b[?1007h",
			"\x1b[?1007l",
		]) {
			assert.ok(!writes.includes(sequence), `Scrollback mode must not emit ${JSON.stringify(sequence)}`);
		}
	});

	it("keeps Scrollback mode rendering linear when children are assigned to Full-screen regions", async () => {
		const terminal = new VirtualTerminal(40, 8);
		const tui = new TUI(terminal);
		const firstMessage = new Lines(["message viewport 1"]);
		const composer = new Lines(["composer region"]);
		const secondMessage = new Lines(["message viewport 2"]);

		tui.addChild(firstMessage, { region: "message-viewport" });
		tui.addChild(composer, { region: "composer-region" });
		tui.addChild(secondMessage, { region: "message-viewport" });

		assert.strictEqual(tui.getScreenRegion(firstMessage), "message-viewport");
		assert.strictEqual(tui.getScreenRegion(composer), "composer-region");
		assert.strictEqual(tui.getScreenRegion(secondMessage), "message-viewport");

		tui.start();
		await terminal.waitForRender();

		assert.deepStrictEqual(terminal.getViewport().slice(0, 4), [
			"message viewport 1",
			"composer region",
			"message viewport 2",
			"",
		]);

		tui.stop();
	});

	it("enters alternate screen and restores the previous terminal view in Full-screen mode", async () => {
		const terminal = new LoggingVirtualTerminal(40, 8);
		terminal.write("shell prompt");
		await terminal.flush();
		const initialViewport = terminal.getViewport();

		const tui = new TUI(terminal, undefined, { screenMode: "full-screen" });
		tui.addChild(new Lines(["full-screen message", "composer"]));

		tui.start();
		await terminal.waitForRender();

		assert.ok(terminal.getWrites().includes("\x1b[?1049h"), "Full-screen mode must enter alternate screen");
		assert.ok(
			terminal.getViewport().some((line) => line.includes("full-screen message")),
			"Full-screen mode must render into the alternate screen",
		);

		tui.stop();
		await terminal.flush();

		assert.ok(terminal.getWrites().includes("\x1b[?1049l"), "Full-screen mode must exit alternate screen");
		assert.deepStrictEqual(terminal.getViewport().slice(0, 2), initialViewport.slice(0, 2));
		assert.ok(
			!terminal.getScrollBuffer().some((line) => line.includes("full-screen message")),
			"Full-screen content must not be replayed into main scrollback",
		);
	});

	it("does not enable pointer terminal protocols unless requested", async () => {
		const terminal = new LoggingVirtualTerminal(40, 8);
		const tui = new TUI(terminal, undefined, { screenMode: "full-screen" });

		tui.addChild(new Lines(["message"]), { region: "message-viewport" });
		tui.addChild(new Lines(["editor"]), { region: "composer-region" });

		tui.start();
		await terminal.waitForRender();
		tui.stop();

		const writes = terminal.getWrites();
		assert.ok(!writes.includes("\x1b[?1000h"), "Full-screen mode must not enable button mouse reporting by default");
		assert.ok(!writes.includes("\x1b[?1006h"), "Full-screen mode must not enable SGR mouse reporting by default");
		assert.ok(!writes.includes("\x1b[?1000l"), "Full-screen mode must not disable inactive button mouse reporting");
		assert.ok(!writes.includes("\x1b[?1006l"), "Full-screen mode must not disable inactive SGR mouse reporting");
		assert.ok(!writes.includes("\x1b[?1007h"), "Full-screen mode must not enable ambiguous alternate-scroll input");
		assert.ok(!writes.includes("\x1b[?1007l"), "Full-screen mode must not disable inactive alternate-scroll");
	});

	it("enables mouse reporting only while requested Full-screen mode is active", async () => {
		const terminal = new LoggingVirtualTerminal(40, 8);
		const tui = new TUI(terminal, undefined, { screenMode: "full-screen", fullScreenMouseReporting: true });

		tui.addChild(new Lines(["message"]), { region: "message-viewport" });
		tui.addChild(new Lines(["editor"]), { region: "composer-region" });

		tui.start();
		await terminal.waitForRender();
		tui.stop();

		const writes = terminal.getWrites();
		assert.ok(writes.includes("\x1b[?1000h"), "Full-screen mode must enable button mouse reporting when requested");
		assert.ok(writes.includes("\x1b[?1002h"), "Full-screen mode must enable drag mouse reporting when requested");
		assert.ok(writes.includes("\x1b[?1006h"), "Full-screen mode must enable SGR mouse reporting when requested");
		assert.ok(writes.includes("\x1b[?1000l"), "Full-screen mode must disable button mouse reporting on stop");
		assert.ok(writes.includes("\x1b[?1002l"), "Full-screen mode must disable drag mouse reporting on stop");
		assert.ok(writes.includes("\x1b[?1006l"), "Full-screen mode must disable SGR mouse reporting on stop");
		assert.ok(
			!writes.includes("\x1b[?1007h"),
			"Full-screen mode must not enable alternate-scroll with mouse reporting",
		);
		assert.ok(!writes.includes("\x1b[?1007l"), "Full-screen mode must not disable inactive alternate-scroll");
	});

	it("restores Full-screen terminal state across stop/start cycles without resetting the historical Message viewport", async () => {
		const terminal = new LoggingVirtualTerminal(40, 6);
		terminal.write("shell prompt");
		await terminal.flush();
		const initialViewport = terminal.getViewport().slice(0, 1);
		const tui = new TUI(terminal, undefined, { screenMode: "full-screen" });

		tui.addChild(new Lines(["message 1", "message 2", "message 3", "message 4", "message 5", "message 6"]), {
			region: "message-viewport",
		});
		tui.addChild(new Lines(["editor", "footer"]), { region: "composer-region" });

		tui.start();
		await terminal.waitForRender();
		assert.strictEqual(tui.pageMessageViewportUp(), true);
		await terminal.waitForRender();
		const historicalViewport = terminal.getViewport().slice(0, 4);

		tui.stop();
		await terminal.flush();
		assert.deepStrictEqual(terminal.getViewport().slice(0, 1), initialViewport);

		tui.start();
		await terminal.waitForRender();
		assert.deepStrictEqual(terminal.getViewport().slice(0, 4), historicalViewport);

		tui.stop();
		await terminal.flush();

		const writes = terminal.getWrites();
		for (const sequence of ["\x1b[?1049h", "\x1b[?1049l"]) {
			const count = writes.split(sequence).length - 1;
			assert.strictEqual(count, 2, `Expected ${JSON.stringify(sequence)} twice across stop/start cycles`);
		}
		assert.ok(
			!terminal.getScrollBuffer().some((line) => line.includes("message 6")),
			"Full-screen restart cycles must not dump session content into main scrollback",
		);
	});

	it("anchors the Composer region at the bottom and bottom-aligns short Message viewport content", async () => {
		const terminal = new VirtualTerminal(40, 8);
		const tui = new TUI(terminal, undefined, { screenMode: "full-screen" });

		tui.addChild(new Lines(["header", "chat transcript"]), { region: "message-viewport" });
		tui.addChild(new Lines(["pending", "editor", "footer"]), { region: "composer-region" });

		tui.start();
		await terminal.waitForRender();

		assert.deepStrictEqual(terminal.getViewport(), [
			"",
			"",
			"",
			"header",
			"chat transcript",
			"pending",
			"editor",
			"footer",
		]);

		tui.stop();
	});

	it("absorbs trailing blank Message viewport lines at the Composer region boundary", async () => {
		const terminal = new VirtualTerminal(40, 6);
		const tui = new TUI(terminal, undefined, { screenMode: "full-screen" });

		tui.addChild(new Lines(["message 1", "message 2", ""]), { region: "message-viewport" });
		tui.addChild(new Lines(["editor", "footer"]), { region: "composer-region" });

		tui.start();
		await terminal.waitForRender();

		assert.deepStrictEqual(terminal.getViewport(), ["", "", "message 1", "message 2", "editor", "footer"]);

		tui.stop();
	});

	it("shrinks the Message viewport before the Composer region and restores the layout after resize", async () => {
		const terminal = new VirtualTerminal(40, 4);
		const tui = new TUI(terminal, undefined, { screenMode: "full-screen" });

		tui.addChild(new Lines(["message 1", "message 2", "message 3"]), { region: "message-viewport" });
		tui.addChild(new Lines(["editor", "footer"]), { region: "composer-region" });

		tui.start();
		await terminal.waitForRender();

		assert.deepStrictEqual(terminal.getViewport(), ["message 2", "message 3", "editor", "footer"]);

		terminal.resize(40, 6);
		await terminal.waitForRender();

		assert.deepStrictEqual(terminal.getViewport(), ["", "message 1", "message 2", "message 3", "editor", "footer"]);

		tui.stop();
	});

	it("starts the Message viewport at the bottom and supports page navigation back to the live bottom", async () => {
		const terminal = new VirtualTerminal(40, 5);
		const tui = new TUI(terminal, undefined, { screenMode: "full-screen" });

		tui.addChild(new Lines(["message 1", "message 2", "message 3", "message 4", "message 5"]), {
			region: "message-viewport",
		});
		tui.addChild(new Lines(["editor", "footer"]), { region: "composer-region" });

		tui.start();
		await terminal.waitForRender();

		assert.deepStrictEqual(terminal.getViewport(), ["message 3", "message 4", "message 5", "editor", "footer"]);

		assert.strictEqual(tui.pageMessageViewportUp(), true);
		await terminal.waitForRender();
		assert.deepStrictEqual(terminal.getViewport(), [
			"message 1",
			"message 2",
			"message 3 · ↓ Newer below",
			"editor",
			"footer",
		]);

		assert.strictEqual(tui.pageMessageViewportDown(), true);
		await terminal.waitForRender();
		assert.deepStrictEqual(terminal.getViewport(), ["message 3", "message 4", "message 5", "editor", "footer"]);

		assert.strictEqual(tui.pageMessageViewportUp(), true);
		await terminal.waitForRender();
		assert.strictEqual(tui.jumpMessageViewportToBottom(), true);
		await terminal.waitForRender();
		assert.deepStrictEqual(terminal.getViewport(), ["message 3", "message 4", "message 5", "editor", "footer"]);

		tui.stop();
	});

	it("keeps appended content visible at the live bottom in Full-screen mode", async () => {
		const terminal = new VirtualTerminal(50, 5);
		const tui = new TUI(terminal, undefined, { screenMode: "full-screen" });
		const messages = new MutableLines(["message 1", "message 2", "message 3"]);

		tui.addChild(messages, { region: "message-viewport" });
		tui.addChild(new Lines(["editor", "footer"]), { region: "composer-region" });

		tui.start();
		await terminal.waitForRender();
		assert.deepStrictEqual(terminal.getViewport(), ["message 1", "message 2", "message 3", "editor", "footer"]);

		messages.setLines(["message 1", "message 2", "message 3", "message 4", "message 5"]);
		tui.requestRender();
		await terminal.waitForRender();
		assert.deepStrictEqual(terminal.getViewport(), ["message 3", "message 4", "message 5", "editor", "footer"]);

		tui.stop();
	});

	it("preserves the historical Message viewport view and shows a New content indicator while scrolled up", async () => {
		const terminal = new VirtualTerminal(50, 5);
		const tui = new TUI(terminal, undefined, { screenMode: "full-screen" });
		const messages = new MutableLines(["message 1", "message 2", "message 3", "message 4", "message 5"]);

		tui.setFullScreenMessageViewportJumpToBottomKeyDisplay("Ctrl+Down");
		tui.addChild(messages, { region: "message-viewport" });
		tui.addChild(new Lines(["editor", "footer"]), { region: "composer-region" });

		tui.start();
		await terminal.waitForRender();
		assert.strictEqual(tui.pageMessageViewportUp(), true);
		await terminal.waitForRender();
		assert.deepStrictEqual(terminal.getViewport(), [
			"message 1",
			"message 2",
			"message 3 · ↓ Newer below",
			"editor",
			"footer",
		]);

		messages.setLines(["message 1", "message 2", "message 3", "message 4", "message 5", "message 6", "message 7"]);
		tui.requestRender();
		await terminal.waitForRender();

		assert.strictEqual(terminal.getViewport()[0], "message 1");
		assert.strictEqual(terminal.getViewport()[1], "message 2");
		assert.strictEqual(terminal.getViewport()[2], "message 3 · ↓ New content below · Ctrl+Down");

		tui.stop();
	});

	it("shows a New content indicator for same-line updates below a historical Message viewport", async () => {
		const terminal = new VirtualTerminal(50, 5);
		const tui = new TUI(terminal, undefined, { screenMode: "full-screen" });
		const messages = new MutableLines(["message 1", "message 2", "message 3", "streaming old", "message 5"]);

		tui.setFullScreenMessageViewportJumpToBottomKeyDisplay("Ctrl+Down");
		tui.addChild(messages, { region: "message-viewport" });
		tui.addChild(new Lines(["editor", "footer"]), { region: "composer-region" });

		tui.start();
		await terminal.waitForRender();
		assert.strictEqual(tui.pageMessageViewportUp(), true);
		await terminal.waitForRender();
		assert.deepStrictEqual(terminal.getViewport(), [
			"message 1",
			"message 2",
			"message 3 · ↓ Newer below",
			"editor",
			"footer",
		]);

		messages.setLines(["message 1", "message 2", "message 3", "streaming updated", "message 5"]);
		tui.requestRender();
		await terminal.waitForRender();

		assert.deepStrictEqual(terminal.getViewport(), [
			"message 1",
			"message 2",
			"message 3 · ↓ New content below · Ctrl+Down",
			"editor",
			"footer",
		]);

		tui.stop();
	});

	it("keeps the New content indicator visible when the boundary message fills the terminal width", async () => {
		const terminal = new VirtualTerminal(50, 5);
		const tui = new TUI(terminal, undefined, { screenMode: "full-screen" });
		const messages = new MutableLines(["message 1", "message 2", "x".repeat(50), "message 4", "message 5"]);

		tui.setFullScreenMessageViewportJumpToBottomKeyDisplay("Ctrl+Down");
		tui.addChild(messages, { region: "message-viewport" });
		tui.addChild(new Lines(["editor", "footer"]), { region: "composer-region" });

		tui.start();
		await terminal.waitForRender();
		assert.strictEqual(tui.pageMessageViewportUp(), true);
		await terminal.waitForRender();

		messages.setLines(["message 1", "message 2", "x".repeat(50), "message 4", "message 5", "message 6", "message 7"]);
		tui.requestRender();
		await terminal.waitForRender();

		const boundaryLine = terminal.getViewport()[2] ?? "";
		assert.ok(boundaryLine.endsWith("↓ New content below · Ctrl+Down"));
		assert.ok(visibleWidth(boundaryLine) <= terminal.columns);

		tui.stop();
	});

	it("shows older and newer boundary hints only while scrolled away from the live bottom", async () => {
		const terminal = new VirtualTerminal(50, 5);
		const tui = new TUI(terminal, undefined, { screenMode: "full-screen" });

		tui.addChild(
			new Lines([
				"message 1",
				"message 2",
				"message 3",
				"message 4",
				"message 5",
				"message 6",
				"message 7",
				"message 8",
			]),
			{ region: "message-viewport" },
		);
		tui.addChild(new Lines(["editor", "footer"]), { region: "composer-region" });

		tui.start();
		await terminal.waitForRender();
		assert.deepStrictEqual(terminal.getViewport(), ["message 6", "message 7", "message 8", "editor", "footer"]);

		assert.strictEqual(tui.pageMessageViewportUp(), true);
		await terminal.waitForRender();
		assert.strictEqual(terminal.getViewport()[0], "↑ Older above · message 3");
		assert.strictEqual(terminal.getViewport()[1], "message 4");
		assert.strictEqual(terminal.getViewport()[2], "message 5 · ↓ Newer below");

		tui.stop();
	});

	it("composites overlays above both Full-screen regions", async () => {
		const terminal = new VirtualTerminal(24, 6);
		const tui = new TUI(terminal, undefined, { screenMode: "full-screen" });

		tui.addChild(new Lines(["message 1", "message 2", "message 3", "message 4"]), { region: "message-viewport" });
		tui.addChild(new Lines(["editor", "footer"]), { region: "composer-region" });
		tui.showOverlay(new Lines(["overlay top", "overlay bottom"]), { row: 3, col: 0, width: 14 });

		tui.start();
		await terminal.waitForRender();

		const viewport = terminal.getViewport();
		assert.deepStrictEqual(viewport.slice(0, 3), ["message 1", "message 2", "message 3"]);
		assert.strictEqual(viewport[3]?.trimEnd(), "overlay top");
		assert.strictEqual(viewport[4]?.trimEnd(), "overlay bottom");
		assert.strictEqual(viewport[5], "footer");

		tui.stop();
	});

	it("keeps capturing and non-capturing overlay focus semantics in Full-screen mode", async () => {
		const terminal = new VirtualTerminal(30, 6);
		const tui = new TUI(terminal, undefined, { screenMode: "full-screen" });
		const editor = new FocusableInputRecorder("editor");
		const capturingOverlay = new FocusableInputRecorder("capturing");
		const nonCapturingOverlay = new FocusableInputRecorder("non-capturing");

		tui.addChild(new Lines(["message 1", "message 2", "message 3", "message 4"]), { region: "message-viewport" });
		tui.addChild(editor, { region: "composer-region" });
		tui.addChild(new Lines(["footer"]), { region: "composer-region" });
		tui.setFocus(editor);

		tui.start();
		await terminal.waitForRender();

		tui.showOverlay(capturingOverlay, { row: 4, col: 0, width: 12 });
		await terminal.waitForRender();
		assert.strictEqual(capturingOverlay.focused, true);
		assert.strictEqual(editor.focused, false);

		tui.hideOverlay();
		await terminal.waitForRender();
		assert.strictEqual(editor.focused, true);

		tui.showOverlay(nonCapturingOverlay, { row: 4, col: 0, width: 16, nonCapturing: true });
		await terminal.waitForRender();
		assert.strictEqual(editor.focused, true);
		assert.strictEqual(nonCapturingOverlay.focused, false);

		terminal.sendInput("x");
		await terminal.waitForRender();
		assert.deepStrictEqual(editor.inputs, ["x"]);
		assert.deepStrictEqual(nonCapturingOverlay.inputs, []);

		tui.stop();
	});

	it("lets visible Full-screen overlays handle wheel input without scrolling the Message viewport", async () => {
		const terminal = new VirtualTerminal(30, 6);
		const tui = new TUI(terminal, undefined, { screenMode: "full-screen", fullScreenMouseReporting: true });
		const overlay = new FocusableInputRecorder("overlay");
		const wheelOverOverlay = "\x1b[<64;5;6M";

		tui.addChild(new Lines(["message 1", "message 2", "message 3", "message 4", "message 5", "message 6"]), {
			region: "message-viewport",
		});
		tui.addChild(new FocusableInputRecorder("editor"), { region: "composer-region" });
		tui.addChild(new Lines(["footer"]), { region: "composer-region" });

		tui.start();
		await terminal.waitForRender();
		const initialMessageViewport = terminal.getViewport().slice(0, 4);

		tui.showOverlay(overlay, { row: 5, col: 0, width: 12 });
		await terminal.waitForRender();
		terminal.sendInput(wheelOverOverlay);
		await terminal.waitForRender();

		assert.deepStrictEqual(overlay.inputs, [wheelOverOverlay]);
		assert.deepStrictEqual(terminal.getViewport().slice(0, 4), initialMessageViewport);

		tui.stop();
	});

	it("forwards Up and Down to the focused component without mouse reporting", async () => {
		const terminal = new VirtualTerminal(40, 8);
		const tui = new TUI(terminal, undefined, { screenMode: "full-screen" });
		const recorder = new InputRecorder();

		tui.addChild(new Lines(["message 1", "message 2", "message 3", "message 4", "message 5", "message 6"]), {
			region: "message-viewport",
		});
		tui.addChild(recorder, { region: "composer-region" });
		tui.addChild(new Lines(["footer"]), { region: "composer-region" });
		tui.setFocus(recorder);

		tui.start();
		await terminal.waitForRender();
		terminal.sendInput("\x1b[A");
		terminal.sendInput("\x1b[B");
		assert.deepStrictEqual(recorder.inputs, ["\x1b[A", "\x1b[B"]);

		tui.stop();
	});

	it("routes non-consumed wheel input by pointer location in Full-screen mode", async () => {
		const terminal = new VirtualTerminal(40, 12);
		const tui = new TUI(terminal, undefined, { screenMode: "full-screen", fullScreenMouseReporting: true });
		const editor = new Editor(tui, defaultEditorTheme);
		const listenerInputs: string[] = [];
		const wheelOverMessageViewport = "\x1b[<64;5;2M";
		const wheelOverEditor = "\x1b[<64;5;7M";
		const wheelOverFooter = "\x1b[<64;5;12M";

		editor.setText(
			["draft 1", "draft 2", "draft 3", "draft 4", "draft 5", "draft 6", "draft 7", "draft 8"].join("\n"),
		);
		tui.setFullScreenPointerScrollTarget(editor, {
			scrollUp: () => editor.scrollViewUp(),
			scrollDown: () => editor.scrollViewDown(),
		});
		tui.addInputListener((data) => {
			listenerInputs.push(data);
			return undefined;
		});
		tui.addChild(new Lines(["message 1", "message 2", "message 3", "message 4", "message 5", "message 6"]), {
			region: "message-viewport",
		});
		tui.addChild(editor, { region: "composer-region" });
		tui.addChild(new Lines(["footer"]), { region: "composer-region" });
		tui.setFocus(editor);

		tui.start();
		await terminal.waitForRender();
		assert.deepStrictEqual(terminal.getViewport().slice(0, 4), ["message 3", "message 4", "message 5", "message 6"]);

		terminal.sendInput(wheelOverMessageViewport);
		await terminal.waitForRender();
		assert.deepStrictEqual(terminal.getViewport().slice(0, 4), [
			"↑ Older above · message 2",
			"message 3",
			"message 4",
			"message 5 · ↓ Newer below",
		]);

		terminal.sendInput(wheelOverEditor);
		await terminal.waitForRender();
		const afterEditorScroll = terminal.getViewport();
		assert.ok(afterEditorScroll[4]?.includes("↑ 2 more"));
		assert.strictEqual(afterEditorScroll[5]?.trimEnd(), "draft 3");
		assert.strictEqual(afterEditorScroll[9]?.trimEnd(), "draft 7");
		assert.ok(afterEditorScroll[10]?.includes("↓ 1 more"));

		const editorViewportBeforeFooterWheel = afterEditorScroll.slice(4, 11);
		terminal.sendInput(wheelOverFooter);
		await terminal.waitForRender();
		assert.deepStrictEqual(terminal.getViewport().slice(4, 11), editorViewportBeforeFooterWheel);
		assert.deepStrictEqual(listenerInputs, [wheelOverMessageViewport, wheelOverEditor, wheelOverFooter]);

		tui.stop();
	});

	it("supports pointer scrolling and app-owned text selection in the same Full-screen mode", async () => {
		const terminal = new VirtualTerminal(40, 7);
		const tui = new TUI(terminal, undefined, { screenMode: "full-screen", fullScreenMouseReporting: true });
		const selectedTexts: string[] = [];

		tui.setFullScreenSelectionHandler((text) => {
			selectedTexts.push(text);
		});
		tui.addChild(
			new Lines(["message 1", "message 2", "message 3", "message 4", "message 5", "message 6", "message 7"]),
			{ region: "message-viewport" },
		);
		tui.addChild(new Lines(["editor"]), { region: "composer-region" });

		tui.start();
		await terminal.waitForRender();
		assert.deepStrictEqual(terminal.getViewport().slice(0, 6), [
			"message 2",
			"message 3",
			"message 4",
			"message 5",
			"message 6",
			"message 7",
		]);

		terminal.sendInput("\x1b[<64;5;2M");
		await terminal.waitForRender();
		assert.deepStrictEqual(terminal.getViewport().slice(0, 6), [
			"message 1",
			"message 2",
			"message 3",
			"message 4",
			"message 5",
			"message 6 · ↓ Newer below",
		]);

		terminal.sendInput("\x1b[<0;1;2M");
		terminal.sendInput("\x1b[<32;9;2M");
		terminal.sendInput("\x1b[<0;9;2m");
		await terminal.waitForRender();

		assert.deepStrictEqual(selectedTexts, ["message 2"]);

		tui.stop();
	});

	it("keeps full-width lines within bounds while rendering a non-zero-column selection", async () => {
		const terminal = new VirtualTerminal(130, 4);
		const tui = new TUI(terminal, undefined, { screenMode: "full-screen", fullScreenMouseReporting: true });

		tui.addChild(new Lines(["a".repeat(130)]), { region: "message-viewport" });
		tui.addChild(new Lines(["editor"]), { region: "composer-region" });

		tui.start();
		await terminal.waitForRender();

		terminal.sendInput("\x1b[<0;9;3M");
		terminal.sendInput("\x1b[<32;14;3M");
		await terminal.waitForRender();

		assert.strictEqual(terminal.getViewport()[2]?.length, 130);

		tui.stop();
	});

	it("lets input listeners consume wheel input before built-in pointer routing", async () => {
		const terminal = new VirtualTerminal(40, 12);
		const tui = new TUI(terminal, undefined, { screenMode: "full-screen", fullScreenMouseReporting: true });
		const editor = new Editor(tui, defaultEditorTheme);
		const wheelEvent = "\x1b[<64;5;2M";

		editor.setText(["draft 1", "draft 2", "draft 3", "draft 4", "draft 5", "draft 6"].join("\n"));
		tui.setFullScreenPointerScrollTarget(editor, {
			scrollUp: () => editor.scrollViewUp(),
			scrollDown: () => editor.scrollViewDown(),
		});
		tui.addInputListener((data) => ({ consume: data === wheelEvent }));
		tui.addChild(new Lines(["message 1", "message 2", "message 3", "message 4", "message 5", "message 6"]), {
			region: "message-viewport",
		});
		tui.addChild(editor, { region: "composer-region" });
		tui.setFocus(editor);

		tui.start();
		await terminal.waitForRender();
		const initialViewport = terminal.getViewport();

		terminal.sendInput(wheelEvent);
		await terminal.waitForRender();
		assert.deepStrictEqual(terminal.getViewport(), initialViewport);

		tui.stop();
	});

	it("ignores non-wheel mouse input after listeners run in Full-screen mode", async () => {
		const terminal = new VirtualTerminal(40, 8);
		const tui = new TUI(terminal, undefined, { screenMode: "full-screen", fullScreenMouseReporting: true });
		const recorder = new InputRecorder();
		const listenerInputs: string[] = [];
		const clickEvent = "\x1b[<0;5;2M";
		const dragEvent = "\x1b[<35;5;2m";

		tui.addInputListener((data) => {
			listenerInputs.push(data);
			return undefined;
		});
		tui.addChild(new Lines(["message 1", "message 2", "message 3"]), { region: "message-viewport" });
		tui.addChild(recorder, { region: "composer-region" });
		tui.setFocus(recorder);

		tui.start();
		await terminal.waitForRender();

		terminal.sendInput(clickEvent);
		terminal.sendInput(dragEvent);

		assert.deepStrictEqual(listenerInputs, [clickEvent, dragEvent]);
		assert.deepStrictEqual(recorder.inputs, []);

		tui.stop();
	});

	it("leaves raw mouse input unchanged in Scrollback mode", async () => {
		const terminal = new VirtualTerminal(40, 8);
		const tui = new TUI(terminal);
		const recorder = new InputRecorder();
		const wheelEvent = "\x1b[<64;5;2M";

		tui.addChild(recorder);
		tui.setFocus(recorder);
		tui.start();
		await terminal.waitForRender();

		terminal.sendInput(wheelEvent);

		assert.deepStrictEqual(recorder.inputs, [wheelEvent]);

		tui.stop();
	});
});
