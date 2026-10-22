import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { BACKGROUND_CONTEXT as BG } from "@earendil-works/chord/context";
import {
	createModels,
	type FauxProviderHandle,
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
	type MutableModels,
} from "@earendil-works/pi-ai";
import { type JsonRpcRequest, LATEST_PROTOCOL_VERSION, type McpTransport } from "@earendil-works/pi-mcp";
import { createInMemoryTransportPair } from "@earendil-works/pi-mcp/testing";
import { type Agent, openAgent } from "../src/agent/open.ts";
import type { Config } from "../src/config.ts";
import type { DiscordPort, FileRef } from "../src/discord/port.ts";
import { silentLogger } from "../src/log.ts";

/** An attachment as Discord received it: its name and the bytes read at upload time. */
type Uploaded = { name: string; content: string };
type Sent = { channelId: string; id: string; text: string; replyTo?: string; edits: string[]; files: Uploaded[] };

async function upload(files: readonly FileRef[] | undefined, reject = false): Promise<Uploaded[]> {
	if (reject && files !== undefined && files.length > 0) throw new Error("Request entity too large");
	return Promise.all((files ?? []).map(async (file) => ({ name: file.name, content: await readFile(file.path, "utf8") })));
}

/** Records what delivery posts, per thread. */
class FakeDiscord implements DiscordPort {
	readonly messages: Sent[] = [];
	/** Refuse uploads, like Discord does for a file over the server's limit. */
	rejectFiles = false;
	#next = 1000;

	async send(channelId: string, text: string, options: { replyTo?: string; files?: readonly FileRef[] } = {}): Promise<string> {
		const files = await upload(options.files, this.rejectFiles);
		const id = String(this.#next++);
		this.messages.push({
			channelId,
			id,
			text,
			edits: [],
			files,
			...(options.replyTo === undefined ? {} : { replyTo: options.replyTo }),
		});
		return id;
	}

	async edit(channelId: string, messageId: string, text: string, options: { files?: readonly FileRef[] } = {}): Promise<void> {
		const message = this.messages.find((each) => each.channelId === channelId && each.id === messageId);
		if (message === undefined) throw new Error("unknown message");
		if (options.files !== undefined) message.files = await upload(options.files, this.rejectFiles);
		message.text = text;
		message.edits.push(text);
	}

	async typing(): Promise<void> {}

	/** The texts a thread shows now, in order. */
	thread(channelId: string): string[] {
		return this.messages.filter((each) => each.channelId === channelId).map((each) => each.text);
	}
}

/** An MCP server in memory with one tool, `echo`. */
function echoServer(): McpTransport {
	const pair = createInMemoryTransportPair();
	const results: Record<string, (request: JsonRpcRequest) => unknown> = {
		initialize: () => ({
			protocolVersion: LATEST_PROTOCOL_VERSION,
			capabilities: { tools: {} },
			serverInfo: { name: "echo", version: "1.0.0" },
			instructions: "Echoes text.",
		}),
		"tools/list": () => ({
			tools: [
				{
					name: "echo",
					description: "Echo text back",
					inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
				},
			],
		}),
		"tools/call": (request) => {
			const params = request.params as { arguments: { text: string } };
			return { content: [{ type: "text", text: `echo: ${params.arguments.text}` }] };
		},
	};
	pair.server.onMessage((message: object) => {
		if (!("id" in message) || !("method" in message)) return;
		const request = message as JsonRpcRequest;
		const result = results[request.method];
		queueMicrotask(() => {
			void pair.server.send(
				result === undefined
					? { jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "not found" } }
					: { jsonrpc: "2.0", id: request.id, result: result(request) },
			);
		});
	});
	void pair.server.start();
	return pair.client;
}

function deferred<T = void>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

async function until(check: () => boolean | Promise<boolean>, ms = 5000): Promise<void> {
	const deadline = Date.now() + ms;
	while (!(await check())) {
		if (Date.now() > deadline) throw new Error("timed out");
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

describe("pi-durable-discord", () => {
	let dir: string;
	let config: Config;
	let faux: FauxProviderHandle;
	let models: MutableModels;

	before(async () => {
		dir = await mkdtemp(join(tmpdir(), "pi-discord-"));
		faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }] });
		models = createModels();
		models.setProvider(faux.provider);
		config = {
			discordToken: "x",
			allowedUserIds: new Set(),
			allowedRoleIds: new Set(),
			channelIds: new Set(),
			guildIds: [],
			provider: "faux",
			modelId: "faux-1",
			thinkingLevel: "off",
			workdir: join(dir, "workspace"),
			workspaceMode: "per-thread",
			dataDir: join(dir, "data"),
			piAgentDir: join(dir, "pi"),
			authFile: join(dir, "pi", "auth.json"),
			instructionsPath: join(dir, "workspace", "AGENTS.md"),
			maxAttachmentBytes: 1024,
			mcpConfigPath: join(dir, "pi", "mcp.json"),
			codemode: true,
		};
		await mkdir(join(dir, "pi"), { recursive: true });
		await writeFile(config.mcpConfigPath as string, JSON.stringify({ mcpServers: { test: { command: "unused" } } }));
	});

	after(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	async function open(port: FakeDiscord): Promise<Agent> {
		const agent = await openAgent(config, { log: silentLogger, models, previewIntervalMs: 0, mcpTransport: echoServer });
		agent.setPort(port);
		agent.harness.resume();
		return agent;
	}

	const thread = (id: string, user = "u1") => ({ threadId: id, guildId: "g", channelId: "c", startedBy: user });

	it("runs tasks from different people at the same time, each in its own thread and workspace", async () => {
		const port = new FakeDiscord();
		const agent = await open(port);
		const started: string[] = [];
		const release = deferred();
		const answer = (name: string) => async (context: { messages: readonly unknown[] }) => {
			const text = JSON.stringify(context.messages);
			started.push(text.includes("alice") ? "alice" : "bob");
			await release.promise;
			return fauxAssistantMessage(`done for ${name}`);
		};
		faux.setResponses([answer("first"), answer("second")]);
		await agent.directory.start(thread("t-alice", "alice"), { requestId: "discord:1", content: "[discord] @alice (id 1):\nhi" }, BG);
		await agent.directory.start(thread("t-bob", "bob"), { requestId: "discord:2", content: "[discord] @bob (id 2):\nhello" }, BG);
		// Both model requests are in flight before either answers: the tasks run concurrently.
		await until(() => started.length === 2);
		assert.deepEqual([...started].sort(), ["alice", "bob"]);
		assert.equal((await agent.directory.active(BG)).length, 2);
		release.resolve();
		await until(() => port.thread("t-alice").some((text) => text.startsWith("done")) && port.thread("t-bob").some((text) => text.startsWith("done")));
		const a = await agent.directory.conversationOf("t-alice", BG);
		const b = await agent.directory.conversationOf("t-bob", BG);
		assert.notEqual(a?.id, b?.id);
		assert.equal((await a?.agent(BG))?.cwd, join(config.workdir, "t-alice"));
		assert.equal((await b?.agent(BG))?.cwd, join(config.workdir, "t-bob"));
		await agent.harness.close(BG);
	});

	it("queues follow-ups in a thread, ignores duplicates and unknown threads", async () => {
		const port = new FakeDiscord();
		const agent = await open(port);
		faux.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two")]);
		await agent.directory.start(thread("t-follow"), { requestId: "discord:10", content: "first" }, BG);
		assert.equal(await agent.directory.followUp("t-follow", { requestId: "discord:11", replyTo: "11", content: "second" }, BG), "admitted");
		assert.equal(await agent.directory.followUp("t-follow", { requestId: "discord:11", replyTo: "11", content: "second" }, BG), "duplicate");
		assert.equal(await agent.directory.followUp("t-other", { requestId: "discord:12", content: "x" }, BG), undefined);
		await until(() => port.thread("t-follow").includes("two"));
		assert.deepEqual(port.thread("t-follow"), ["one", "two"]);
		assert.equal(port.messages.find((each) => each.text === "two")?.replyTo, "11");
		await agent.harness.close(BG);
	});

	it("runs tools in the thread's workspace and streams a preview before the answer", async () => {
		const port = new FakeDiscord();
		const agent = await open(port);
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("bash", { command: "pwd && echo $DISCORD_TOKEN" }), { stopReason: "toolUse" }),
			(context) => {
				const result = JSON.stringify(context.messages.at(-1));
				return fauxAssistantMessage(`ran: ${result.includes("t-tools") ? "in thread dir" : "elsewhere"}`);
			},
		]);
		process.env.DISCORD_TOKEN = "secret-token";
		await agent.directory.start(thread("t-tools"), { requestId: "discord:20", content: "where are you?" }, BG);
		await until(() => port.thread("t-tools").some((text) => text.startsWith("ran:")));
		const [message] = port.messages.filter((each) => each.channelId === "t-tools");
		assert.equal(message?.text, "ran: in thread dir");
		assert.ok((message?.edits.length ?? 0) >= 1, "the preview was edited into the answer");
		const conversation = await agent.directory.conversationOf("t-tools", BG);
		const entries = await conversation?.entries({}, 100, undefined, BG);
		assert.ok(!JSON.stringify(entries).includes("secret-token"), "bash does not see the bot token");
		delete process.env.DISCORD_TOKEN;
		await agent.harness.close(BG);
	});

	it("attaches files the agent sends to its answer message, as they were when sent", async () => {
		const port = new FakeDiscord();
		const agent = await open(port);
		const step = (call: ReturnType<typeof fauxToolCall>) => fauxAssistantMessage(call, { stopReason: "toolUse" });
		faux.setResponses([
			step(fauxToolCall("bash", { command: "printf first > chart.png" })),
			step(fauxToolCall("discord_send_file", { path: "chart.png" })),
			// Changing the file afterwards does not change what was attached.
			step(fauxToolCall("bash", { command: "printf second > chart.png" })),
			fauxAssistantMessage("here is the chart"),
		]);
		await agent.directory.start(thread("t-image"), { requestId: "discord:40", content: "plot it" }, BG);
		await until(() => port.thread("t-image").includes("here is the chart"));
		const posted = port.messages.filter((each) => each.channelId === "t-image");
		assert.equal(posted.length, 1, "the file goes on the answer message, not a message of its own");
		assert.deepEqual(posted[0]?.files, [{ name: "chart.png", content: "first" }]);
		await until(async () => (await readdir(join(config.dataDir, "outbox"))).length === 0);
		await agent.harness.close(BG);
	});

	it("still posts the answer when Discord refuses the attachment", async () => {
		const port = new FakeDiscord();
		port.rejectFiles = true;
		const agent = await open(port);
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("bash", { command: "printf big > big.png" }), { stopReason: "toolUse" }),
			fauxAssistantMessage(fauxToolCall("discord_send_file", { path: "big.png" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("too big?"),
		]);
		await agent.directory.start(thread("t-refused"), { requestId: "discord:50", content: "send it" }, BG);
		await until(() => port.thread("t-refused").some((text) => text.startsWith("too big?")));
		assert.deepEqual(port.thread("t-refused"), ["too big?\n-# ⚠ could not attach big.png"]);
		await agent.harness.close(BG);
	});

	it("finds an MCP tool with tool_search and calls it", async () => {
		const port = new FakeDiscord();
		const agent = await open(port);
		const offered = async () => {
			const conversation = await agent.directory.conversationOf("t-mcp", BG);
			return ((await conversation?.agent(BG))?.tools ?? []).map((tool) => tool.name);
		};
		const before = deferred<string[]>();
		faux.setResponses([
			async () => {
				before.resolve(await offered());
				return fauxAssistantMessage(fauxToolCall("tool_search", { query: "echo" }), { stopReason: "toolUse" });
			},
			fauxAssistantMessage(fauxToolCall("mcp__test__echo", { text: "hi" }), { stopReason: "toolUse" }),
			(context) => fauxAssistantMessage(JSON.stringify(context.messages.at(-1)).includes("echo: hi") ? "mcp ok" : "mcp missing"),
		]);
		await agent.directory.start(thread("t-mcp"), { requestId: "discord:60", content: "echo hi" }, BG);
		await until(() => port.thread("t-mcp").some((text) => text.startsWith("mcp")));
		assert.deepEqual(port.thread("t-mcp"), ["mcp ok"]);
		const initial = await before.promise;
		assert.ok(!initial.includes("mcp__test__echo"), "MCP tools are deferred until searched");
		assert.ok(initial.includes("codemode") && initial.includes("tool_search"));
		assert.ok((await offered()).includes("mcp__test__echo"), "tool_search loaded it");
		await agent.close(BG);
	});

	it("runs a codemode script that calls MCP and workspace tools", async () => {
		const port = new FakeDiscord();
		const agent = await open(port);
		const code = [
			'const echoed = await tools.mcp__test__echo({ text: "from script" });',
			'const shell = await tools.bash({ command: "echo $((6 * 7))" });',
			"console.log(echoed, shell.output.trim());",
		].join("\n");
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("codemode", { code }), { stopReason: "toolUse" }),
			(context) => {
				const result = JSON.stringify(context.messages.at(-1));
				return fauxAssistantMessage(result.includes("echo: from script") && result.includes("42") ? "script ok" : `script: ${result}`);
			},
		]);
		await agent.directory.start(thread("t-code"), { requestId: "discord:70", content: "script it" }, BG);
		await until(() => port.thread("t-code").some((text) => text.startsWith("script")), 20_000);
		assert.deepEqual(port.thread("t-code"), ["script ok"]);
		await agent.close(BG);
	});

	it("finishes a task after a restart and posts its answer once", async () => {
		const port = new FakeDiscord();
		const first = await open(port);
		const entered = deferred();
		faux.setResponses([
			async (_context, options) => {
				entered.resolve();
				// Hangs until the harness closes and aborts the request.
				await new Promise((_resolve, reject) => options?.signal?.addEventListener("abort", () => reject(new Error("aborted"))));
				return fauxAssistantMessage("never");
			},
			fauxAssistantMessage("after restart"),
		]);
		await first.directory.start(thread("t-restart"), { requestId: "discord:30", content: "long job" }, BG);
		await entered.promise;
		await first.harness.close(BG);
		const second = await open(port);
		await until(() => port.thread("t-restart").includes("after restart"));
		assert.equal(port.thread("t-restart").filter((text) => text === "after restart").length, 1);
		await second.harness.close(BG);
	});
});
