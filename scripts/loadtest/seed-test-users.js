'use strict';

const fs = require('fs');
const path = require('path');
const axios = require('axios');

const BASE_URL = process.env.BASE_URL || 'http://localhost:1337';
const USER_COUNT = Number(process.env.USER_COUNT || 200);
const EMAIL_PREFIX = process.env.EMAIL_PREFIX || 'loadtest.student';
const EMAIL_DOMAIN = process.env.EMAIL_DOMAIN || 'iiitn.ac.in';
const DEFAULT_PASSWORD = process.env.DEFAULT_PASSWORD || 'LoadTest@123';
const DEVICE_PREFIX = process.env.DEVICE_PREFIX || 'loadtest-device';
const OUTPUT_FILE = process.env.OUTPUT_FILE || path.join(__dirname, 'test-users.json');

function buildUser(i) {
  const n = String(i + 1).padStart(4, '0');
  const email = `${EMAIL_PREFIX}${n}@${EMAIL_DOMAIN}`;
  return {
    index: i + 1,
    username: `loadtest_student_${n}`,
    email,
    password: DEFAULT_PASSWORD,
    phone_number: `90000${String(i + 1).padStart(5, '0')}`,
    deviceID: `${DEVICE_PREFIX}-${n}`,
  };
}

async function registerOrLogin(user) {
  const registerPayload = {
    username: user.username,
    email: user.email,
    password: user.password,
    phone_number: user.phone_number,
    deviceID: user.deviceID,
  };

  try {
    const reg = await axios.post(`${BASE_URL}/api/custom-register`, registerPayload, {
      timeout: 15000,
      headers: { 'Content-Type': 'application/json' },
      validateStatus: () => true,
    });

    if (reg.status === 200 || reg.status === 201) {
      return { status: 'created' };
    }
  } catch (_) {
    // Fallback to login path below.
  }

  const loginPayload = {
    identifier: user.email,
    password: user.password,
    deviceID: user.deviceID,
  };

  const login = await axios.post(`${BASE_URL}/api/auth/local`, loginPayload, {
    timeout: 15000,
    headers: { 'Content-Type': 'application/json' },
    validateStatus: () => true,
  });

  if (login.status === 200 || login.status === 201) {
    return { status: 'existing' };
  }

  const message =
    login.data?.error?.message ||
    login.data?.message ||
    `HTTP ${login.status}`;
  throw new Error(message);
}

async function main() {
  console.log(`Seeding ${USER_COUNT} load-test users at ${BASE_URL} ...`);

  const users = Array.from({ length: USER_COUNT }, (_, i) => buildUser(i));
  let created = 0;
  let existing = 0;
  let failed = 0;
  const successfulUsers = [];

  for (const user of users) {
    try {
      const result = await registerOrLogin(user);
      if (result.status === 'created') created++;
      else existing++;
      successfulUsers.push(user);
      console.log(`✅ [${user.index}/${USER_COUNT}] ${result.status}: ${user.email}`);
    } catch (err) {
      failed++;
      console.log(`❌ [${user.index}/${USER_COUNT}] failed: ${user.email} | ${err.message}`);
    }
  }

  fs.mkdirSync(path.dirname(OUTPUT_FILE), { recursive: true });
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(successfulUsers, null, 2), 'utf8');

  console.log('\n--- Seed Summary ---');
  console.log(`Created:  ${created}`);
  console.log(`Existing: ${existing}`);
  console.log(`Failed:   ${failed}`);
  console.log(`Saved credentials: ${OUTPUT_FILE}`);

  if (failed > 0) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(`Fatal: ${err.message}`);
  process.exit(1);
});

