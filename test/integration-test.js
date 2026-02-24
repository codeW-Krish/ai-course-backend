/**
 * Firebase Migration — Integration Test Script
 * Usage: node test/integration-test.js
 */

import admin from 'firebase-admin';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import dotenv from 'dotenv';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load .env
dotenv.config({ path: join(__dirname, '..', '.env') });

console.log('\n🔥 Firebase Migration — Integration Tests');
console.log('──────────────────────────────────────────');

// ─── Config ───────────────────────────────────────────────────
const BASE_URL = 'http://localhost:3030';
const TEST_EMAIL = `test_${Date.now()}@example.com`;
const TEST_PASSWORD = 'TestPass123!';
const TEST_USERNAME = 'test_user';
const FIREBASE_API_KEY = process.env.FIREBASE_API_KEY;

console.log(`📍 Server: ${BASE_URL}`);
console.log(`📧 Test user: ${TEST_EMAIL}`);
console.log(`🔑 API Key: ${FIREBASE_API_KEY ? '✅ Found (' + FIREBASE_API_KEY.substring(0, 8) + '...)' : '❌ MISSING'}`);

if (!FIREBASE_API_KEY) {
    console.error('\n❌ FIREBASE_API_KEY not found in .env');
    console.error('   Get it from: Firebase Console → Project Settings → Web API Key');
    process.exit(1);
}

// Initialize Firebase Admin (named instance to avoid conflict with server)
console.log('\n⏳ Initializing Firebase Admin SDK...');
let testApp, testAuth, testDb;
try {
    const serviceAccount = JSON.parse(
        readFileSync(join(__dirname, '..', 'cert', 'serviceAccountKey.json'), 'utf8')
    );
    testApp = admin.initializeApp(
        { credential: admin.credential.cert(serviceAccount) },
        'test-app-' + Date.now()
    );
    testAuth = testApp.auth();
    testDb = testApp.firestore();
    console.log('✅ Firebase Admin initialized (separate test instance)');
} catch (err) {
    console.error('❌ Firebase Admin init failed:', err.message);
    process.exit(1);
}

// ─── Counters ─────────────────────────────────────────────────
let passCount = 0;
let failCount = 0;
let skipCount = 0;

// ─── HTTP Helper ──────────────────────────────────────────────
async function req(method, path, body = null, token = null) {
    const url = `${BASE_URL}${path}`;
    console.log(`\n  📡 ${method} ${path}`);

    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token.substring(0, 20)}...`;

    const opts = { method, headers: { 'Content-Type': 'application/json' } };
    if (token) opts.headers['Authorization'] = `Bearer ${token}`;
    if (body) {
        opts.body = JSON.stringify(body);
        console.log(`     Body: ${JSON.stringify(body).substring(0, 100)}...`);
    }

    try {
        const res = await fetch(url, opts);
        let data;
        const contentType = res.headers.get('content-type');
        if (contentType && contentType.includes('application/json')) {
            data = await res.json();
        } else {
            data = await res.text();
        }
        console.log(`     Response: ${res.status} ${res.statusText}`);
        if (typeof data === 'object' && data !== null) {
            const preview = JSON.stringify(data).substring(0, 200);
            console.log(`     Data: ${preview}${preview.length >= 200 ? '...' : ''}`);
        }
        return { status: res.status, data };
    } catch (err) {
        console.log(`     ❌ Request failed: ${err.message}`);
        return { status: 0, data: null, error: err.message };
    }
}

async function getIdToken(customToken) {
    console.log('  🔄 Exchanging custom token for ID token...');
    const res = await fetch(
        `https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${FIREBASE_API_KEY}`,
        {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token: customToken, returnSecureToken: true }),
        }
    );
    const data = await res.json();
    if (data.error) {
        console.log(`  ❌ Token exchange failed: ${data.error.message}`);
        throw new Error(data.error.message);
    }
    console.log(`  ✅ Got ID token (${data.idToken.substring(0, 20)}...)`);
    return data.idToken;
}

// ─── State ────────────────────────────────────────────────────
let idToken = null;
let userId = null;
let courseId = null;

// ─── Main ─────────────────────────────────────────────────────
async function main() {

    // ═══════════ 0. HEALTH CHECK ═══════════
    console.log('\n═══════════════════════════════════════');
    console.log('  TEST 0: Health Check');
    console.log('═══════════════════════════════════════');
    try {
        const res = await fetch(`${BASE_URL}/`);
        const text = await res.text();
        console.log(`  Response: ${res.status} — ${text}`);
        if (res.status === 200) { passCount++; console.log('  ✅ PASS'); }
        else { failCount++; console.log('  ❌ FAIL'); }
    } catch (err) {
        failCount++;
        console.log(`  ❌ FAIL — Server not reachable: ${err.message}`);
        console.log('\n  ⚠️  Start the server first: npm run dev\n');
        process.exit(1);
    }

    // ═══════════ 1. REGISTER ═══════════
    console.log('\n═══════════════════════════════════════');
    console.log('  TEST 1: Register');
    console.log('═══════════════════════════════════════');
    try {
        const { status, data } = await req('POST', '/api/auth/register', {
            email: TEST_EMAIL, password: TEST_PASSWORD, username: TEST_USERNAME,
        });

        if (status === 201 && data?.user?.id) {
            userId = data.user.id;
            console.log(`  👤 Created user: ${userId}`);
            passCount++;
            console.log('  ✅ PASS');

            // Get ID token — auth controller returns field named "token"
            if (data.token) {
                idToken = await getIdToken(data.token);
            } else {
                console.log('  ⚠️  No customToken in response, creating manually...');
                const ct = await testAuth.createCustomToken(userId);
                idToken = await getIdToken(ct);
            }
        } else {
            failCount++;
            console.log('  ❌ FAIL');
        }
    } catch (err) {
        failCount++;
        console.log(`  ❌ FAIL — ${err.message}`);
    }

    // ═══════════ 2. LOGIN ═══════════
    console.log('\n═══════════════════════════════════════');
    console.log('  TEST 2: Login (verify token)');
    console.log('═══════════════════════════════════════');
    if (!idToken) { skipCount++; console.log('  ⏭️  SKIP — No token'); }
    else {
        const { status, data } = await req('POST', '/api/auth/login', {}, idToken);
        if (status === 200 && data?.user) { passCount++; console.log('  ✅ PASS'); }
        else { failCount++; console.log('  ❌ FAIL'); }
    }

    // ═══════════ 3. NO AUTH ═══════════
    console.log('\n═══════════════════════════════════════');
    console.log('  TEST 3: Protected route without token');
    console.log('═══════════════════════════════════════');
    {
        const { status } = await req('GET', '/api/courses/me');
        if (status === 401 || status === 403) { passCount++; console.log(`  ✅ PASS — Got ${status}`); }
        else { failCount++; console.log(`  ❌ FAIL — Expected 401/403, got ${status}`); }
    }

    // ═══════════ 4. PUBLIC COURSES ═══════════
    console.log('\n═══════════════════════════════════════');
    console.log('  TEST 4: Get Public Courses');
    console.log('═══════════════════════════════════════');
    {
        const { status, data } = await req('GET', '/api/courses');
        if (status === 200 && Array.isArray(data?.courses)) {
            passCount++; console.log(`  ✅ PASS — ${data.courses.length} public courses`);
        } else { failCount++; console.log('  ❌ FAIL'); }
    }

    // ═══════════ 5. MY COURSES ═══════════
    console.log('\n═══════════════════════════════════════');
    console.log('  TEST 5: Get My Courses');
    console.log('═══════════════════════════════════════');
    if (!idToken) { skipCount++; console.log('  ⏭️  SKIP'); }
    else {
        const { status, data } = await req('GET', '/api/courses/me', null, idToken);
        if (status === 200 && Array.isArray(data?.myCourses)) {
            passCount++; console.log(`  ✅ PASS — ${data.myCourses.length} courses`);
        } else { failCount++; console.log('  ❌ FAIL'); }
    }

    // ═══════════ 6. GENERATE OUTLINE ═══════════
    console.log('\n═══════════════════════════════════════');
    console.log('  TEST 6: Generate Course Outline (LLM)');
    console.log('  ⏳ This calls the LLM — may take 10-30s...');
    console.log('═══════════════════════════════════════');
    if (!idToken) { skipCount++; console.log('  ⏭️  SKIP'); }
    else {
        const { status, data } = await req('POST', '/api/courses/generate-outline', {
            title: 'Firebase Testing Course',
            description: 'A test course to verify Firebase migration',
            numUnits: 2,
            difficulty: 'Beginner',
            includeVideos: false,
            provider: 'Groq',
        }, idToken);

        if (status === 201 && data?.courseId) {
            courseId = data.courseId;
            passCount++;
            console.log(`  ✅ PASS — courseId: ${courseId}`);
        } else {
            failCount++;
            console.log('  ❌ FAIL');
        }
    }

    // ═══════════ 7. GET OUTLINE ═══════════
    console.log('\n═══════════════════════════════════════');
    console.log('  TEST 7: Get Course Outline');
    console.log('═══════════════════════════════════════');
    if (!courseId) { skipCount++; console.log('  ⏭️  SKIP — No courseId'); }
    else {
        const { status, data } = await req('GET', `/api/courses/${courseId}/getoutline`);
        if (status === 200) { passCount++; console.log('  ✅ PASS'); }
        else { failCount++; console.log('  ❌ FAIL'); }
    }

    // ═══════════ 8. FULL CONTENT ═══════════
    console.log('\n═══════════════════════════════════════');
    console.log('  TEST 8: Get Course Full Content');
    console.log('═══════════════════════════════════════');
    if (!courseId || !idToken) { skipCount++; console.log('  ⏭️  SKIP'); }
    else {
        const { status, data } = await req('GET', `/api/courses/${courseId}/full`, null, idToken);
        if (status === 200 && data?.course) { passCount++; console.log('  ✅ PASS'); }
        else { failCount++; console.log('  ❌ FAIL'); }
    }

    // ═══════════ 9. ENROLL ═══════════
    console.log('\n═══════════════════════════════════════');
    console.log('  TEST 9: Enroll in Course');
    console.log('═══════════════════════════════════════');
    if (!courseId || !idToken) { skipCount++; console.log('  ⏭️  SKIP'); }
    else {
        const { status } = await req('POST', `/api/courses/${courseId}/enroll`, {}, idToken);
        if (status === 200 || status === 409) { passCount++; console.log(`  ✅ PASS — Status ${status}`); }
        else { failCount++; console.log('  ❌ FAIL'); }
    }

    // ═══════════ 10. ENROLLED LIST ═══════════
    console.log('\n═══════════════════════════════════════');
    console.log('  TEST 10: Get Enrolled Courses');
    console.log('═══════════════════════════════════════');
    if (!idToken) { skipCount++; console.log('  ⏭️  SKIP'); }
    else {
        const { status, data } = await req('GET', '/api/courses/me/enrolled', null, idToken);
        if (status === 200 && Array.isArray(data?.enrolledCourses)) {
            passCount++; console.log(`  ✅ PASS — ${data.enrolledCourses.length} enrolled`);
        } else { failCount++; console.log('  ❌ FAIL'); }
    }

    // ═══════════ 11. SEARCH ═══════════
    console.log('\n═══════════════════════════════════════');
    console.log('  TEST 11: Search Courses');
    console.log('═══════════════════════════════════════');
    {
        const { status, data } = await req('GET', '/api/courses/search?query=Firebase');
        if (status === 200 && Array.isArray(data?.courses)) {
            passCount++; console.log(`  ✅ PASS — ${data.courses.length} results`);
        } else { failCount++; console.log('  ❌ FAIL'); }
    }

    // ═══════════ 12. GENERATION STATUS ═══════════
    console.log('\n═══════════════════════════════════════');
    console.log('  TEST 12: Generation Status');
    console.log('═══════════════════════════════════════');
    if (!courseId || !idToken) { skipCount++; console.log('  ⏭️  SKIP'); }
    else {
        const { status } = await req('GET', `/api/courses/${courseId}/generation-status`, null, idToken);
        if (status === 200 || status === 404) { passCount++; console.log('  ✅ PASS'); }
        else { failCount++; console.log('  ❌ FAIL'); }
    }

    // ═══════════ 13. PROGRESS ═══════════
    console.log('\n═══════════════════════════════════════');
    console.log('  TEST 13: Get Course Progress');
    console.log('═══════════════════════════════════════');
    if (!courseId || !idToken) { skipCount++; console.log('  ⏭️  SKIP'); }
    else {
        const { status, data } = await req('GET', `/api/courses/courses/${courseId}/progress`, null, idToken);
        if (status === 200) { passCount++; console.log('  ✅ PASS'); }
        else { failCount++; console.log('  ❌ FAIL'); }
    }

    // ═══════════ 14. SETTINGS ═══════════
    console.log('\n═══════════════════════════════════════');
    console.log('  TEST 14: Get Providers');
    console.log('═══════════════════════════════════════');
    {
        const { status } = await req('GET', '/api/settings/providers/available');
        if (status === 200) { passCount++; console.log('  ✅ PASS'); }
        else { failCount++; console.log('  ❌ FAIL'); }
    }

    // ═══════════ 15. DELETE ═══════════
    console.log('\n═══════════════════════════════════════');
    console.log('  TEST 15: Delete Course');
    console.log('═══════════════════════════════════════');
    if (!courseId || !idToken) { skipCount++; console.log('  ⏭️  SKIP'); }
    else {
        const { status } = await req('DELETE', `/api/courses/${courseId}`, null, idToken);
        if (status === 200) { passCount++; console.log('  ✅ PASS'); }
        else { failCount++; console.log('  ❌ FAIL'); }
    }

    // ═══════════ CLEANUP ═══════════
    console.log('\n═══════════════════════════════════════');
    console.log('  CLEANUP');
    console.log('═══════════════════════════════════════');
    if (userId) {
        try {
            console.log(`  🧹 Deleting test user ${TEST_EMAIL}...`);
            await testAuth.deleteUser(userId);
            await testDb.collection('users').doc(userId).delete().catch(() => { });
            console.log('  ✅ Test user deleted');
        } catch (err) {
            console.log(`  ⚠️  Cleanup failed: ${err.message}`);
        }
    }

    // ═══════════ SUMMARY ═══════════
    console.log('\n═══════════════════════════════════════');
    console.log(`  RESULTS: ✅ ${passCount} passed | ❌ ${failCount} failed | ⏭️  ${skipCount} skipped`);
    console.log('═══════════════════════════════════════\n');

    await testApp.delete();
    process.exit(failCount > 0 ? 1 : 0);
}

main().catch(err => {
    console.error('\n💀 FATAL ERROR:', err.message);
    console.error(err.stack);
    process.exit(1);
});
