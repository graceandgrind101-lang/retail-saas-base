import type { Sql } from "postgres";

/** Defeat the audit protections the way a database administrator could, then put them back. */
export async function asRogueDba<T>(admin: Sql, fn: () => Promise<T>): Promise<T> {
  await admin.unsafe("grant update, delete, truncate on audit.log to current_user");
  await admin.unsafe("alter table audit.log disable trigger audit_log_immutable_rows");
  try {
    return await fn();
  } finally {
    await admin.unsafe("alter table audit.log enable trigger audit_log_immutable_rows");
    await admin.unsafe("revoke update, delete, truncate on audit.log from current_user");
  }
}

/**
 * The perfect forgery: change one entry's `label` and recompute every hash from there to the
 * end, so the chain still verifies on its own. Only an anchor taken earlier can expose it.
 * `tenant` is a UUID made by our own code, never user input.
 */
export async function rewriteHistoryFrom(admin: Sql, tenant: string, seq: number): Promise<void> {
  await asRogueDba(admin, async () => {
    await admin.unsafe(`
      do $$
      declare r audit.log%rowtype; v_prev text; v_after jsonb;
      begin
        select hash into v_prev from audit.log where tenant_id = '${tenant}' and seq = ${seq - 1};
        if not found then v_prev := audit.genesis_hash('${tenant}'); end if;
        for r in select * from audit.log where tenant_id = '${tenant}' and seq >= ${seq} order by seq loop
          v_after := case when r.seq = ${seq} then jsonb_set(r.after_data, '{label}', '"forged"') else r.after_data end;
          update audit.log set prev_hash = v_prev, after_data = v_after,
            hash = audit.compute_hash(v_prev, r.tenant_id, r.seq, r.occurred_at, r.event_key, r.actor_kind,
                     r.actor_id, r.impersonator_id, r.session_id, r.device_id, r.pin_verification_id,
                     r.table_name, r.row_id, r.before_data, v_after, r.txid, r.device_at)
          where tenant_id = r.tenant_id and seq = r.seq
          returning hash into v_prev;
        end loop;
      end $$`);
  });
}
