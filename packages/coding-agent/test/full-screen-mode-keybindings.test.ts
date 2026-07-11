import { describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { InteractiveMode, resolveFullScreenMouseReporting } from "../src/modes/interactive/interactive-mode.ts";

type FakeInteractiveMode = {
	defaultEditor: ReturnType<typeof createFakeEditor>;
	editor: ReturnType<typeof createFakeEditor>;
	editorContainer: {
		clear: ReturnType<typeof vi.fn>;
		addChild: ReturnType<typeof vi.fn>;
	};
	keybindings: KeybindingsManager;
	autocompleteProvider?: { name: string };
	editorComponentFactory?: unknown;
	ui: {
		onDebug: undefined;
		getScreenMode: () => "scrollback" | "full-screen";
		pageMessageViewportUp: ReturnType<typeof vi.fn>;
		pageMessageViewportDown: ReturnType<typeof vi.fn>;
		jumpMessageViewportToBottom: ReturnType<typeof vi.fn>;
		scrollMessageViewportUp: ReturnType<typeof vi.fn>;
		scrollMessageViewportDown: ReturnType<typeof vi.fn>;
		setFullScreenPointerScrollTarget: ReturnType<typeof vi.fn>;
		setFocus: ReturnType<typeof vi.fn>;
		requestRender: ReturnType<typeof vi.fn>;
	};
	settingsManager: {
		getDoubleEscapeAction: () => "none";
	};
	lastEscapeTime: number;
	handleCtrlC: ReturnType<typeof vi.fn>;
	handleCtrlD: ReturnType<typeof vi.fn>;
	handleCtrlZ: ReturnType<typeof vi.fn>;
	cycleThinkingLevel: ReturnType<typeof vi.fn>;
	cycleModel: ReturnType<typeof vi.fn>;
	showModelSelector: ReturnType<typeof vi.fn>;
	toggleToolOutputExpansion: ReturnType<typeof vi.fn>;
	toggleThinkingBlockVisibility: ReturnType<typeof vi.fn>;
	openExternalEditor: ReturnType<typeof vi.fn>;
	handleFollowUp: ReturnType<typeof vi.fn>;
	handleDequeue: ReturnType<typeof vi.fn>;
	handleClearCommand: ReturnType<typeof vi.fn>;
	showTreeSelector: ReturnType<typeof vi.fn>;
	showUserMessageSelector: ReturnType<typeof vi.fn>;
	showSessionSelector: ReturnType<typeof vi.fn>;
	handleClipboardImagePaste: ReturnType<typeof vi.fn>;
	isBashMode: boolean;
	updateEditorBorderColor: ReturnType<typeof vi.fn>;
};

describe("Full-screen Message viewport keybindings", () => {
	it("enables mouse reporting by default so pointer scrolling works", () => {
		expect(resolveFullScreenMouseReporting("full-screen", undefined)).toBe(true);
		expect(resolveFullScreenMouseReporting("full-screen", "1")).toBe(true);
		expect(resolveFullScreenMouseReporting("full-screen", "0")).toBe(false);
		expect(resolveFullScreenMouseReporting("scrollback", undefined)).toBe(false);
	});

	it("registers default and configurable viewport actions", () => {
		const defaultBindings = new KeybindingsManager();

		expect(defaultBindings.getKeys("app.messageViewport.pageUp")).toEqual(["pageUp"]);
		expect(defaultBindings.getKeys("app.messageViewport.pageDown")).toEqual(["pageDown"]);
		expect(defaultBindings.getKeys("app.messageViewport.scrollUp")).toEqual([]);
		expect(defaultBindings.getKeys("app.messageViewport.scrollDown")).toEqual([]);

		const customBindings = new KeybindingsManager({
			"app.messageViewport.scrollUp": "alt+pageUp",
			"app.messageViewport.scrollDown": ["alt+pageDown", "shift+pageDown"],
		});

		expect(customBindings.getKeys("app.messageViewport.scrollUp")).toEqual(["alt+pageUp"]);
		expect(customBindings.getKeys("app.messageViewport.scrollDown")).toEqual(["alt+pageDown", "shift+pageDown"]);
	});

	it("registers viewport actions only for ordinary Full-screen editor focus", () => {
		const setupKeyHandlers = (
			InteractiveMode.prototype as unknown as { setupKeyHandlers(this: Record<string, unknown>): void }
		).setupKeyHandlers;

		const fullScreenEditor = createFakeEditor();
		const fullScreenMode = createFakeInteractiveMode(fullScreenEditor, "full-screen");
		setupKeyHandlers.call(fullScreenMode);
		expect(fullScreenEditor.actionHandlers.has("app.messageViewport.pageUp")).toBe(true);
		expect(fullScreenEditor.actionHandlers.has("app.messageViewport.pageDown")).toBe(true);
		expect(fullScreenEditor.actionHandlers.has("app.messageViewport.scrollUp")).toBe(true);
		expect(fullScreenEditor.actionHandlers.has("app.messageViewport.scrollDown")).toBe(true);
		expect(fullScreenMode.ui.setFullScreenPointerScrollTarget).toHaveBeenCalledTimes(1);
		expect(fullScreenMode.ui.setFullScreenPointerScrollTarget).toHaveBeenCalledWith(fullScreenEditor, {
			scrollUp: expect.any(Function),
			scrollDown: expect.any(Function),
		});
		fullScreenEditor.onChange?.("draft text");
		expect(fullScreenMode.ui.jumpMessageViewportToBottom).not.toHaveBeenCalled();

		const scrollbackEditor = createFakeEditor();
		const scrollbackMode = createFakeInteractiveMode(scrollbackEditor, "scrollback");
		setupKeyHandlers.call(scrollbackMode);
		expect(scrollbackEditor.actionHandlers.has("app.messageViewport.pageUp")).toBe(false);
		expect(scrollbackEditor.actionHandlers.has("app.messageViewport.pageDown")).toBe(false);
		expect(scrollbackEditor.actionHandlers.has("app.messageViewport.scrollUp")).toBe(false);
		expect(scrollbackEditor.actionHandlers.has("app.messageViewport.scrollDown")).toBe(false);
		expect(scrollbackMode.ui.setFullScreenPointerScrollTarget).not.toHaveBeenCalled();
	});

	it("does not copy built-in Message viewport actions onto custom editors", () => {
		const setupKeyHandlers = (
			InteractiveMode.prototype as unknown as { setupKeyHandlers(this: Record<string, unknown>): void }
		).setupKeyHandlers;
		const setCustomEditorComponent = (
			InteractiveMode.prototype as unknown as {
				setCustomEditorComponent(
					this: Record<string, unknown>,
					factory: (...args: unknown[]) => ReturnType<typeof createFakeEditor>,
				): void;
			}
		).setCustomEditorComponent;

		const fullScreenMode = createFakeInteractiveMode(createFakeEditor("draft"), "full-screen");
		setupKeyHandlers.call(fullScreenMode);

		const extensionEditor = createFakeEditor();
		const extensionPageUp = vi.fn();
		extensionEditor.actionHandlers.set("app.messageViewport.pageUp", extensionPageUp);
		setCustomEditorComponent.call(fullScreenMode, () => extensionEditor);

		expect(extensionEditor.setText).toHaveBeenCalledWith("draft");
		expect(extensionEditor.actionHandlers.has("app.clear")).toBe(true);
		expect(extensionEditor.actionHandlers.get("app.messageViewport.pageUp")).toBe(extensionPageUp);
		expect(extensionEditor.actionHandlers.has("app.messageViewport.pageDown")).toBe(false);
		expect(extensionEditor.actionHandlers.has("app.messageViewport.scrollUp")).toBe(false);
		expect(extensionEditor.actionHandlers.has("app.messageViewport.scrollDown")).toBe(false);
		expect(extensionEditor.onEscape).toBeTypeOf("function");
	});
});

function createFakeEditor(initialText = "") {
	let text = initialText;

	return {
		actionHandlers: new Map<string, () => void>(),
		onEscape: undefined as (() => void) | undefined,
		onCtrlD: undefined as (() => void) | undefined,
		onPasteImage: undefined as (() => void) | undefined,
		onExtensionShortcut: undefined as ((data: string) => boolean) | undefined,
		onChange: undefined as ((text: string) => void) | undefined,
		onSubmit: undefined as ((text: string) => void) | undefined,
		borderColor: undefined as ((text: string) => string) | undefined,
		scrollViewUp: vi.fn(() => true),
		scrollViewDown: vi.fn(() => true),
		setPaddingX: vi.fn(),
		getPaddingX: () => 0,
		setAutocompleteProvider: vi.fn(),
		setText: vi.fn((nextText: string) => {
			text = nextText;
		}),
		render: () => [],
		invalidate: vi.fn(),
		onAction(action: string, handler: () => void) {
			this.actionHandlers.set(action, handler);
		},
		getText: () => text,
	};
}

function createFakeInteractiveMode(
	defaultEditor: ReturnType<typeof createFakeEditor>,
	screenMode: "scrollback" | "full-screen",
): FakeInteractiveMode {
	return {
		defaultEditor,
		editor: defaultEditor,
		editorContainer: {
			clear: vi.fn(),
			addChild: vi.fn(),
		},
		keybindings: KeybindingsManager.create(),
		ui: {
			onDebug: undefined,
			getScreenMode: () => screenMode,
			pageMessageViewportUp: vi.fn(),
			pageMessageViewportDown: vi.fn(),
			jumpMessageViewportToBottom: vi.fn(),
			scrollMessageViewportUp: vi.fn(),
			scrollMessageViewportDown: vi.fn(),
			setFullScreenPointerScrollTarget: vi.fn(),
			setFocus: vi.fn(),
			requestRender: vi.fn(),
		},
		settingsManager: {
			getDoubleEscapeAction: () => "none",
		},
		lastEscapeTime: 0,
		handleCtrlC: vi.fn(),
		handleCtrlD: vi.fn(),
		handleCtrlZ: vi.fn(),
		cycleThinkingLevel: vi.fn(),
		cycleModel: vi.fn(),
		showModelSelector: vi.fn(),
		toggleToolOutputExpansion: vi.fn(),
		toggleThinkingBlockVisibility: vi.fn(),
		openExternalEditor: vi.fn(),
		handleFollowUp: vi.fn(),
		handleDequeue: vi.fn(),
		handleClearCommand: vi.fn(),
		showTreeSelector: vi.fn(),
		showUserMessageSelector: vi.fn(),
		showSessionSelector: vi.fn(),
		handleClipboardImagePaste: vi.fn(),
		isBashMode: false,
		updateEditorBorderColor: vi.fn(),
	};
}
