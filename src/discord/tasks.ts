import { join } from "node:path";
import type { Context } from "@earendil-works/chord";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import {
	type Conversation,
	type ConversationId,
	configure,
	type Harness,
	InboxDoc,
	LiveDoc,
	type ModelRef,
	type Tx,
} from "@earendil-works/pi-durable";
import type { WorkspaceMode } from "../config.ts";
import type { DeliverInput, DeliverTask } from "./deliver.ts";
import { INTAKE_RING_SIZE, Intake, pushRing, ThreadInfo, ThreadMap } from "./docs.ts";

export type TaskDefaults = {
	readonly model: ModelRef;
	readonly thinkingLevel: ModelThinkingLevel;
	readonly workdir: string;
	readonly workspaceMode: WorkspaceMode;
};

export type ThreadRef = { threadId: string; guildId: string; channelId: string; startedBy: string };

export type TaskSummary = {
	threadId: string;
	startedBy: string;
	conversationId: ConversationId;
	running: boolean;
	queued: number;
};

/**
 * Durable bookkeeping of tasks: one conversation per Discord thread. Starting a task creates the conversation, maps
 * the thread to it and admits the first message's delivery task in one commit; follow-ups in the thread are admitted
 * into the same conversation. Message ids deduplicate, so a redelivered message never runs twice.
 */
export class TaskDirectory {
	readonly #harness: Harness;
	readonly #deliver: DeliverTask;
	readonly #defaults: TaskDefaults;
	readonly #cache = new Map<string, ConversationId>();

	constructor(harness: Harness, deliver: DeliverTask, defaults: TaskDefaults) {
		this.#harness = harness;
		this.#deliver = deliver;
		this.#defaults = defaults;
	}

	/** The working directory of a thread's task. */
	cwdOf(threadId: string): string {
		return this.#defaults.workspaceMode === "shared" ? this.#defaults.workdir : join(this.#defaults.workdir, threadId);
	}

	/** Start a task in a new thread, or admit into the existing one when the thread is already known. */
	async start(
		thread: ThreadRef,
		input: Omit<DeliverInput, "threadId">,
		context: Context,
	): Promise<{ conversationId: ConversationId; admitted: boolean }> {
		const defaults = this.#defaults;
		const cwd = this.cwdOf(thread.threadId);
		const result = await this.#harness.commit(async (tx) => {
			const map = await tx.doc(ThreadMap);
			let id = map.threads[thread.threadId] as ConversationId | undefined;
			if (id === undefined) {
				const record = await tx.createConversation({ ownership: { kind: "ownerless" } });
				id = record.id;
				await configure(tx, id, { model: defaults.model, thinkingLevel: defaults.thinkingLevel, cwd });
				Object.assign(await tx.doc(ThreadInfo, id), thread);
				map.threads[thread.threadId] = id;
			}
			const admitted = await this.#admitIn(tx, id, { ...input, threadId: thread.threadId });
			return { conversationId: id, admitted };
		}, context);
		this.#cache.set(thread.threadId, result.conversationId);
		return result;
	}

	/** Admit a message posted in a task's thread; undefined when the thread is not a task. */
	async followUp(
		threadId: string,
		input: Omit<DeliverInput, "threadId">,
		context: Context,
	): Promise<"admitted" | "duplicate" | undefined> {
		const conversation = await this.conversationOf(threadId, context);
		if (conversation === undefined) return undefined;
		const admitted = await conversation.commit(
			(tx) => this.#admitIn(tx, conversation.id, { ...input, threadId }),
			context,
		);
		return admitted ? "admitted" : "duplicate";
	}

	async conversationOf(threadId: string, context: Context): Promise<Conversation | undefined> {
		let id = this.#cache.get(threadId);
		if (id === undefined) {
			const map = await this.#harness.snapshot(ThreadMap, context);
			id = map?.threads[threadId] as ConversationId | undefined;
			if (id === undefined) return undefined;
			this.#cache.set(threadId, id);
		}
		return this.#harness.conversation(id, context);
	}

	/** Tasks with a run going or inputs queued, newest thread first. */
	async active(context: Context): Promise<TaskSummary[]> {
		const map = await this.#harness.snapshot(ThreadMap, context);
		const out: TaskSummary[] = [];
		for (const [threadId, raw] of Object.entries(map?.threads ?? {})) {
			const id = raw as ConversationId;
			const live = await this.#harness.snapshot(LiveDoc, id, context);
			const inbox = await this.#harness.snapshot(InboxDoc, id, context);
			const queued = inbox?.items.filter((item) => item.mode !== "write").length ?? 0;
			if (live?.run === undefined && queued === 0) continue;
			const info = await this.#harness.snapshot(ThreadInfo, id, context);
			out.push({ threadId, startedBy: info?.startedBy ?? "", conversationId: id, running: live?.run !== undefined, queued });
		}
		return out.reverse();
	}

	/** Record the message key and create its delivery task in one commit; false when the key was already admitted. */
	async #admitIn(tx: Tx, conversationId: ConversationId, input: DeliverInput): Promise<boolean> {
		if (!pushRing((await tx.doc(Intake, conversationId)).keys, input.requestId, INTAKE_RING_SIZE)) return false;
		await tx.createTask(this.#deliver, input, { ownership: { kind: "conversation" }, background: true, conversationId });
		return true;
	}
}
