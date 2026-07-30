'use strict';

const mysql = require('mysql2/promise');

const DB = {
  host: process.env.DATABASE_HOST || '127.0.0.1',
  port: Number(process.env.DATABASE_PORT || 3306),
  database: process.env.DATABASE_NAME || 'pravesh',
  user: process.env.DATABASE_USERNAME || 'root',
  password: process.env.DATABASE_PASSWORD || '',
};

const EMAIL_PREFIX = process.env.EMAIL_PREFIX || 'loadtest.student';
const EMAIL_DOMAIN = process.env.EMAIL_DOMAIN || 'iiitn.ac.in';
const DRY_RUN = String(process.env.DRY_RUN || 'true').toLowerCase() !== 'false';

function inClause(ids) {
  return ids.map(() => '?').join(', ');
}

async function fetchIds(conn, sql, params) {
  const [rows] = await conn.execute(sql, params);
  return rows.map((r) => r.id);
}

async function main() {
  const emailLike = `${EMAIL_PREFIX}%@${EMAIL_DOMAIN}`;
  const conn = await mysql.createConnection(DB);
  console.log(`Connected to ${DB.host}:${DB.port}/${DB.database}`);
  console.log(`Target users: email LIKE "${emailLike}"`);
  console.log(`Mode: ${DRY_RUN ? 'DRY_RUN' : 'DELETE'}`);

  const userIds = await fetchIds(
    conn,
    'SELECT id FROM up_users WHERE email LIKE ?',
    [emailLike]
  );

  if (userIds.length === 0) {
    console.log('No matching test users found.');
    await conn.end();
    return;
  }

  console.log(`Matched users: ${userIds.length}`);

  const exitIds = await fetchIds(
    conn,
    `SELECT id FROM exit_requests WHERE student_id IN (${inClause(userIds)})`,
    userIds
  );
  const lateIds = await fetchIds(
    conn,
    `SELECT id FROM late_entry_requests WHERE users_permissions_user_id IN (${inClause(userIds)})`,
    userIds
  );

  console.log(`Related exit_requests: ${exitIds.length}`);
  console.log(`Related late_entry_requests: ${lateIds.length}`);

  if (DRY_RUN) {
    await conn.end();
    return;
  }

  await conn.beginTransaction();
  try {
    if (exitIds.length > 0) {
      await conn.execute(
        `DELETE FROM qr_tokens WHERE exit_requests_id IN (${inClause(exitIds)})`,
        exitIds
      );
    }

    if (lateIds.length > 0) {
      await conn.execute(
        `DELETE FROM qr_tokens WHERE token IN (
          SELECT qrToken FROM late_entry_requests WHERE id IN (${inClause(lateIds)})
        )`,
        lateIds
      );
    }

    await conn.execute(
      `DELETE FROM late_entry_requests WHERE users_permissions_user_id IN (${inClause(userIds)})`,
      userIds
    );
    await conn.execute(
      `DELETE FROM exit_requests WHERE student_id IN (${inClause(userIds)})`,
      userIds
    );
    await conn.execute(
      `DELETE FROM up_users_role_lnk WHERE user_id IN (${inClause(userIds)})`,
      userIds
    );
    await conn.execute(
      `DELETE FROM up_users WHERE id IN (${inClause(userIds)})`,
      userIds
    );

    await conn.commit();
    console.log('Cleanup committed successfully.');
  } catch (err) {
    await conn.rollback();
    console.error(`Cleanup rolled back: ${err.message}`);
    process.exitCode = 1;
  } finally {
    await conn.end();
  }
}

main().catch((err) => {
  console.error(`Fatal: ${err.message}`);
  process.exit(1);
});

