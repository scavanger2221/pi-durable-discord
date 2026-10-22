# pi-durable-discord

A durable [pi](https://github.com/earendil-works/pi) agent with Discord as the gateway. pi-durable is the harness: conversations, model turns, tool calls and answer delivery are committed to SQLite, so a crash or restart picks the work up where it stopped.

- **Each prompt is a new task.** Mention the bot (`@pi fix the flaky test`) or use `/pi prompt:...` in a channel. The bot opens a thread for the task, and the task gets its own durable conversation and its own working directory.
- **Many people at once.** Every thread is a separate conversation, and the harness runs them in parallel. Two people who start tasks at the same time both get model requests in flight right away.
- **Threads are shared.** Anyone allowed can post in a task's thread. Each message reaches the model tagged with its author, and messages sent while the agent is busy queue behind the current run.

```text
#general   alice: @pi add a healthcheck endpoint      bob: /pi prompt: why is CI red?
              └─ thread "add a healthcheck endpoint"      └─ thread "why is CI red?"
                 conversation 1, cwd workspace/<id1>         conversation 2, cwd workspace/<id2>
                 discord.deliver task → pi.generation        discord.deliver task → pi.generation
                   → pi.tool (bash, edit, ...)                  → pi.tool ...
```

## How it works

| Piece | What it does |
|---|---|
| `src/discord/gateway.ts` | discord.js client. Turns a mention or `/pi` into a thread plus a task, sends thread messages to that task, and handles `/stop` and `/tasks`. Handlers only admit work and never wait for a model. |
| `src/discord/tasks.ts` | One commit creates the conversation, sets its model and cwd, maps thread → conversation, records the message id and creates the delivery task. A message delivered twice runs once. |
| `src/discord/deliver.ts` | `discord.deliver`, a durable task, one per message. **wait** submits the input (idempotent by request id) and streams a preview message while it is this message's run. **send** posts the answer in ≤2000-char chunks, with the agent's files attached to the last one, and checkpoints each message, so a restart neither drops nor repeats the answer. |
| `src/agent/extensions.ts` | pi's coding tools (`read`, `write`, `edit`, `bash`). `bash` gets an allowlisted environment, so the bot token and provider keys never reach it. The system prompt includes `~/.pi/agent/AGENTS.md` and the workspace `AGENTS.md`. Also defines the `discord_send_file` tool, which copies a file to `<data>/outbox/` for the answer to carry. |
| `src/agent/mcp.ts` | Reads an `mcpServers` file (pi's `~/.pi/agent/mcp.json` by default), connects every server at startup and wraps each tool as `mcp__<server>__<tool>`. A server that fails to start is logged and skipped, and a dropped connection reopens on the next call. |
| `src/agent/auth.ts` | Reads and writes pi's `~/.pi/agent/auth.json` with pi's lock, so a `/login` in pi also works for the bot. |
| `src/config.ts` | The `config.json` schema (TypeBox), validation with readable messages, and the order settings come from: environment, file, pi's `settings.json`, default. `src/setup.ts` and `src/check.ts` are `npm run setup` and `npm run check`. |

## Setup

1. Create an application at <https://discord.com/developers/applications>. Add a bot, and under **Bot → Privileged Gateway Intents** turn on **Message Content Intent**.
2. Log in to a model provider with pi (`pi`, then `/login`), or export the provider's API key.
3. Run the setup, which asks for the token, who may use the bot, the server, the model and the workspace:

```bash
npm install
npm run setup   # writes config.json, and the token to .env; then runs the check
npm start
```

`npm run check` checks everything without starting the bot: the config, the token and the Message Content intent, the model and its credentials, the MCP servers and the directories. It also prints the invite link, with the scopes `bot` and `applications.commands` and the permissions the bot needs (View Channels, Send Messages, Create Public Threads, Send Messages in Threads, Read Message History, Attach Files). Run it after editing `config.json`.

Node 22.19 or newer is required (it uses `node:sqlite`).

## Configuration

All settings are in one file, `config.json` (see [`config.example.json`](config.example.json)). It points to `config.schema.json`, so editors such as VS Code autocomplete the settings and describe each one. A setting that is misspelled or has the wrong type stops the bot at startup with a message naming it. Relative paths are relative to the file, and `~` is the home directory. `PI_DISCORD_CONFIG=path/to/file.json` uses another file.

```json
{
	"$schema": "./config.schema.json",
	"discord": { "allowedUsers": ["123456789012345678"], "guilds": ["234567890123456789"] },
	"model": { "provider": "anthropic", "id": "claude-sonnet-5-5", "thinking": "medium" },
	"workspace": { "dir": "./workspace", "mode": "per-thread" }
}
```

Keep the bot token in `.env` as `DISCORD_TOKEN`; `npm run setup` puts it there and makes the file readable only by you. Every setting can also come from an environment variable, which wins over the file. This is handy for containers. When the model is not set, it comes from pi's `~/.pi/agent/settings.json`.

| Setting | Variable | Default | Meaning |
|---|---|---|---|
| | `DISCORD_TOKEN` | required | Bot token |
| `discord.allowedUsers` | `DISCORD_ALLOWED_USERS` | | User ids allowed to prompt. Turn on Developer Mode in Discord, then right-click → Copy ID. |
| `discord.allowedRoles` | `DISCORD_ALLOWED_ROLES` | | Role ids allowed to prompt |
| `discord.allowEveryone` | `DISCORD_ALLOW_EVERYONE=1` | `false` | Everyone who can see a channel may prompt. Without it, at least one of the two lists above is required. |
| `discord.channels` | `DISCORD_CHANNELS` | all | Channel ids where mentions and `/pi` start tasks |
| `discord.guilds` | `DISCORD_GUILDS` | | Server ids to register slash commands in immediately. Without it, commands are registered globally, which can take up to an hour. |
| `discord.maxAttachmentMB` | `DISCORD_MAX_ATTACHMENT_MB` | `25` | Larger attachments are named to the model but not saved |
| `model.provider` / `.id` / `.thinking` | `PI_PROVIDER` / `PI_MODEL` / `PI_THINKING` | pi's `settings.json` | A built-in pi-ai provider, a model id and a thinking level |
| `workspace.dir` | `PI_WORKDIR` | `./workspace` | Root of the agent's files |
| `workspace.mode` | `PI_WORKSPACE_MODE` | `per-thread` | `per-thread`: each task works in `<dir>/<threadId>`. `shared`: every task works in `<dir>`, for example one repo checkout. |
| `workspace.instructions` | `PI_INSTRUCTIONS` | `<dir>/AGENTS.md` | Project instructions file |
| `dataDir` | `PI_DATA_DIR` | `./data` | SQLite database |
| `pi.agentDir` / `pi.authFile` | `PI_CODING_AGENT_DIR` / `PI_AUTH_FILE` | `~/.pi/agent`, `<that>/auth.json` | pi's agent directory and credentials |
| `mcp.config` | `PI_MCP_CONFIG` | `<agentDir>/mcp.json` | `mcpServers` file to load |
| `mcp.enabled` | `PI_MCP_CONFIG=none` | `true` | `false` turns MCP off |
| `codemode` | `PI_CODEMODE` | `true` | `false` (or `off`) removes the `codemode` tool |
| `logLevel` | `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` (JSON lines on stderr) |

## Commands

- `@pi <task>` or `/pi prompt:<task>` in a channel: start a new task in a new thread.
- A message in a task thread, or `/pi` there: add to that task. It queues as a follow-up while a run is going.
- `/stop` or `!stop` in a thread: stop the current run. Queued messages still run.
- `/stop all:true` or `!stop all`: stop the run and drop queued messages.
- `/tasks`: list tasks that are running or have queued messages.

## MCP, tool search and code mode

- **MCP.** Servers come from the same `mcpServers` format pi's MCP extension, Claude and Cursor use: `command`/`args`/`env` for a local server, `url`/`headers` for a remote one, `"disabled": true` to skip one, and `${VAR}` filled from the bot's environment. Local servers get the agent's allowlisted environment plus their own `env`, never the bot token. The startup log line `mcp_ready` lists the servers and their tool counts.
- **Tool search.** MCP tools are deferred: they are not sent with every request (chrome-devtools alone has 32). The model finds them with `tool_search`, which loads the matches for the rest of the conversation.
- **Code mode.** The `codemode` tool runs JavaScript the model writes in a QuickJS sandbox, where `await tools.bash(...)`, `tools.read(...)` and `tools.mcp__exa__...(...)` call the other tools. Only the script's output reaches the model. A script interrupted by a restart resumes without re-running the calls it already finished.

## Files and images

The agent shares files, such as a chart, a diagram or a screenshot it made with its shell, through the `discord_send_file` tool. A file is attached to the answer message, after its text, and Discord shows images inline. It is copied when the agent sends it, so later changes to the file do not affect what is posted, and like the text it is posted once even across restarts. A message carries up to 10 files; more follow in extra messages. If Discord refuses a file (over 10 MB, or the server's limit), the answer is posted without it, with a note. With `now: true` the agent posts a file right away as its own message instead, for example a progress screenshot; that post is not protected against a repeat after a restart. Ask for an image explicitly ("plot it and send the chart") to get one reliably.

## Tests

```bash
npm test        # faux model provider + fake Discord port: concurrency, follow-ups, dedupe, tools, restart; config
npm run typecheck
npm run schema  # regenerate config.schema.json after changing the settings in src/config.ts
```

## Limits

- **Security.** Every allowed person can run shell commands on this machine with the bot's user. Restrict users or roles, and run it in a container or VM if the server is not just you and people you trust. `per-thread` mode separates working directories, but it is not a sandbox.
- **Offline messages.** Discord does not redeliver gateway events. A message sent while the bot is offline is never seen, though work admitted before a crash does finish. A message that was half-handled when the process died (thread created, task not yet admitted) can be posted again.
- **What it does not take from pi.** Only built-in pi-ai providers work: custom providers from pi's `models.json` are not loaded. pi's extensions and packages, skills, prompt templates and its other settings are not loaded either, because pi-durable is its own harness and does not run pi's extension API. What it does share with pi: the model defaults from `settings.json`, the logins in `auth.json`, `AGENTS.md`, and the MCP servers in `mcp.json`.
- **DMs.** Not supported, because DMs have no threads.
- **MCP.** Servers run as the bot's user, and their tools are open to everyone who may prompt: with chrome-devtools that is your browser and its logged-in sessions. The tool list is read at startup; restart the bot after changing servers. Like other tools, an MCP call cut off by a restart is not run again.
- pi-durable is experimental, and its API changes between releases. The dependency is pinned to 1.4.0.
