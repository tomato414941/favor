import { DatabaseSync } from 'node:sqlite';
import { dirname } from 'node:path';
import { mkdirSync } from 'node:fs';
import type { RequestInput } from '../shared.js';
import { commandFingerprint } from './fingerprint.js';

export class Store {
  readonly db: DatabaseSync;
  private transactionDepth = 0;
  constructor(path = ':memory:') {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA foreign_keys = ON;
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, role TEXT NOT NULL,
        points INTEGER NOT NULL CHECK (points >= 0)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS requests (
        id TEXT PRIMARY KEY, client_id TEXT NOT NULL REFERENCES users(id),
        creator_id TEXT NOT NULL REFERENCES users(id),
        brief TEXT NOT NULL, amount INTEGER NOT NULL CHECK (amount > 0),
        visibility TEXT NOT NULL, nsfw INTEGER NOT NULL, state TEXT NOT NULL,
        created_at INTEGER NOT NULL, accept_by INTEGER NOT NULL, deliver_by INTEGER NOT NULL,
        cancelled_reason TEXT, delivery_version INTEGER NOT NULL DEFAULT 0
      ) STRICT;
      CREATE TABLE IF NOT EXISTS payments (
        request_id TEXT PRIMARY KEY REFERENCES requests(id), method TEXT NOT NULL,
        state TEXT NOT NULL, amount INTEGER NOT NULL,
        hold_until INTEGER NOT NULL, capture_requested INTEGER NOT NULL DEFAULT 0
      ) STRICT;
      CREATE TABLE IF NOT EXISTS effects (
        request_id TEXT NOT NULL REFERENCES requests(id), operation TEXT NOT NULL,
        created_at INTEGER NOT NULL, PRIMARY KEY (request_id, operation)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS commands (
        actor_id TEXT NOT NULL, scope TEXT NOT NULL, key TEXT NOT NULL,
        fingerprint TEXT NOT NULL, request_id TEXT NOT NULL REFERENCES requests(id),
        PRIMARY KEY (actor_id, scope, key)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS payment_events (
        id TEXT PRIMARY KEY, request_id TEXT NOT NULL REFERENCES requests(id)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS files (
        id TEXT PRIMARY KEY, request_id TEXT NOT NULL REFERENCES requests(id),
        version INTEGER NOT NULL, name TEXT NOT NULL, data BLOB NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS audit (
        id INTEGER PRIMARY KEY, request_id TEXT NOT NULL REFERENCES requests(id),
        actor_id TEXT NOT NULL, action TEXT NOT NULL, at INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS social_accounts (
        provider TEXT NOT NULL, subject TEXT NOT NULL, handle TEXT NOT NULL, name TEXT NOT NULL,
        user_id TEXT REFERENCES users(id), PRIMARY KEY (provider, subject), UNIQUE (provider, user_id)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS sessions (
        token_hash TEXT PRIMARY KEY, provider TEXT NOT NULL, subject TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        FOREIGN KEY (provider, subject) REFERENCES social_accounts(provider, subject)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS local_credentials (
        login TEXT PRIMARY KEY, subject TEXT NOT NULL UNIQUE,
        salt TEXT NOT NULL, password_hash TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS invitations (
        id TEXT PRIMARY KEY, client_id TEXT NOT NULL REFERENCES users(id),
        recipient_provider TEXT NOT NULL, recipient_subject TEXT NOT NULL,
        recipient_handle TEXT NOT NULL, recipient_name TEXT NOT NULL,
        brief TEXT NOT NULL, amount INTEGER NOT NULL CHECK (amount > 0),
        visibility TEXT NOT NULL, nsfw INTEGER NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('pending', 'accepted', 'cancelled')),
        created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, deliver_by INTEGER NOT NULL,
        token_hash TEXT NOT NULL UNIQUE, cancelled_reason TEXT,
        request_id TEXT REFERENCES requests(id)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS oauth_flows (
        state_hash TEXT PRIMARY KEY, browser_hash TEXT NOT NULL UNIQUE,
        verifier TEXT NOT NULL, previous_session_hash TEXT, expires_at INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS auth_limits (
        bucket TEXT PRIMARY KEY, started_at INTEGER NOT NULL, attempts INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS registration_consents (
        user_id TEXT PRIMARY KEY REFERENCES users(id), version TEXT NOT NULL, accepted_at INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS invitation_submissions (
        actor_id TEXT NOT NULL REFERENCES users(id), key TEXT NOT NULL, fingerprint TEXT NOT NULL,
        invitation_id TEXT NOT NULL REFERENCES invitations(id), PRIMARY KEY (actor_id, key)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS invitations_client ON invitations(client_id, created_at);
      CREATE INDEX IF NOT EXISTS invitations_recipient ON invitations(recipient_provider, recipient_subject, state);
      CREATE TABLE IF NOT EXISTS invitation_commands (
        actor_id TEXT NOT NULL, scope TEXT NOT NULL, key TEXT NOT NULL, fingerprint TEXT NOT NULL,
        invitation_id TEXT NOT NULL REFERENCES invitations(id), PRIMARY KEY (actor_id, scope, key)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS invitation_events (
        id INTEGER PRIMARY KEY, invitation_id TEXT NOT NULL REFERENCES invitations(id),
        actor_id TEXT NOT NULL, action TEXT NOT NULL, at INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS invitation_preferences (
        provider TEXT NOT NULL, subject TEXT NOT NULL, blocked INTEGER NOT NULL CHECK (blocked IN (0, 1)),
        PRIMARY KEY (provider, subject)
      ) STRICT;
    `);
    // Existing account-addressed invitations keep their original access rules.
    this.transaction(() => {
      if (!this.db.prepare('PRAGMA table_info(invitations)').all().some((column) => column.name === 'access_mode')) {
        this.db.exec("ALTER TABLE invitations ADD COLUMN access_mode TEXT NOT NULL DEFAULT 'account' CHECK (access_mode IN ('account', 'link'))");
      }
    });
    this.transaction(() => {
      if (this.db.prepare('PRAGMA table_info(users)').all().some((column) => column.name === 'creator_enabled')) return;
      this.db.exec("ALTER TABLE users ADD COLUMN creator_enabled INTEGER NOT NULL DEFAULT 0 CHECK (creator_enabled IN (0, 1)); UPDATE users SET creator_enabled = 1 WHERE role = 'creator'");
    });
    this.transaction(() => {
      if (!this.db.prepare('PRAGMA table_info(requests)').all().some((column) => column.name === 'genre')) return;
      // Preserve retry keys when upgrading requests created with the old classification.
      const requests = this.db.prepare(`SELECT r.id, r.client_id AS clientId, r.creator_id AS creatorId,
        r.genre, r.brief, r.amount, r.visibility, r.nsfw, p.method AS paymentMethod
        FROM requests r JOIN payments p ON p.request_id = r.id`).all() as unknown as Array<
          Omit<RequestInput, 'nsfw' | 'agreeToRules'> & { id: string; clientId: string; genre: string; nsfw: number }
        >;
      const update = this.db.prepare(`UPDATE commands SET fingerprint = ?
        WHERE actor_id = ? AND scope = 'create' AND request_id = ? AND fingerprint = ?`);
      for (const { id, clientId, genre, nsfw, ...input } of requests) {
        const payload: RequestInput = { ...input, nsfw: Boolean(nsfw), agreeToRules: true };
        update.run(commandFingerprint(payload), clientId, id, commandFingerprint({ ...payload, genre }));
      }
      this.db.exec('ALTER TABLE requests DROP COLUMN genre');
    });
    const add = this.db.prepare('INSERT OR IGNORE INTO users (id, name, role, points) VALUES (?, ?, ?, ?)');
    add.run('demo-client', '青葉 / aoba', 'client', 50000);
    add.run('demo-creator', '凪 / nagi', 'creator', 0);
    add.run('other-client', '別の依頼者', 'client', 50000);
    add.run('other-creator', '別の作り手', 'creator', 0);
    this.db.prepare("UPDATE users SET creator_enabled = 1 WHERE id IN ('demo-creator', 'other-creator')").run();
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
      this.db.exec(depth === 0 ? 'ROLLBACK' : `ROLLBACK TO SAVEPOINT ${savepoint}; RELEASE SAVEPOINT ${savepoint}`);
      throw error;
    } finally {
      this.transactionDepth--;
    }
  }
  close() { this.db.close(); }
}
