import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/server/store.js';

test('移行前のバックアップを保存し、既存の送金額とStripeの識別子を引き継ぐ', () => {
  const directory = mkdtempSync(join(tmpdir(), 'favor-migration-'));
  const path = join(directory, 'app.sqlite');
  const old = new DatabaseSync(path);
  old.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE requests (id TEXT PRIMARY KEY) STRICT;
    CREATE TABLE recipients (id TEXT PRIMARY KEY, provider TEXT NOT NULL) STRICT;
    CREATE TABLE payments (link_id TEXT PRIMARY KEY, request_id TEXT REFERENCES requests(id), provider TEXT NOT NULL, state TEXT NOT NULL, amount INTEGER NOT NULL, checked_at INTEGER NOT NULL) STRICT;
    CREATE TABLE transfers (request_id TEXT PRIMARY KEY REFERENCES requests(id), recipient_id TEXT NOT NULL REFERENCES recipients(id), account_id TEXT NOT NULL, amount INTEGER NOT NULL, state TEXT NOT NULL, transfer_id TEXT UNIQUE, checked_at INTEGER NOT NULL DEFAULT 0) STRICT;
    INSERT INTO requests VALUES ('delivered'), ('waiting');
    INSERT INTO recipients VALUES ('recipient', 'stripe_test');
    INSERT INTO payments VALUES ('link_delivered', 'delivered', 'stripe_test', 'captured', 12000, 1), ('link_waiting', 'waiting', 'stripe_test', 'captured', 12000, 2);
    INSERT INTO transfers VALUES ('delivered', 'recipient', 'acct_recipient', 11040, 'transferred', 'tr_confirmed', 100), ('waiting', 'recipient', 'acct_recipient', 11040, 'pending', NULL, 200);
    PRAGMA user_version = 9;
  `);
  old.close();
  try {
    execFileSync(process.execPath, ['scripts/migrate-v10.mjs', path], { stdio: 'pipe' });
    const store = new Store(path);
    try {
      assert.deepEqual(
        store.db
          .prepare('SELECT state, net_amount FROM transfers ORDER BY request_id')
          .all()
          .map((row) => ({ ...row })),
        [
          { state: 'transferred', net_amount: 11040 },
          { state: 'pending', net_amount: 0 },
        ],
      );
      assert.equal(
        store.db
          .prepare("SELECT provider_id FROM transfer_operations WHERE request_id = 'delivered'")
          .get()!.provider_id,
        'tr_confirmed',
      );
      assert.deepEqual(store.db.prepare('PRAGMA foreign_key_check').all(), []);
    } finally {
      store.close();
    }
    const backupFile = readdirSync(directory).find((file) => file.includes('.v9.'))!;
    assert.ok(backupFile);
    assert.equal(statSync(join(directory, backupFile)).mode & 0o777, 0o600);
    const backup = new DatabaseSync(join(directory, backupFile), { readOnly: true });
    try {
      assert.equal(backup.prepare('PRAGMA user_version').get()!.user_version, 9);
      assert.equal(
        backup.prepare("SELECT transfer_id FROM transfers WHERE request_id = 'delivered'").get()!
          .transfer_id,
        'tr_confirmed',
      );
    } finally {
      backup.close();
    }
    const report = JSON.parse(
      execFileSync(process.execPath, ['scripts/payments-report.mjs', path], {
        encoding: 'utf8',
        stdio: 'pipe',
      }),
    );
    assert.equal(report.transfers[0].request_id, 'waiting');
    assert.equal(report.transfers[0].net_amount, 0);
  } finally {
    rmSync(directory, { recursive: true });
  }
});
