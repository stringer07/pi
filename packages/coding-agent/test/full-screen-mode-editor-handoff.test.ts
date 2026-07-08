import { describe, expect, it, vi } from "vitest";
import { CombinedAutocompleteProvider, type EditorTheme, type SelectListTheme, TUI } from "../../tui/src/index.ts";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { CustomEditor } from "../src/modes/interactive/components/custom-editor.ts";

const passthrough = (text: string) => text;

const selectListTheme: SelectListTheme = {
	selectedPrefix: passthrough,
	selectedText: passthrough,
	description: passthrough,
	scrollInfo: passthrough,
	noMatch: passthrough,
};

const editorTheme: EditorTheme = {
	borderColor: passthrough,
	selectList: selectListTheme,
};

function createEditor(): CustomEditor {
	return new CustomEditor(new TUI(new VirtualTerminal(40, 24)), editorTheme, KeybindingsManager.create());
}

async function flushAutocomplete(): Promise<void> {
	await Promise.resolve();
	await new Promise((resolve) => setImmediate(resolve));
}

describe("CustomEditor Scroll handoff", () => {
	it("hands Up and Down off only after built-in editor navigation reaches an edge", () => {
		const editor = createEditor();
		const onScrollHandoff = vi.fn();
		editor.onScrollHandoff = onScrollHandoff;
		editor.setText("alpha\nomega");

		editor.handleInput("\x1b[A");
		expect(editor.getCursor()).toEqual({ line: 0, col: 5 });
		expect(onScrollHandoff).not.toHaveBeenCalled();

		editor.handleInput("\x1b[A");
		expect(editor.getCursor()).toEqual({ line: 0, col: 0 });
		expect(onScrollHandoff).not.toHaveBeenCalled();

		editor.handleInput("\x1b[A");
		expect(onScrollHandoff).toHaveBeenCalledTimes(1);
		expect(onScrollHandoff).toHaveBeenLastCalledWith("up");

		editor.handleInput("\x1b[B");
		expect(editor.getCursor()).toEqual({ line: 1, col: 0 });
		expect(onScrollHandoff).toHaveBeenCalledTimes(1);

		editor.handleInput("\x1b[B");
		expect(editor.getCursor()).toEqual({ line: 1, col: 5 });
		expect(onScrollHandoff).toHaveBeenCalledTimes(1);

		editor.handleInput("\x1b[B");
		expect(onScrollHandoff).toHaveBeenCalledTimes(2);
		expect(onScrollHandoff).toHaveBeenLastCalledWith("down");
	});

	it("keeps prompt history browsing ahead of Scroll handoff even when history text matches the draft", () => {
		const editor = createEditor();
		const onScrollHandoff = vi.fn();
		editor.onScrollHandoff = onScrollHandoff;
		editor.addToHistory("draft");
		editor.setText("draft");

		editor.handleInput("\x1b[A");
		expect(editor.getCursor()).toEqual({ line: 0, col: 0 });
		expect(onScrollHandoff).not.toHaveBeenCalled();

		editor.handleInput("\x1b[A");
		expect(editor.getText()).toBe("draft");
		expect(editor.getCursor()).toEqual({ line: 0, col: 0 });
		expect(onScrollHandoff).not.toHaveBeenCalled();

		editor.handleInput("\x1b[B");
		expect(editor.getText()).toBe("draft");
		expect(editor.getCursor()).toEqual({ line: 0, col: 0 });
		expect(onScrollHandoff).not.toHaveBeenCalled();
	});

	it("keeps autocomplete selection ahead of Scroll handoff", async () => {
		const editor = createEditor();
		const onScrollHandoff = vi.fn();
		editor.onScrollHandoff = onScrollHandoff;
		editor.setAutocompleteProvider(
			new CombinedAutocompleteProvider([{ name: "status", description: "Show status" }], process.cwd()),
		);

		editor.handleInput("/");
		await flushAutocomplete();

		expect(editor.isShowingAutocomplete()).toBe(true);

		editor.handleInput("\x1b[A");
		editor.handleInput("\x1b[B");

		expect(onScrollHandoff).not.toHaveBeenCalled();
	});

	it("leaves boundary arrows unchanged when Scroll handoff is not installed", () => {
		const editor = createEditor();
		editor.setText("alpha\nomega");

		editor.handleInput("\x1b[A");
		editor.handleInput("\x1b[A");
		editor.handleInput("\x1b[A");

		expect(editor.getText()).toBe("alpha\nomega");
		expect(editor.getCursor()).toEqual({ line: 0, col: 0 });
	});
});
