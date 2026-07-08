import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { main } from "../src/main.ts";

class ProcessExitError extends Error {
	readonly code: string | number | null | undefined;

	constructor(code: string | number | null | undefined) {
		super(`process.exit(${String(code)})`);
		this.code = code;
	}
}

describe("--full-screen-mode CLI validation", () => {
	let tempDir: string;
	let agentDir: string;
	let projectDir: string;
	let originalCwd: string;
	let originalAgentDir: string | undefined;
	let originalStdinIsTTY: PropertyDescriptor | undefined;
	let originalStdoutIsTTY: PropertyDescriptor | undefined;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-full-screen-mode-"));
		agentDir = join(tempDir, "agent");
		projectDir = join(tempDir, "project");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(projectDir, { recursive: true });

		originalCwd = process.cwd();
		originalAgentDir = process.env[ENV_AGENT_DIR];
		originalStdinIsTTY = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
		originalStdoutIsTTY = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");

		process.env[ENV_AGENT_DIR] = agentDir;
		process.chdir(projectDir);

		vi.spyOn(process, "exit").mockImplementation(((code?: string | number | null) => {
			throw new ProcessExitError(code);
		}) as typeof process.exit);
	});

	afterEach(() => {
		vi.restoreAllMocks();
		process.chdir(originalCwd);
		if (originalAgentDir === undefined) {
			delete process.env[ENV_AGENT_DIR];
		} else {
			process.env[ENV_AGENT_DIR] = originalAgentDir;
		}
		restoreTtyFlag(process.stdin, "isTTY", originalStdinIsTTY);
		restoreTtyFlag(process.stdout, "isTTY", originalStdoutIsTTY);
		rmSync(tempDir, { recursive: true, force: true });
	});

	async function runMainExpectingExit(
		args: string[],
		tty: { stdin: boolean; stdout: boolean } = { stdin: true, stdout: true },
	): Promise<string> {
		Object.defineProperty(process.stdin, "isTTY", { value: tty.stdin, configurable: true });
		Object.defineProperty(process.stdout, "isTTY", { value: tty.stdout, configurable: true });

		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		try {
			await main(args);
		} catch (error) {
			expect(error).toBeInstanceOf(ProcessExitError);
			expect((error as ProcessExitError).code).toBe(1);
			return errorSpy.mock.calls.map(([message]) => String(message)).join("\n");
		}

		throw new Error(`Expected main(${JSON.stringify(args)}) to exit`);
	}

	it("rejects --help because the flag is interactive-only", async () => {
		const stderr = await runMainExpectingExit(["--full-screen-mode", "--help"]);

		expect(stderr).toContain("--full-screen-mode cannot be used with --help");
		expect(stderr).not.toContain("Usage:");
	});

	it("rejects --print before any interactive startup", async () => {
		const stderr = await runMainExpectingExit(["--full-screen-mode", "-p", "hi"]);

		expect(stderr).toContain("--full-screen-mode cannot be used with --print");
	});

	it("rejects --mode json before any interactive startup", async () => {
		const stderr = await runMainExpectingExit(["--full-screen-mode", "--mode", "json", "hi"]);

		expect(stderr).toContain("--full-screen-mode cannot be used with --mode json");
	});

	it("rejects --mode rpc before any interactive startup", async () => {
		const stderr = await runMainExpectingExit(["--full-screen-mode", "--mode", "rpc"]);

		expect(stderr).toContain("--full-screen-mode cannot be used with --mode rpc");
	});

	it("rejects --version before printing version output", async () => {
		const stderr = await runMainExpectingExit(["--full-screen-mode", "--version"]);

		expect(stderr).toContain("--full-screen-mode cannot be used with --version");
	});

	it("rejects --list-models before listing models", async () => {
		const stderr = await runMainExpectingExit(["--full-screen-mode", "--list-models"]);

		expect(stderr).toContain("--full-screen-mode cannot be used with --list-models");
	});

	it("rejects --export before exporting a session", async () => {
		const stderr = await runMainExpectingExit(["--full-screen-mode", "--export", "session.jsonl"]);

		expect(stderr).toContain("--full-screen-mode cannot be used with --export");
	});

	it("rejects utility commands before command handlers run", async () => {
		const stderr = await runMainExpectingExit(["list", "--full-screen-mode"]);

		expect(stderr).toContain('--full-screen-mode cannot be used with the "list" command');
	});

	it("rejects piped stdin", async () => {
		const stderr = await runMainExpectingExit(["--full-screen-mode"], { stdin: false, stdout: true });

		expect(stderr).toContain("--full-screen-mode requires an interactive TTY on stdin and stdout");
	});

	it("rejects non-TTY stdout", async () => {
		const stderr = await runMainExpectingExit(["--full-screen-mode"], { stdin: true, stdout: false });

		expect(stderr).toContain("--full-screen-mode requires an interactive TTY on stdin and stdout");
	});
});

function restoreTtyFlag(
	stream: NodeJS.ReadStream | NodeJS.WriteStream,
	key: "isTTY",
	descriptor: PropertyDescriptor | undefined,
): void {
	if (descriptor === undefined) {
		delete (stream as { isTTY?: boolean })[key];
		return;
	}

	Object.defineProperty(stream, key, descriptor);
}
