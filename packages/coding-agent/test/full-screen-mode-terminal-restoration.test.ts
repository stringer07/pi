import { EventEmitter } from "node:events";
import { existsSync, writeFileSync } from "node:fs";
import { afterEach, describe, expect, test, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

const { spawnMock } = vi.hoisted(() => ({
	spawnMock: vi.fn(),
}));

vi.mock("node:child_process", () => ({
	spawn: spawnMock,
}));

type SignalCleanup = () => void;

type RegisterSignalHandlersThis = {
	signalCleanupHandlers: SignalCleanup[];
	ignoreProcessSigint?: boolean;
	isFullScreenMode(): boolean;
	unregisterSignalHandlers(): void;
	shutdown(options?: { fromSignal?: boolean }): Promise<void>;
	emergencyTerminalExit(): never;
	uncaughtCrash(error: Error, source?: "uncaughtException" | "unhandledRejection"): never;
};

type InteractiveModePrototypeWithRegisterSignalHandlers = {
	registerSignalHandlers(this: RegisterSignalHandlersThis): void;
};

type ExternalEditorThis = {
	settingsManager: {
		getExternalEditorCommand(): string | undefined;
	};
	editor: {
		getExpandedText?(): string;
		getText(): string;
		setText(text: string): void;
	};
	ui: {
		stop(): void;
		start(): void;
		requestRender(force?: boolean): void;
	};
	showWarning(message: string): void;
};

type InteractiveModePrototypeWithOpenExternalEditor = {
	openExternalEditor(this: ExternalEditorThis): Promise<void>;
};

const interactiveModePrototype = InteractiveMode.prototype as unknown;

class CrashSentinel extends Error {}

describe("Full-screen terminal restoration seams", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	test("routes unhandled rejections through terminal-restoring crash handling", () => {
		const registeredHandlers = new Map<string, (...args: unknown[]) => void>();
		const crashSentinel = new CrashSentinel("crash sentinel");
		const context: RegisterSignalHandlersThis = {
			signalCleanupHandlers: [],
			isFullScreenMode: () => true,
			unregisterSignalHandlers: vi.fn(),
			shutdown: vi.fn(async () => {}),
			emergencyTerminalExit: vi.fn(() => {
				throw crashSentinel;
			}),
			uncaughtCrash: vi.fn((() => {
				throw crashSentinel;
			}) as RegisterSignalHandlersThis["uncaughtCrash"]),
		};

		vi.spyOn(process, "prependListener").mockImplementation(((
			event: string,
			listener: (...args: unknown[]) => void,
		) => {
			registeredHandlers.set(event, listener);
			return process;
		}) as typeof process.prependListener);
		vi.spyOn(process.stdout, "on").mockImplementation(
			((_event: string, _listener: (...args: unknown[]) => void) => process.stdout) as typeof process.stdout.on,
		);
		vi.spyOn(process.stderr, "on").mockImplementation(
			((_event: string, _listener: (...args: unknown[]) => void) => process.stderr) as typeof process.stderr.on,
		);

		(interactiveModePrototype as InteractiveModePrototypeWithRegisterSignalHandlers).registerSignalHandlers.call(
			context,
		);

		const unhandledRejectionHandler = registeredHandlers.get("unhandledRejection");
		expect(unhandledRejectionHandler).toBeTypeOf("function");

		const rejection = new Error("unhandled boom");
		expect(() => unhandledRejectionHandler?.(rejection, Promise.resolve())).toThrow(crashSentinel);
		expect(context.uncaughtCrash).toHaveBeenCalledWith(rejection, "unhandledRejection");
	});

	test("routes process SIGINT through signal shutdown", () => {
		const registeredHandlers = new Map<string, (...args: unknown[]) => void>();
		const context: RegisterSignalHandlersThis = {
			signalCleanupHandlers: [],
			ignoreProcessSigint: false,
			isFullScreenMode: () => true,
			unregisterSignalHandlers: vi.fn(),
			shutdown: vi.fn(async () => {}),
			emergencyTerminalExit: vi.fn(() => {
				throw new Error("unexpected emergency exit");
			}),
			uncaughtCrash: vi.fn((() => {
				throw new Error("unexpected crash");
			}) as RegisterSignalHandlersThis["uncaughtCrash"]),
		};

		vi.spyOn(process, "prependListener").mockImplementation(((
			event: string,
			listener: (...args: unknown[]) => void,
		) => {
			registeredHandlers.set(event, listener);
			return process;
		}) as typeof process.prependListener);
		vi.spyOn(process.stdout, "on").mockImplementation(
			((_event: string, _listener: (...args: unknown[]) => void) => process.stdout) as typeof process.stdout.on,
		);
		vi.spyOn(process.stderr, "on").mockImplementation(
			((_event: string, _listener: (...args: unknown[]) => void) => process.stderr) as typeof process.stderr.on,
		);

		(interactiveModePrototype as InteractiveModePrototypeWithRegisterSignalHandlers).registerSignalHandlers.call(
			context,
		);

		const sigintHandler = registeredHandlers.get("SIGINT");
		expect(sigintHandler).toBeTypeOf("function");

		sigintHandler?.();
		expect(context.shutdown).toHaveBeenCalledWith({ fromSignal: true });
	});

	test("does not add Full-screen-only process handlers in Scrollback mode", () => {
		const registeredHandlers = new Map<string, (...args: unknown[]) => void>();
		const context: RegisterSignalHandlersThis = {
			signalCleanupHandlers: [],
			isFullScreenMode: () => false,
			unregisterSignalHandlers: vi.fn(),
			shutdown: vi.fn(async () => {}),
			emergencyTerminalExit: vi.fn(() => {
				throw new Error("unexpected emergency exit");
			}),
			uncaughtCrash: vi.fn((() => {
				throw new Error("unexpected crash");
			}) as RegisterSignalHandlersThis["uncaughtCrash"]),
		};

		vi.spyOn(process, "prependListener").mockImplementation(((
			event: string,
			listener: (...args: unknown[]) => void,
		) => {
			registeredHandlers.set(event, listener);
			return process;
		}) as typeof process.prependListener);
		vi.spyOn(process.stdout, "on").mockImplementation(
			((_event: string, _listener: (...args: unknown[]) => void) => process.stdout) as typeof process.stdout.on,
		);
		vi.spyOn(process.stderr, "on").mockImplementation(
			((_event: string, _listener: (...args: unknown[]) => void) => process.stderr) as typeof process.stderr.on,
		);

		(interactiveModePrototype as InteractiveModePrototypeWithRegisterSignalHandlers).registerSignalHandlers.call(
			context,
		);

		expect(registeredHandlers.has("SIGINT")).toBe(false);
		expect(registeredHandlers.has("unhandledRejection")).toBe(false);
		expect(registeredHandlers.has("SIGTERM")).toBe(true);
		expect(registeredHandlers.has("uncaughtException")).toBe(true);
	});

	test("releases and restores the terminal around the external editor with a full redraw", async () => {
		const ui = {
			stop: vi.fn(),
			start: vi.fn(),
			requestRender: vi.fn(),
		};
		const editor = {
			getExpandedText: () => "draft before editor",
			getText: () => "draft before editor",
			setText: vi.fn(),
		};
		const context: ExternalEditorThis = {
			settingsManager: {
				getExternalEditorCommand: () => "fake-editor --wait",
			},
			editor,
			ui,
			showWarning: vi.fn(),
		};
		let tempFilePath: string | undefined;

		vi.spyOn(process.stdout, "write").mockImplementation((() => true) as typeof process.stdout.write);
		spawnMock.mockImplementation((command: string, args?: readonly string[]) => {
			expect(command).toBe("fake-editor");
			expect(args).toBeDefined();
			tempFilePath = args?.[args.length - 1];
			expect(tempFilePath).toBeDefined();
			if (tempFilePath) {
				writeFileSync(tempFilePath, "edited in external editor\n");
			}
			const child = new EventEmitter();
			process.nextTick(() => {
				child.emit("close", 0);
			});
			return child as unknown;
		});

		await (interactiveModePrototype as InteractiveModePrototypeWithOpenExternalEditor).openExternalEditor.call(
			context,
		);

		expect(ui.stop).toHaveBeenCalledTimes(1);
		expect(ui.start).toHaveBeenCalledTimes(1);
		expect(ui.requestRender).toHaveBeenCalledWith(true);
		expect(editor.setText).toHaveBeenCalledWith("edited in external editor");
		expect(context.showWarning).not.toHaveBeenCalled();
		expect(tempFilePath).toBeDefined();
		expect(existsSync(tempFilePath as string)).toBe(false);
	});
});
