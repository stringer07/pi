/**
 * Minimal TUI implementation with differential rendering
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { performance } from "node:perf_hooks";
import { isKeyRelease, matchesKey } from "./keys.ts";
import type { Terminal } from "./terminal.ts";
import {
	isOsc11BackgroundColorResponse,
	parseOsc11BackgroundColor,
	parseTerminalColorSchemeReport,
	type RgbColor,
	type TerminalColorScheme,
} from "./terminal-colors.ts";
import { deleteKittyImage, getCapabilities, isImageLine, setCellDimensions } from "./terminal-image.ts";
import {
	extractAnsiCode,
	extractSegments,
	normalizeTerminalOutput,
	sliceByColumn,
	sliceWithWidth,
	truncateToWidth,
	visibleWidth,
} from "./utils.ts";

const KITTY_SEQUENCE_PREFIX = "\x1b_G";
const ALTERNATE_SCREEN_ENABLE_SEQUENCE = "\x1b[?1049h";
const ALTERNATE_SCREEN_DISABLE_SEQUENCE = "\x1b[?1049l";
const MOUSE_REPORTING_ENABLE_SEQUENCE = "\x1b[?1000h\x1b[?1002h\x1b[?1006h";
const MOUSE_REPORTING_DISABLE_SEQUENCE = "\x1b[?1002l\x1b[?1000l\x1b[?1006l";
const SELECTION_ENABLE_SEQUENCE = "\x1b[48;5;8m";
const SELECTION_DISABLE_SEQUENCE = "\x1b[49m";
const SCROLLBAR_PARTIAL_BLOCKS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];
const SCROLLBAR_TRACK_SEQUENCE = "\x1b[38;5;238;48;5;238m█\x1b[0m";
const SCROLLBAR_THUMB_SEQUENCE = "\x1b[38;5;245;48;5;245m█\x1b[0m";

interface KittyImageHeader {
	ids: number[];
	rows: number;
}

function parseKittyImageHeader(line: string): KittyImageHeader | undefined {
	const sequenceStart = line.indexOf(KITTY_SEQUENCE_PREFIX);
	if (sequenceStart === -1) return undefined;

	const paramsStart = sequenceStart + KITTY_SEQUENCE_PREFIX.length;
	const paramsEnd = line.indexOf(";", paramsStart);
	if (paramsEnd === -1) return undefined;

	const ids: number[] = [];
	let rows = 1;
	const params = line.slice(paramsStart, paramsEnd);
	for (const param of params.split(",")) {
		const [key, value] = param.split("=", 2);
		if (value === undefined) continue;
		const numberValue = Number(value);
		if (!Number.isInteger(numberValue) || numberValue <= 0 || numberValue > 0xffffffff) continue;
		if (key === "i") {
			ids.push(numberValue);
		} else if (key === "r") {
			rows = numberValue;
		}
	}
	return { ids, rows };
}

function extractKittyImageIds(line: string): number[] {
	return parseKittyImageHeader(line)?.ids ?? [];
}

function extractKittyImageRows(line: string): number {
	return parseKittyImageHeader(line)?.rows ?? 1;
}

/**
 * Component interface - all components must implement this
 */
export interface Component {
	/**
	 * Render the component to lines for the given viewport width
	 * @param width - Current viewport width
	 * @returns Array of strings, each representing a line
	 */
	render(width: number): string[];

	/**
	 * Optional handler for keyboard input when component has focus
	 */
	handleInput?(data: string): void;

	/**
	 * If true, component receives key release events (Kitty protocol).
	 * Default is false - release events are filtered out.
	 */
	wantsKeyRelease?: boolean;

	/**
	 * Invalidate any cached rendering state.
	 * Called when theme changes or when component needs to re-render from scratch.
	 */
	invalidate(): void;
}

type InputListenerResult = { consume?: boolean; data?: string } | undefined;
type InputListener = (data: string) => InputListenerResult;
type PendingOsc11BackgroundQuery = {
	settled: boolean;
	resolve: ((rgb: RgbColor | undefined) => void) | undefined;
	timer: NodeJS.Timeout | undefined;
};

type PointerScrollTarget = {
	component: Component;
	scrollUp: () => boolean;
	scrollDown: () => boolean;
};

type FullScreenSelectionPoint = {
	row: number;
	col: number;
};

type FullScreenPointerEvent =
	| { kind: "wheel"; direction: "up" | "down"; row: number; col: number }
	| { kind: "left-down"; row: number; col: number }
	| { kind: "left-drag"; row: number; col: number }
	| { kind: "left-up"; row: number; col: number }
	| { kind: "other"; row: number; col: number };

function parseFullScreenPointerEvent(data: string): FullScreenPointerEvent | undefined {
	const match = data.match(/^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/);
	if (!match) {
		return undefined;
	}

	const code = Number.parseInt(match[1]!, 10);
	const col = Number.parseInt(match[2]!, 10) - 1;
	const row = Number.parseInt(match[3]!, 10) - 1;
	if (!Number.isFinite(code) || !Number.isFinite(col) || !Number.isFinite(row)) {
		return undefined;
	}

	if ((code & 64) !== 0) {
		const wheelDirection = code & 0b11;
		if (wheelDirection === 0) {
			return { kind: "wheel", direction: "up", row, col };
		}
		if (wheelDirection === 1) {
			return { kind: "wheel", direction: "down", row, col };
		}
	}

	const button = code & 0b11;
	const isRelease = match[4] === "m";
	const isMotion = (code & 32) !== 0;
	if (button === 0) {
		if (isRelease) {
			return { kind: "left-up", row, col };
		}
		if (isMotion) {
			return { kind: "left-drag", row, col };
		}
		return { kind: "left-down", row, col };
	}

	return { kind: "other", row, col };
}

/**
 * Interface for components that can receive focus and display a hardware cursor.
 * When focused, the component should emit CURSOR_MARKER at the cursor position
 * in its render output. TUI will find this marker and position the hardware
 * cursor there for proper IME candidate window positioning.
 */
export interface Focusable {
	/** Set by TUI when focus changes. Component should emit CURSOR_MARKER when true. */
	focused: boolean;
}

/** Type guard to check if a component implements Focusable */
export function isFocusable(component: Component | null): component is Component & Focusable {
	return component !== null && "focused" in component;
}

/**
 * Cursor position marker - APC (Application Program Command) sequence.
 * This is a zero-width escape sequence that terminals ignore.
 * Components emit this at the cursor position when focused.
 * TUI finds and strips this marker, then positions the hardware cursor there.
 */
export const CURSOR_MARKER = "\x1b_pi:c\x07";

export { visibleWidth };

/**
 * Anchor position for overlays
 */
export type OverlayAnchor =
	| "center"
	| "top-left"
	| "top-right"
	| "bottom-left"
	| "bottom-right"
	| "top-center"
	| "bottom-center"
	| "left-center"
	| "right-center";

/**
 * Margin configuration for overlays
 */
export interface OverlayMargin {
	top?: number;
	right?: number;
	bottom?: number;
	left?: number;
}

/** Value that can be absolute (number) or percentage (string like "50%") */
export type SizeValue = number | `${number}%`;

/** Parse a SizeValue into absolute value given a reference size */
function parseSizeValue(value: SizeValue | undefined, referenceSize: number): number | undefined {
	if (value === undefined) return undefined;
	if (typeof value === "number") return value;
	// Parse percentage string like "50%"
	const match = value.match(/^(\d+(?:\.\d+)?)%$/);
	if (match) {
		return Math.floor((referenceSize * parseFloat(match[1])) / 100);
	}
	return undefined;
}

function isTermuxSession(): boolean {
	return Boolean(process.env.TERMUX_VERSION);
}

/**
 * Options for overlay positioning and sizing.
 * Values can be absolute numbers or percentage strings (e.g., "50%").
 */
export interface OverlayOptions {
	// === Sizing ===
	/** Width in columns, or percentage of terminal width (e.g., "50%") */
	width?: SizeValue;
	/** Minimum width in columns */
	minWidth?: number;
	/** Maximum height in rows, or percentage of terminal height (e.g., "50%") */
	maxHeight?: SizeValue;

	// === Positioning - anchor-based ===
	/** Anchor point for positioning (default: 'center') */
	anchor?: OverlayAnchor;
	/** Horizontal offset from anchor position (positive = right) */
	offsetX?: number;
	/** Vertical offset from anchor position (positive = down) */
	offsetY?: number;

	// === Positioning - percentage or absolute ===
	/** Row position: absolute number, or percentage (e.g., "25%" = 25% from top) */
	row?: SizeValue;
	/** Column position: absolute number, or percentage (e.g., "50%" = centered horizontally) */
	col?: SizeValue;

	// === Margin from terminal edges ===
	/** Margin from terminal edges. Number applies to all sides. */
	margin?: OverlayMargin | number;

	// === Visibility ===
	/**
	 * Control overlay visibility based on terminal dimensions.
	 * If provided, overlay is only rendered when this returns true.
	 * Called each render cycle with current terminal dimensions.
	 */
	visible?: (termWidth: number, termHeight: number) => boolean;
	/** If true, don't capture keyboard focus when shown */
	nonCapturing?: boolean;
}

/** Options for {@link OverlayHandle.unfocus}. */
export interface OverlayUnfocusOptions {
	/** Explicit target to focus after releasing this overlay. */
	target: Component | null;
}

/**
 * Handle returned by showOverlay for controlling the overlay
 */
export interface OverlayHandle {
	/** Permanently remove the overlay (cannot be shown again) */
	hide(): void;
	/** Temporarily hide or show the overlay */
	setHidden(hidden: boolean): void;
	/** Check if overlay is temporarily hidden */
	isHidden(): boolean;
	/** Focus this overlay and bring it to the visual front */
	focus(): void;
	/** Release focus to the next visible capturing overlay or previous target, or to an explicit target when provided */
	unfocus(options?: OverlayUnfocusOptions): void;
	/** Check if this overlay currently has focus */
	isFocused(): boolean;
}

export type ScreenMode = "scrollback" | "full-screen";
export type ScreenRegion = "message-viewport" | "composer-region";

export interface TUIChildOptions {
	region?: ScreenRegion;
}

export interface TUIOptions {
	screenMode?: ScreenMode;
	fullScreenMouseReporting?: boolean;
	fullScreenMessageViewportScrollbar?: boolean;
}

type FullScreenLayout = {
	frameLines: string[];
	messageLines: string[];
	messageViewportHeight: number;
	totalMessageLines: number;
	maxMessageViewportDistanceFromBottom: number;
	messageViewportDistanceFromBottom: number;
};

type MessageViewportWindow = {
	lines: string[];
	start: number;
	end: number;
};

type FullScreenMessageSnapshot = {
	width: number;
	lines: readonly string[];
};

type FullScreenRenderReason = "content" | "viewport";

type OverlayStackEntry = {
	component: Component;
	options?: OverlayOptions;
	preFocus: Component | null;
	hidden: boolean;
	focusOrder: number;
};

type OverlayBlockedFocusResume = { status: "restore-overlay" } | { status: "focus-target"; target: Component | null };
type EligibleOverlayFocusRestoreState = { status: "eligible"; overlay: OverlayStackEntry };
type BlockedOverlayFocusRestoreState = {
	status: "blocked";
	overlay: OverlayStackEntry;
	blockedBy: Component;
	resume: OverlayBlockedFocusResume;
};
type ActiveOverlayFocusRestoreState = EligibleOverlayFocusRestoreState | BlockedOverlayFocusRestoreState;
type OverlayFocusRestoreState = { status: "inactive" } | ActiveOverlayFocusRestoreState;
type OverlayFocusRestorePolicy = "clear" | "preserve";

/**
 * Container - a component that contains other components
 */
export class Container implements Component {
	children: Component[] = [];

	addChild(component: Component): void {
		this.children.push(component);
	}

	removeChild(component: Component): void {
		const index = this.children.indexOf(component);
		if (index !== -1) {
			this.children.splice(index, 1);
		}
	}

	clear(): void {
		this.children = [];
	}

	invalidate(): void {
		for (const child of this.children) {
			child.invalidate?.();
		}
	}

	render(width: number): string[] {
		const lines: string[] = [];
		for (const child of this.children) {
			const childLines = child.render(width);
			for (const line of childLines) {
				lines.push(line);
			}
		}
		return lines;
	}
}

/**
 * TUI - Main class for managing terminal UI with differential rendering
 */
export class TUI extends Container {
	public terminal: Terminal;
	private previousLines: string[] = [];
	private previousKittyImageIds = new Set<number>();
	private previousWidth = 0;
	private previousHeight = 0;
	private focusedComponent: Component | null = null;
	private inputListeners = new Set<InputListener>();

	/** Global callback for debug key (Shift+Ctrl+D). Called before input is forwarded to focused component. */
	public onDebug?: () => void;
	private renderRequested = false;
	private pendingRenderReason: FullScreenRenderReason | undefined;
	private scheduledRenderReason: FullScreenRenderReason | undefined;
	private viewportNavigationHandledDuringInput = false;
	private renderTimer: NodeJS.Timeout | undefined;
	private lastRenderAt = 0;
	private static readonly MIN_RENDER_INTERVAL_MS = 16;
	private cursorRow = 0; // Logical cursor row (end of rendered content)
	private hardwareCursorRow = 0; // Actual terminal cursor row (may differ due to IME positioning)
	private showHardwareCursor = process.env.PI_HARDWARE_CURSOR === "1";
	private clearOnShrink = process.env.PI_CLEAR_ON_SHRINK === "1"; // Clear empty rows when content shrinks (default: off)
	private maxLinesRendered = 0; // Track terminal's working area (max lines ever rendered)
	private previousViewportTop = 0; // Track previous viewport top for resize-aware cursor moves
	private fullRedrawCount = 0;
	private stopped = false;
	private pendingOsc11BackgroundReplies = 0;
	private pendingOsc11BackgroundQueries: PendingOsc11BackgroundQuery[] = [];
	private terminalColorSchemeListeners = new Set<(scheme: TerminalColorScheme) => void>();
	private terminalColorSchemeNotificationsEnabled = false;
	private readonly screenMode: ScreenMode;
	private readonly fullScreenMouseReporting: boolean;
	private readonly fullScreenMessageViewportScrollbar: boolean;
	private readonly childRegions = new Map<Component, ScreenRegion>();
	private fullScreenMessageViewportHeight = 0;
	private fullScreenMessageViewportScrollbarLines: string[] = [];
	private fullScreenMessageViewportDistanceFromBottom = 0;
	private fullScreenMessageViewportLastMessageLineCount = 0;
	private fullScreenMessageSnapshot: FullScreenMessageSnapshot | undefined;
	private fullScreenPointerScrollTarget?: PointerScrollTarget;
	private fullScreenSelectionAnchor?: FullScreenSelectionPoint;
	private fullScreenSelectionFocus?: FullScreenSelectionPoint;
	private fullScreenSelectionActive = false;
	private fullScreenSelectionSourceLines: string[] = [];
	private fullScreenSelectionHandler?: (text: string) => void;

	// Overlay stack for modal components rendered on top of base content
	private focusOrderCounter = 0;
	private overlayStack: OverlayStackEntry[] = [];
	private overlayFocusRestore: OverlayFocusRestoreState = { status: "inactive" };

	constructor(terminal: Terminal, showHardwareCursor?: boolean, options: TUIOptions = {}) {
		super();
		this.terminal = terminal;
		this.screenMode = options.screenMode ?? "scrollback";
		this.fullScreenMouseReporting = options.fullScreenMouseReporting ?? false;
		this.fullScreenMessageViewportScrollbar = options.fullScreenMessageViewportScrollbar ?? false;
		if (showHardwareCursor !== undefined) {
			this.showHardwareCursor = showHardwareCursor;
		}
	}

	get fullRedraws(): number {
		return this.fullRedrawCount;
	}

	getScreenMode(): ScreenMode {
		return this.screenMode;
	}

	getScreenRegion(component: Component): ScreenRegion | undefined {
		return this.childRegions.get(component);
	}

	override addChild(component: Component, options?: TUIChildOptions): void {
		this.fullScreenMessageSnapshot = undefined;
		super.addChild(component);
		if (options?.region === undefined) {
			this.childRegions.delete(component);
			return;
		}
		this.childRegions.set(component, options.region);
	}

	override removeChild(component: Component): void {
		this.fullScreenMessageSnapshot = undefined;
		super.removeChild(component);
		this.childRegions.delete(component);
	}

	override clear(): void {
		this.fullScreenMessageSnapshot = undefined;
		super.clear();
		this.childRegions.clear();
	}

	override render(width: number): string[] {
		// Direct callers always observe current child state. Scheduled frames set
		// scheduledRenderReason so pure viewport navigation can reuse the snapshot.
		const reason = this.scheduledRenderReason ?? "content";
		switch (this.screenMode) {
			case "scrollback":
				return this.renderScrollbackMode(width);
			case "full-screen":
				return this.renderFullScreenMode(width, reason);
		}
	}

	private renderScrollbackMode(width: number): string[] {
		return super.render(width);
	}

	private renderFullScreenMode(width: number, reason: FullScreenRenderReason = "content"): string[] {
		if (this.childRegions.size === 0) {
			this.fullScreenMessageViewportHeight = 0;
			this.fullScreenMessageViewportScrollbarLines = [];
			this.fullScreenMessageSnapshot = undefined;
			return super.render(width);
		}

		const layout = this.getFullScreenLayout(width, this.terminal.rows, {
			preserveHistoricalView: true,
			reason,
		});
		this.fullScreenMessageViewportHeight = layout.messageViewportHeight;
		this.fullScreenMessageViewportDistanceFromBottom = layout.messageViewportDistanceFromBottom;
		this.fullScreenMessageViewportLastMessageLineCount = layout.totalMessageLines;
		return layout.frameLines;
	}

	private renderChildren(children: readonly Component[], width: number): string[] {
		const lines: string[] = [];
		for (const child of children) {
			const childLines = child.render(width);
			for (const line of childLines) {
				lines.push(line);
			}
		}
		return lines;
	}

	private getMessageViewportWidth(width: number): number {
		return this.fullScreenMessageViewportScrollbar && width > 1 ? width - 1 : width;
	}

	private getMessageLinesForLayout(messageViewportWidth: number, reason: FullScreenRenderReason): string[] {
		if (
			reason === "viewport" &&
			this.fullScreenMessageSnapshot &&
			this.fullScreenMessageSnapshot.width === messageViewportWidth
		) {
			return this.fullScreenMessageSnapshot.lines as string[];
		}

		const messageLines = this.renderChildren(this.getChildrenOutsideComposerRegion(), messageViewportWidth);
		this.fullScreenMessageSnapshot = {
			width: messageViewportWidth,
			lines: messageLines,
		};
		return messageLines;
	}

	private getFullScreenLayout(
		width: number,
		height: number,
		options: { preserveHistoricalView?: boolean; reason?: FullScreenRenderReason } = {},
	): FullScreenLayout {
		const reason = options.reason ?? "content";
		const messageViewportWidth = this.getMessageViewportWidth(width);
		const messageLines = this.getMessageLinesForLayout(messageViewportWidth, reason);
		const composerLines = this.renderChildren(this.getChildrenInScreenRegion("composer-region"), width);
		const composerHeight = Math.min(height, composerLines.length);
		const messageViewportHeight = Math.max(0, height - composerHeight);
		let messageViewportDistanceFromBottom = this.fullScreenMessageViewportDistanceFromBottom;

		if (options.preserveHistoricalView && messageViewportDistanceFromBottom > 0) {
			if (messageLines.length > this.fullScreenMessageViewportLastMessageLineCount) {
				messageViewportDistanceFromBottom +=
					messageLines.length - this.fullScreenMessageViewportLastMessageLineCount;
			}
			if (
				this.fullScreenMessageViewportHeight > 0 &&
				messageViewportHeight !== this.fullScreenMessageViewportHeight
			) {
				messageViewportDistanceFromBottom += this.fullScreenMessageViewportHeight - messageViewportHeight;
			}
		}

		const maxMessageViewportDistanceFromBottom = this.getMaxMessageViewportDistanceFromBottom(
			messageLines.length,
			messageViewportHeight,
		);
		messageViewportDistanceFromBottom = Math.max(
			0,
			Math.min(messageViewportDistanceFromBottom, maxMessageViewportDistanceFromBottom),
		);
		return {
			frameLines: this.composeFullScreenLayout(
				width,
				messageLines,
				composerLines,
				height,
				messageViewportHeight,
				messageViewportDistanceFromBottom,
				messageViewportWidth,
			),
			messageLines,
			messageViewportHeight,
			totalMessageLines: messageLines.length,
			maxMessageViewportDistanceFromBottom,
			messageViewportDistanceFromBottom,
		};
	}

	private composeFullScreenLayout(
		width: number,
		messageLines: string[],
		composerLines: string[],
		height: number,
		messageViewportHeight: number,
		messageViewportDistanceFromBottom: number,
		messageViewportWidth: number,
	): string[] {
		this.fullScreenMessageViewportScrollbarLines = [];
		if (height <= 0) {
			return [];
		}

		if (composerLines.length >= height) {
			return composerLines.slice(-height);
		}

		const visibleMessageWindow = this.getVisibleMessageViewportWindow(
			messageLines,
			messageViewportHeight,
			messageViewportDistanceFromBottom,
		);
		const boundaryMessageLines = this.trimTrailingMessageViewportBoundaryBlankLines(
			visibleMessageWindow.lines,
			messageViewportDistanceFromBottom,
		);
		const topPadding = Math.max(0, messageViewportHeight - boundaryMessageLines.length);
		const frameMessageLines = [...Array<string>(topPadding).fill(""), ...boundaryMessageLines];
		return [
			...this.decorateFullScreenMessageViewportScrollbar(
				frameMessageLines,
				messageViewportHeight,
				messageLines.length,
				visibleMessageWindow.start,
				messageViewportWidth,
				width,
			),
			...composerLines,
		];
	}

	private decorateFullScreenMessageViewportScrollbar(
		lines: string[],
		messageViewportHeight: number,
		totalMessageLines: number,
		messageViewportStart: number,
		messageViewportWidth: number,
		width: number,
	): string[] {
		if (
			!this.fullScreenMessageViewportScrollbar ||
			messageViewportWidth === width ||
			totalMessageLines <= messageViewportHeight
		) {
			return lines;
		}

		const thumbHeight = Math.max(1, (messageViewportHeight * messageViewportHeight) / totalMessageLines);
		const maxThumbStart = messageViewportHeight - thumbHeight;
		const maxMessageViewportStart = totalMessageLines - messageViewportHeight;
		const thumbStart = (messageViewportStart / maxMessageViewportStart) * maxThumbStart;
		const thumbEnd = thumbStart + thumbHeight;
		const decoratedLines = lines.map((line, index) => {
			const content = truncateToWidth(line, messageViewportWidth, "");
			let scrollbar = SCROLLBAR_TRACK_SEQUENCE;
			if (index === Math.floor(thumbStart)) {
				const filledEighths = Math.floor((1 - (thumbStart - index)) * 8);
				const partialBlock = SCROLLBAR_PARTIAL_BLOCKS[filledEighths] ?? "█";
				scrollbar = `\x1b[38;5;245;48;5;238m${partialBlock}\x1b[0m`;
			} else if (index === Math.floor(thumbEnd)) {
				const unfilledEighths = Math.floor((1 - (thumbEnd - index)) * 8);
				const partialBlock = SCROLLBAR_PARTIAL_BLOCKS[unfilledEighths] ?? "█";
				scrollbar = `\x1b[38;5;238;48;5;245m${partialBlock}\x1b[0m`;
			} else if (index > thumbStart && index < thumbEnd) {
				scrollbar = SCROLLBAR_THUMB_SEQUENCE;
			}
			this.fullScreenMessageViewportScrollbarLines.push(scrollbar);
			return `${content}${" ".repeat(messageViewportWidth - visibleWidth(content))}${scrollbar}`;
		});
		return decoratedLines;
	}

	private trimTrailingMessageViewportBoundaryBlankLines(
		lines: string[],
		messageViewportDistanceFromBottom: number,
	): string[] {
		if (messageViewportDistanceFromBottom !== 0) {
			return lines;
		}

		let end = lines.length;
		while (end > 0 && visibleWidth(lines[end - 1] ?? "") === 0) {
			end--;
		}
		return end === lines.length ? lines : lines.slice(0, end);
	}

	private getVisibleMessageViewportWindow(
		messageLines: string[],
		messageViewportHeight: number,
		messageViewportDistanceFromBottom: number,
	): MessageViewportWindow {
		if (messageViewportHeight <= 0) {
			return { lines: [], start: 0, end: 0 };
		}

		const end = Math.max(0, messageLines.length - messageViewportDistanceFromBottom);
		const start = Math.max(0, end - messageViewportHeight);
		return {
			lines: messageLines.slice(start, end),
			start,
			end,
		};
	}

	private getMaxMessageViewportDistanceFromBottom(totalMessageLines: number, messageViewportHeight: number): number {
		return Math.max(0, totalMessageLines - messageViewportHeight);
	}

	private getCommittedMaxMessageViewportDistanceFromBottom(): number {
		return this.getMaxMessageViewportDistanceFromBottom(
			this.fullScreenMessageViewportLastMessageLineCount,
			this.fullScreenMessageViewportHeight,
		);
	}

	private adjustMessageViewportDistanceFromBottom(delta: number): boolean {
		// Mark the focused-input dispatch as viewport navigation even for no-ops at a
		// boundary, so handleInput does not fall back to a full content render.
		this.viewportNavigationHandledDuringInput = true;
		if (this.screenMode !== "full-screen" || this.childRegions.size === 0) {
			return false;
		}

		const messageViewportHeight = this.fullScreenMessageViewportHeight;
		const maxMessageViewportDistanceFromBottom = this.getCommittedMaxMessageViewportDistanceFromBottom();
		if (messageViewportHeight <= 0 || maxMessageViewportDistanceFromBottom === 0) {
			return false;
		}

		const nextDistanceFromBottom = Math.max(
			0,
			Math.min(maxMessageViewportDistanceFromBottom, this.fullScreenMessageViewportDistanceFromBottom + delta),
		);
		if (nextDistanceFromBottom === this.fullScreenMessageViewportDistanceFromBottom) {
			return false;
		}

		this.fullScreenMessageViewportDistanceFromBottom = nextDistanceFromBottom;
		this.requestViewportRender();
		return true;
	}

	private getChildrenInScreenRegion(region: ScreenRegion): Component[] {
		return this.children.filter((child) => this.childRegions.get(child) === region);
	}

	private getChildrenOutsideComposerRegion(): Component[] {
		return this.children.filter((child) => this.childRegions.get(child) !== "composer-region");
	}

	getShowHardwareCursor(): boolean {
		return this.showHardwareCursor;
	}

	pageMessageViewportUp(): boolean {
		this.viewportNavigationHandledDuringInput = true;
		if (this.screenMode !== "full-screen" || this.fullScreenMessageViewportHeight <= 0) {
			return false;
		}
		return this.adjustMessageViewportDistanceFromBottom(this.fullScreenMessageViewportHeight);
	}

	pageMessageViewportDown(): boolean {
		this.viewportNavigationHandledDuringInput = true;
		if (this.screenMode !== "full-screen" || this.fullScreenMessageViewportHeight <= 0) {
			return false;
		}
		return this.adjustMessageViewportDistanceFromBottom(-this.fullScreenMessageViewportHeight);
	}

	scrollMessageViewportUp(): boolean {
		return this.adjustMessageViewportDistanceFromBottom(1);
	}

	scrollMessageViewportDown(): boolean {
		return this.adjustMessageViewportDistanceFromBottom(-1);
	}

	jumpMessageViewportToBottom(): boolean {
		this.viewportNavigationHandledDuringInput = true;
		if (this.screenMode !== "full-screen" || this.fullScreenMessageViewportDistanceFromBottom === 0) {
			return false;
		}

		this.fullScreenMessageViewportDistanceFromBottom = 0;
		this.requestViewportRender();
		return true;
	}

	setFullScreenPointerScrollTarget(
		component: Component | undefined,
		handlers?: { scrollUp: () => boolean; scrollDown: () => boolean },
	): void {
		if (!component || !handlers) {
			this.fullScreenPointerScrollTarget = undefined;
			return;
		}
		this.fullScreenPointerScrollTarget = {
			component,
			scrollUp: handlers.scrollUp,
			scrollDown: handlers.scrollDown,
		};
	}

	setFullScreenSelectionHandler(handler: ((text: string) => void) | undefined): void {
		this.fullScreenSelectionHandler = handler;
	}

	setShowHardwareCursor(enabled: boolean): void {
		if (this.showHardwareCursor === enabled) return;
		this.showHardwareCursor = enabled;
		if (!enabled) {
			this.terminal.hideCursor();
		}
		this.requestRender();
	}

	getClearOnShrink(): boolean {
		return this.clearOnShrink;
	}

	/**
	 * Set whether to trigger full re-render when content shrinks.
	 * When true (default), empty rows are cleared when content shrinks.
	 * When false, empty rows remain (reduces redraws on slower terminals).
	 */
	setClearOnShrink(enabled: boolean): void {
		this.clearOnShrink = enabled;
	}

	setFocus(component: Component | null): void {
		this.setFocusInternal({ component, overlayFocusRestore: "clear" });
	}

	private setFocusInternal({
		component,
		overlayFocusRestore,
	}: {
		component: Component | null;
		overlayFocusRestore: OverlayFocusRestorePolicy;
	}): void {
		const previousFocus = this.focusedComponent;
		let nextFocus = component;
		const previousFocusedOverlay = previousFocus
			? this.overlayStack.find((entry) => entry.component === previousFocus && this.isOverlayVisible(entry))
			: undefined;
		const nextFocusIsOverlay = nextFocus ? this.overlayStack.some((entry) => entry.component === nextFocus) : false;
		const restoreState = this.getVisibleOverlayFocusRestore();
		if (nextFocus && !nextFocusIsOverlay) {
			if (restoreState.status === "blocked" && restoreState.blockedBy === previousFocus) {
				if (restoreState.resume.status === "focus-target" || !this.isComponentMounted(restoreState.blockedBy)) {
					nextFocus = this.resolveBlockedOverlayFocusResume(restoreState);
				} else {
					this.overlayFocusRestore = {
						status: "blocked",
						overlay: restoreState.overlay,
						blockedBy: nextFocus,
						resume: restoreState.resume,
					};
				}
			} else if (
				previousFocusedOverlay &&
				restoreState.status !== "inactive" &&
				restoreState.overlay === previousFocusedOverlay &&
				!this.isOverlayFocusAncestor(previousFocusedOverlay, nextFocus)
			) {
				this.overlayFocusRestore = {
					status: "blocked",
					overlay: previousFocusedOverlay,
					blockedBy: nextFocus,
					resume: { status: "restore-overlay" },
				};
			}
		} else if (nextFocus === null) {
			if (restoreState.status === "blocked" && restoreState.blockedBy === previousFocus) {
				nextFocus = this.resolveBlockedOverlayFocusResume(restoreState);
			} else if (overlayFocusRestore === "clear") {
				this.clearOverlayFocusRestore();
			}
		}

		if (isFocusable(this.focusedComponent)) {
			this.focusedComponent.focused = false;
		}

		this.focusedComponent = nextFocus;

		if (isFocusable(nextFocus)) {
			nextFocus.focused = true;
		}

		const focusedOverlay = nextFocus
			? this.overlayStack.find((entry) => entry.component === nextFocus && this.isOverlayVisible(entry))
			: undefined;
		if (focusedOverlay) {
			this.overlayFocusRestore = { status: "eligible", overlay: focusedOverlay };
		}
	}

	private clearOverlayFocusRestore(): void {
		this.overlayFocusRestore = { status: "inactive" };
	}

	private clearOverlayFocusRestoreFor(overlay: OverlayStackEntry): void {
		if (this.overlayFocusRestore.status !== "inactive" && this.overlayFocusRestore.overlay === overlay) {
			this.clearOverlayFocusRestore();
		}
	}

	private resolveBlockedOverlayFocusResume(restoreState: BlockedOverlayFocusRestoreState): Component | null {
		if (restoreState.resume.status === "restore-overlay") return restoreState.overlay.component;
		this.clearOverlayFocusRestore();
		return restoreState.resume.target;
	}

	private getVisibleOverlayFocusRestore(): OverlayFocusRestoreState {
		const restoreState = this.overlayFocusRestore;
		if (restoreState.status === "inactive") return restoreState;
		if (!this.overlayStack.includes(restoreState.overlay) || !this.isOverlayVisible(restoreState.overlay)) {
			return { status: "inactive" };
		}
		return restoreState;
	}

	private isOverlayFocusAncestor(entry: OverlayStackEntry, component: Component): boolean {
		const visited = new Set<Component>();
		let current = entry.preFocus;
		while (current && !visited.has(current)) {
			visited.add(current);
			if (current === component) return true;
			current = this.overlayStack.find((overlay) => overlay.component === current)?.preFocus ?? null;
		}
		return false;
	}

	private retargetOverlayPreFocus(removed: OverlayStackEntry): void {
		for (const overlay of this.overlayStack) {
			if (overlay !== removed && overlay.preFocus === removed.component) {
				overlay.preFocus = removed.preFocus;
			}
		}
	}

	private isComponentMounted(component: Component): boolean {
		return this.children.some((child) => this.containsComponent(child, component));
	}

	private containsComponent(root: Component, target: Component): boolean {
		if (root === target) return true;
		if (!(root instanceof Container)) return false;
		return root.children.some((child) => this.containsComponent(child, target));
	}

	/**
	 * Show an overlay component with configurable positioning and sizing.
	 * Returns a handle to control the overlay's visibility.
	 */
	showOverlay(component: Component, options?: OverlayOptions): OverlayHandle {
		const entry: OverlayStackEntry = {
			component,
			...(options === undefined ? {} : { options }),
			preFocus: this.focusedComponent,
			hidden: false,
			focusOrder: ++this.focusOrderCounter,
		};
		this.overlayStack.push(entry);
		// Only focus if overlay is actually visible
		if (!options?.nonCapturing && this.isOverlayVisible(entry)) {
			this.setFocus(component);
		}
		this.terminal.hideCursor();
		this.requestRender();

		// Return handle for controlling this overlay
		return {
			hide: () => {
				const index = this.overlayStack.indexOf(entry);
				if (index !== -1) {
					this.clearOverlayFocusRestoreFor(entry);
					this.retargetOverlayPreFocus(entry);
					this.overlayStack.splice(index, 1);
					// Restore focus if this overlay had focus
					if (this.focusedComponent === component) {
						const topVisible = this.getTopmostVisibleOverlay();
						this.setFocus(topVisible?.component ?? entry.preFocus);
					}
					if (this.overlayStack.length === 0) this.terminal.hideCursor();
					this.requestRender();
				}
			},
			setHidden: (hidden: boolean) => {
				if (entry.hidden === hidden) return;
				entry.hidden = hidden;
				// Update focus when hiding/showing
				if (hidden) {
					this.clearOverlayFocusRestoreFor(entry);
					// If this overlay had focus, move focus to next visible or preFocus
					if (this.focusedComponent === component) {
						const topVisible = this.getTopmostVisibleOverlay();
						this.setFocus(topVisible?.component ?? entry.preFocus);
					}
				} else {
					// Restore focus to this overlay when showing (if it's actually visible)
					if (!options?.nonCapturing && this.isOverlayVisible(entry)) {
						entry.focusOrder = ++this.focusOrderCounter;
						this.setFocus(component);
					}
				}
				this.requestRender();
			},
			isHidden: () => entry.hidden,
			focus: () => {
				if (!this.overlayStack.includes(entry) || !this.isOverlayVisible(entry)) return;
				entry.focusOrder = ++this.focusOrderCounter;
				this.setFocus(component);
				this.requestRender();
			},
			unfocus: (unfocusOptions) => {
				const isFocused = this.focusedComponent === component;
				const restoreState = this.overlayFocusRestore;
				const hasPendingRestore = restoreState.status !== "inactive" && restoreState.overlay === entry;
				if (!isFocused && !hasPendingRestore) return;
				if (
					restoreState.status === "blocked" &&
					restoreState.overlay === entry &&
					this.focusedComponent === restoreState.blockedBy
				) {
					if (unfocusOptions) {
						this.overlayFocusRestore = {
							status: "blocked",
							overlay: entry,
							blockedBy: restoreState.blockedBy,
							resume: { status: "focus-target", target: unfocusOptions.target },
						};
					} else {
						this.clearOverlayFocusRestore();
					}
					this.requestRender();
					return;
				}
				this.clearOverlayFocusRestoreFor(entry);
				if (isFocused || unfocusOptions) {
					const topVisible = this.getTopmostVisibleOverlay();
					const fallbackTarget = topVisible && topVisible !== entry ? topVisible.component : entry.preFocus;
					this.setFocus(unfocusOptions ? unfocusOptions.target : fallbackTarget);
				}
				this.requestRender();
			},
			isFocused: () => this.focusedComponent === component,
		};
	}

	/** Hide the topmost overlay and restore previous focus. */
	hideOverlay(): void {
		const overlay = this.overlayStack[this.overlayStack.length - 1];
		if (!overlay) return;
		this.clearOverlayFocusRestoreFor(overlay);
		this.retargetOverlayPreFocus(overlay);
		this.overlayStack.pop();
		if (this.focusedComponent === overlay.component) {
			// Find topmost visible overlay, or fall back to preFocus
			const topVisible = this.getTopmostVisibleOverlay();
			this.setFocus(topVisible?.component ?? overlay.preFocus);
		}
		if (this.overlayStack.length === 0) this.terminal.hideCursor();
		this.requestRender();
	}

	/** Check if there are any visible overlays */
	hasOverlay(): boolean {
		return this.overlayStack.some((o) => this.isOverlayVisible(o));
	}

	/** Check if an overlay entry is currently visible */
	private isOverlayVisible(entry: OverlayStackEntry): boolean {
		if (entry.hidden) return false;
		if (entry.options?.visible) {
			return entry.options.visible(this.terminal.columns, this.terminal.rows);
		}
		return true;
	}

	/** Find the visual-frontmost visible capturing overlay, if any */
	private getTopmostVisibleOverlay(): OverlayStackEntry | undefined {
		let topmost: OverlayStackEntry | undefined;
		for (const overlay of this.overlayStack) {
			if (overlay.options?.nonCapturing || !this.isOverlayVisible(overlay)) continue;
			if (!topmost || overlay.focusOrder > topmost.focusOrder) {
				topmost = overlay;
			}
		}
		return topmost;
	}

	override invalidate(): void {
		this.fullScreenMessageSnapshot = undefined;
		super.invalidate();
		for (const overlay of this.overlayStack) overlay.component.invalidate?.();
	}

	start(): void {
		this.stopped = false;
		this.terminal.start(
			(data) => this.handleInput(data),
			() => this.requestRender(),
		);
		if (this.screenMode === "full-screen") {
			this.terminal.write(ALTERNATE_SCREEN_ENABLE_SEQUENCE);
			if (this.fullScreenMouseReporting) {
				this.terminal.write(MOUSE_REPORTING_ENABLE_SEQUENCE);
			}
		}
		this.terminal.hideCursor();
		if (this.terminalColorSchemeNotificationsEnabled) {
			this.terminal.write("\x1b[?2031h");
		}
		this.queryCellSize();
		this.requestRender(this.screenMode === "full-screen");
	}

	addInputListener(listener: InputListener): () => void {
		this.inputListeners.add(listener);
		return () => {
			this.inputListeners.delete(listener);
		};
	}

	removeInputListener(listener: InputListener): void {
		this.inputListeners.delete(listener);
	}

	onTerminalColorSchemeChange(listener: (scheme: TerminalColorScheme) => void): () => void {
		this.terminalColorSchemeListeners.add(listener);
		return () => {
			this.terminalColorSchemeListeners.delete(listener);
		};
	}

	setTerminalColorSchemeNotifications(enabled: boolean): void {
		if (this.terminalColorSchemeNotificationsEnabled === enabled) {
			return;
		}
		this.terminalColorSchemeNotificationsEnabled = enabled;
		if (!this.stopped) {
			this.terminal.write(enabled ? "\x1b[?2031h" : "\x1b[?2031l");
		}
	}

	private queryCellSize(): void {
		// Only query if terminal supports images (cell size is only used for image rendering)
		if (!getCapabilities().images) {
			return;
		}
		// Query terminal for cell size in pixels: CSI 16 t
		// Response format: CSI 6 ; height ; width t
		this.terminal.write("\x1b[16t");
	}

	stop(): void {
		this.stopped = true;
		if (this.renderTimer) {
			clearTimeout(this.renderTimer);
			this.renderTimer = undefined;
		}
		if (this.terminalColorSchemeNotificationsEnabled) {
			this.terminal.write("\x1b[?2031l");
		}
		// Move cursor to the end of the content to prevent overwriting/artifacts on exit
		if (this.previousLines.length > 0) {
			const targetRow = this.previousLines.length; // Line after the last content
			const lineDiff = targetRow - this.hardwareCursorRow;
			if (lineDiff > 0) {
				this.terminal.write(`\x1b[${lineDiff}B`);
			} else if (lineDiff < 0) {
				this.terminal.write(`\x1b[${-lineDiff}A`);
			}
			this.terminal.write("\r\n");
		}

		if (this.screenMode === "full-screen") {
			if (this.fullScreenMouseReporting) {
				this.terminal.write(MOUSE_REPORTING_DISABLE_SEQUENCE);
			}
			this.terminal.write(ALTERNATE_SCREEN_DISABLE_SEQUENCE);
		}
		this.terminal.showCursor();
		this.terminal.stop();
	}

	requestRender(force = false): void {
		this.queueRender("content", force);
	}

	private requestViewportRender(): void {
		this.viewportNavigationHandledDuringInput = true;
		this.queueRender("viewport");
	}

	private queueRender(reason: FullScreenRenderReason, force = false): void {
		this.pendingRenderReason = this.mergeFullScreenRenderReason(this.pendingRenderReason, reason);
		if (force) {
			this.fullScreenMessageSnapshot = undefined;
			this.previousLines = [];
			this.previousWidth = -1; // -1 triggers widthChanged, forcing a full clear
			this.previousHeight = -1; // -1 triggers heightChanged, forcing a full clear
			this.cursorRow = 0;
			this.hardwareCursorRow = 0;
			this.maxLinesRendered = 0;
			this.previousViewportTop = 0;
			if (this.renderTimer) {
				clearTimeout(this.renderTimer);
				this.renderTimer = undefined;
			}
			this.renderRequested = true;
			process.nextTick(() => {
				if (this.stopped || !this.renderRequested) {
					return;
				}
				this.renderRequested = false;
				this.lastRenderAt = performance.now();
				this.doRender();
			});
			return;
		}
		if (this.renderRequested) return;
		this.renderRequested = true;
		process.nextTick(() => this.scheduleRender());
	}

	private mergeFullScreenRenderReason(
		current: FullScreenRenderReason | undefined,
		next: FullScreenRenderReason,
	): FullScreenRenderReason {
		if (current === "content" || next === "content") {
			return "content";
		}
		return "viewport";
	}

	private consumeFullScreenRenderReason(): FullScreenRenderReason {
		const reason = this.pendingRenderReason ?? "content";
		this.pendingRenderReason = undefined;
		return reason;
	}

	private scheduleRender(): void {
		if (this.stopped || this.renderTimer || !this.renderRequested) {
			return;
		}
		const elapsed = performance.now() - this.lastRenderAt;
		const delay = Math.max(0, TUI.MIN_RENDER_INTERVAL_MS - elapsed);
		this.renderTimer = setTimeout(() => {
			this.renderTimer = undefined;
			if (this.stopped || !this.renderRequested) {
				return;
			}
			this.renderRequested = false;
			this.lastRenderAt = performance.now();
			this.doRender();
			if (this.renderRequested) {
				this.scheduleRender();
			}
		}, delay);
	}

	private handleInput(data: string): void {
		if (this.consumeOsc11BackgroundResponse(data)) {
			return;
		}
		if (this.consumeTerminalColorSchemeReport(data)) {
			return;
		}

		if (this.inputListeners.size > 0) {
			let current = data;
			for (const listener of this.inputListeners) {
				const result = listener(current);
				if (result?.consume) {
					return;
				}
				if (result?.data !== undefined) {
					current = result.data;
				}
			}
			if (current.length === 0) {
				return;
			}
			data = current;
		}

		// Consume terminal cell size responses without blocking unrelated input.
		if (this.consumeCellSizeResponse(data)) {
			return;
		}

		if (this.handleFullScreenPointerInput(data)) {
			return;
		}

		// Global debug key handler (Shift+Ctrl+D)
		if (matchesKey(data, "shift+ctrl+d") && this.onDebug) {
			this.onDebug();
			return;
		}

		// If focused component is an overlay, verify it's still visible
		// (visibility can change due to terminal resize or visible() callback)
		const focusedOverlay = this.overlayStack.find((o) => o.component === this.focusedComponent);
		if (focusedOverlay && !this.isOverlayVisible(focusedOverlay)) {
			// Focused overlay is no longer visible, redirect to topmost visible overlay
			const topVisible = this.getTopmostVisibleOverlay();
			if (topVisible) {
				this.setFocus(topVisible.component);
			} else {
				this.setFocusInternal({ component: focusedOverlay.preFocus, overlayFocusRestore: "preserve" });
			}
		}

		const focusIsOverlay = this.overlayStack.some((o) => o.component === this.focusedComponent);
		if (!focusIsOverlay) {
			const restoreState = this.getVisibleOverlayFocusRestore();
			if (restoreState.status === "eligible") {
				this.setFocus(restoreState.overlay.component);
			} else if (restoreState.status === "blocked" && restoreState.blockedBy !== this.focusedComponent) {
				if (restoreState.resume.status === "restore-overlay") {
					this.setFocus(restoreState.overlay.component);
				} else {
					this.clearOverlayFocusRestore();
					this.setFocus(restoreState.resume.target);
				}
			}
		}

		// Pass input to focused component (including Ctrl+C)
		// The focused component can decide how to handle Ctrl+C
		if (this.focusedComponent?.handleInput) {
			// Filter out key release events unless component opts in
			if (isKeyRelease(data) && !this.focusedComponent.wantsKeyRelease) {
				return;
			}
			this.viewportNavigationHandledDuringInput = false;
			this.focusedComponent.handleInput(data);
			// Message viewport navigation already handled this input, even if it was a
			// no-op at a scroll boundary and therefore did not schedule a frame.
			if (!this.viewportNavigationHandledDuringInput) {
				this.requestRender();
			}
			this.viewportNavigationHandledDuringInput = false;
		}
	}

	private consumeOsc11BackgroundResponse(data: string): boolean {
		if (this.pendingOsc11BackgroundReplies <= 0) {
			return false;
		}

		if (!isOsc11BackgroundColorResponse(data)) {
			return false;
		}

		const rgb = parseOsc11BackgroundColor(data);
		this.pendingOsc11BackgroundReplies -= 1;
		const query = this.pendingOsc11BackgroundQueries.shift();
		if (query && !query.settled) {
			query.settled = true;
			if (query.timer) {
				clearTimeout(query.timer);
				query.timer = undefined;
			}
			query.resolve?.(rgb);
			query.resolve = undefined;
		}
		return true;
	}

	private consumeTerminalColorSchemeReport(data: string): boolean {
		const scheme = parseTerminalColorSchemeReport(data);
		if (!scheme) {
			return false;
		}

		for (const listener of this.terminalColorSchemeListeners) {
			listener(scheme);
		}
		return true;
	}

	private consumeCellSizeResponse(data: string): boolean {
		// Response format: ESC [ 6 ; height ; width t
		const match = data.match(/^\x1b\[6;(\d+);(\d+)t$/);
		if (!match) {
			return false;
		}

		const heightPx = parseInt(match[1], 10);
		const widthPx = parseInt(match[2], 10);
		if (heightPx <= 0 || widthPx <= 0) {
			return true;
		}

		setCellDimensions({ widthPx, heightPx });
		// Invalidate all components so images re-render with correct dimensions.
		this.invalidate();
		this.requestRender();
		return true;
	}

	private getFullScreenSelectionRange():
		| {
				start: FullScreenSelectionPoint;
				end: FullScreenSelectionPoint;
		  }
		| undefined {
		if (!this.fullScreenSelectionAnchor || !this.fullScreenSelectionFocus) {
			return undefined;
		}

		const anchor = this.fullScreenSelectionAnchor;
		const focus = this.fullScreenSelectionFocus;
		if (anchor.row === focus.row && anchor.col === focus.col) {
			return undefined;
		}

		if (anchor.row < focus.row || (anchor.row === focus.row && anchor.col <= focus.col)) {
			return { start: anchor, end: focus };
		}
		return { start: focus, end: anchor };
	}

	private updateFullScreenSelection(point: FullScreenSelectionPoint): void {
		this.fullScreenSelectionFocus = this.clampFullScreenSelectionPoint(point);
		this.requestRender();
	}

	private clampFullScreenSelectionPoint(point: FullScreenSelectionPoint): FullScreenSelectionPoint {
		return {
			row: Math.max(0, Math.min(this.terminal.rows - 1, point.row)),
			col: Math.max(0, Math.min(this.terminal.columns - 1, point.col)),
		};
	}

	private clearFullScreenSelection(options: { render?: boolean } = {}): void {
		if (!this.fullScreenSelectionAnchor && !this.fullScreenSelectionFocus && !this.fullScreenSelectionActive) {
			return;
		}
		this.fullScreenSelectionAnchor = undefined;
		this.fullScreenSelectionFocus = undefined;
		this.fullScreenSelectionActive = false;
		if (options.render) {
			this.requestRender();
		}
	}

	private applyFullScreenSelection(lines: string[], width: number): string[] {
		if (this.screenMode !== "full-screen") {
			return lines;
		}

		const range = this.getFullScreenSelectionRange();
		if (!range) {
			return lines;
		}

		return lines.map((line, row) => {
			const renderedScrollbar = this.fullScreenMessageViewportScrollbarLines[row];
			const scrollbar = renderedScrollbar && line.endsWith(renderedScrollbar) ? renderedScrollbar : "";
			const selectableLine = scrollbar ? sliceByColumn(line, 0, width - 1, true) : line;
			const span = this.getSelectionSpanForLine(selectableLine, row, range, width);
			if (!span) {
				return line;
			}
			const selectedLength = span.end - span.start;
			const selectableWidth = scrollbar ? width - 1 : width;
			const before = sliceByColumn(selectableLine, 0, span.start, true);
			const selected = sliceByColumn(selectableLine, span.start, selectedLength, true);
			const after = sliceByColumn(selectableLine, span.end, selectableWidth - span.end, true);
			if (visibleWidth(selected) === 0) {
				return line;
			}
			return `${before}${this.applyFullScreenSelectionStyle(selected)}${after}${scrollbar}`;
		});
	}

	private applyFullScreenSelectionStyle(text: string): string {
		let result = SELECTION_ENABLE_SEQUENCE;
		let index = 0;
		while (index < text.length) {
			const ansi = extractAnsiCode(text, index);
			if (ansi) {
				result += ansi.code + SELECTION_ENABLE_SEQUENCE;
				index += ansi.length;
				continue;
			}
			result += text[index];
			index++;
		}
		return result + SELECTION_DISABLE_SEQUENCE;
	}

	private getSelectionSpanForLine(
		line: string,
		row: number,
		range: { start: FullScreenSelectionPoint; end: FullScreenSelectionPoint },
		width: number,
	): { start: number; end: number } | undefined {
		const selectableWidth =
			this.fullScreenMessageViewportScrollbar && width > 1 && row < this.fullScreenMessageViewportHeight
				? width - 1
				: width;
		const selectionSpan = this.getSelectionSpanForRow(row, range, selectableWidth);
		if (!selectionSpan) {
			return undefined;
		}

		const start = visibleWidth(sliceByColumn(line, 0, selectionSpan.start, true));
		const end = visibleWidth(sliceByColumn(line, 0, selectionSpan.end));
		return start < end ? { start, end } : undefined;
	}

	private getSelectionSpanForRow(
		row: number,
		range: { start: FullScreenSelectionPoint; end: FullScreenSelectionPoint },
		width: number,
	): { start: number; end: number } | undefined {
		if (row < range.start.row || row > range.end.row) {
			return undefined;
		}

		const start = Math.min(row === range.start.row ? range.start.col : 0, width);
		const end = Math.min(row === range.end.row ? range.end.col + 1 : width, width);
		if (start >= end) {
			return undefined;
		}
		return { start, end };
	}

	private getFullScreenSelectedText(): string {
		const range = this.getFullScreenSelectionRange();
		if (!range) {
			return "";
		}

		const lines: string[] = [];
		for (let row = range.start.row; row <= range.end.row; row++) {
			const line = this.fullScreenSelectionSourceLines[row] ?? "";
			const span = this.getSelectionSpanForLine(line, row, range, this.terminal.columns);
			if (!span) {
				continue;
			}
			lines.push(
				this.stripTerminalControlCodes(sliceByColumn(line, span.start, span.end - span.start, true)).trimEnd(),
			);
		}
		return lines.join("\n");
	}

	private stripTerminalControlCodes(text: string): string {
		let result = "";
		let index = 0;
		while (index < text.length) {
			const ansi = extractAnsiCode(text, index);
			if (ansi) {
				index += ansi.length;
				continue;
			}
			result += text[index];
			index++;
		}
		return result;
	}

	private handleFullScreenPointerInput(data: string): boolean {
		if (this.screenMode !== "full-screen" || !this.fullScreenMouseReporting) {
			return false;
		}

		const pointerEvent = parseFullScreenPointerEvent(data);
		if (!pointerEvent) {
			return false;
		}

		if (this.hasOverlay()) {
			// Visible overlays keep their existing focused-input semantics.
			// In Full-screen mode we only suppress built-in wheel routing here;
			// raw wheel input still flows to the focused component.
			return pointerEvent.kind !== "wheel";
		}

		if (
			pointerEvent.row < 0 ||
			pointerEvent.row >= this.terminal.rows ||
			pointerEvent.col < 0 ||
			pointerEvent.col >= this.terminal.columns
		) {
			return true;
		}

		if (pointerEvent.kind === "left-down") {
			const point = this.clampFullScreenSelectionPoint(pointerEvent);
			this.fullScreenSelectionAnchor = point;
			this.fullScreenSelectionFocus = point;
			this.fullScreenSelectionActive = true;
			this.requestRender();
			return true;
		}

		if (pointerEvent.kind === "left-drag") {
			if (this.fullScreenSelectionActive) {
				this.updateFullScreenSelection(pointerEvent);
			}
			return true;
		}

		if (pointerEvent.kind === "left-up") {
			if (this.fullScreenSelectionActive) {
				this.updateFullScreenSelection(pointerEvent);
				this.fullScreenSelectionActive = false;
				const selectedText = this.getFullScreenSelectedText();
				this.clearFullScreenSelection();
				if (selectedText.trim().length > 0) {
					this.fullScreenSelectionHandler?.(selectedText);
				}
			}
			return true;
		}

		if (pointerEvent.kind !== "wheel") {
			this.clearFullScreenSelection({ render: true });
			return true;
		}

		this.clearFullScreenSelection();

		const height = this.terminal.rows;
		const committedMessageViewportHeight = this.fullScreenMessageViewportHeight;
		if (committedMessageViewportHeight > 0 && pointerEvent.row < committedMessageViewportHeight) {
			if (pointerEvent.direction === "up") {
				this.scrollMessageViewportUp();
				return true;
			}
			this.scrollMessageViewportDown();
			return true;
		}

		const layout = this.getFullScreenPointerLayout();
		if (!layout) {
			return true;
		}

		if (pointerEvent.row < layout.messageViewportHeight) {
			if (pointerEvent.direction === "up") {
				this.scrollMessageViewportUp();
				return true;
			}
			this.scrollMessageViewportDown();
			return true;
		}

		const targetSpan = this.getVisibleFullScreenComponentRowSpan(
			this.fullScreenPointerScrollTarget?.component,
			layout.width,
			height,
			layout.composerVisibleStartOffset,
			layout.composerHeight,
		);
		if (!targetSpan) {
			return true;
		}

		if (pointerEvent.row >= targetSpan.start && pointerEvent.row < targetSpan.end) {
			if (pointerEvent.direction === "up") {
				this.fullScreenPointerScrollTarget?.scrollUp();
				return true;
			}
			this.fullScreenPointerScrollTarget?.scrollDown();
			return true;
		}

		return true;
	}

	private getFullScreenPointerLayout():
		| {
				width: number;
				height: number;
				messageViewportHeight: number;
				composerHeight: number;
				composerVisibleStartOffset: number;
		  }
		| undefined {
		if (this.childRegions.size === 0) {
			return undefined;
		}

		const width = this.terminal.columns;
		const height = this.terminal.rows;
		if (this.fullScreenMessageViewportHeight > 0) {
			const composerHeight = Math.max(0, height - this.fullScreenMessageViewportHeight);
			return {
				width,
				height,
				messageViewportHeight: this.fullScreenMessageViewportHeight,
				composerHeight,
				// The visible Composer span is measured against the bottom-aligned region.
				// When committed layout is available, the full composer height equals the
				// visible height, so the visible start offset is zero.
				composerVisibleStartOffset: 0,
			};
		}

		const composerLines = this.renderChildren(this.getChildrenInScreenRegion("composer-region"), width);
		const composerHeight = Math.min(height, composerLines.length);
		return {
			width,
			height,
			messageViewportHeight: Math.max(0, height - composerHeight),
			composerHeight,
			composerVisibleStartOffset: Math.max(0, composerLines.length - composerHeight),
		};
	}

	private getVisibleFullScreenComponentRowSpan(
		component: Component | undefined,
		width: number,
		height: number,
		composerVisibleStartOffset: number,
		composerHeight: number,
	): { start: number; end: number } | undefined {
		if (!component) {
			return undefined;
		}

		const fullSpan = this.findComponentLineSpanInChildren(
			this.getChildrenInScreenRegion("composer-region"),
			component,
			width,
			0,
		);
		if (!fullSpan) {
			return undefined;
		}

		const visibleStart = Math.max(fullSpan.start, composerVisibleStartOffset);
		const visibleEnd = Math.min(fullSpan.end, composerVisibleStartOffset + composerHeight);
		if (visibleStart >= visibleEnd) {
			return undefined;
		}

		const composerStartRow = height - composerHeight;
		return {
			start: composerStartRow + visibleStart - composerVisibleStartOffset,
			end: composerStartRow + visibleEnd - composerVisibleStartOffset,
		};
	}

	private findComponentLineSpanInChildren(
		children: readonly Component[],
		target: Component,
		width: number,
		startRow: number,
	): { start: number; end: number } | undefined {
		let row = startRow;
		for (const child of children) {
			const measurement = this.measureComponentLineSpan(child, target, width, row);
			if (measurement.span) {
				return measurement.span;
			}
			row += measurement.lineCount;
		}
		return undefined;
	}

	private measureComponentLineSpan(
		component: Component,
		target: Component,
		width: number,
		startRow: number,
	): { lineCount: number; span?: { start: number; end: number } } {
		if (!(component instanceof Container)) {
			const lineCount = component.render(width).length;
			return {
				lineCount,
				...(component === target ? { span: { start: startRow, end: startRow + lineCount } } : {}),
			};
		}

		let lineCount = 0;
		let span: { start: number; end: number } | undefined;
		for (const child of component.children) {
			const measurement = this.measureComponentLineSpan(child, target, width, startRow + lineCount);
			lineCount += measurement.lineCount;
			if (!span && measurement.span) {
				span = measurement.span;
			}
		}

		if (!span && component === target) {
			span = { start: startRow, end: startRow + lineCount };
		}

		return { lineCount, ...(span ? { span } : {}) };
	}

	/**
	 * Resolve overlay layout from options.
	 * Returns { width, row, col, maxHeight } for rendering.
	 */
	private resolveOverlayLayout(
		options: OverlayOptions | undefined,
		overlayHeight: number,
		termWidth: number,
		termHeight: number,
	): { width: number; row: number; col: number; maxHeight: number | undefined } {
		const opt = options ?? {};

		// Parse margin (clamp to non-negative)
		const margin =
			typeof opt.margin === "number"
				? { top: opt.margin, right: opt.margin, bottom: opt.margin, left: opt.margin }
				: (opt.margin ?? {});
		const marginTop = Math.max(0, margin.top ?? 0);
		const marginRight = Math.max(0, margin.right ?? 0);
		const marginBottom = Math.max(0, margin.bottom ?? 0);
		const marginLeft = Math.max(0, margin.left ?? 0);

		// Available space after margins
		const availWidth = Math.max(1, termWidth - marginLeft - marginRight);
		const availHeight = Math.max(1, termHeight - marginTop - marginBottom);

		// === Resolve width ===
		let width = parseSizeValue(opt.width, termWidth) ?? Math.min(80, availWidth);
		// Apply minWidth
		if (opt.minWidth !== undefined) {
			width = Math.max(width, opt.minWidth);
		}
		// Clamp to available space
		width = Math.max(1, Math.min(width, availWidth));

		// === Resolve maxHeight ===
		let maxHeight = parseSizeValue(opt.maxHeight, termHeight);
		// Clamp to available space
		if (maxHeight !== undefined) {
			maxHeight = Math.max(1, Math.min(maxHeight, availHeight));
		}

		// Effective overlay height (may be clamped by maxHeight)
		const effectiveHeight = maxHeight !== undefined ? Math.min(overlayHeight, maxHeight) : overlayHeight;

		// === Resolve position ===
		let row: number;
		let col: number;

		if (opt.row !== undefined) {
			if (typeof opt.row === "string") {
				// Percentage: 0% = top, 100% = bottom (overlay stays within bounds)
				const match = opt.row.match(/^(\d+(?:\.\d+)?)%$/);
				if (match) {
					const maxRow = Math.max(0, availHeight - effectiveHeight);
					const percent = parseFloat(match[1]) / 100;
					row = marginTop + Math.floor(maxRow * percent);
				} else {
					// Invalid format, fall back to center
					row = this.resolveAnchorRow("center", effectiveHeight, availHeight, marginTop);
				}
			} else {
				// Absolute row position
				row = opt.row;
			}
		} else {
			// Anchor-based (default: center)
			const anchor = opt.anchor ?? "center";
			row = this.resolveAnchorRow(anchor, effectiveHeight, availHeight, marginTop);
		}

		if (opt.col !== undefined) {
			if (typeof opt.col === "string") {
				// Percentage: 0% = left, 100% = right (overlay stays within bounds)
				const match = opt.col.match(/^(\d+(?:\.\d+)?)%$/);
				if (match) {
					const maxCol = Math.max(0, availWidth - width);
					const percent = parseFloat(match[1]) / 100;
					col = marginLeft + Math.floor(maxCol * percent);
				} else {
					// Invalid format, fall back to center
					col = this.resolveAnchorCol("center", width, availWidth, marginLeft);
				}
			} else {
				// Absolute column position
				col = opt.col;
			}
		} else {
			// Anchor-based (default: center)
			const anchor = opt.anchor ?? "center";
			col = this.resolveAnchorCol(anchor, width, availWidth, marginLeft);
		}

		// Apply offsets
		if (opt.offsetY !== undefined) row += opt.offsetY;
		if (opt.offsetX !== undefined) col += opt.offsetX;

		// Clamp to terminal bounds (respecting margins)
		row = Math.max(marginTop, Math.min(row, termHeight - marginBottom - effectiveHeight));
		col = Math.max(marginLeft, Math.min(col, termWidth - marginRight - width));

		return { width, row, col, maxHeight };
	}

	private resolveAnchorRow(anchor: OverlayAnchor, height: number, availHeight: number, marginTop: number): number {
		switch (anchor) {
			case "top-left":
			case "top-center":
			case "top-right":
				return marginTop;
			case "bottom-left":
			case "bottom-center":
			case "bottom-right":
				return marginTop + availHeight - height;
			case "left-center":
			case "center":
			case "right-center":
				return marginTop + Math.floor((availHeight - height) / 2);
		}
	}

	private resolveAnchorCol(anchor: OverlayAnchor, width: number, availWidth: number, marginLeft: number): number {
		switch (anchor) {
			case "top-left":
			case "left-center":
			case "bottom-left":
				return marginLeft;
			case "top-right":
			case "right-center":
			case "bottom-right":
				return marginLeft + availWidth - width;
			case "top-center":
			case "center":
			case "bottom-center":
				return marginLeft + Math.floor((availWidth - width) / 2);
		}
	}

	/** Composite all overlays into content lines (sorted by focusOrder, higher = on top). */
	private compositeOverlays(lines: string[], termWidth: number, termHeight: number): string[] {
		if (this.overlayStack.length === 0) return lines;
		const result = [...lines];

		// Pre-render all visible overlays and calculate positions
		const rendered: { overlayLines: string[]; row: number; col: number; w: number }[] = [];
		let minLinesNeeded = result.length;

		const visibleEntries = this.overlayStack.filter((e) => this.isOverlayVisible(e));
		visibleEntries.sort((a, b) => a.focusOrder - b.focusOrder);
		for (const entry of visibleEntries) {
			const { component, options } = entry;

			// Get layout with height=0 first to determine width and maxHeight
			// (width and maxHeight don't depend on overlay height)
			const { width, maxHeight } = this.resolveOverlayLayout(options, 0, termWidth, termHeight);

			// Render component at calculated width
			let overlayLines = component.render(width);

			// Apply maxHeight if specified
			if (maxHeight !== undefined && overlayLines.length > maxHeight) {
				overlayLines = overlayLines.slice(0, maxHeight);
			}

			// Get final row/col with actual overlay height
			const { row, col } = this.resolveOverlayLayout(options, overlayLines.length, termWidth, termHeight);

			rendered.push({ overlayLines, row, col, w: width });
			minLinesNeeded = Math.max(minLinesNeeded, row + overlayLines.length);
		}

		// Pad to at least terminal height so overlays have screen-relative positions.
		// Excludes maxLinesRendered: the historical high-water mark caused self-reinforcing
		// inflation that pushed content into scrollback on terminal widen.
		const workingHeight = Math.max(result.length, termHeight, minLinesNeeded);

		// Extend result with empty lines if content is too short for overlay placement or working area
		while (result.length < workingHeight) {
			result.push("");
		}

		const viewportStart = Math.max(0, workingHeight - termHeight);

		// Composite each overlay
		for (const { overlayLines, row, col, w } of rendered) {
			for (let i = 0; i < overlayLines.length; i++) {
				const idx = viewportStart + row + i;
				if (idx >= 0 && idx < result.length) {
					// Defensive: truncate overlay line to declared width before compositing
					// (components should already respect width, but this ensures it)
					const truncatedOverlayLine =
						visibleWidth(overlayLines[i]) > w ? sliceByColumn(overlayLines[i], 0, w, true) : overlayLines[i];
					result[idx] = this.compositeLineAt(result[idx], truncatedOverlayLine, col, w, termWidth);
				}
			}
		}

		return result;
	}

	private static readonly SEGMENT_RESET = "\x1b[0m\x1b]8;;\x07";

	private applyLineResets(lines: string[]): string[] {
		const reset = TUI.SEGMENT_RESET;
		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			if (!isImageLine(line)) {
				lines[i] = normalizeTerminalOutput(line) + reset;
			}
		}
		return lines;
	}

	private collectKittyImageIds(lines: string[]): Set<number> {
		const ids = new Set<number>();
		for (const line of lines) {
			for (const id of extractKittyImageIds(line)) {
				ids.add(id);
			}
		}
		return ids;
	}

	private deleteKittyImages(ids: Iterable<number>): string {
		let buffer = "";
		for (const id of ids) {
			buffer += deleteKittyImage(id);
		}
		return buffer;
	}

	private getKittyImageReservedRows(lines: string[], index: number, maxIndex = lines.length - 1): number {
		const rows = extractKittyImageRows(lines[index] ?? "");
		if (rows <= 1) return 1;

		const maxRows = Math.min(rows, maxIndex - index + 1, lines.length - index);
		let reservedRows = 1;
		while (reservedRows < maxRows) {
			const line = lines[index + reservedRows] ?? "";
			if (isImageLine(line) || visibleWidth(line) > 0) break;
			reservedRows++;
		}
		return reservedRows;
	}

	private expandChangedRangeForKittyImages(
		firstChanged: number,
		lastChanged: number,
		newLines: string[],
	): { firstChanged: number; lastChanged: number } {
		let expandedFirstChanged = firstChanged;
		let expandedLastChanged = lastChanged;
		const expandForLines = (lines: string[]): void => {
			for (let i = 0; i < lines.length; i++) {
				if (extractKittyImageIds(lines[i]).length === 0) continue;
				const blockEnd = i + this.getKittyImageReservedRows(lines, i) - 1;
				if (i >= firstChanged || (i <= lastChanged && blockEnd >= firstChanged)) {
					expandedFirstChanged = Math.min(expandedFirstChanged, i);
					expandedLastChanged = Math.max(expandedLastChanged, blockEnd);
				}
			}
		};

		expandForLines(this.previousLines);
		expandForLines(newLines);
		return { firstChanged: expandedFirstChanged, lastChanged: expandedLastChanged };
	}

	private deleteChangedKittyImages(firstChanged: number, lastChanged: number): string {
		if (firstChanged < 0 || lastChanged < firstChanged) return "";

		const ids = new Set<number>();
		const maxLine = Math.min(lastChanged, this.previousLines.length - 1);
		for (let i = firstChanged; i <= maxLine; i++) {
			for (const id of extractKittyImageIds(this.previousLines[i] ?? "")) {
				ids.add(id);
			}
		}

		return this.deleteKittyImages(ids);
	}

	/** Splice overlay content into a base line at a specific column. Single-pass optimized. */
	private compositeLineAt(
		baseLine: string,
		overlayLine: string,
		startCol: number,
		overlayWidth: number,
		totalWidth: number,
	): string {
		if (isImageLine(baseLine)) return baseLine;

		// Single pass through baseLine extracts both before and after segments
		const afterStart = startCol + overlayWidth;
		const base = extractSegments(baseLine, startCol, afterStart, totalWidth - afterStart, true);

		// Extract overlay with width tracking (strict=true to exclude wide chars at boundary)
		const overlay = sliceWithWidth(overlayLine, 0, overlayWidth, true);

		// Pad segments to target widths
		const beforePad = Math.max(0, startCol - base.beforeWidth);
		const overlayPad = Math.max(0, overlayWidth - overlay.width);
		const actualBeforeWidth = Math.max(startCol, base.beforeWidth);
		const actualOverlayWidth = Math.max(overlayWidth, overlay.width);
		const afterTarget = Math.max(0, totalWidth - actualBeforeWidth - actualOverlayWidth);
		const afterPad = Math.max(0, afterTarget - base.afterWidth);

		// Compose result
		const r = TUI.SEGMENT_RESET;
		const result =
			base.before +
			" ".repeat(beforePad) +
			r +
			overlay.text +
			" ".repeat(overlayPad) +
			r +
			base.after +
			" ".repeat(afterPad);

		// CRITICAL: Always verify and truncate to terminal width.
		// This is the final safeguard against width overflow which would crash the TUI.
		// Width tracking can drift from actual visible width due to:
		// - Complex ANSI/OSC sequences (hyperlinks, colors)
		// - Wide characters at segment boundaries
		// - Edge cases in segment extraction
		const resultWidth = visibleWidth(result);
		if (resultWidth <= totalWidth) {
			return result;
		}
		// Truncate with strict=true to ensure we don't exceed totalWidth
		return sliceByColumn(result, 0, totalWidth, true);
	}

	/**
	 * Find and extract cursor position from rendered lines.
	 * Searches for CURSOR_MARKER, calculates its position, and strips it from the output.
	 * Only scans the bottom terminal height lines (visible viewport).
	 * @param lines - Rendered lines to search
	 * @param height - Terminal height (visible viewport size)
	 * @returns Cursor position { row, col } or null if no marker found
	 */
	private extractCursorPosition(lines: string[], height: number): { row: number; col: number } | null {
		// Only scan the bottom `height` lines (visible viewport)
		const viewportTop = Math.max(0, lines.length - height);
		for (let row = lines.length - 1; row >= viewportTop; row--) {
			const line = lines[row];
			const markerIndex = line.indexOf(CURSOR_MARKER);
			if (markerIndex !== -1) {
				// Calculate visual column (width of text before marker)
				const beforeMarker = line.slice(0, markerIndex);
				const col = visibleWidth(beforeMarker);

				// Strip marker from the line
				lines[row] = line.slice(0, markerIndex) + line.slice(markerIndex + CURSOR_MARKER.length);

				return { row, col };
			}
		}
		return null;
	}

	private doRender(): void {
		if (this.stopped) return;
		const width = this.terminal.columns;
		const height = this.terminal.rows;
		const widthChanged = this.previousWidth !== 0 && this.previousWidth !== width;
		const heightChanged = this.previousHeight !== 0 && this.previousHeight !== height;
		const previousBufferLength = this.previousHeight > 0 ? this.previousViewportTop + this.previousHeight : height;
		let prevViewportTop = heightChanged ? Math.max(0, previousBufferLength - height) : this.previousViewportTop;
		let viewportTop = prevViewportTop;
		let hardwareCursorRow = this.hardwareCursorRow;
		const computeLineDiff = (targetRow: number): number => {
			const currentScreenRow = hardwareCursorRow - prevViewportTop;
			const targetScreenRow = targetRow - viewportTop;
			return targetScreenRow - currentScreenRow;
		};

		// Render all components to get new lines through the public override point.
		this.scheduledRenderReason = this.consumeFullScreenRenderReason();
		let newLines: string[];
		try {
			newLines = this.render(width);
		} finally {
			this.scheduledRenderReason = undefined;
		}

		// Composite overlays into the rendered lines (before differential compare)
		if (this.overlayStack.length > 0) {
			newLines = this.compositeOverlays(newLines, width, height);
		}

		// Extract cursor position before applying line resets (marker must be found first)
		const cursorPos = this.extractCursorPosition(newLines, height);

		this.fullScreenSelectionSourceLines = newLines;
		newLines = this.applyFullScreenSelection(newLines, width);

		newLines = this.applyLineResets(newLines);

		// Helper to clear scrollback and viewport and render all new lines
		const fullRender = (clear: boolean): void => {
			this.fullRedrawCount += 1;
			let buffer = "\x1b[?2026h"; // Begin synchronized output
			if (clear) {
				buffer += this.deleteKittyImages(this.previousKittyImageIds);
				buffer += "\x1b[2J\x1b[H\x1b[3J"; // Clear screen, home, then clear scrollback
			}
			for (let i = 0; i < newLines.length; i++) {
				if (i > 0) buffer += "\r\n";
				const line = newLines[i];
				const isImage = isImageLine(line);
				const imageReservedRows = isImage ? this.getKittyImageReservedRows(newLines, i) : 1;
				if (imageReservedRows > 1 && imageReservedRows <= height) {
					for (let row = 1; row < imageReservedRows; row++) {
						buffer += "\r\n";
					}
					buffer += `\x1b[${imageReservedRows - 1}A`;
					buffer += line;
					buffer += `\x1b[${imageReservedRows - 1}B`;
					i += imageReservedRows - 1;
					continue;
				}
				buffer += line;
			}
			buffer += "\x1b[?2026l"; // End synchronized output
			this.terminal.write(buffer);
			this.cursorRow = Math.max(0, newLines.length - 1);
			this.hardwareCursorRow = this.cursorRow;
			// Reset max lines when clearing, otherwise track growth
			if (clear) {
				this.maxLinesRendered = newLines.length;
			} else {
				this.maxLinesRendered = Math.max(this.maxLinesRendered, newLines.length);
			}
			const bufferLength = Math.max(height, newLines.length);
			this.previousViewportTop = Math.max(0, bufferLength - height);
			this.positionHardwareCursor(cursorPos, newLines.length);
			this.previousLines = newLines;
			this.previousKittyImageIds = this.collectKittyImageIds(newLines);
			this.previousWidth = width;
			this.previousHeight = height;
		};

		const debugRedraw = process.env.PI_DEBUG_REDRAW === "1";
		const logRedraw = (reason: string): void => {
			if (!debugRedraw) return;
			const logPath = path.join(os.homedir(), ".pi", "agent", "pi-debug.log");
			const msg = `[${new Date().toISOString()}] fullRender: ${reason} (prev=${this.previousLines.length}, new=${newLines.length}, height=${height})\n`;
			fs.appendFileSync(logPath, msg);
		};

		// First render - just output everything without clearing (assumes clean screen)
		if (this.previousLines.length === 0 && !widthChanged && !heightChanged) {
			logRedraw("first render");
			fullRender(false);
			return;
		}

		// Width changes always need a full re-render because wrapping changes.
		if (widthChanged) {
			logRedraw(`terminal width changed (${this.previousWidth} -> ${width})`);
			fullRender(true);
			return;
		}

		// Height changes normally need a full re-render to keep the visible viewport aligned,
		// but Termux changes height when the software keyboard shows or hides.
		// In that environment, a full redraw causes the entire history to replay on every toggle.
		if (heightChanged && !isTermuxSession()) {
			logRedraw(`terminal height changed (${this.previousHeight} -> ${height})`);
			fullRender(true);
			return;
		}

		// Content shrunk below the working area and no overlays - re-render to clear empty rows
		// (overlays need the padding, so only do this when no overlays are active)
		// Configurable via setClearOnShrink() or PI_CLEAR_ON_SHRINK=0 env var
		if (this.clearOnShrink && newLines.length < this.maxLinesRendered && this.overlayStack.length === 0) {
			logRedraw(`clearOnShrink (maxLinesRendered=${this.maxLinesRendered})`);
			fullRender(true);
			return;
		}

		// Find first and last changed lines
		let firstChanged = -1;
		let lastChanged = -1;
		const maxLines = Math.max(newLines.length, this.previousLines.length);
		for (let i = 0; i < maxLines; i++) {
			const oldLine = i < this.previousLines.length ? this.previousLines[i] : "";
			const newLine = i < newLines.length ? newLines[i] : "";

			if (oldLine !== newLine) {
				if (firstChanged === -1) {
					firstChanged = i;
				}
				lastChanged = i;
			}
		}
		const appendedLines = newLines.length > this.previousLines.length;
		if (appendedLines) {
			if (firstChanged === -1) {
				firstChanged = this.previousLines.length;
			}
			lastChanged = newLines.length - 1;
		}
		if (firstChanged !== -1) {
			const expandedRange = this.expandChangedRangeForKittyImages(firstChanged, lastChanged, newLines);
			firstChanged = expandedRange.firstChanged;
			lastChanged = expandedRange.lastChanged;
		}
		const appendStart = appendedLines && firstChanged === this.previousLines.length && firstChanged > 0;

		// No changes - but still need to update hardware cursor position if it moved
		if (firstChanged === -1) {
			this.positionHardwareCursor(cursorPos, newLines.length);
			this.previousViewportTop = prevViewportTop;
			this.previousHeight = height;
			return;
		}

		// All changes are in deleted lines (nothing to render, just clear)
		if (firstChanged >= newLines.length) {
			if (this.previousLines.length > newLines.length) {
				let buffer = "\x1b[?2026h";
				buffer += this.deleteChangedKittyImages(firstChanged, lastChanged);
				// Move to end of new content (clamp to 0 for empty content)
				const targetRow = Math.max(0, newLines.length - 1);
				if (targetRow < prevViewportTop) {
					logRedraw(`deleted lines moved viewport up (${targetRow} < ${prevViewportTop})`);
					fullRender(true);
					return;
				}
				const lineDiff = computeLineDiff(targetRow);
				if (lineDiff > 0) buffer += `\x1b[${lineDiff}B`;
				else if (lineDiff < 0) buffer += `\x1b[${-lineDiff}A`;
				buffer += "\r";
				// Clear extra lines without scrolling
				const extraLines = this.previousLines.length - newLines.length;
				if (extraLines > height) {
					logRedraw(`extraLines > height (${extraLines} > ${height})`);
					fullRender(true);
					return;
				}
				const clearStartOffset = newLines.length === 0 ? 0 : 1;
				if (extraLines > 0 && clearStartOffset > 0) {
					buffer += `\x1b[${clearStartOffset}B`;
				}
				for (let i = 0; i < extraLines; i++) {
					buffer += "\r\x1b[2K";
					if (i < extraLines - 1) buffer += "\x1b[1B";
				}
				const moveBack = Math.max(0, extraLines - 1 + clearStartOffset);
				if (moveBack > 0) {
					buffer += `\x1b[${moveBack}A`;
				}
				buffer += "\x1b[?2026l";
				this.terminal.write(buffer);
				this.cursorRow = targetRow;
				this.hardwareCursorRow = targetRow;
			}
			this.positionHardwareCursor(cursorPos, newLines.length);
			this.previousLines = newLines;
			this.previousKittyImageIds = this.collectKittyImageIds(newLines);
			this.previousWidth = width;
			this.previousHeight = height;
			this.previousViewportTop = prevViewportTop;
			return;
		}

		// Differential rendering can only touch what was actually visible.
		// If the first changed line is above the previous viewport, we need a full redraw.
		if (firstChanged < prevViewportTop) {
			logRedraw(`firstChanged < viewportTop (${firstChanged} < ${prevViewportTop})`);
			fullRender(true);
			return;
		}

		// Render from first changed line to end
		// Build buffer with all updates wrapped in synchronized output
		let buffer = "\x1b[?2026h"; // Begin synchronized output
		buffer += this.deleteChangedKittyImages(firstChanged, lastChanged);
		const prevViewportBottom = prevViewportTop + height - 1;
		const moveTargetRow = appendStart ? firstChanged - 1 : firstChanged;
		if (moveTargetRow > prevViewportBottom) {
			const currentScreenRow = Math.max(0, Math.min(height - 1, hardwareCursorRow - prevViewportTop));
			const moveToBottom = height - 1 - currentScreenRow;
			if (moveToBottom > 0) {
				buffer += `\x1b[${moveToBottom}B`;
			}
			const scroll = moveTargetRow - prevViewportBottom;
			buffer += "\r\n".repeat(scroll);
			prevViewportTop += scroll;
			viewportTop += scroll;
			hardwareCursorRow = moveTargetRow;
		}

		// Move cursor to first changed line (use hardwareCursorRow for actual position)
		const lineDiff = computeLineDiff(moveTargetRow);
		if (lineDiff > 0) {
			buffer += `\x1b[${lineDiff}B`; // Move down
		} else if (lineDiff < 0) {
			buffer += `\x1b[${-lineDiff}A`; // Move up
		}

		buffer += appendStart ? "\r\n" : "\r"; // Move to column 0

		// Only render changed lines (firstChanged to lastChanged), not all lines to end
		// This reduces flicker when only a single line changes (e.g., spinner animation)
		const renderEnd = Math.min(lastChanged, newLines.length - 1);
		for (let i = firstChanged; i <= renderEnd; i++) {
			if (i > firstChanged) buffer += "\r\n";
			const line = newLines[i];
			const isImage = isImageLine(line);
			const imageReservedRows = isImage ? this.getKittyImageReservedRows(newLines, i, renderEnd) : 1;
			if (imageReservedRows > 1) {
				const imageStartScreenRow = i - viewportTop;
				if (imageStartScreenRow < 0 || imageStartScreenRow + imageReservedRows > height) {
					logRedraw(
						`kitty image pre-clear would scroll (${imageStartScreenRow} + ${imageReservedRows} > ${height})`,
					);
					fullRender(true);
					return;
				}

				buffer += "\x1b[2K";
				for (let row = 1; row < imageReservedRows; row++) {
					buffer += "\r\n\x1b[2K";
				}
				buffer += `\x1b[${imageReservedRows - 1}A`;
				buffer += line;
				buffer += `\x1b[${imageReservedRows - 1}B`;
				i += imageReservedRows - 1;
				continue;
			}

			buffer += "\x1b[2K"; // Clear current line
			if (!isImage && visibleWidth(line) > width) {
				// Log all lines to crash file for debugging
				const crashLogPath = path.join(os.homedir(), ".pi", "agent", "pi-crash.log");
				const crashData = [
					`Crash at ${new Date().toISOString()}`,
					`Terminal width: ${width}`,
					`Line ${i} visible width: ${visibleWidth(line)}`,
					"",
					"=== All rendered lines ===",
					...newLines.map((l, idx) => `[${idx}] (w=${visibleWidth(l)}) ${l}`),
					"",
				].join("\n");
				fs.mkdirSync(path.dirname(crashLogPath), { recursive: true });
				fs.writeFileSync(crashLogPath, crashData);

				// Clean up terminal state before throwing
				this.stop();

				const errorMsg = [
					`Rendered line ${i} exceeds terminal width (${visibleWidth(line)} > ${width}).`,
					"",
					"This is likely caused by a custom TUI component not truncating its output.",
					"Use visibleWidth() to measure and truncateToWidth() to truncate lines.",
					"",
					`Debug log written to: ${crashLogPath}`,
				].join("\n");
				throw new Error(errorMsg);
			}
			buffer += line;
		}

		// Track where cursor ended up after rendering
		let finalCursorRow = renderEnd;

		// If we had more lines before, clear them and move cursor back
		if (this.previousLines.length > newLines.length) {
			// Move to end of new content first if we stopped before it
			if (renderEnd < newLines.length - 1) {
				const moveDown = newLines.length - 1 - renderEnd;
				buffer += `\x1b[${moveDown}B`;
				finalCursorRow = newLines.length - 1;
			}
			const extraLines = this.previousLines.length - newLines.length;
			for (let i = newLines.length; i < this.previousLines.length; i++) {
				buffer += "\r\n\x1b[2K";
			}
			// Move cursor back to end of new content
			buffer += `\x1b[${extraLines}A`;
		}

		buffer += "\x1b[?2026l"; // End synchronized output

		if (process.env.PI_TUI_DEBUG === "1") {
			const debugDir = "/tmp/tui";
			fs.mkdirSync(debugDir, { recursive: true });
			const debugPath = path.join(debugDir, `render-${Date.now()}-${Math.random().toString(36).slice(2)}.log`);
			const debugData = [
				`firstChanged: ${firstChanged}`,
				`viewportTop: ${viewportTop}`,
				`cursorRow: ${this.cursorRow}`,
				`height: ${height}`,
				`lineDiff: ${lineDiff}`,
				`hardwareCursorRow: ${hardwareCursorRow}`,
				`renderEnd: ${renderEnd}`,
				`finalCursorRow: ${finalCursorRow}`,
				`cursorPos: ${JSON.stringify(cursorPos)}`,
				`newLines.length: ${newLines.length}`,
				`previousLines.length: ${this.previousLines.length}`,
				"",
				"=== newLines ===",
				JSON.stringify(newLines, null, 2),
				"",
				"=== previousLines ===",
				JSON.stringify(this.previousLines, null, 2),
				"",
				"=== buffer ===",
				JSON.stringify(buffer),
			].join("\n");
			fs.writeFileSync(debugPath, debugData);
		}

		// Write entire buffer at once
		this.terminal.write(buffer);

		// Track cursor position for next render
		// cursorRow tracks end of content (for viewport calculation)
		// hardwareCursorRow tracks actual terminal cursor position (for movement)
		this.cursorRow = Math.max(0, newLines.length - 1);
		this.hardwareCursorRow = finalCursorRow;
		// Track terminal's working area (grows but doesn't shrink unless cleared)
		this.maxLinesRendered = Math.max(this.maxLinesRendered, newLines.length);
		this.previousViewportTop = Math.max(prevViewportTop, finalCursorRow - height + 1);

		// Position hardware cursor for IME
		this.positionHardwareCursor(cursorPos, newLines.length);

		this.previousLines = newLines;
		this.previousKittyImageIds = this.collectKittyImageIds(newLines);
		this.previousWidth = width;
		this.previousHeight = height;
	}

	/**
	 * Position the hardware cursor for IME candidate window.
	 * @param cursorPos The cursor position extracted from rendered output, or null
	 * @param totalLines Total number of rendered lines
	 */
	private positionHardwareCursor(cursorPos: { row: number; col: number } | null, totalLines: number): void {
		if (!cursorPos || totalLines <= 0) {
			this.terminal.hideCursor();
			return;
		}

		// Clamp cursor position to valid range
		const targetRow = Math.max(0, Math.min(cursorPos.row, totalLines - 1));
		const targetCol = Math.max(0, cursorPos.col);

		// Move cursor from current position to target
		const rowDelta = targetRow - this.hardwareCursorRow;
		let buffer = "";
		if (rowDelta > 0) {
			buffer += `\x1b[${rowDelta}B`; // Move down
		} else if (rowDelta < 0) {
			buffer += `\x1b[${-rowDelta}A`; // Move up
		}
		// Move to absolute column (1-indexed)
		buffer += `\x1b[${targetCol + 1}G`;

		if (buffer) {
			this.terminal.write(buffer);
		}

		this.hardwareCursorRow = targetRow;
		if (this.showHardwareCursor) {
			this.terminal.showCursor();
		} else {
			this.terminal.hideCursor();
		}
	}

	/**
	 * Query the terminal's default background color with OSC 11 (`ESC ] 11 ; ? BEL`).
	 * @param timeoutMs Query timeout in milliseconds.
	 * @returns Promise containing the parsed RGB color, or undefined if it times out or fails to parse.
	 */
	queryTerminalBackgroundColor({ timeoutMs }: { timeoutMs: number }): Promise<RgbColor | undefined> {
		return new Promise((resolve) => {
			const query: PendingOsc11BackgroundQuery = {
				settled: false,
				resolve,
				timer: undefined,
			};

			query.timer = setTimeout(() => {
				if (query.settled) {
					return;
				}
				query.settled = true;
				query.timer = undefined;
				query.resolve?.(undefined);
				query.resolve = undefined;
			}, timeoutMs);
			this.pendingOsc11BackgroundQueries.push(query);
			this.pendingOsc11BackgroundReplies += 1;
			this.terminal.write("\x1b]11;?\x07");
		});
	}

	/**
	 * Query the terminal's color-scheme preference with DSR (`CSI ? 996 n`).
	 * Terminals that support the color palette notification protocol reply with
	 * `CSI ? 997 ; 1 n` for dark or `CSI ? 997 ; 2 n` for light.
	 */
	queryTerminalColorScheme({ timeoutMs }: { timeoutMs: number }): Promise<TerminalColorScheme | undefined> {
		return new Promise((resolve) => {
			let settled = false;
			let timer: NodeJS.Timeout | undefined;
			let unsubscribe: () => void = () => {};
			const settle = (scheme: TerminalColorScheme | undefined) => {
				if (settled) return;
				settled = true;
				if (timer) {
					clearTimeout(timer);
					timer = undefined;
				}
				unsubscribe();
				resolve(scheme);
			};

			unsubscribe = this.onTerminalColorSchemeChange(settle);
			timer = setTimeout(() => settle(undefined), timeoutMs);
			this.terminal.write("\x1b[?996n");
		});
	}
}
