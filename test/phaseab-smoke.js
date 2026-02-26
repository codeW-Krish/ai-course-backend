import admin from 'firebase-admin';
import { readFileSync } from 'fs';
import { join } from 'path';

const BASE = 'http://localhost:3030';
const API_KEY = process.env.FIREBASE_API_KEY;

if (!API_KEY) {
  console.error('Missing FIREBASE_API_KEY');
  process.exit(1);
}

const sa = JSON.parse(readFileSync(join(process.cwd(), 'cert', 'serviceAccountKey.json'), 'utf8'));
const app = admin.initializeApp({ credential: admin.credential.cert(sa) }, 'phaseab-' + Date.now());
const auth = app.auth();
const db = app.firestore();

const email = `phaseab_${Date.now()}@example.com`;
const password = 'TestPass123!';
const username = `phaseab_user_${Date.now()}`;
let idToken = '';
let userId = '';
let courseId = '';

async function api(path, opts = {}) {
  const res = await fetch(`${BASE}${path}`, opts);
  const ct = res.headers.get('content-type') || '';
  const data = ct.includes('application/json') ? await res.json() : await res.text();
  return { res, data };
}

async function exchangeCustomToken(customToken) {
  const ex = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${API_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: customToken, returnSecureToken: true }),
  });
  const exd = await ex.json();
  if (!exd.idToken) throw new Error(`token exchange failed: ${JSON.stringify(exd)}`);
  return exd.idToken;
}

try {
  console.log('1) Register');
  const reg = await api('/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, username }),
  });
  if (reg.res.status !== 201) throw new Error(`register failed ${reg.res.status} ${JSON.stringify(reg.data)}`);

  userId = reg.data.user.id;
  idToken = await exchangeCustomToken(reg.data.token);
  const H = { Authorization: `Bearer ${idToken}`, 'Content-Type': 'application/json' };

  console.log('2) Phase B endpoints');
  for (const [label, path, method, body] of [
    ['gamification me', '/api/gamification/me', 'GET', null],
    ['gamification ping', '/api/gamification/activity/ping', 'POST', { activity_type: 'manual_check' }],
    ['analytics summary', '/api/analytics/summary', 'GET', null],
    ['analytics weekly', '/api/analytics/weekly', 'GET', null],
  ]) {
    const r = await api(path, {
      method,
      headers: H,
      body: body ? JSON.stringify(body) : undefined,
    });
    console.log(`  - ${label}: ${r.res.status}`);
    if (r.res.status !== 200) throw new Error(`${label} failed ${r.res.status} ${JSON.stringify(r.data)}`);
  }

  console.log('3) Create tiny course for course-level endpoints');
  const outline = await api('/api/courses/generate-outline', {
    method: 'POST',
    headers: H,
    body: JSON.stringify({
      title: 'PhaseAB Test Course',
      description: 'Course for phase A/B endpoint test',
      numUnits: 1,
      difficulty: 'Beginner',
      includeVideos: false,
      provider: 'Groq',
    }),
  });
  if (outline.res.status !== 201) throw new Error(`outline failed ${outline.res.status} ${JSON.stringify(outline.data)}`);

  courseId = outline.data.courseId;

  const gen = await api(`/api/courses/${courseId}/generate-content`, {
    method: 'POST',
    headers: H,
    body: JSON.stringify({ provider: 'Groq' }),
  });
  if (gen.res.status !== 200) throw new Error(`content gen failed ${gen.res.status} ${JSON.stringify(gen.data)}`);

  const full = await api(`/api/courses/${courseId}/full`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${idToken}` },
  });
  if (full.res.status !== 200) throw new Error(`full course failed ${full.res.status}`);

  let subtopicId = '';
  for (const unit of full.data.units || []) {
    for (const subtopic of unit.subtopics || []) {
      if (subtopic.content) {
        subtopicId = subtopic.id;
        break;
      }
    }
    if (subtopicId) break;
  }
  if (!subtopicId) throw new Error('no subtopic with content found');

  console.log('4) Phase A + course analytics endpoints');
  for (const [label, path, method, body] of [
    ['analytics course', `/api/analytics/course/${courseId}`, 'GET', null],
    ['course ai chat', `/api/interactive/course/${courseId}/chat`, 'POST', { message: 'Explain key idea shortly', provider: 'Groq' }],
    ['course practice', `/api/interactive/course/${courseId}/practice`, 'POST', { focus: 'basics', provider: 'Groq' }],
    ['audio stream', `/api/audio/${subtopicId}/stream`, 'GET', null],
    ['audio download', `/api/audio/${subtopicId}/download`, 'GET', null],
  ]) {
    const r = await api(path, {
      method,
      headers: method === 'GET'
        ? { Authorization: `Bearer ${idToken}` }
        : { Authorization: `Bearer ${idToken}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    console.log(`  - ${label}: ${r.res.status}`);
    if (r.res.status !== 200 && r.res.status !== 201) {
      const text = typeof r.data === 'string' ? r.data.slice(0, 200) : JSON.stringify(r.data).slice(0, 200);
      throw new Error(`${label} failed ${r.res.status} ${text}`);
    }
  }

  console.log('\n✅ Phase A+B targeted smoke passed');
} catch (e) {
  console.error('\n❌ Targeted smoke failed:', e.message);
} finally {
  try {
    if (courseId && idToken) {
      await fetch(`${BASE}/api/courses/${courseId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${idToken}` },
      }).catch(() => {});
    }

    if (userId) {
      await auth.deleteUser(userId).catch(() => {});
      await db.collection('users').doc(userId).delete().catch(() => {});
    }
  } catch {}

  await app.delete().catch(() => {});
}
