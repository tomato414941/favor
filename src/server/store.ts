import { DatabaseSync } from 'node:sqlite';
import { dirname } from 'node:path';
import { mkdirSync } from 'node:fs';
import { settlementTables } from './settlement-schema.js';

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
    if (version !== 10 && (version !== 0 || initialized)) {
      this.db.close();
      throw new Error(
        'Unsupported database schema. Run the offline migration before starting the application.',
      );
    }
    this.db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000');
    if (version === 10) return;
    this.transaction(() =>
      this.db.exec(`
      CREATE TABLE users (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT, display_name TEXT
      ) STRICT;
      CREATE TABLE requests (
        id TEXT PRIMARY KEY, client_id TEXT NOT NULL REFERENCES users(id),
        creator_id TEXT NOT NULL REFERENCES users(id),
        brief TEXT NOT NULL, amount INTEGER NOT NULL CHECK (amount > 0),
        platform_fee INTEGER NOT NULL CHECK (platform_fee >= 0 AND platform_fee < amount),
        visibility TEXT NOT NULL, state TEXT NOT NULL,
        created_at INTEGER NOT NULL, accept_by INTEGER NOT NULL, deliver_by INTEGER NOT NULL,
        cancelled_reason TEXT, delivery_version INTEGER NOT NULL DEFAULT 0
      ) STRICT;
      CREATE TABLE payments (
        link_id TEXT PRIMARY KEY REFERENCES request_links(id),
        request_id TEXT UNIQUE REFERENCES requests(id), provider TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('pending', 'authorized', 'capturing', 'captured', 'releasing', 'released')),
        amount INTEGER NOT NULL, hold_until INTEGER NOT NULL DEFAULT 0,
        checkout_id TEXT UNIQUE, checkout_url TEXT, intent_id TEXT UNIQUE, charge_id TEXT,
        checkout_expires_at INTEGER NOT NULL, origin TEXT NOT NULL,
        checked_at INTEGER NOT NULL DEFAULT 0
      ) STRICT;
      CREATE TABLE effects (
        request_id TEXT NOT NULL REFERENCES requests(id), operation TEXT NOT NULL,
        created_at INTEGER NOT NULL, PRIMARY KEY (request_id, operation)
      ) STRICT;
      CREATE TABLE recipients (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL UNIQUE REFERENCES users(id),
        provider TEXT NOT NULL, account_id TEXT UNIQUE,
        state TEXT NOT NULL CHECK (state IN ('unregistered', 'incomplete', 'reviewing', 'ready'))
      ) STRICT;
      CREATE TABLE commands (
        actor_id TEXT NOT NULL, scope TEXT NOT NULL, key TEXT NOT NULL,
        fingerprint TEXT NOT NULL, request_id TEXT NOT NULL REFERENCES requests(id),
        PRIMARY KEY (actor_id, scope, key)
      ) STRICT;
      CREATE TABLE payment_events (
        id TEXT PRIMARY KEY, link_id TEXT NOT NULL REFERENCES request_links(id)
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
        platform_fee INTEGER NOT NULL CHECK (platform_fee >= 0 AND platform_fee < amount),
        visibility TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('awaiting_payment', 'pending', 'accepted', 'cancelled')),
        created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, deliver_by INTEGER NOT NULL,
        token_hash TEXT UNIQUE, cancelled_reason TEXT,
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
      ${settlementTables}
      PRAGMA user_version = 10;
    `),
    );
  }
  bindInstance(paymentMode: string, stripeAccount: string, authKey: string) {
    this.transaction(() => {
      const row = this.db.prepare('SELECT * FROM instance WHERE id = 1').get();
      if (row) {
        if (
          row.payment_mode !== paymentMode ||
          row.stripe_account !== stripeAccount ||
          row.auth_key !== authKey
        )
          throw new Error(
            'This database belongs to a different payment or authentication environment.',
          );
        return;
      }
      if (paymentMode === 'stripe_live' && this.db.prepare('SELECT 1 FROM users LIMIT 1').get())
        throw new Error('Live payments require a new database on first startup.');
      const foreign = this.db
        .prepare(
          'SELECT 1 FROM payments WHERE provider != ? UNION ALL SELECT 1 FROM recipients WHERE provider != ? LIMIT 1',
        )
        .get(paymentMode, paymentMode);
      if (foreign) throw new Error('Use a separate database for this payment environment.');
      this.db
        .prepare('INSERT INTO instance VALUES (1, ?, ?, ?)')
        .run(paymentMode, stripeAccount, authKey);
    });
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
