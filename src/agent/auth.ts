import { mkdir, open, readFile, rename, rmdir, stat, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import type { AuthOperationOptions, Credential, CredentialInfo, CredentialStore } from "@earendil-works/pi-ai";

type CredentialFile = Record<string, Credential>;

/** pi's auth lock (proper-lockfile): a `<file>.lock` directory, stale after 30 s. */
const LOCK_STALE_MS = 30_000;
const LOCK_WAIT_MS = 30_000;

/**
 * pi-ai credential store over pi's `auth.json` (`{ [providerId]: Credential }`, mode 0600), so one `/login` in pi
 * serves the bot too. Every read goes to the file, because an OAuth refresh rotates the refresh token and pi may have
 * written it. Writes are serialized per provider here and across processes with pi's lock directory, then renamed in.
 */
export class FileCredentialStore implements CredentialStore {
	readonly path: string;
	readonly #chains = new Map<string, Promise<unknown>>();

	constructor(path: string) {
		this.path = path;
	}

	async read(providerId: string, _options?: AuthOperationOptions): Promise<Credential | undefined> {
		const file = await this.#load();
		return Object.hasOwn(file, providerId) ? file[providerId] : undefined;
	}

	async list(_options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
		const file = await this.#load();
		return Object.entries(file).map(([providerId, credential]) => ({ providerId, type: credential.type }));
	}

	modify(
		providerId: string,
		fn: (current: Credential | undefined) => Promise<Credential | undefined>,
		options?: AuthOperationOptions,
	): Promise<Credential | undefined> {
		return this.#enqueue(providerId, () =>
			this.#locked(options, async () => {
				const file = await this.#load();
				const current = Object.hasOwn(file, providerId) ? file[providerId] : undefined;
				const next = await fn(current);
				if (next === undefined) return current;
				await this.#write({ ...file, [providerId]: next });
				return next;
			}),
		);
	}

	delete(providerId: string, options?: AuthOperationOptions): Promise<void> {
		return this.#enqueue(providerId, () =>
			this.#locked(options, async () => {
				const file = await this.#load();
				if (!Object.hasOwn(file, providerId)) return;
				const { [providerId]: _removed, ...rest } = file;
				await this.#write(rest);
			}),
		);
	}

	#enqueue<T>(providerId: string, task: () => Promise<T>): Promise<T> {
		const previous = this.#chains.get(providerId) ?? Promise.resolve();
		const run = previous.then(task, task);
		const settled = run.catch(() => undefined);
		this.#chains.set(providerId, settled);
		void settled.then(() => {
			if (this.#chains.get(providerId) === settled) this.#chains.delete(providerId);
		});
		return run;
	}

	async #locked<T>(options: AuthOperationOptions | undefined, fn: () => Promise<T>): Promise<T> {
		await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
		const lock = `${this.path}.lock`;
		const deadline = Date.now() + LOCK_WAIT_MS;
		for (let delay = 10; ; delay = Math.min(delay * 2, 200)) {
			options?.signal?.throwIfAborted();
			try {
				await mkdir(lock);
				break;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
				const age = await stat(lock).then(
					(info) => Date.now() - info.mtimeMs,
					() => 0,
				);
				if (age > LOCK_STALE_MS) await rmdir(lock).catch(() => undefined);
				else if (Date.now() > deadline) throw new Error(`Timed out waiting for the lock on ${this.path}`);
				else await new Promise((resolve) => setTimeout(resolve, delay));
			}
		}
		try {
			return await fn();
		} finally {
			await rmdir(lock).catch(() => undefined);
		}
	}

	async #load(): Promise<CredentialFile> {
		let text: string;
		try {
			text = await readFile(this.path, "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
			throw new Error(`Cannot read credentials file ${this.path}`);
		}
		try {
			const value = JSON.parse(text) as unknown;
			if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("not an object");
			return value as CredentialFile;
		} catch {
			// Never echo file contents: they are secrets.
			throw new Error(`Credentials file ${this.path} is not valid JSON`);
		}
	}

	async #write(file: CredentialFile): Promise<void> {
		const temp = `${this.path}.${process.pid}.tmp`;
		const handle = await open(temp, "w", 0o600);
		try {
			await handle.writeFile(`${JSON.stringify(file, null, 2)}\n`);
			await handle.sync();
		} finally {
			await handle.close();
		}
		try {
			await rename(temp, this.path);
		} catch (error) {
			await unlink(temp).catch(() => undefined);
			throw error;
		}
	}
}
