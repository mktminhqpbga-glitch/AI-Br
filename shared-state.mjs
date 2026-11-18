import { randomUUID } from "node:crypto";
import pg from "pg";

// One namespace represents one service role. A new runtime claims the role
// during startup, which fences writes from a superseded Render instance.
export async function openSharedState(connectionString, namespace, onFault) {
  const url = new URL(connectionString);
  if (!["postgres:", "postgresql:"].includes(url.protocol) || !/^[a-zA-Z0-9_.:-]{1,120}$/.test(namespace)) {
    throw new Error("Configure the PostgreSQL URL and AI Bridge state namespace.");
  }
  // Preserve certificate verification even when a provider's URL contains
  // sslmode=require or client-specific SSL query options.
  for (const key of [...url.searchParams.keys()]) {
    if (key.startsWith("ssl")) url.searchParams.delete(key);
  }
  const pool = new pg.Pool({
    connectionString: url.toString(), ssl: { rejectUnauthorized: true },
    max: 1, connectionTimeoutMillis: 8_000, statement_timeout: 12_000,
  });
  pool.on("error", () => {
    // Idle connections can be dropped by a serverless database. The next
    // operation will obtain a replacement connection and recheck the fence.
  });
  const owner = randomUUID();
  const initial = new Map();
  let client;
  try {
    client = await pool.connect();
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(945032117)");
    await client.query(`
      CREATE TABLE IF NOT EXISTS aibr_state_owners (namespace text PRIMARY KEY, owner uuid NOT NULL);
      CREATE TABLE IF NOT EXISTS aibr_state_records (
        namespace text NOT NULL, key text NOT NULL, value jsonb NOT NULL, PRIMARY KEY (namespace, key)
      );
    `);
    await client.query(`
      INSERT INTO aibr_state_owners (namespace, owner) VALUES ($1, $2)
      ON CONFLICT (namespace) DO UPDATE SET owner = EXCLUDED.owner
    `, [namespace, owner]);
    const result = await client.query("SELECT key, value FROM aibr_state_records WHERE namespace = $1", [namespace]);
    for (const row of result.rows) initial.set(row.key, row.value);
    await client.query("COMMIT");
  } catch {
    try { await client?.query("ROLLBACK"); } catch {}
    client?.release(true);
    await pool.end();
    throw new Error("Unable to open shared AI Bridge database state.");
  }
  client.release();

  let pending = new Map();
  let tail = Promise.resolve();
  let timer;
  let fault;

  function fail(superseded = false) {
    if (!fault) {
      fault = superseded
        ? new Error("This AI Bridge runtime was replaced.")
        : new Error("The shared AI Bridge database is unavailable.");
      fault.code = superseded ? "STATE_SUPERSEDED" : "STATE_UNAVAILABLE";
      onFault?.(fault);
    }
    return fault;
  }

  function flush() {
    if (fault) return Promise.reject(fault);
    if (!pending.size) return tail;
    const batch = [...pending];
    pending = new Map();
    tail = tail.then(async () => {
      const rows = batch.filter(([, value]) => value != null).map(([key, value]) => ({ key, value }));
      const deleted = batch.filter(([, value]) => value == null).map(([key]) => key);
      const result = await pool.query(`
        WITH leader AS MATERIALIZED (
          SELECT namespace FROM aibr_state_owners WHERE namespace = $1 AND owner = $2 FOR UPDATE
        ), saved AS (
          INSERT INTO aibr_state_records (namespace, key, value)
          SELECT leader.namespace, record.key, record.value
          FROM leader CROSS JOIN jsonb_to_recordset($3::jsonb) AS record(key text, value jsonb)
          ON CONFLICT (namespace, key) DO UPDATE SET value = EXCLUDED.value RETURNING key
        ), removed AS (
          DELETE FROM aibr_state_records WHERE namespace IN (SELECT namespace FROM leader)
          AND key = ANY($4::text[]) RETURNING key
        )
        SELECT EXISTS(SELECT 1 FROM leader) AS active,
          (SELECT count(*) FROM saved) + (SELECT count(*) FROM removed) AS written
      `, [namespace, owner, JSON.stringify(rows), deleted]);
      if (!result.rows[0]?.active) throw fail(true);
    }).catch(() => { throw fail(); });
    // Some producers only queue a write. The next I/O barrier still observes
    // a failure and can refuse to send an acknowledgment or dispatch a job.
    tail.catch(() => {});
    return tail;
  }

  function write(key, value) {
    if (fault) throw fault;
    pending.set(key, value);
    timer ??= setImmediate(() => {
      timer = undefined;
      flush().catch(() => {});
    });
  }

  async function verify() {
    await flush();
    try {
      const { rows } = await pool.query("SELECT 1 FROM aibr_state_owners WHERE namespace = $1 AND owner = $2", [namespace, owner]);
      if (!rows.length) throw fail(true);
    } catch { throw fail(); }
  }

  return {
    initial, write, flush, verify,
    get faultCode() { return fault?.code; },
    async close() {
      clearImmediate(timer);
      try { await flush(); } finally { await pool.end(); }
    },
  };
}

export function namespaceFor(env, role) {
  const base = env.BRIDGE_STATE_NAMESPACE ?? env.RENDER_SERVICE_ID;
  if (!base) throw new Error("Configure BRIDGE_STATE_NAMESPACE outside Render.");
  return role + ":" + base;
}
