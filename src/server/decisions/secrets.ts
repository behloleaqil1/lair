/**
 * The secret store: where a credentials decision's value goes.
 *
 * The Decision Inbox never keeps a secret itself. Answering a credentials
 * decision with an option that supplies the secret hands the value to a
 * SecretStore under the decision's `secretName`; the decision then records
 * only that it was supplied. The value is not written to data/decisions.db,
 * the audit trail, an event, a log line or any API response.
 *
 * A module that needs the credential reads it with get(name). A persistent
 * broker (an OS keychain, a vault, an encrypted file) implements this
 * interface; until one is configured, Lair uses MemorySecretStore.
 */

export interface SecretStore {
  /** Shown in the UI next to a secret field, e.g. "server memory (asked again after a restart)" */
  readonly description: string;
  /** Store the value under `name`, replacing any earlier one. */
  put(name: string, value: string): Promise<void>;
  has(name: string): Promise<boolean>;
  get(name: string): Promise<string | undefined>;
}

/** Thrown by a SecretStore that can't take the value right now (HTTP 503). */
export class SecretStoreUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SecretStoreUnavailableError";
  }
}

/**
 * The stub: values live in the server's memory only. Nothing is written to
 * disk, and a restart forgets them, so a module that finds its credential
 * missing raises the credentials decision again.
 */
export class MemorySecretStore implements SecretStore {
  readonly description = "server memory only (never written to disk; asked again after a restart)";
  private values = new Map<string, string>();

  async put(name: string, value: string): Promise<void> {
    this.values.set(name, value);
  }

  async has(name: string): Promise<boolean> {
    return this.values.has(name);
  }

  async get(name: string): Promise<string | undefined> {
    return this.values.get(name);
  }
}
