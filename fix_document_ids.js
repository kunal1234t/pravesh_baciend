'use strict';

/**
 * One-time fix: assigns document_id and published_at to any up_users rows
 * that were inserted without them (causing Strapi v5 query errors).
 * Run with:  node fix_document_ids.js
 */

const mysql  = require('mysql2/promise');
const crypto = require('crypto');

const DB = {
  host:     '127.0.0.1',
  port:     3306,
  database: 'pravesh',
  user:     'root',
  password: 'iiitnBX248',
};

function makeDocumentId() {
  return crypto.randomBytes(18).toString('base64')
    .toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 24).padEnd(24, '0');
}

async function main() {
  const conn = await mysql.createConnection(DB);
  console.log('Connected to MySQL.');

  const [rows] = await conn.execute(
    'SELECT id FROM up_users WHERE document_id IS NULL OR document_id = ""'
  );

  console.log('Found ' + rows.length + ' users missing document_id.\n');

  const now = new Date();
  let fixed = 0;

  for (const row of rows) {
    await conn.execute(
      'UPDATE up_users SET document_id = ?, published_at = ? WHERE id = ?',
      [makeDocumentId(), now, row.id]
    );
    fixed++;
  }

  await conn.end();
  console.log('Fixed ' + fixed + ' users.');
}

main().catch(function(err) {
  console.error('Fatal error: ' + err.message);
  process.exit(1);
});
