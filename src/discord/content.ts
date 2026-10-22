import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

export type IncomingAttachment = {
	readonly name: string;
	readonly url: string;
	readonly size: number;
	readonly contentType?: string | null;
};

export type IncomingMessage = {
	readonly id: string;
	readonly authorId: string;
	readonly authorName: string;
	readonly text: string;
	readonly attachments: readonly IncomingAttachment[];
};

/** A file name safe on any filesystem, keeping the extension. */
export function safeName(name: string): string {
	const cleaned = name.replace(/[^\w.-]+/g, "_").replace(/^\.+/, "");
	return cleaned.slice(-100) || "file";
}

/** The first words of a prompt as a thread title (Discord allows 100 characters). */
export function threadName(prompt: string): string {
	const flat = prompt.replace(/\s+/g, " ").trim();
	if (flat === "") return "pi task";
	return flat.length <= 90 ? flat : `${flat.slice(0, 89)}…`;
}

/** Remove mentions of the bot, so `@pi fix the build` reads `fix the build`. */
export function stripMention(text: string, botId: string): string {
	return text.replace(new RegExp(`<@!?${botId}>`, "g"), "").trim();
}

/**
 * What the model sees for one Discord message: a header naming its author (several people share a thread), the text,
 * and a line per attachment. Attachments are saved under `<cwd>/inbox/`; one that cannot be saved is still named.
 */
export async function messageContent(
	message: IncomingMessage,
	cwd: string,
	limits: { maxBytes: number },
	fetchFile: (url: string, path: string) => Promise<void> = download,
): Promise<string> {
	const lines = [`[discord] @${message.authorName} (id ${message.authorId}):`];
	if (message.text !== "") lines.push(message.text);
	for (const attachment of message.attachments) {
		const relative = join("inbox", `${message.id}-${safeName(attachment.name)}`);
		const kind = attachment.contentType?.startsWith("image/") ? "image" : (attachment.contentType ?? "file");
		if (attachment.size > limits.maxBytes) {
			lines.push(`[attachment ${attachment.name} (${kind}) not saved: larger than ${limits.maxBytes} bytes]`);
			continue;
		}
		try {
			await mkdir(join(cwd, "inbox"), { recursive: true });
			await fetchFile(attachment.url, join(cwd, relative));
			lines.push(`[attachment saved: ${relative} (${kind}, ${attachment.size} bytes)]`);
		} catch (error) {
			lines.push(`[attachment ${attachment.name} not saved: ${error instanceof Error ? error.message : String(error)}]`);
		}
	}
	return lines.join("\n");
}

async function download(url: string, path: string): Promise<void> {
	const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
	if (!response.ok || response.body === null) throw new Error(`download failed (${response.status})`);
	await pipeline(Readable.fromWeb(response.body as never), createWriteStream(path));
}
