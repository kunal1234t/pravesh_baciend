'use strict';

/**
 * Faculty import script — writes directly to MySQL, bypassing HTTP entirely.
 * Run with:  node import_faculty.js
 */

const axios  = require('axios');
const mysql  = require('mysql2/promise');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

// Generates a 24-char lowercase alphanumeric document_id matching Strapi v5 format
function makeDocumentId() {
  return crypto.randomBytes(18).toString('base64')
    .toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 24).padEnd(24, '0');
}

// ─── Config ───────────────────────────────────────────────────────────────────
const FACULTY_API      = 'https://iiitn.ac.in/api/faculty/all_faculty_grouped_by_department';
const DEFAULT_PASSWORD = 'IIITNFaculty123!';
const TEACHER_ROLE_ID  = 3;   // adjust if your Teacher role has a different ID

const DB = {
  host:     '127.0.0.1',
  port:     3306,
  database: 'pravesh',
  user:     'root',
  password: 'iiitnBX248',
};
// ─────────────────────────────────────────────────────────────────────────────

async function fetchFaculty() {
  console.log('Fetching faculty from IIIT Nagpur API...');
  const { data } = await axios.get(FACULTY_API, { timeout: 15000 });
  const departments = (typeof data === 'object' && !Array.isArray(data)) ? data : {};
  const faculty = [];
  for (const members of Object.values(departments)) {
    if (Array.isArray(members)) faculty.push(...members);
  }
  console.log('Found ' + faculty.length + ' faculty members.\n');
  return faculty;
}

function extractPayload(person) {
  const email = (person.email || person.Email || person.email_id || person.emailId || '').trim().toLowerCase();
  const name  = (person.name  || person.Name  || person.faculty_name || person.fullName || '').trim();
  const phone = String(person.phone || person.Phone || person.phone_number || person.mobile || person.contact || '').replace(/\D/g, '');

  if (!email || !email.includes('@')) return null;

  return {
    username:     name ? name.toLowerCase().replace(/\s+/g, '.') : email.split('@')[0],
    email:        email,
    phone_number: phone ? phone.slice(0, 15) : null,   // keep as string for bigint safety
  };
}

async function importUsers(faculty) {
  const conn = await mysql.createConnection(DB);
  console.log('Connected to MySQL.\n');

  const hashedPassword = await bcrypt.hash(DEFAULT_PASSWORD, 10);
  const now = new Date();

  const results = { created: 0, skipped: 0, failed: 0 };
  const total   = faculty.length;

  for (let i = 0; i < total; i++) {
    const payload = extractPayload(faculty[i]);
    if (!payload) { results.skipped++; continue; }

    const idx = i + 1;
    try {
      // Check for existing user by email
      const [rows] = await conn.execute(
        'SELECT id FROM up_users WHERE email = ?',
        [payload.email]
      );

      if (rows.length > 0) {
        console.log('[' + idx + '/' + total + '] Skipped (exists): ' + payload.email);
        results.skipped++;
        continue;
      }

      // Insert user
      const [result] = await conn.execute(
        `INSERT INTO up_users
           (document_id, username, email, password, provider, confirmed, blocked,
            phone_number, created_at, updated_at, published_at)
         VALUES (?, ?, ?, ?, 'local', 1, 0, ?, ?, ?, ?)`,
        [makeDocumentId(), payload.username, payload.email, hashedPassword,
         payload.phone_number, now, now, now]
      );

      const userId = result.insertId;

      // Link to Teacher role
      await conn.execute(
        'INSERT INTO up_users_role_lnk (user_id, role_id) VALUES (?, ?)',
        [userId, TEACHER_ROLE_ID]
      );

      console.log('[' + idx + '/' + total + '] Created: ' + payload.email);
      results.created++;
    } catch (err) {
      console.error('[' + idx + '/' + total + '] Failed: ' + payload.email + ' -- ' + err.message);
      results.failed++;
    }
  }

  await conn.end();
  return results;
}

async function main() {
  const faculty = await fetchFaculty();
  const results = await importUsers(faculty);

  console.log('\n---------------------------------');
  console.log('Import Summary');
  console.log('  Created : ' + results.created);
  console.log('  Skipped : ' + results.skipped);
  console.log('  Failed  : ' + results.failed);
  console.log('---------------------------------');
}

main().catch(function(err) {
  console.error('Fatal error: ' + err.message);
  process.exit(1);
});
