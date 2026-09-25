import { DatabaseSync } from 'node:sqlite';
const path = process.argv[2];
if (!path) throw new Error('Usage: node scripts/payments-report.mjs <database>');
const db = new DatabaseSync(path, { readOnly: true });
try {
  console.log(
    JSON.stringify(
      {
        transfers: db
          .prepare(
            "SELECT t.request_id, t.state, t.amount, t.net_amount, t.error_code, t.checked_at FROM transfers t JOIN payments p ON p.request_id = t.request_id WHERE p.state = 'captured' AND t.state IN ('pending', 'held', 'recovery_pending')",
          )
          .all(),
        refunds: db
          .prepare(
            "SELECT id, link_id, amount, status, reason FROM adjustments WHERE kind = 'refund' AND status NOT IN ('succeeded', 'canceled')",
          )
          .all(),
        disputes: db
          .prepare(
            "SELECT id, link_id, amount, status, respond_by FROM adjustments WHERE kind = 'dispute' AND status NOT IN ('won', 'lost', 'warning_closed', 'prevented')",
          )
          .all(),
      },
      null,
      2,
    ),
  );
} finally {
  db.close();
}
