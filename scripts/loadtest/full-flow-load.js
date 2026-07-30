import http from 'k6/http';
import { check } from 'k6';
import { SharedArray } from 'k6/data';
import exec from 'k6/execution';
import { Counter, Trend } from 'k6/metrics';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:1337';
const USERS_FILE = __ENV.USERS_FILE || './scripts/loadtest/test-users.json';
const GATE_API_KEY = __ENV.GATE_API_KEY || '';
const REASON = __ENV.EXIT_REASON || 'Nagpur';
const VUS = Number(__ENV.VUS || 200);

const users = new SharedArray('users', function () {
  return JSON.parse(open(USERS_FILE));
});

const successFlow = new Counter('flow_success');
const failLogin = new Counter('fail_login');
const failExitCreate = new Counter('fail_exit_create');
const failExitValidate = new Counter('fail_exit_validate');
const failEntryCreate = new Counter('fail_entry_create');
const failEntryValidate = new Counter('fail_entry_validate');

const tLogin = new Trend('t_login');
const tExitCreate = new Trend('t_exit_create');
const tExitValidate = new Trend('t_exit_validate');
const tEntryCreate = new Trend('t_entry_create');
const tEntryValidate = new Trend('t_entry_validate');

export const options = {
  scenarios: {
    full_flow_once_per_user: {
      executor: 'shared-iterations',
      vus: VUS,
      iterations: users.length,
      maxDuration: __ENV.MAX_DURATION || '20m',
    },
  },
  thresholds: {
    checks: ['rate>0.99'],
    http_req_failed: ['rate<0.02'],
  },
};

function postJson(url, body, headers = {}) {
  return http.post(url, JSON.stringify(body), {
    headers: { 'Content-Type': 'application/json', ...headers },
    timeout: '30s',
  });
}

function extractQrToken(responseJson) {
  const qr = responseJson?.qr;
  if (typeof qr === 'string') return qr;
  if (qr && typeof qr === 'object' && typeof qr.t === 'string') return qr.t;
  return null;
}

export default function () {
  const idx = exec.scenario.iterationInTest;
  const user = users[idx];

  if (!user || !user.email || !user.password) {
    check(null, { 'user payload exists': () => false });
    return;
  }

  const loginRes = postJson(`${BASE_URL}/api/auth/local`, {
    identifier: user.email,
    password: user.password,
    deviceID: user.deviceID || `loadtest-device-${idx + 1}`,
  });
  tLogin.add(loginRes.timings.duration);

  const loginOk = check(loginRes, {
    'login 200': (r) => r.status === 200,
  });
  if (!loginOk) {
    failLogin.add(1);
    return;
  }

  const loginData = loginRes.json();
  const jwt = loginData?.jwt;
  if (!jwt) {
    failLogin.add(1);
    return;
  }
  const authHeaders = { Authorization: `Bearer ${jwt}` };

  const exitCreateRes = postJson(
    `${BASE_URL}/api/exit-requests/create`,
    { reason: REASON },
    authHeaders
  );
  tExitCreate.add(exitCreateRes.timings.duration);

  const exitCreateOk = check(exitCreateRes, {
    'exit create 200/201': (r) => r.status === 200 || r.status === 201,
  });
  if (!exitCreateOk) {
    failExitCreate.add(1);
    return;
  }
  const exitToken = extractQrToken(exitCreateRes.json());
  if (!exitToken) {
    failExitCreate.add(1);
    return;
  }

  const gateHeaders = GATE_API_KEY ? { 'x-gate-api-key': GATE_API_KEY } : {};
  const exitValidateRes = postJson(
    `${BASE_URL}/api/qr-token/validate`,
    { token: exitToken },
    gateHeaders
  );
  tExitValidate.add(exitValidateRes.timings.duration);

  const exitValidateOk = check(exitValidateRes, {
    'exit validate 200 + allowed': (r) =>
      r.status === 200 && r.json('allowed') === true && r.json('action') === 'exit',
  });
  if (!exitValidateOk) {
    failExitValidate.add(1);
    return;
  }

  const entryCreateRes = postJson(
    `${BASE_URL}/api/exit-requests/entry`,
    {},
    authHeaders
  );
  tEntryCreate.add(entryCreateRes.timings.duration);

  const entryCreateOk = check(entryCreateRes, {
    'entry create 200/201': (r) => r.status === 200 || r.status === 201,
  });
  if (!entryCreateOk) {
    failEntryCreate.add(1);
    return;
  }
  const entryToken = extractQrToken(entryCreateRes.json());
  if (!entryToken) {
    failEntryCreate.add(1);
    return;
  }

  const entryValidateRes = postJson(
    `${BASE_URL}/api/qr-token/validate`,
    { token: entryToken },
    gateHeaders
  );
  tEntryValidate.add(entryValidateRes.timings.duration);

  const entryValidateOk = check(entryValidateRes, {
    'entry validate 200 + allowed': (r) =>
      r.status === 200 && r.json('allowed') === true && r.json('action') === 'entry',
  });
  if (!entryValidateOk) {
    failEntryValidate.add(1);
    return;
  }

  successFlow.add(1);
}

