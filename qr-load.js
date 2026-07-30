import http from "k6/http";
import { check, sleep } from "k6";
import { Counter } from "k6/metrics";

const ok = new Counter("ok_2xx");
const bizReject = new Counter("biz_4xx");
const authErr = new Counter("auth_401_403");

export const options = {
  stages: [
    { duration: "1m", target: 20 },
    { duration: "2m", target: 100 },
    { duration: "1m", target: 0 },
  ],
};

const BASE = __ENV.BASE_URL;
const TOKENS = (__ENV.JWT_TOKENS || "").split(",").map((s) => s.trim()).filter(Boolean);

export default function () {
  const token = TOKENS[__VU % TOKENS.length];
  const res = http.post(
    `${BASE}/api/exit-requests/create`,
    JSON.stringify({ reason: "Nagpur" }),
    { headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" } }
  );

  if (res.status >= 200 && res.status < 300) ok.add(1);
  else if (res.status === 401 || res.status === 403) authErr.add(1);
  else if (res.status >= 400 && res.status < 500) bizReject.add(1);

  check(res, { "responded": (r) => r.status > 0 });
  sleep(1);
}

