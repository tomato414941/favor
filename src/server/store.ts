import { DatabaseSync } from 'node:sqlite';
import { dirname } from 'node:path';
import { mkdirSync } from 'node:fs';

export class Store {
  readonly db: DatabaseSync;
  private transactionDepth = 0;
  constructor(path = ':memory:') {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    const version = Number(this.db.prepare('PRAGMA user_version').get()!.user_version);
    const initialized = this.db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .get();
    if (version !== 5 && (version !== 0 || initialized)) {
      this.db.close();
      throw new Error(
        'Unsupported database schema. Prepare schema version 5 before starting the application.',
      );
    }
    this.db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000');
    if (version === 5) return;
    this.transaction(() =>
      this.db.exec(`
      CREATE TABLE users (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT
      ) STRICT;
      CREATE TABLE requests (
        id TEXT PRIMARY KEY, client_id TEXT NOT NULL REFERENCES users(id),
        creator_id TEXT NOT NULL REFERENCES users(id),
        brief TEXT NOT NULL, amount INTEGER NOT NULL CHECK (amount > 0),
        visibility TEXT NOT NULL, state TEXT NOT NULL,
        created_at INTEGER NOT NULL, accept_by INTEGER NOT NULL, deliver_by INTEGER NOT NULL,
        cancelled_reason TEXT, delivery_version INTEGER NOT NULL DEFAULT 0
      ) STRICT;
      CREATE TABLE payments (
        request_id TEXT PRIMARY KEY REFERENCES requests(id),
        state TEXT NOT NULL, amount INTEGER NOT NULL, hold_until INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE effects (
        request_id TEXT NOT NULL REFERENCES requests(id), operation TEXT NOT NULL,
        created_at INTEGER NOT NULL, PRIMARY KEY (request_id, operation)
      ) STRICT;
      CREATE TABLE commands (
        actor_id TEXT NOT NULL, scope TEXT NOT NULL, key TEXT NOT NULL,
        fingerprint TEXT NOT NULL, request_id TEXT NOT NULL REFERENCES requests(id),
        PRIMARY KEY (actor_id, scope, key)
      ) STRICT;
      CREATE TABLE payment_events (
        id TEXT PRIMARY KEY, request_id TEXT NOT NULL REFERENCES requests(id)
      ) STRICT;
      CREATE TABLE files (
        id TEXT PRIMARY KEY, request_id TEXT NOT NULL REFERENCES requests(id),
        version INTEGER NOT NULL, name TEXT NOT NULL, data BLOB NOT NULL
      ) STRICT;
      CREATE TABLE audit (
        id INTEGER PRIMARY KEY, request_id TEXT NOT NULL REFERENCES requests(id),
        actor_id TEXT NOT NULL, action TEXT NOT NULL, at INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE request_links (
        id TEXT PRIMARY KEY, client_id TEXT NOT NULL REFERENCES users(id),
        recipient_provider TEXT NOT NULL, recipient_subject TEXT NOT NULL,
        recipient_name TEXT NOT NULL,
        delivery TEXT NOT NULL DEFAULT 'self' CHECK (delivery IN ('self', 'email')),
        recipient_email TEXT,
        brief TEXT NOT NULL, amount INTEGER NOT NULL CHECK (amount > 0),
        visibility TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('pending', 'accepted', 'cancelled')),
        created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, deliver_by INTEGER NOT NULL,
        token_hash TEXT NOT NULL UNIQUE, cancelled_reason TEXT,
        request_id TEXT REFERENCES requests(id)
      ) STRICT;
      CREATE INDEX request_links_client ON request_links(client_id, created_at);
      CREATE TABLE link_commands (
        actor_id TEXT NOT NULL, scope TEXT NOT NULL, key TEXT NOT NULL, fingerprint TEXT NOT NULL,
        link_id TEXT NOT NULL REFERENCES request_links(id), PRIMARY KEY (actor_id, scope, key)
      ) STRICT;
      CREATE TABLE link_events (
        id INTEGER PRIMARY KEY, link_id TEXT NOT NULL REFERENCES request_links(id),
        actor_id TEXT NOT NULL, action TEXT NOT NULL, at INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE link_optouts (
        email TEXT PRIMARY KEY, at INTEGER NOT NULL
      ) STRICT;
      PRAGMA user_version = 5;
    `),
    );
  }
  transaction<T>(run: () => T): T {
    const depth = this.transactionDepth;
    const savepoint = `nested_${depth}`;
    this.db.exec(depth === 0 ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${savepoint}`);
    this.transactionDepth++;
    try {
      const result = run();
      this.db.exec(depth === 0 ? 'COMMIT' : `RELEASE SAVEPOINT ${savepoint}`);
      return result;
    } catch (error) {
      this.db.exec(
        depth === 0
          ? 'ROLLBACK'
          : `ROLLBACK TO SAVEPOINT ${savepoint}; RELEASE SAVEPOINT ${savepoint}`,
      );
      throw error;
    } finally {
      this.transactionDepth--;
    }
  }
  close() {
    this.db.close();
  }
}
