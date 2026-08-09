import { pool } from '@gutter/db';

const [action, input] = process.argv.slice(2);
const email = input?.trim().toLowerCase();
if (!action || (action !== 'reset-bootstrap' && (!email || process.argv.length !== 4))) {
  console.error(
    'Usage: gutter-auth <revoke-sessions|disable-user|enable-user> <email> | reset-bootstrap',
  );
  process.exitCode = 2;
} else {
  if (action === 'revoke-sessions') {
    const result = await pool.query(
      'delete from "session" where "userId"=(select id from "user" where email=$1) returning id',
      [email],
    );
    console.log(`revoked_sessions=${result.rowCount ?? 0}`);
  } else if (action === 'disable-user' || action === 'enable-user') {
    const disabled = action === 'disable-user';
    const client = await pool.connect();
    try {
      await client.query('begin');
      const result = await client.query<{ id: string }>(
        'update "user" set banned=$1, "updatedAt"=now() where email=$2 returning id',
        [disabled, email],
      );
      if (disabled && result.rows[0])
        await client.query('delete from "session" where "userId"=$1', [result.rows[0].id]);
      await client.query('commit');
      console.log(`${disabled ? 'disabled' : 'enabled'}_users=${result.rowCount ?? 0}`);
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
  } else {
    const client = await pool.connect();
    try {
      const lock = await client.query<{ locked: boolean }>(
        "select pg_try_advisory_lock(hashtext('gutter_auth_bootstrap')) as locked",
      );
      const result = lock.rows[0]?.locked
        ? await client.query(
            'update gutter_auth_bootstrap set claimed_at=null where id=true and not exists (select 1 from "user") returning id',
          )
        : { rowCount: 0 };
      console.log(`bootstrap_reset=${result.rowCount === 1}`);
      if (lock.rows[0]?.locked)
        await client.query("select pg_advisory_unlock(hashtext('gutter_auth_bootstrap'))");
    } finally {
      client.release();
    }
  }
  await pool.end();
}
