import type { Context } from "@earendil-works/chord";
import { type Conversation, type Harness, InboxDoc, LiveDoc, UserEntry } from "@earendil-works/pi-durable";

/**
 * Stop a task's current run: abort the task that owns it (and with it its tool calls) until the run is gone, not the
 * conversation, so follow-ups queued behind it still run. A passive write then gives the conversation a boundary to
 * place them. With `all`, queued inputs are withdrawn too. Resolves with what was stopped.
 */
export async function stopRun(
	harness: Harness,
	conversation: Conversation,
	requestId: string,
	context: Context,
	options: { all?: boolean } = {},
): Promise<{ stopped: boolean; queued: number }> {
	const live = async () => (await harness.snapshot(LiveDoc, conversation.id, context))?.run;
	if (options.all === true) {
		const stopped = (await live()) !== undefined;
		await conversation.abort(context);
		return { stopped, queued: 0 };
	}
	const stopping = await live();
	if (stopping === undefined) return { stopped: false, queued: await queuedCount(harness, conversation, context) };
	let current: typeof stopping | undefined = stopping;
	while (current !== undefined && current.inputs[0] === stopping.inputs[0]) {
		await harness.abortTask(current.taskId, context);
		await harness.waitForTask(current.taskId, context);
		current = await live();
	}
	const queued = await queuedCount(harness, conversation, context);
	const message = { role: "user" as const, content: "[stopped by a user]", timestamp: Date.now() };
	await conversation.submit({ type: "write", requestId, entry: { kind: UserEntry.kind, model: [message] } }, context);
	return { stopped: true, queued };
}

async function queuedCount(harness: Harness, conversation: Conversation, context: Context): Promise<number> {
	const inbox = await harness.snapshot(InboxDoc, conversation.id, context);
	return inbox?.items.filter((item) => item.mode !== "write").length ?? 0;
}
