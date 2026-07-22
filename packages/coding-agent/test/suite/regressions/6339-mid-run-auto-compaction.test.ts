import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { Context } from "@earendil-works/pi-ai";
import {
	type AssistantMessage,
	contentText,
	createAssistantMessageEventStream,
	fauxAssistantMessage,
	fauxToolCall,
} from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionFactory } from "../../../src/index.ts";
import { createHarness, type Harness } from "../harness.ts";

describe("#6339 mid-run auto-compaction", () => {
	const harnesses: Harness[] = [];

	function seedHistory(harness: Harness): void {
		harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "Earlier request" }],
			timestamp: Date.now() - 2000,
		});
		harness.sessionManager.appendMessage(fauxAssistantMessage("Earlier answer"));
		harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
	}

	function seedLargeHistory(harness: Harness): void {
		harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "Earlier long request" }],
			timestamp: Date.now() - 4000,
		});
		harness.sessionManager.appendMessage(fauxAssistantMessage("x".repeat(3200)));
		seedHistory(harness);
	}

	function createUsage(totalTokens: number) {
		return {
			input: totalTokens,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
	}

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("compacts tool output before the next provider request in the same run", async () => {
		let secondContext: Context | undefined;
		let toolCallCount = 0;
		const extensionFactories: ExtensionFactory[] = [
			(pi) => {
				pi.registerTool({
					name: "large_output",
					label: "Large output",
					description: "Return a large result",
					parameters: Type.Object({}),
					execute: async () => ({
						content: [{ type: "text", text: toolCallCount++ === 0 ? "small" : "x".repeat(1600) }],
						details: {},
					}),
				});

				pi.on("session_before_compact", async (event) => ({
					compaction: {
						summary: "mid-run summary",
						firstKeptEntryId: event.preparation.firstKeptEntryId,
						tokensBefore: event.preparation.tokensBefore,
						details: {},
					},
				}));
			},
		];
		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 1000, maxTokens: 64 }],
			settings: { compaction: { enabled: true, reserveTokens: 300, keepRecentTokens: 410 } },
			extensionFactories,
		});
		harnesses.push(harness);
		harness.session.setActiveToolsByName(["large_output"]);
		seedHistory(harness);

		harness.setResponses([
			() => fauxAssistantMessage(fauxToolCall("large_output", {}), { stopReason: "toolUse" }),
			() => fauxAssistantMessage(fauxToolCall("large_output", {}), { stopReason: "toolUse" }),
			(context) => {
				secondContext = context;
				return fauxAssistantMessage("done");
			},
		]);

		await harness.session.prompt("start");

		expect(harness.eventsOfType("compaction_start").length).toBeGreaterThan(0);
		expect(harness.eventsOfType("compaction_end")[0]).toMatchObject({
			reason: "threshold",
			aborted: false,
			willRetry: false,
		});
		expect(
			secondContext?.messages.some(
				(message) => message.role === "user" && contentText(message.content).includes("mid-run summary"),
			),
		).toBe(true);
		expect(harness.faux.state.callCount).toBe(3);
		expect(harness.events.filter((event) => event.type === "agent_start")).toHaveLength(1);
		expect(harness.events.filter((event) => event.type === "agent_end")).toHaveLength(1);
	});

	it("does not recompact from usage that predates a mid-run compaction", async () => {
		let providerRequestCount = 0;
		const extensionFactories: ExtensionFactory[] = [
			(pi) => {
				pi.registerTool({
					name: "large_output",
					label: "Large output",
					description: "Return a large result",
					parameters: Type.Object({}),
					execute: async () => ({
						content: [{ type: "text", text: "small" }],
						details: {},
					}),
				});

				pi.on("session_before_compact", async (event) => ({
					compaction: {
						summary: "mid-run summary",
						firstKeptEntryId: event.preparation.firstKeptEntryId,
						tokensBefore: event.preparation.tokensBefore,
						details: {},
					},
				}));
			},
		];
		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 1000, maxTokens: 64 }],
			settings: { compaction: { enabled: true, reserveTokens: 300, keepRecentTokens: 410 } },
			extensionFactories,
		});
		harnesses.push(harness);
		harness.session.setActiveToolsByName(["large_output"]);
		seedLargeHistory(harness);

		const messages: AssistantMessage[] = [
			{
				...fauxAssistantMessage(fauxToolCall("large_output", {}), { stopReason: "toolUse" }),
				usage: createUsage(10),
			},
			{
				...fauxAssistantMessage(fauxToolCall("large_output", {}), { stopReason: "toolUse" }),
				usage: createUsage(900),
			},
			{
				...fauxAssistantMessage(fauxToolCall("large_output", {}), { stopReason: "toolUse" }),
				usage: createUsage(0),
			},
			{
				...fauxAssistantMessage("done"),
				usage: createUsage(0),
			},
		];
		const streamFunction: StreamFn = (model) => {
			const message = messages[providerRequestCount] ?? messages[messages.length - 1]!;
			providerRequestCount++;

			const stream = createAssistantMessageEventStream();
			queueMicrotask(() => {
				stream.push({
					type: "done",
					reason: message.stopReason === "toolUse" ? "toolUse" : "stop",
					message: {
						...message,
						api: model.api,
						provider: model.provider,
						model: model.id,
					},
				});
			});
			return stream;
		};
		harness.session.agent.streamFunction = streamFunction;

		await harness.session.prompt("start");

		expect(providerRequestCount).toBe(4);
		expect(harness.eventsOfType("compaction_start")).toHaveLength(1);
	});

	it("retries transient summary failures with the normal compaction policy", async () => {
		let toolCallCount = 0;
		let summaryCallCount = 0;
		const extensionFactories: ExtensionFactory[] = [
			(pi) => {
				pi.registerTool({
					name: "large_output",
					label: "Large output",
					description: "Return a large result",
					parameters: Type.Object({}),
					execute: async () => ({
						content: [{ type: "text", text: toolCallCount++ === 0 ? "small" : "x".repeat(1600) }],
						details: {},
					}),
				});
			},
		];
		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 1000, maxTokens: 64 }],
			settings: {
				compaction: { enabled: true, reserveTokens: 300, keepRecentTokens: 410 },
				retry: { enabled: true, maxRetries: 2, baseDelayMs: 0 },
			},
			extensionFactories,
		});
		harnesses.push(harness);
		harness.session.setActiveToolsByName(["large_output"]);
		seedHistory(harness);

		const streamFunction: StreamFn = (model, context, options) => {
			if (!context.systemPrompt?.includes("context summarization assistant")) {
				return streamSimple(model, context, options);
			}

			summaryCallCount++;
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() => {
				if (summaryCallCount < 3) {
					stream.push({
						type: "error",
						reason: "error",
						error: fauxAssistantMessage("", {
							stopReason: "error",
							errorMessage: "terminated",
						}),
					});
				} else {
					stream.push({ type: "done", reason: "stop", message: fauxAssistantMessage("retried summary") });
				}
			});
			return stream;
		};
		harness.session.agent.streamFunction = streamFunction;
		harness.setResponses([
			() => fauxAssistantMessage(fauxToolCall("large_output", {}), { stopReason: "toolUse" }),
			() => fauxAssistantMessage(fauxToolCall("large_output", {}), { stopReason: "toolUse" }),
			() => fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("start");

		expect(summaryCallCount).toBeGreaterThanOrEqual(4);
		expect(harness.eventsOfType("summarization_retry_scheduled")).toHaveLength(2);
		expect(harness.eventsOfType("summarization_retry_scheduled")).toMatchObject([
			{ attempt: 1, maxAttempts: 2 },
			{ attempt: 2, maxAttempts: 2 },
		]);
		expect(harness.eventsOfType("summarization_retry_finished")).toHaveLength(1);
		expect(harness.eventsOfType("compaction_end")[0]).toMatchObject({
			reason: "threshold",
			aborted: false,
			willRetry: false,
		});
	});

	it("stops before the next provider request after summary retries are exhausted", async () => {
		let toolCallCount = 0;
		let summaryCallCount = 0;
		const extensionFactories: ExtensionFactory[] = [
			(pi) => {
				pi.registerTool({
					name: "large_output",
					label: "Large output",
					description: "Return a large result",
					parameters: Type.Object({}),
					execute: async () => ({
						content: [{ type: "text", text: toolCallCount++ === 0 ? "small" : "x".repeat(1600) }],
						details: {},
					}),
				});
			},
		];
		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 1000, maxTokens: 64 }],
			settings: {
				compaction: { enabled: true, reserveTokens: 300, keepRecentTokens: 410 },
				retry: { enabled: true, maxRetries: 2, baseDelayMs: 0 },
			},
			extensionFactories,
		});
		harnesses.push(harness);
		harness.session.setActiveToolsByName(["large_output"]);
		seedHistory(harness);

		const streamFunction: StreamFn = (model, context, options) => {
			if (!context.systemPrompt?.includes("context summarization assistant")) {
				return streamSimple(model, context, options);
			}

			summaryCallCount++;
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() => {
				stream.push({
					type: "error",
					reason: "error",
					error: fauxAssistantMessage("", {
						stopReason: "error",
						errorMessage: "terminated",
					}),
				});
			});
			return stream;
		};
		harness.session.agent.streamFunction = streamFunction;
		harness.setResponses([
			() => fauxAssistantMessage(fauxToolCall("large_output", {}), { stopReason: "toolUse" }),
			() => fauxAssistantMessage(fauxToolCall("large_output", {}), { stopReason: "toolUse" }),
			() => fauxAssistantMessage("must not be requested"),
		]);

		await harness.session.prompt("start");

		expect(summaryCallCount).toBe(3);
		expect(harness.faux.state.callCount).toBe(2);
		expect(harness.eventsOfType("compaction_start")).toHaveLength(1);
		expect(harness.eventsOfType("compaction_end")[0]).toMatchObject({
			reason: "threshold",
			aborted: false,
			willRetry: false,
			errorMessage: "Auto-compaction failed: Summarization failed: terminated",
		});
	});

	it("stops before the next provider request when mid-run compaction is cancelled", async () => {
		let toolCallCount = 0;
		const extensionFactories: ExtensionFactory[] = [
			(pi) => {
				pi.registerTool({
					name: "large_output",
					label: "Large output",
					description: "Return a large result",
					parameters: Type.Object({}),
					execute: async () => ({
						content: [{ type: "text", text: toolCallCount++ === 0 ? "small" : "x".repeat(1600) }],
						details: {},
					}),
				});

				pi.on("session_before_compact", async (event) => {
					return await new Promise<{ cancel: true }>((resolve) => {
						event.signal.addEventListener("abort", () => resolve({ cancel: true }), { once: true });
					});
				});
			},
		];
		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 1000, maxTokens: 64 }],
			settings: { compaction: { enabled: true, reserveTokens: 300, keepRecentTokens: 410 } },
			extensionFactories,
		});
		harnesses.push(harness);
		harness.session.setActiveToolsByName(["large_output"]);
		seedHistory(harness);
		harness.setResponses([
			() => fauxAssistantMessage(fauxToolCall("large_output", {}), { stopReason: "toolUse" }),
			() => fauxAssistantMessage(fauxToolCall("large_output", {}), { stopReason: "toolUse" }),
			() => fauxAssistantMessage("must not be requested"),
		]);

		const promptPromise = harness.session.prompt("start");
		for (let attempt = 0; attempt < 100 && harness.eventsOfType("compaction_start").length === 0; attempt++) {
			await new Promise((resolve) => setTimeout(resolve, 0));
		}
		harness.session.abortCompaction();
		await promptPromise;

		expect(harness.faux.state.callCount).toBe(2);
		expect(harness.eventsOfType("compaction_start")).toHaveLength(1);
		expect(harness.eventsOfType("compaction_end")[0]).toMatchObject({
			reason: "threshold",
			aborted: true,
			willRetry: false,
		});
		const assistantMessages = harness
			.eventsOfType("message_end")
			.filter((event) => event.message.role === "assistant");
		const lastAssistant = assistantMessages.at(-1)?.message;
		expect(lastAssistant?.role).toBe("assistant");
		if (lastAssistant?.role === "assistant") {
			expect(lastAssistant.stopReason).toBe("aborted");
		}
	});
});
