export const settlementTables = `
  CREATE UNIQUE INDEX payments_charge ON payments(charge_id);
  CREATE INDEX payments_reconciliation ON payments(provider, state, checked_at);
  CREATE TABLE adjustments (
    id TEXT PRIMARY KEY, link_id TEXT NOT NULL REFERENCES payments(link_id),
    kind TEXT NOT NULL CHECK (kind IN ('refund', 'dispute')),
    amount INTEGER NOT NULL CHECK (amount > 0), status TEXT NOT NULL,
    reason TEXT, respond_by INTEGER, updated_at INTEGER NOT NULL
  ) STRICT;
  CREATE INDEX adjustments_payment ON adjustments(link_id);
  CREATE TABLE transfers (
    request_id TEXT PRIMARY KEY REFERENCES requests(id),
    recipient_id TEXT NOT NULL REFERENCES recipients(id), account_id TEXT NOT NULL,
    amount INTEGER NOT NULL CHECK (amount > 0),
    state TEXT NOT NULL CHECK (state IN ('pending', 'transferred', 'held', 'recovery_pending', 'recovered')),
    net_amount INTEGER NOT NULL DEFAULT 0 CHECK (net_amount >= 0),
    checked_at INTEGER NOT NULL DEFAULT 0, retry_at INTEGER NOT NULL DEFAULT 0,
    error_code TEXT
  ) STRICT;
  CREATE TABLE transfer_operations (
    id TEXT PRIMARY KEY, request_id TEXT NOT NULL REFERENCES transfers(request_id),
    kind TEXT NOT NULL CHECK (kind IN ('transfer', 'reversal')),
    amount INTEGER NOT NULL CHECK (amount > 0), source_id TEXT,
    provider_id TEXT UNIQUE, status TEXT NOT NULL CHECK (status IN ('pending', 'complete', 'failed')),
    created_at INTEGER NOT NULL
  ) STRICT;
  CREATE UNIQUE INDEX transfer_operations_pending ON transfer_operations(request_id) WHERE status = 'pending';
  CREATE INDEX transfers_reconciliation ON transfers(retry_at, checked_at);
  CREATE TABLE instance (
    id INTEGER PRIMARY KEY CHECK (id = 1), payment_mode TEXT NOT NULL,
    stripe_account TEXT NOT NULL, auth_key TEXT NOT NULL
  ) STRICT;
`;

/** Applied once, by the offline migration, before starting this version. */
export const settlementSchema = `
  ALTER TABLE payments ADD COLUMN charge_id TEXT;
  ALTER TABLE transfers RENAME TO old_transfers;
  ${settlementTables}
  INSERT INTO transfers (request_id, recipient_id, account_id, amount, state, net_amount, checked_at)
    SELECT request_id, recipient_id, account_id, amount, state,
      CASE WHEN state = 'transferred' THEN amount ELSE 0 END, checked_at FROM old_transfers;
  INSERT INTO transfer_operations
    SELECT 'initial:' || request_id, request_id, 'transfer', amount, NULL,
      transfer_id, 'complete', 0 FROM old_transfers WHERE transfer_id IS NOT NULL;
  DROP TABLE old_transfers;
`;
