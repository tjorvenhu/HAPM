// Kleiner Client für die Prüfung: meldet sich an und ruft Routen von HAPM auf.
//   node api.mjs <METHODE> <pfad> [json]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = process.env.HAPM_URL || 'http://localhost:7080';
const STATE = path.join(path.dirname(fileURLToPath(import.meta.url)), '.session.json');
const EMAIL = process.env.HAPM_EMAIL || 'admin@hapmtest.example';
const PASSWORD = process.env.HAPM_PASSWORD || 'Geheim-Passwort-2026';

async function login() {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`Anmeldung: ${res.status} ${JSON.stringify(body)}`);
  const cookie = res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  const state = { cookie, csrf: body.data.csrfToken };
  fs.writeFileSync(STATE, JSON.stringify(state));
  return state;
}

async function call(method, route, payload, retry = true) {
  let state;
  try {
    state = JSON.parse(fs.readFileSync(STATE, 'utf8'));
  } catch {
    state = await login();
  }
  const res = await fetch(`${BASE}${route}`, {
    method,
    headers: {
      Cookie: state.cookie,
      'X-CSRF-Token': state.csrf,
      ...(payload ? { 'Content-Type': 'application/json' } : {}),
    },
    body: payload ? JSON.stringify(payload) : undefined,
  });
  if (res.status === 401 && retry) {
    fs.rmSync(STATE, { force: true });
    return call(method, route, payload, false);
  }
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text.slice(0, 500);
  }
  return { status: res.status, body };
}

const [method, route, json] = process.argv.slice(2);
const result = await call(method, route, json ? JSON.parse(json) : undefined);
const limit = Number(process.env.LIMIT || 3000);
console.log(result.status, JSON.stringify(result.body, null, 1).slice(0, limit));
