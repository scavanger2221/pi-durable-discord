import { AttachmentBuilder, type Client, DiscordAPIError } from "discord.js";

export type FileRef = { readonly path: string; readonly name: string };

export type SendOptions = {
	/** Reply to this message in the same channel. */
	readonly replyTo?: string;
	readonly files?: readonly FileRef[];
};

/** Discord allows up to 10 attachments per message. */
export const FILES_PER_MESSAGE = 10;

/** What delivery needs from Discord. Tests replace it with a fake; production wraps a discord.js client. */
export interface DiscordPort {
	/** Send a message to a channel or thread; resolves with its id. Mentions in `text` never ping anyone. */
	send(channelId: string, text: string, options?: SendOptions): Promise<string>;
	/** Replace a message's text; with `files`, also replace its attachments (so repeating the edit is harmless). */
	edit(channelId: string, messageId: string, text: string, options?: { readonly files?: readonly FileRef[] }): Promise<void>;
	typing(channelId: string): Promise<void>;
}

/** discord.js rate-limits and retries REST calls itself; this only resolves channels and maps options. */
export function createDiscordPort(client: Client): DiscordPort {
	const channel = async (id: string) => {
		const found = await client.channels.fetch(id);
		if (found === null || !found.isSendable()) throw new Error(`Discord channel ${id} is not a text channel`);
		return found;
	};
	return {
		send: async (channelId, text, options = {}) => {
			const target = await channel(channelId);
			const sent = await target.send({
				content: text,
				allowedMentions: { parse: [] },
				...(options.replyTo === undefined ? {} : { reply: { messageReference: options.replyTo, failIfNotExists: false } }),
				...(options.files === undefined ? {} : { files: attachments(options.files) }),
			});
			return sent.id;
		},
		edit: async (channelId, messageId, text, options = {}) => {
			const target = await channel(channelId);
			// discord.js sends `attachments` as exactly the new files, which replaces whatever the message had.
			await target.messages.edit(messageId, {
				content: text,
				allowedMentions: { parse: [] },
				...(options.files === undefined ? {} : { files: attachments(options.files) }),
			});
		},
		typing: async (channelId) => {
			const target = await channel(channelId);
			if ("sendTyping" in target) await target.sendTyping();
		},
	};
}

function attachments(files: readonly FileRef[]): AttachmentBuilder[] {
	return files.map((file) => new AttachmentBuilder(file.path, { name: file.name }));
}

/** The message, or the channel it was in, no longer exists or cannot be reached by the bot. */
export function isGone(error: unknown): boolean {
	// 10003 Unknown Channel, 10008 Unknown Message, 50001 Missing Access, 50083 thread archived.
	return error instanceof DiscordAPIError && [10003, 10008, 50001, 50083].includes(Number(error.code));
}
