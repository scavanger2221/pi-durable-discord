import { BACKGROUND_CONTEXT as BG } from "@earendil-works/chord/context";
import {
	type ChatInputCommandInteraction,
	Client,
	Events,
	GatewayIntentBits,
	type GuildMember,
	type Interaction,
	type Message,
	MessageFlags,
	Partials,
	SlashCommandBuilder,
	ThreadAutoArchiveDuration,
} from "discord.js";
import type { Agent } from "../agent/open.ts";
import type { Config } from "../config.ts";
import { errorSummary, type Logger } from "../log.ts";
import { type IncomingMessage, messageContent, stripMention, threadName } from "./content.ts";
import { createDiscordPort } from "./port.ts";
import { stopRun } from "./stop.ts";

const COMMANDS = [
	new SlashCommandBuilder()
		.setName("pi")
		.setDescription("Start a new pi task in its own thread (or add to this task when used in a task thread)")
		.addStringOption((option) => option.setName("prompt").setDescription("What to do").setRequired(true)),
	new SlashCommandBuilder()
		.setName("stop")
		.setDescription("Stop this thread's running task")
		.addBooleanOption((option) => option.setName("all").setDescription("Also drop queued messages")),
	new SlashCommandBuilder().setName("tasks").setDescription("List running pi tasks"),
].map((command) => command.toJSON());

export type Gateway = {
	/** Log in, register slash commands, then resume durable work and start taking prompts. */
	start(): Promise<void>;
	stop(): Promise<void>;
};

/**
 * Discord as the gateway: a mention or `/pi` in an allowed channel starts a task in a new thread with its own durable
 * conversation, so any number of people can run tasks at once. Messages in a task's thread (from anyone allowed) go
 * to that task, queued behind its current run. Handlers only admit work; nothing waits for a model here.
 */
export function createGateway(config: Config, agent: Agent, log: Logger): Gateway {
	const client = new Client({
		intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
		partials: [Partials.Channel],
	});
	const { harness, directory } = agent;
	/** Per-thread chain, so messages of one thread are admitted in the order Discord delivered them. */
	const chains = new Map<string, Promise<unknown>>();
	const inOrder = (key: string, work: () => Promise<void>): Promise<void> => {
		const run = (chains.get(key) ?? Promise.resolve()).then(work, work);
		const settled = run.catch(() => undefined);
		chains.set(key, settled);
		void settled.then(() => chains.get(key) === settled && chains.delete(key));
		return run;
	};

	const allowed = (userId: string, member: GuildMember | null | undefined | unknown): boolean => {
		if (config.allowedUserIds.size === 0 && config.allowedRoleIds.size === 0) return true;
		if (config.allowedUserIds.has(userId)) return true;
		const roles = (member as GuildMember | null | undefined)?.roles;
		if (roles === undefined) return false;
		// Interactions in uncached guilds carry the raw role id list.
		const ids: readonly string[] = Array.isArray(roles) ? roles : [...roles.cache.keys()];
		return ids.some((id) => config.allowedRoleIds.has(id));
	};
	const channelAllowed = (channelId: string) => config.channelIds.size === 0 || config.channelIds.has(channelId);

	const incoming = (message: Message, text: string): IncomingMessage => ({
		id: message.id,
		authorId: message.author.id,
		authorName: message.member?.displayName ?? message.author.username,
		text,
		attachments: [...message.attachments.values()].map((each) => ({
			name: each.name,
			url: each.url,
			size: each.size,
			contentType: each.contentType,
		})),
	});

	async function onMessage(message: Message): Promise<void> {
		if (message.author.bot || message.system || !message.inGuild() || client.user === null) return;
		const botId = client.user.id;
		const channel = message.channel;
		if (channel.isThread()) {
			await inOrder(channel.id, async () => {
				if ((await directory.conversationOf(channel.id, BG)) === undefined) return;
				if (!allowed(message.author.id, message.member)) return;
				const text = stripMention(message.content, botId);
				if (text === "!stop" || text === "!stop all") {
					await stopInThread(channel.id, `discord:${message.id}`, text === "!stop all", (reply) =>
						message.reply({ content: reply, allowedMentions: { parse: [] } }).then(() => undefined),
					);
					return;
				}
				const content = await messageContent(incoming(message, text), directory.cwdOf(channel.id), {
					maxBytes: config.maxAttachmentBytes,
				});
				const result = await directory.followUp(
					channel.id,
					{ requestId: `discord:${message.id}`, replyTo: message.id, content },
					BG,
				);
				log.info("message_admitted", { thread: channel.id, message: message.id, result });
			});
			return;
		}
		if (!message.mentions.users.has(botId) || !channelAllowed(channel.id)) return;
		if (!allowed(message.author.id, message.member)) {
			await message.reply({ content: "You are not allowed to start pi tasks here.", allowedMentions: { parse: [] } });
			return;
		}
		const prompt = stripMention(message.content, botId);
		if (prompt === "" && message.attachments.size === 0) {
			await message.reply({ content: "Mention me with a task, or use `/pi`.", allowedMentions: { parse: [] } });
			return;
		}
		// A thread started from a message has the message's id; after a crash the thread may already exist.
		const thread =
			message.thread ??
			(await message.startThread({ name: threadName(prompt), autoArchiveDuration: ThreadAutoArchiveDuration.OneDay }));
		await inOrder(thread.id, async () => {
			const content = await messageContent(incoming(message, prompt), directory.cwdOf(thread.id), {
				maxBytes: config.maxAttachmentBytes,
			});
			const ref = { threadId: thread.id, guildId: message.guildId, channelId: channel.id, startedBy: message.author.id };
			const result = await directory.start(ref, { requestId: `discord:${message.id}`, content }, BG);
			log.info("task_started", { thread: thread.id, user: message.author.id, admitted: result.admitted });
		});
	}

	async function stopInThread(
		threadId: string,
		requestId: string,
		all: boolean,
		reply: (text: string) => Promise<void>,
	): Promise<void> {
		const conversation = await directory.conversationOf(threadId, BG);
		if (conversation === undefined) return reply("This thread is not a pi task.");
		const result = await stopRun(harness, conversation, requestId, BG, { all });
		if (!result.stopped) return reply(result.queued > 0 ? `Nothing is running; ${result.queued} queued.` : "Nothing is running.");
		await reply(result.queued > 0 ? `Stopped. ${result.queued} queued message(s) will continue.` : "Stopped.");
	}

	async function onCommand(interaction: ChatInputCommandInteraction): Promise<void> {
		const ephemeral = (content: string) =>
			interaction.reply({ content, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } }).then(() => undefined);
		if (!interaction.inGuild()) return ephemeral("pi tasks run in server channels.");
		if (!allowed(interaction.user.id, interaction.member)) return ephemeral("You are not allowed to use pi here.");
		const channel = interaction.channel;
		const inThread = channel?.isThread() === true;
		switch (interaction.commandName) {
			case "tasks": {
				const active = await directory.active(BG);
				if (active.length === 0) return ephemeral("No pi tasks are running.");
				const lines = active
					.slice(0, 25)
					.map((task) => `• <#${task.threadId}> by <@${task.startedBy}>: ${task.running ? "running" : "waiting"}${task.queued > 0 ? `, ${task.queued} queued` : ""}`);
				return ephemeral(lines.join("\n"));
			}
			case "stop": {
				if (!inThread || channel === null) return ephemeral("Use /stop in a task's thread.");
				await interaction.deferReply();
				const all = interaction.options.getBoolean("all") === true;
				await stopInThread(channel.id, `discord:${interaction.id}`, all, (text) =>
					interaction.editReply({ content: text, allowedMentions: { parse: [] } }).then(() => undefined),
				);
				return;
			}
			case "pi": {
				const prompt = interaction.options.getString("prompt", true);
				const name = interaction.member && "displayName" in interaction.member ? interaction.member.displayName : interaction.user.username;
				const request: IncomingMessage = {
					id: interaction.id,
					authorId: interaction.user.id,
					authorName: String(name),
					text: prompt,
					attachments: [],
				};
				if (inThread && channel !== null && (await directory.conversationOf(channel.id, BG)) !== undefined) {
					await interaction.reply({ content: `**${name}:** ${prompt}`, allowedMentions: { parse: [] } });
					const echo = await interaction.fetchReply();
					await inOrder(channel.id, async () => {
						const content = await messageContent(request, directory.cwdOf(channel.id), { maxBytes: config.maxAttachmentBytes });
						await directory.followUp(channel.id, { requestId: `discord:${interaction.id}`, replyTo: echo.id, content }, BG);
					});
					return;
				}
				if (channel === null || inThread || !channelAllowed(channel.id)) return ephemeral("Use /pi in a channel where pi is enabled.");
				await interaction.reply({ content: `**${name}:** ${prompt}`, allowedMentions: { parse: [] } });
				const echo = await interaction.fetchReply();
				const thread = await echo.startThread({ name: threadName(prompt), autoArchiveDuration: ThreadAutoArchiveDuration.OneDay });
				await inOrder(thread.id, async () => {
					const content = await messageContent(request, directory.cwdOf(thread.id), { maxBytes: config.maxAttachmentBytes });
					const ref = { threadId: thread.id, guildId: interaction.guildId, channelId: channel.id, startedBy: interaction.user.id };
					const result = await directory.start(ref, { requestId: `discord:${interaction.id}`, content }, BG);
					log.info("task_started", { thread: thread.id, user: interaction.user.id, admitted: result.admitted });
				});
				return;
			}
		}
	}

	const guarded =
		<T>(name: string, handler: (value: T) => Promise<void>) =>
		(value: T) => {
			handler(value).catch((error: unknown) => log.error("handler_failed", { handler: name, error: errorSummary(error) }));
		};

	return {
		start: async () => {
			const ready = new Promise<void>((resolve) => client.once(Events.ClientReady, () => resolve()));
			client.on(Events.MessageCreate, guarded("message", onMessage));
			client.on(
				Events.InteractionCreate,
				guarded("interaction", async (interaction: Interaction) => {
					if (interaction.isChatInputCommand()) await onCommand(interaction);
				}),
			);
			client.on(Events.Error, (error) => log.error("discord_error", { error: errorSummary(error) }));
			await client.login(config.discordToken);
			await ready;
			const application = client.application;
			if (application !== null) {
				if (config.guildIds.length === 0) await application.commands.set(COMMANDS);
				else for (const guild of config.guildIds) await application.commands.set(COMMANDS, guild);
			}
			agent.setPort(createDiscordPort(client));
			// Work a previous process left (runs, deliveries) continues now that answers can reach Discord.
			harness.resume();
			log.info("gateway_ready", { user: client.user?.tag, guilds: client.guilds.cache.size });
		},
		stop: async () => {
			await client.destroy();
		},
	};
}
