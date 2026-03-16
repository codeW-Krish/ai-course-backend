import axios from 'axios';
import admin from 'firebase-admin';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import dotenv from 'dotenv';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
dotenv.config({ path: join(__dirname, '..', '.env') });

// Config
const BASE_URL = 'http://localhost:3030';
const FIREBASE_API_KEY = process.env.FIREBASE_API_KEY;
const TEST_EMAIL = 'audio_persistent_tester@example.com';
const COURSE_TITLE = 'Audio Test Course — Deep Dive';

// Initialize Firebase Admin
const sa = JSON.parse(readFileSync(join(__dirname, '..', 'cert', 'serviceAccountKey.json'), 'utf8'));
if (!admin.apps.length) {
    admin.initializeApp({ credential: admin.credential.cert(sa) });
}
const db = admin.firestore();
const auth = admin.auth();

async function getIdToken(customToken) {
    const res = await axios.post(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${FIREBASE_API_KEY}`, {
        token: customToken,
        returnSecureToken: true
    });
    return res.data.idToken;
}

async function runDetailedVerification() {
    console.log('🚀 Starting Persistent Audio Overview Verification...');

    // 1. Get/Create User and Token
    console.log('\n1️⃣  Authenticating...');
    let idToken;
    let userId;
    try {
        // Try login via register logic (or just create if not exists)
        let user;
        try {
            user = await auth.getUserByEmail(TEST_EMAIL);
            userId = user.uid;
            console.log(`   Reusing user: ${userId}`);
        } catch (e) {
            user = await auth.createUser({ email: TEST_EMAIL, password: 'Password123!' });
            userId = user.uid;
            console.log(`   Created new user: ${userId}`);
        }
        const customToken = await auth.createCustomToken(userId);
        idToken = await getIdToken(customToken);
        console.log('   ✅ ID Token obtained.');
    } catch (err) {
        console.error('   ❌ Auth failed:', err.response?.data || err.message);
        return;
    }

    const headers = { Authorization: `Bearer ${idToken}` };

    // 2. Check for existing course with this title
    console.log(`\n2️⃣  Checking for course content: "${COURSE_TITLE}"...`);
    const courseSnap = await db.collection('courses')
        .where('title', '==', COURSE_TITLE)
        .limit(1)
        .get();

    let courseId;
    let subtopicId;

    if (courseSnap.empty) {
        console.log('   ✨ Course not found. Generating Outline...');
        const outlineRes = await axios.post(`${BASE_URL}/api/courses/generate-outline`, {
            title: COURSE_TITLE,
            description: "A comprehensive course to test persistent content and audio overview features.",
            numUnits: 1,
            difficulty: "Intermediate",
            includeVideos: false,
            provider: "Groq"
        }, { headers });
        courseId = outlineRes.data.courseId;
        console.log(`   ✅ Outline generated: ${courseId}`);

        console.log('   ⏳ Generating Subtopic Content (LLM)...');
        await axios.post(`${BASE_URL}/api/courses/${courseId}/generate-content`, {
            provider: "Groq"
        }, { headers });
        console.log('   ✅ Content generation triggered.');
    } else {
        courseId = courseSnap.docs[0].id;
        console.log(`   ♻️  Reusing existing course: ${courseId}`);
    }

    // 3. Find subtopic with content
    console.log('\n3️⃣  Finding subtopic with content...');
    const unitsSnap = await db.collection('courses').doc(courseId).collection('units').get();
    for (const unitDoc of unitsSnap.docs) {
        const subsSnap = await unitDoc.ref.collection('subtopics').get();
        for (const subDoc of subsSnap.docs) {
            if (subDoc.data().content) {
                subtopicId = subDoc.id;
                console.log(`   ✅ Found subtopic: "${subDoc.data().title}" (${subtopicId})`);
                break;
            }
        }
        if (subtopicId) break;
    }

    if (!subtopicId) {
        console.error('   ❌ No subtopic with content found. Please check LLM status.');
        return;
    }

    // 4. Test Single Subtopic Audio (Groq)
    console.log('\n4️⃣  Testing Subtopic Audio (Groq - Hannah)...');
    try {
        const res = await axios.get(`${BASE_URL}/api/audio/${subtopicId}?tts_provider=Groq&voice=hannah`, { headers });
        console.log('   ✅ Subtopic Audio (Groq) Result:', res.data.audio.audio_url);
    } catch (err) {
        console.error('   ❌ Subtopic Audio (Groq) failed:', err.response?.data || err.message);
        if (err.response?.data?.details) {
            console.error('      Details:', err.response.data.details);
        }
    }

    // 5. Test Full Course Audio (Resemble)
    console.log('\n5️⃣  Testing Full Course Audio (Resemble)...');
    try {
        const res = await axios.get(`${BASE_URL}/api/audio/course/${courseId}?tts_provider=Resemble`, { headers });
        console.log('   ✅ Course Audio (Resemble) Result:', res.data.audio.audio_url);
    } catch (err) {
        console.error('   ❌ Course Audio (Resemble) failed:', err.response?.data || err.message);
        if (err.response?.data?.details) {
            console.error('      Details:', err.response.data.details);
        }
    }

    console.log('\n🏁 Verification Finished. Course and contents are PRESERVED in Firestore.');
    process.exit(0);
}

runDetailedVerification().catch(err => {
    console.error('💥 Fatal error:', err);
    process.exit(1);
});
