import { defineDoc } from "@earendil-works/pi-durable";

/**
 * Discord thread id → durable conversation id. Every task has its own thread and its own conversation, so tasks run
 * concurrently and never share context. A thread started from a message has the message's id, which makes the
 * mapping idempotent for a redelivered prompt.
 */
export const ThreadMap = defineDoc<{ threads: Record<string, number> }>({
	kind: "discord.threads",
	version: 1,
	scope: "session",
	initial: () => ({ threads: {} }),
	checkpointWhen: () => false,
});

/** Where a conversation's answers go, and who started it. */
export const ThreadInfo = defineDoc<{ threadId: string; guildId: string; channelId: string; startedBy: string }>({
	kind: "discord.thread",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({ threadId: "", guildId: "", channelId: "", startedBy: "" }),
	checkpointWhen: () => false,
});

/** Ring of admitted Discord message ids: a message delivered twice (gateway resume, a retried slash command) runs once. */
export const Intake = defineDoc<{ keys: string[] }>({
	kind: "discord.intake",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({ keys: [] }),
	checkpointWhen: () => false,
});

export const INTAKE_RING_SIZE = 1000;

/** Which answer entries were claimed for delivery, by which task: an answer shared by queued inputs is posted once. */
export const Delivered = defineDoc<{ answers: Record<string, number>; order: number[] }>({
	kind: "discord.delivered",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({ answers: {}, order: [] }),
	checkpointWhen: () => false,
});

export const DELIVERED_RING_SIZE = 500;

/** A file attached to an answer: a copy in the data directory, so later changes to the original do not affect it. */
export type Attachment = { path: string; name: string };

/**
 * Files the agent attached with `discord_send_file` that no answer has taken yet. The delivery of the run's answer
 * takes them in the commit that records its outcome, so they go out once, with that answer.
 */
export const Outbox = defineDoc<{ files: Attachment[] }>({
	kind: "discord.outbox",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({ files: [] }),
	checkpointWhen: () => false,
});

/** Add `key` to a ring, dropping the oldest beyond `size`; false when it was already present. */
export function pushRing(keys: string[], key: string, size: number): boolean {
	if (keys.includes(key)) return false;
	keys.push(key);
	if (keys.length > size) keys.splice(0, keys.length - size);
	return true;
}
