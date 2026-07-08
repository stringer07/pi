import { beforeAll, describe, expect, it } from "vitest";
import { type Component, Container, type Focusable, TUI } from "../../tui/src/tui.ts";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import type { ExtensionWidgetOptions } from "../src/core/extensions/types.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

class StaticLines implements Component {
	private readonly lines: string[];

	constructor(lines: string[]) {
		this.lines = lines;
	}

	render(): string[] {
		return this.lines;
	}

	invalidate(): void {}
}

class FakeEditorComponent implements Component, Focusable {
	focused = false;
	private text: string;
	private readonly line: string;

	constructor(line: string, text = "draft") {
		this.line = line;
		this.text = text;
	}

	render(): string[] {
		return [this.line];
	}

	getText(): string {
		return this.text;
	}

	setText(text: string): void {
		this.text = text;
	}

	invalidate(): void {}
}

async function flushTui(tui: TUI, terminal: VirtualTerminal): Promise<void> {
	tui.requestRender(true);
	await Promise.resolve();
	await terminal.waitForRender();
}

type ReplacementUiContext = {
	editor: FakeEditorComponent;
	editorContainer: Container;
	keybindings: Record<string, never>;
	ui: TUI;
};

type WidgetComponent = Component & { dispose?(): void };

type WidgetFooterContext = {
	ui: TUI;
	extensionWidgetsAbove: Map<string, WidgetComponent>;
	extensionWidgetsBelow: Map<string, WidgetComponent>;
	widgetContainerAbove: Container;
	widgetContainerBelow: Container;
	renderWidgets(): void;
	renderWidgetContainer(
		container: Container,
		widgets: Map<string, WidgetComponent>,
		spacerWhenEmpty: boolean,
		leadingSpacer: boolean,
	): void;
	footer: WidgetComponent;
	customFooter: WidgetComponent | undefined;
	footerDataProvider: object;
};

type ShowExtensionCustomFn = <T>(
	this: ReplacementUiContext,
	factory: (
		tui: TUI,
		theme: object,
		keybindings: Record<string, never>,
		done: (result: T) => void,
	) => Component | Promise<Component>,
	options?: {
		overlay?: boolean;
	},
) => Promise<T>;

type SetExtensionWidgetFn = (
	this: WidgetFooterContext,
	key: string,
	content: string[] | ((tui: TUI, theme: object) => WidgetComponent) | undefined,
	options?: ExtensionWidgetOptions,
) => void;

type RenderWidgetsFn = (this: WidgetFooterContext) => void;

type RenderWidgetContainerFn = (
	this: WidgetFooterContext,
	container: Container,
	widgets: Map<string, WidgetComponent>,
	spacerWhenEmpty: boolean,
	leadingSpacer: boolean,
) => void;

type SetExtensionFooterFn = (
	this: WidgetFooterContext,
	factory: ((tui: TUI, theme: object, footerData: object) => WidgetComponent) | undefined,
) => void;

const showExtensionCustom = (
	InteractiveMode.prototype as unknown as {
		showExtensionCustom: ShowExtensionCustomFn;
	}
).showExtensionCustom;

const setExtensionWidget = (
	InteractiveMode.prototype as unknown as {
		setExtensionWidget: SetExtensionWidgetFn;
	}
).setExtensionWidget;

const renderWidgets = (
	InteractiveMode.prototype as unknown as {
		renderWidgets: RenderWidgetsFn;
	}
).renderWidgets;

const renderWidgetContainer = (
	InteractiveMode.prototype as unknown as {
		renderWidgetContainer: RenderWidgetContainerFn;
	}
).renderWidgetContainer;

const setExtensionFooter = (
	InteractiveMode.prototype as unknown as {
		setExtensionFooter: SetExtensionFooterFn;
	}
).setExtensionFooter;

function createFullScreenHarness(
	messageLines: string[],
	height: number,
): {
	terminal: VirtualTerminal;
	ui: TUI;
	editor: FakeEditorComponent;
	editorContainer: Container;
	widgetContainerAbove: Container;
	widgetContainerBelow: Container;
	footer: WidgetComponent;
} {
	const terminal = new VirtualTerminal(40, height);
	const ui = new TUI(terminal, undefined, { screenMode: "full-screen" });
	const editor = new FakeEditorComponent("editor");
	const editorContainer = new Container();
	const widgetContainerAbove = new Container();
	const widgetContainerBelow = new Container();
	const footer = new StaticLines(["footer"]);

	editorContainer.addChild(editor);
	ui.addChild(new StaticLines(messageLines), { region: "message-viewport" });
	ui.addChild(new Container(), { region: "composer-region" });
	ui.addChild(new Container(), { region: "composer-region" });
	ui.addChild(widgetContainerAbove, { region: "composer-region" });
	ui.addChild(editorContainer, { region: "composer-region" });
	ui.addChild(widgetContainerBelow, { region: "composer-region" });
	ui.addChild(footer, { region: "composer-region" });
	ui.setFocus(editor);

	return { terminal, ui, editor, editorContainer, widgetContainerAbove, widgetContainerBelow, footer };
}

describe("Full-screen extension UI layout", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	it("renders non-overlay custom replacement UI inside the Composer region", async () => {
		const { terminal, ui, editor, editorContainer, footer } = createFullScreenHarness(
			["message 1", "message 2", "message 3"],
			5,
		);
		const replacement = new StaticLines(["replacement"]);
		let closeReplacement: ((result: string) => void) | undefined;

		ui.start();
		try {
			const replacementPromise = showExtensionCustom.call(
				{
					editor,
					editorContainer,
					keybindings: {},
					ui,
				},
				(_tui, _theme, _keybindings, done) => {
					closeReplacement = done;
					return replacement;
				},
			);

			await flushTui(ui, terminal);
			expect(ui.getScreenRegion(editorContainer)).toBe("composer-region");
			expect(ui.getScreenRegion(footer)).toBe("composer-region");
			expect(terminal.getViewport()).toEqual(["message 1", "message 2", "message 3", "replacement", "footer"]);

			expect(closeReplacement).toBeTypeOf("function");
			closeReplacement?.("done");
			await replacementPromise;
			await flushTui(ui, terminal);
			expect(terminal.getViewport()).toEqual(["message 1", "message 2", "message 3", "editor", "footer"]);
		} finally {
			ui.stop();
		}
	});

	it("keeps widgets and custom footers in the Composer region with existing caps and order", async () => {
		const { terminal, ui, widgetContainerAbove, widgetContainerBelow, footer } = createFullScreenHarness(
			["message 1"],
			26,
		);
		const aboveLines = Array.from({ length: 11 }, (_, index) => `above ${index + 1}`);
		const belowLines = Array.from({ length: 11 }, (_, index) => `below ${index + 1}`);
		const context: WidgetFooterContext = {
			ui,
			extensionWidgetsAbove: new Map(),
			extensionWidgetsBelow: new Map(),
			widgetContainerAbove,
			widgetContainerBelow,
			renderWidgets() {
				return renderWidgets.call(this);
			},
			renderWidgetContainer(container, widgets, spacerWhenEmpty, leadingSpacer) {
				return renderWidgetContainer.call(this, container, widgets, spacerWhenEmpty, leadingSpacer);
			},
			footer,
			customFooter: undefined,
			footerDataProvider: {},
		};

		setExtensionWidget.call(context, "above", aboveLines);
		setExtensionWidget.call(context, "below", belowLines, { placement: "belowEditor" });
		setExtensionFooter.call(context, () => new StaticLines(["custom footer"]));

		ui.start();
		try {
			await flushTui(ui, terminal);
			const viewport = terminal.getViewport();

			expect(ui.getScreenRegion(widgetContainerAbove)).toBe("composer-region");
			expect(ui.getScreenRegion(widgetContainerBelow)).toBe("composer-region");
			expect(ui.getScreenRegion(context.customFooter as Component)).toBe("composer-region");
			expect(viewport[0]).toBe("message 1");
			expect(viewport[1]).toBe("");
			expect(viewport.slice(2, 12).map((line) => line.trim())).toEqual(aboveLines.slice(0, 10));
			expect(viewport[12]).toContain("... (widget truncated)");
			expect(viewport[13]).toBe("editor");
			expect(viewport.slice(14, 24).map((line) => line.trim())).toEqual(belowLines.slice(0, 10));
			expect(viewport[24]).toContain("... (widget truncated)");
			expect(viewport[25]).toBe("custom footer");
		} finally {
			ui.stop();
		}
	});
});
