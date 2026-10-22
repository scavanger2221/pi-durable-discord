import { rm } from "node:fs/promises";
import type { Context, JsonValue } from "@earendil-works/chord";
import type { Message } from "@earendil-works/pi-ai";
import {
	AssistantEntry,
	defineTask,
	type EntryId,
	LiveDoc,
	type LiveState,
	type NextTaskState,
	type RunningTask,
	type SettledSubmissionRecord,
	type Submission,
	type TaskRuntime,
	type Tx,
	type UserInput,
} from "@earendil-works/pi-durable";
import type { Logger } from "../log.ts";
import { type Attachment, DELIVERED_RING_SIZE, Delivered, Outbox } from "./docs.ts";
import { finalReplyText, MESSAGE_LIMIT, splitForDiscord, tail, truncate } from "./format.ts";
import { type DiscordPort, FILES_PER_MESSAGE, isGone } from "./port.ts";

export const DELIVER_TASK = "discord.deliver";

export type DeliverInput = {
	/** The task's thread: previews and answers go here. */
	threadId: string;
	/** The prompting message; the answer replies to it when it is in the thread. */
	replyTo?: string;
	/** Durable request id of the submission: `discord:<messageId>`. */
	requestId: string;
	/** pi-ai `UserInput`. */
	content: JsonValue;
};

type Outcome = { kind: "answer"; entryId: number } | { kind: "shared" } | { kind: "unanswered"; reason: string; detail?: string };

type WaitState = { phase: "wait"; submissionId?: number; preview?: string };
type SendState = {
	phase: "send";
	outcome: Outcome;
	preview?: string;
	/** Files the agent attached during the run: they go on the answer's last message. */
	files?: Attachment[];
	/** Messages delivered (or given up on) so far. */
	sent: number;
	/** A new message was being sent for this index when the process stopped: it may have gone out. */
	inFlight?: number;
};
type DeliverState = WaitState | SendState;

type Runtime = TaskRuntime<DeliverInput, DeliverState, null, object>;
type Next = NextTaskState<DeliverState, null>;

export type DeliveryDeps = {
	readonly port: () => DiscordPort;
	readonly log: Logger;
	readonly model: { provider: string; modelId: string };
	/** Minimum pause between preview edits; Discord allows about five edits per 5 s per channel. */
	readonly previewIntervalMs?: number;
};

const PREVIEW_CHARS = 1800;
const TYPING_MS = 8000;
export const WORKING_TEXT = "⏳ working…";
export const STOPPED_TEXT = "⏹ stopped";
export const EMPTY_TEXT = "(empty answer)";

/**
 * One background, conversation-owned task per admitted Discord message. Phase `wait` submits the message (idempotent
 * by request id), streams the run into a preview message while it is this message's run and waits for the answer;
 * phase `send` posts the answer chunk by chunk, with the files the agent attached on the last message, keeping durable
 * progress, so a restart neither loses nor repeats it.
 */
export function createDeliverTask(deps: DeliveryDeps) {
	return defineTask<DeliverInput, DeliverState, null>({
		name: DELIVER_TASK,
		version: 1,
		initial: () => ({ phase: "wait" }),
		phases: {
			wait: (task, runtime, context) => guard("wait", runtime, deps, () => waitPhase(task, runtime, context, deps)),
			send: (task, runtime, context) => guard("send", runtime, deps, () => sendPhase(task, runtime, context, deps)),
		},
		abort: async (task, runtime, context) => {
			const checkpoint = task.state.checkpoint;
			if (checkpoint.preview !== undefined && checkpoint.phase === "wait") {
				await deps
					.port()
					.edit(task.input.threadId, checkpoint.preview, STOPPED_TEXT)
					.catch(() => undefined);
			}
			await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context);
			if (checkpoint.phase === "send") await removeFiles(checkpoint.files);
		},
	});
}

export type DeliverTask = ReturnType<typeof createDeliverTask>;

/** A throw faults the task; log it first unless the invocation is closing or aborted. */
async function guard(name: string, runtime: Runtime, deps: DeliveryDeps, body: () => Promise<void>): Promise<void> {
	try {
		await body();
	} catch (error) {
		if (!runtime.signal.aborted) deps.log.error("delivery_phase_failed", { phase: name, error: String(error) });
		throw error;
	}
}

async function waitPhase(
	task: RunningTask<DeliverInput, WaitState, null>,
	runtime: Runtime,
	context: Context,
	deps: DeliveryDeps,
): Promise<void> {
	const conversation = await runtime.conversation(runtime.conversationId, context);
	if (conversation === undefined) {
		await runtime.commit(() => terminal(), context);
		return;
	}
	const submission = await conversation.submit(
		{ type: "input", content: task.input.content as UserInput, requestId: task.input.requestId, whenBusy: "followUp" },
		context,
	);
	if (task.state.checkpoint.submissionId === undefined) {
		await runtime.commit((_tx, current) => running({ ...waitOf(current), submissionId: submission.id }), context);
	}
	const settled = await streamUntilSettled(task, submission, runtime, context, deps);
	await runtime.commit(async (tx, current) => {
		const wait = waitOf(current);
		const next: SendState = { phase: "send", outcome: await outcomeOf(tx, settled, runtime, current.id), sent: 0 };
		if (wait.preview !== undefined) next.preview = wait.preview;
		// The task posting the run's answer (or its failure) takes the files; one whose answer is shared takes none.
		if (next.outcome.kind !== "shared") {
			const outbox = await tx.doc(Outbox, runtime.conversationId);
			if (outbox.files.length > 0) {
				next.files = outbox.files.map((file) => ({ path: file.path, name: file.name }));
				outbox.files = [];
			}
		}
		return running(next);
	}, context);
}

/** Stream this message's run into the preview and keep the typing indicator on, until the submission settles. */
async function streamUntilSettled(
	task: RunningTask<DeliverInput, WaitState, null>,
	submission: Submission,
	runtime: Runtime,
	context: Context,
	deps: DeliveryDeps,
): Promise<SettledSubmissionRecord> {
	const preview = new Preview(task, runtime, context, deps);
	const watch = await runtime.watchDoc(LiveDoc, runtime.conversationId, context);
	watch?.start(async (value) => {
		if (value !== null) preview.update(value, submission.id);
	});
	try {
		return await submission.wait(context);
	} finally {
		await watch?.stop();
		await preview.close();
	}
}

/**
 * The preview message of one delivery: created when this message's run starts (a queued follow-up shows nothing
 * until its turn), edited at most once per interval with the newest frame. Never throws; failures are logged.
 */
class Preview {
	readonly #task: RunningTask<DeliverInput, WaitState, null>;
	readonly #runtime: Runtime;
	readonly #context: Context;
	readonly #deps: DeliveryDeps;
	#messageId: string | undefined;
	#latest: string | undefined;
	#shown: string | undefined;
	#lastEditAt = 0;
	#busy: Promise<void> | undefined;
	#timer: (() => void) | undefined;
	#typingAt = 0;
	#closed = false;

	constructor(task: RunningTask<DeliverInput, WaitState, null>, runtime: Runtime, context: Context, deps: DeliveryDeps) {
		this.#task = task;
		this.#runtime = runtime;
		this.#context = context;
		this.#deps = deps;
		this.#messageId = task.state.checkpoint.preview;
	}

	update(live: Readonly<LiveState>, submissionId: number): void {
		if (this.#closed || live.run === undefined || !live.run.inputs.includes(submissionId as never)) return;
		this.#pulseTyping();
		this.#latest = renderPreview(live);
		this.#schedule();
	}

	async close(): Promise<void> {
		this.#closed = true;
		this.#timer?.();
		await this.#busy;
	}

	#pulseTyping(): void {
		const now = this.#runtime.now();
		if (now - this.#typingAt < TYPING_MS) return;
		this.#typingAt = now;
		void this.#deps
			.port()
			.typing(this.#task.input.threadId)
			.catch(() => undefined);
	}

	#schedule(): void {
		if (this.#timer !== undefined || this.#busy !== undefined || this.#closed) return;
		const interval = this.#deps.previewIntervalMs ?? 1500;
		const wait = Math.max(0, this.#lastEditAt + interval - this.#runtime.now());
		this.#timer = this.#runtime.setTimer(() => {
			this.#timer = undefined;
			this.#flush();
		}, wait);
	}

	#flush(): void {
		const text = this.#latest;
		if (this.#closed || text === undefined || text === this.#shown) return;
		this.#lastEditAt = this.#runtime.now();
		this.#busy = this.#send(text).finally(() => {
			this.#busy = undefined;
			if (this.#latest !== this.#shown) this.#schedule();
		});
	}

	async #send(text: string): Promise<void> {
		const port = this.#deps.port();
		const { threadId, replyTo } = this.#task.input;
		try {
			if (this.#messageId === undefined) {
				const id = await port.send(threadId, text, replyTo === undefined ? {} : { replyTo });
				this.#messageId = id;
				// Persisted before anything else touches it, so a restart edits this message instead of sending another.
				await this.#runtime.commit((_tx, current) => running({ ...waitOf(current), preview: id }), this.#context);
			} else await port.edit(threadId, this.#messageId, text);
			this.#shown = text;
		} catch (error) {
			if (!this.#runtime.signal.aborted) this.#deps.log.debug("preview_failed", { error: String(error) });
		}
	}
}

/** The tail of the streamed answer, or what the agent is doing while it is not writing. */
export function renderPreview(live: Readonly<LiveState>): string {
	const message = live.generation?.message as Message | undefined;
	const parts = message?.role === "assistant" ? message.content : [];
	const text = parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n").trim();
	const thinking = parts.some((part) => part.type === "thinking");
	const running = (live.tools ?? []).filter((slot) => slot.status !== "done").map((slot) => slot.name);
	const lines: string[] = [];
	if (text !== "") lines.push(tail(text, PREVIEW_CHARS));
	if (running.length > 0) lines.push(`-# ⚙ ${truncate(running.join(", "), 120)}`);
	else if (text === "") lines.push(thinking ? "-# 💭 thinking…" : `-# ${WORKING_TEXT}`);
	return truncate(lines.join("\n\n"), MESSAGE_LIMIT);
}

async function outcomeOf(tx: Tx, settled: SettledSubmissionRecord, runtime: Runtime, taskId: number): Promise<Outcome> {
	if (settled.status === "unanswered") {
		const detail = detailText(settled.detail);
		return detail === undefined
			? { kind: "unanswered", reason: settled.reason }
			: { kind: "unanswered", reason: settled.reason, detail };
	}
	if (settled.type !== "input") return { kind: "unanswered", reason: "not_an_input" };
	// Inputs placed in one run share its answer: the first delivery task claims it, the others say so.
	const delivered = await tx.doc(Delivered, runtime.conversationId);
	const key = String(settled.answer);
	const claim = Object.hasOwn(delivered.answers, key) ? delivered.answers[key] : undefined;
	if (claim !== undefined && claim !== taskId) return { kind: "shared" };
	if (claim === undefined) {
		delivered.answers[key] = taskId;
		delivered.order.push(settled.answer);
		while (delivered.order.length > DELIVERED_RING_SIZE) delete delivered.answers[String(delivered.order.shift())];
	}
	return { kind: "answer", entryId: settled.answer };
}

function detailText(detail: JsonValue | undefined): string | undefined {
	if (detail === undefined || detail === null) return undefined;
	const text = typeof detail === "string" ? detail : JSON.stringify(detail);
	const line = text.split("\n").find((each) => each.trim() !== "")?.trim();
	return line === undefined || line === "" ? undefined : truncate(line, 300);
}

async function sendPhase(
	task: RunningTask<DeliverInput, SendState, null>,
	runtime: Runtime,
	context: Context,
	deps: DeliveryDeps,
): Promise<void> {
	const port = deps.port();
	let state = task.state.checkpoint;
	const messages = withFiles(await render(state, runtime, context, deps), state.files ?? []);
	const { threadId, replyTo } = task.input;
	while (state.sent < messages.length) {
		const index = state.sent;
		const message = messages[index] as Outgoing;
		const next: SendState = { ...state, sent: index + 1 };
		delete next.inFlight;
		if (index === 0 && state.preview !== undefined && (await editPreview(port, threadId, state.preview, message, deps))) {
			// Edits are idempotent, attachments included: nothing to guard.
		} else if (state.inFlight === index && index > 0) {
			// A rare lost chunk beats a duplicate of a long answer; chunk 0 is sent again instead, as it carries the reply.
			deps.log.warn("delivery_unknown", { thread: threadId, chunk: index });
		} else {
			await save(runtime, { ...state, inFlight: index }, context);
			try {
				await post(message, threadId, deps, (text, files) =>
					port.send(threadId, text, {
						...(index === 0 && replyTo !== undefined ? { replyTo } : {}),
						...(files.length > 0 ? { files } : {}),
					}),
				);
			} catch (error) {
				if (runtime.signal.aborted) throw error;
				deps.log.warn("delivery_failed", { thread: threadId, chunk: index, error: String(error) });
				if (isGone(error)) break;
			}
		}
		await save(runtime, next, context);
		state = next;
	}
	await runtime.commit(() => terminal(), context);
	await removeFiles(state.files);
	deps.log.info("delivered", { thread: threadId, outcome: state.outcome.kind, messages: state.sent });
}

type Outgoing = { text: string; files: Attachment[] };

/** The answer's chunks, with the files on the last one; files beyond Discord's per-message limit follow on their own. */
export function withFiles(chunks: readonly string[], files: readonly Attachment[]): Outgoing[] {
	const messages: Outgoing[] = chunks.map((text) => ({ text, files: [] }));
	for (let start = 0; start < files.length; start += FILES_PER_MESSAGE) {
		const group = files.slice(start, start + FILES_PER_MESSAGE);
		const last = messages.at(-1);
		if (start === 0 && last !== undefined) last.files = group;
		else messages.push({ text: "", files: group });
	}
	return messages;
}

/**
 * Post a message with its files. When the files are refused (too large for the server, deleted meanwhile), post the
 * text alone with a note instead of losing it; a gone thread is not worth a second try.
 */
async function post(
	message: Outgoing,
	threadId: string,
	deps: DeliveryDeps,
	attempt: (text: string, files: Attachment[]) => Promise<unknown>,
): Promise<void> {
	if (message.files.length === 0) {
		await attempt(message.text, []);
		return;
	}
	try {
		await attempt(message.text, message.files);
	} catch (error) {
		if (isGone(error)) throw error;
		deps.log.warn("attachment_failed", { thread: threadId, files: message.files.map((file) => file.name), error: String(error) });
		const note = `-# ⚠ could not attach ${truncate(message.files.map((file) => file.name).join(", "), 200)}`;
		// The note is dropped rather than cutting a full chunk short.
		const text = message.text === "" ? note : `${message.text}\n${note}`;
		await attempt(text.length <= MESSAGE_LIMIT ? text : message.text, []);
	}
}

async function editPreview(port: DiscordPort, threadId: string, messageId: string, message: Outgoing, deps: DeliveryDeps): Promise<boolean> {
	try {
		await post(message, threadId, deps, (text, files) =>
			port.edit(threadId, messageId, text, files.length > 0 ? { files } : {}),
		);
		return true;
	} catch {
		return false;
	}
}

/** The copies are only needed until the answer is out. */
async function removeFiles(files: readonly Attachment[] | undefined): Promise<void> {
	for (const file of files ?? []) await rm(file.path, { force: true }).catch(() => undefined);
}

async function render(state: SendState, runtime: Runtime, context: Context, deps: DeliveryDeps): Promise<string[]> {
	const { outcome, preview } = state;
	if (outcome.kind === "answer") {
		const entry = await runtime.entry(AssistantEntry, outcome.entryId as EntryId, context);
		return splitForDiscord(finalReplyText(entry?.model?.[0] as Message | undefined) ?? EMPTY_TEXT);
	}
	if (outcome.kind === "shared") return preview === undefined ? [] : ["-# ↑ answered above"];
	const text = unansweredText(outcome.reason, outcome.detail, deps.model);
	if (text !== undefined) return [text];
	return outcome.reason === "aborted" && preview !== undefined ? [STOPPED_TEXT] : [];
}

/** The one line a user sees when a request got no answer; undefined when nothing should be said. */
export function unansweredText(
	reason: string,
	detail: string | undefined,
	model: { provider: string; modelId: string },
): string | undefined {
	switch (reason) {
		case "aborted":
			return undefined;
		case "model_error":
			return `⚠ Model error: ${truncate(detail ?? "unknown", 300)}`;
		case "no_model":
			return `⚠ Model ${model.provider}/${model.modelId} is not available.`;
		case "reset":
			return "Context was reset; this request was dropped.";
		default:
			return `⚠ Request not answered (${reason}${detail === undefined ? "" : `: ${truncate(detail, 200)}`}).`;
	}
}

function save(runtime: Runtime, state: SendState, context: Context): Promise<void> {
	return runtime.commit(() => running(state), context);
}

function waitOf(current: RunningTask<DeliverInput, DeliverState, null>): WaitState {
	const checkpoint = current.state.checkpoint;
	return checkpoint.phase === "wait" ? checkpoint : { phase: "wait" };
}

function running(checkpoint: DeliverState): Next {
	return { status: "running", checkpoint };
}

function terminal(): Next {
	return { status: "terminal", outcome: { status: "completed", result: null } };
}
