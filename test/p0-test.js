/**
 * ═══════════════════════════════════════════════════════════════
 *  Phase 2 (P0) — End-to-End Integration Tests
 *  Follows REAL user flow:
 *    1. Register → 2. Generate Outline (LLM) → 3. Generate Content (LLM)
 *    4. Flashcards → 5. Notes → 6. Cleanup
 *
 *  Usage: node test/p0-test.js
 * ═══════════════════════════════════════════════════════════════
 */

import admin from "firebase-admin";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import dotenv from "dotenv";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
dotenv.config({ path: join(__dirname, "..", ".env") });

console.log("\n🧪 Phase 2 (P0) — End-to-End Integration Tests");
console.log("═══════════════════════════════════════════════════════\n");

// ─── Config ─────────────────────────────────────────────
const BASE_URL = "http://localhost:3030";
const FIREBASE_API_KEY = process.env.FIREBASE_API_KEY;
const TEST_EMAIL = `p0e2e_${Date.now()}@example.com`;

console.log(`📍 Server:     ${BASE_URL}`);
console.log(`📧 Test user:  ${TEST_EMAIL}`);
console.log(`🔑 API Key:    ${FIREBASE_API_KEY ? "✅" : "❌ MISSING"}`);

if (!FIREBASE_API_KEY) {
    console.error("\n❌ FIREBASE_API_KEY not found in .env");
    process.exit(1);
}

// ─── Firebase Admin (separate test instance) ────────────
let testApp, testAuth, testDb;
try {
    const sa = JSON.parse(
        readFileSync(join(__dirname, "..", "cert", "serviceAccountKey.json"), "utf8")
    );
    testApp = admin.initializeApp(
        { credential: admin.credential.cert(sa) },
        "p0e2e-" + Date.now()
    );
    testAuth = testApp.auth();
    testDb = testApp.firestore();
    console.log("✅ Firebase Admin initialized\n");
} catch (e) {
    console.error("❌ Firebase init failed:", e.message);
    process.exit(1);
}

// ─── Helper: exchange custom token → ID token ───────────
async function getIdToken(customToken) {
    const res = await fetch(
        `https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${FIREBASE_API_KEY}`,
        {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ token: customToken, returnSecureToken: true }),
        }
    );
    const data = await res.json();
    if (!data.idToken) throw new Error("Token exchange failed: " + JSON.stringify(data));
    return data.idToken;
}

// ─── Test State ─────────────────────────────────────────
let userId, idToken;
let courseId, subtopicId, flashcardId;
let passed = 0,
    failed = 0,
    skipped = 0;

function ok(name, detail = "") {
    passed++;
    console.log(`  ✅ PASS — ${name}${detail ? " — " + detail : ""}`);
}
function fail(name, msg) {
    failed++;
    console.error(`  ❌ FAIL — ${name}: ${msg}`);
}
function skip(name) {
    skipped++;
    console.log(`  ⏭️ SKIP — ${name}`);
}
function header(num, title) {
    console.log(`\n═══════════════════════════════════════════`);
    console.log(`  TEST ${num}: ${title}`);
    console.log(`═══════════════════════════════════════════\n`);
}

// ═════════════════════════════════════════════════════════
//  TEST 0: Register
// ═════════════════════════════════════════════════════════
async function test0_register() {
    header(0, "Register New User");

    const res = await fetch(`${BASE_URL}/api/auth/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            email: TEST_EMAIL,
            password: "TestPass123!",
            username: "p0_e2e_tester",
        }),
    });

    const data = await res.json();

    if (res.status !== 201 || !data.user?.id || !data.token) {
        fail("Register", `${res.status}: ${data.error || "no user/token"}`);
        return false;
    }

    userId = data.user.id;
    idToken = await getIdToken(data.token);

    console.log(`  👤 User: ${userId}`);
    console.log(`  🔑 Token: ${idToken.substring(0, 20)}...`);
    ok("Registered", `${userId}`);
    return true;
}

// ═════════════════════════════════════════════════════════
//  TEST 1: Generate Course Outline (LLM)
// ═════════════════════════════════════════════════════════
async function test1_generateOutline() {
    header(1, "Generate Course Outline (LLM)");
    console.log("  ⏳ Calling LLM — may take 10-30s...\n");

    const res = await fetch(`${BASE_URL}/api/courses/generate-outline`, {
        method: "POST",
        headers: {
            Authorization: `Bearer ${idToken}`,
            "Content-Type": "application/json",
        },
        body: JSON.stringify({
            title: "P0 Test — JavaScript Basics",
            description:
                "A short test course about JavaScript basics to verify flashcard and notes generation.",
            numUnits: 1,
            difficulty: "Beginner",
            includeVideos: false,
            provider: "Groq",
        }),
    });

    const data = await res.json();

    if (res.status !== 201 || !data.courseId) {
        fail("Outline generation", `${res.status}: ${JSON.stringify(data).substring(0, 200)}`);
        return false;
    }

    courseId = data.courseId;
    const unitCount = data.outline?.units?.length || 0;
    const subtopicCount = data.outline?.units?.reduce((a, u) => a + (u.subtopics?.length || 0), 0) || 0;

    console.log(`  📚 Course ID: ${courseId}`);
    console.log(`  📋 Outline: ${unitCount} unit(s), ${subtopicCount} subtopic(s)`);
    console.log(`  📖 Unit 1: ${data.outline?.units?.[0]?.title || "?"}`);
    console.log(`  📝 Subtopics: ${data.outline?.units?.[0]?.subtopics?.join(", ") || "?"}`);

    ok("Outline generated", `${unitCount} unit(s), ${subtopicCount} subtopic(s)`);
    return true;
}

// ═════════════════════════════════════════════════════════
//  TEST 2: Get Course Outline
// ═════════════════════════════════════════════════════════
async function test2_getOutline() {
    header(2, "Get Course Outline");

    const res = await fetch(`${BASE_URL}/api/courses/${courseId}/getoutline`);
    const data = await res.json();

    if (res.status === 200 && data.outline?.units?.length > 0) {
        ok("Outline fetched", `${data.outline.units.length} unit(s)`);
        return true;
    } else {
        fail("Get outline", `${res.status}: ${data.error}`);
        return false;
    }
}

// ═════════════════════════════════════════════════════════
//  TEST 3: Generate Content (LLM)
// ═════════════════════════════════════════════════════════
async function test3_generateContent() {
    header(3, "Generate Subtopic Content (LLM)");
    console.log("  ⏳ Generating content for first unit — may take 20-60s...\n");

    const res = await fetch(`${BASE_URL}/api/courses/${courseId}/generate-content`, {
        method: "POST",
        headers: {
            Authorization: `Bearer ${idToken}`,
            "Content-Type": "application/json",
        },
        body: JSON.stringify({ provider: "Groq" }),
    });

    const data = await res.json();

    if (res.status === 200 && data.generated > 0) {
        console.log(`  📝 Generated content for ${data.generated} subtopic(s)`);
        ok("Content generated", `${data.generated} subtopics`);
        return true;
    } else {
        fail("Content generation", `${res.status}: ${JSON.stringify(data).substring(0, 200)}`);
        return false;
    }
}

// ═════════════════════════════════════════════════════════
//  TEST 4: Get Full Course (verify content exists)
// ═════════════════════════════════════════════════════════
async function test4_getFullCourse() {
    header(4, "Get Full Course (with content)");

    const res = await fetch(`${BASE_URL}/api/courses/${courseId}/full`, {
        headers: { Authorization: `Bearer ${idToken}` },
    });

    const data = await res.json();

    // API returns { course: {...}, units: [...] } — units is TOP-LEVEL, not nested in course
    if (res.status !== 200 || !data.units?.length) {
        fail("Full course", `${res.status}: ${data.error || "no units"}`);
        return false;
    }

    // Find first subtopic with content
    for (const unit of data.units) {
        for (const sub of unit.subtopics || []) {
            if (sub.content) {
                subtopicId = sub.id;
                console.log(`  ✅ Found subtopic with content: ${sub.id}`);
                console.log(`     Title: ${sub.title || sub.content?.subtopic_title}`);
                break;
            }
        }
        if (subtopicId) break;
    }

    if (subtopicId) {
        ok("Full course fetched", `subtopicId=${subtopicId}`);
        return true;
    } else {
        fail("Full course", "No subtopic with content found");
        return false;
    }
}

// ═════════════════════════════════════════════════════════
//  TEST 5: Generate Flashcards (LLM)
// ═════════════════════════════════════════════════════════
async function test5_generateFlashcards() {
    header(5, "Generate Flashcards (LLM)");

    if (!subtopicId) {
        skip("No subtopic — content gen may have failed");
        return false;
    }

    console.log("  ⏳ Calling LLM — may take 10-30s...\n");

    const res = await fetch(`${BASE_URL}/api/flashcards/${subtopicId}`, {
        headers: { Authorization: `Bearer ${idToken}` },
    });

    const data = await res.json();

    if ((res.status === 200 || res.status === 201) && data.flashcards?.length >= 3) {
        flashcardId = data.flashcards[0].id;
        const card = data.flashcards[0];

        console.log(`  🃏 Generated ${data.flashcards.length} flashcards`);
        console.log(`  📖 Card 1: "${card.front?.substring(0, 60)}..."`);
        console.log(`  📝 Answer: "${card.back?.substring(0, 60)}..."`);
        console.log(`  🏷️ Type: ${card.card_type}`);

        if (card.front && card.back && card.card_type) {
            ok("Flashcards generated", `${data.flashcards.length} cards, generated=${data.generated}`);
            return true;
        } else {
            fail("Flashcard structure", "Missing front/back/card_type");
            return false;
        }
    } else {
        fail("Flashcard generation", `${res.status}: ${data.error}`);
        return false;
    }
}

// ═════════════════════════════════════════════════════════
//  TEST 6: Get Cached Flashcards (no LLM call)
// ═════════════════════════════════════════════════════════
async function test6_cachedFlashcards() {
    header(6, "Get Cached Flashcards (no LLM call)");

    if (!subtopicId) { skip("No subtopic"); return false; }

    const res = await fetch(`${BASE_URL}/api/flashcards/${subtopicId}`, {
        headers: { Authorization: `Bearer ${idToken}` },
    });

    const data = await res.json();

    if (res.status === 200 && data.generated === false) {
        ok("Cached flashcards returned", `${data.flashcards.length} cards, no LLM call`);
        return true;
    } else {
        fail("Flashcard cache", `Expected generated=false, got ${data.generated}`);
        return false;
    }
}

// ═════════════════════════════════════════════════════════
//  TEST 7: SM-2 Flashcard Review — Perfect Recall
// ═════════════════════════════════════════════════════════
async function test7_sm2Review() {
    header(7, "SM-2 Flashcard Review");

    if (!flashcardId) { skip("No flashcard ID"); return false; }

    // Perfect recall (quality=5)
    const res1 = await fetch(`${BASE_URL}/api/flashcards/${flashcardId}/review`, {
        method: "POST",
        headers: {
            Authorization: `Bearer ${idToken}`,
            "Content-Type": "application/json",
        },
        body: JSON.stringify({ quality: 5 }),
    });

    const d1 = await res1.json();
    console.log(`  Perfect recall (q=5): interval=${d1.interval_days}d, EF=${d1.ease_factor}, reps=${d1.repetitions}`);

    if (res1.status === 200 && d1.interval_days === 1 && d1.repetitions === 1) {
        ok("SM-2 perfect recall", `interval=1d, reps=1`);
    } else {
        fail("SM-2 perfect", `interval=${d1.interval_days}, reps=${d1.repetitions}`);
    }

    // Failed recall (quality=1) → should reset
    const res2 = await fetch(`${BASE_URL}/api/flashcards/${flashcardId}/review`, {
        method: "POST",
        headers: {
            Authorization: `Bearer ${idToken}`,
            "Content-Type": "application/json",
        },
        body: JSON.stringify({ quality: 1 }),
    });

    const d2 = await res2.json();
    console.log(`  Failed recall (q=1): interval=${d2.interval_days}d, EF=${d2.ease_factor}, reps=${d2.repetitions}`);

    if (res2.status === 200 && d2.interval_days === 1 && d2.repetitions === 0) {
        ok("SM-2 failed recall reset", `interval=1d, reps=0`);
    } else {
        fail("SM-2 reset", `interval=${d2.interval_days}, reps=${d2.repetitions}`);
    }

    return true;
}

// ═════════════════════════════════════════════════════════
//  TEST 8: Due Flashcards
// ═════════════════════════════════════════════════════════
async function test8_dueFlashcards() {
    header(8, "Get Due Flashcards for Course");

    if (!courseId) { skip("No course ID"); return false; }

    const res = await fetch(`${BASE_URL}/api/flashcards/course/${courseId}/due`, {
        headers: { Authorization: `Bearer ${idToken}` },
    });

    const data = await res.json();

    if (res.status === 200 && typeof data.total === "number") {
        ok("Due flashcards", `${data.total} due cards`);
        return true;
    } else {
        fail("Due flashcards", `${res.status}: ${data.error}`);
        return false;
    }
}

// ═════════════════════════════════════════════════════════
//  TEST 9: Generate Smart Notes (LLM)
// ═════════════════════════════════════════════════════════
async function test9_generateNotes() {
    header(9, "Generate Smart Notes (LLM)");

    if (!subtopicId) { skip("No subtopic"); return false; }

    console.log("  ⏳ Calling LLM — may take 10-30s...\n");

    const res = await fetch(`${BASE_URL}/api/notes/${subtopicId}/generated`, {
        headers: { Authorization: `Bearer ${idToken}` },
    });

    const data = await res.json();

    if (res.status === 201 || res.status === 200) {
        const n = data.notes;
        const requiredFields = [
            "summary", "the_problem", "previous_approaches", "the_solution",
            "key_points", "analogy", "real_world_example", "common_mistakes",
            "common_confusions", "mini_qa",
        ];

        const missing = requiredFields.filter((f) => !n[f]);

        if (missing.length === 0) {
            console.log(`  📝 Summary: ${n.summary?.substring(0, 80)}...`);
            console.log(`  ❓ Problem: ${n.the_problem?.substring(0, 60)}...`);
            console.log(`  🎯 Key Points: ${n.key_points?.length} items`);
            console.log(`  🔗 Analogy: ${n.analogy?.substring(0, 60)}...`);
            console.log(`  ⚠️ Mistakes: ${n.common_mistakes?.length} items`);
            console.log(`  📋 Q&A: ${n.mini_qa?.length} pairs`);
            ok("Notes generated", `${requiredFields.length} sections, generated=${data.generated}`);
            return true;
        } else {
            fail("Notes sections", `Missing: ${missing.join(", ")}`);
            return false;
        }
    } else {
        fail("Notes generation", `${res.status}: ${data.error}`);
        return false;
    }
}

// ═════════════════════════════════════════════════════════
//  TEST 10: Cached Notes (no LLM call)
// ═════════════════════════════════════════════════════════
async function test10_cachedNotes() {
    header(10, "Get Cached Notes (no LLM call)");

    if (!subtopicId) { skip("No subtopic"); return false; }

    const res = await fetch(`${BASE_URL}/api/notes/${subtopicId}/generated`, {
        headers: { Authorization: `Bearer ${idToken}` },
    });

    const data = await res.json();

    if (res.status === 200 && data.generated === false) {
        ok("Cached notes returned", "no LLM call");
        return true;
    } else {
        fail("Notes cache", `Expected generated=false, got ${data.generated}`);
        return false;
    }
}

// ═════════════════════════════════════════════════════════
//  TEST 11: Export Subtopic Notes (Markdown)
// ═════════════════════════════════════════════════════════
async function test11_exportSubtopicNotes() {
    header(11, "Export Subtopic Notes (Markdown)");

    if (!subtopicId) { skip("No subtopic"); return false; }

    const res = await fetch(`${BASE_URL}/api/notes/${subtopicId}/export`, {
        headers: { Authorization: `Bearer ${idToken}` },
    });

    const text = await res.text();
    const ct = res.headers.get("content-type");

    console.log(`  Content-Type: ${ct}`);
    console.log(`  Markdown: ${text.length} chars`);
    console.log(`  Preview: ${text.substring(0, 120).replace(/\n/g, "\\n")}...`);

    if (res.status === 200 && text.includes("## ") && text.includes("Summary")) {
        ok("Subtopic notes exported", `${text.length} chars MD`);
        return true;
    } else {
        fail("Subtopic export", `${res.status}, missing sections`);
        return false;
    }
}

// ═════════════════════════════════════════════════════════
//  TEST 12: Export Course Notes (Markdown)
// ═════════════════════════════════════════════════════════
async function test12_exportCourseNotes() {
    header(12, "Export Full Course Notes (Markdown)");

    if (!courseId) { skip("No course ID"); return false; }

    const res = await fetch(`${BASE_URL}/api/notes/course/${courseId}/export`, {
        headers: { Authorization: `Bearer ${idToken}` },
    });

    const text = await res.text();

    console.log(`  Markdown: ${text.length} chars`);
    console.log(`  Preview: ${text.substring(0, 120).replace(/\n/g, "\\n")}...`);

    if (res.status === 200 && text.includes("# ") && text.length > 100) {
        ok("Course notes exported", `${text.length} chars MD`);
        return true;
    } else {
        fail("Course export", `${res.status}`);
        return false;
    }
}

// ═════════════════════════════════════════════════════════
//  TEST 13: Auth Guards (no token)
// ═════════════════════════════════════════════════════════
async function test13_authGuards() {
    header(13, "Auth Guards (no token → 401)");

    const endpoints = [
        { url: `${BASE_URL}/api/flashcards/fake-id`, name: "Flashcards GET" },
        { url: `${BASE_URL}/api/notes/fake-id/generated`, name: "Notes GET" },
        { url: `${BASE_URL}/api/notes/course/fake-id/export`, name: "Course Export" },
    ];

    for (const ep of endpoints) {
        const res = await fetch(ep.url);
        if (res.status === 401) {
            ok(`${ep.name}`, "401 Unauthorized");
        } else {
            fail(`${ep.name} auth guard`, `Expected 401, got ${res.status}`);
        }
    }
}

// ═════════════════════════════════════════════════════════
//  CLEANUP
// ═════════════════════════════════════════════════════════
async function cleanup() {
    console.log("\n⏳ Cleaning up test data...\n");

    try {
        // 1. Delete flashcards for test subtopic
        if (subtopicId) {
            const flashSnap = await testDb
                .collection("flashcards")
                .where("subtopic_id", "==", subtopicId)
                .get();
            if (!flashSnap.empty) {
                const batch = testDb.batch();
                flashSnap.docs.forEach((d) => batch.delete(d.ref));
                await batch.commit();
                console.log(`  🗑️ Deleted ${flashSnap.size} flashcards`);
            }

            // Delete notes
            await testDb.collection("generated_notes").doc(subtopicId).delete().catch(() => { });
            console.log("  🗑️ Deleted generated notes");
        }

        // 2. Delete flashcard progress
        if (flashcardId && userId) {
            await testDb
                .collection("user_flashcard_progress")
                .doc(`${userId}_${flashcardId}`)
                .delete()
                .catch(() => { });
            console.log("  🗑️ Deleted flashcard progress");
        }

        // 3. Delete enrollment
        if (courseId && userId) {
            await testDb
                .collection("user_courses")
                .doc(`${userId}_${courseId}`)
                .delete()
                .catch(() => { });
            await testDb.collection("course_public_stats").doc(courseId).delete().catch(() => { });
        }

        // 4. Delete course with subcollections
        if (courseId) {
            const unitsSnap = await testDb
                .collection("courses")
                .doc(courseId)
                .collection("units")
                .get();

            for (const unitDoc of unitsSnap.docs) {
                const subsSnap = await unitDoc.ref.collection("subtopics").get();
                for (const subDoc of subsSnap.docs) {
                    // Delete videos subcollection
                    const vSnap = await subDoc.ref.collection("videos").get();
                    if (!vSnap.empty) {
                        const b = testDb.batch();
                        vSnap.docs.forEach((v) => b.delete(v.ref));
                        await b.commit();
                    }
                    await subDoc.ref.delete();
                }
                await unitDoc.ref.delete();
            }

            await testDb.collection("courses").doc(courseId).delete();
            console.log(`  🗑️ Deleted course ${courseId} + subcollections`);
        }

        // 5. Delete user
        if (userId) {
            await testAuth.deleteUser(userId);
            await testDb.collection("users").doc(userId).delete().catch(() => { });
            console.log(`  🗑️ Deleted test user ${userId}`);
        }

        await testApp.delete();
    } catch (e) {
        console.error("  ⚠️ Cleanup error:", e.message);
    }
}

// ═════════════════════════════════════════════════════════
//  RUN
// ═════════════════════════════════════════════════════════
async function run() {
    const start = Date.now();

    try {
        // ── Phase 0: Register ───────────────────────
        const registered = await test0_register();
        if (!registered) throw new Error("Registration failed — cannot continue");

        // ── Phase 1: Course creation flow ───────────
        const outlined = await test1_generateOutline();
        if (!outlined) throw new Error("Outline failed — cannot continue");

        await test2_getOutline();

        const contentGenerated = await test3_generateContent();
        if (!contentGenerated) {
            console.log("\n  ⚠️ Content generation failed — flashcard/notes tests will use fallback");
        }

        await test4_getFullCourse();

        // ── Phase 2: Flashcards ─────────────────────
        await test5_generateFlashcards();
        await test6_cachedFlashcards();
        await test7_sm2Review();
        await test8_dueFlashcards();

        // ── Phase 3: Notes ──────────────────────────
        await test9_generateNotes();
        await test10_cachedNotes();
        await test11_exportSubtopicNotes();
        await test12_exportCourseNotes();

        // ── Auth guards ─────────────────────────────
        await test13_authGuards();
    } catch (e) {
        console.error(`\n💥 Fatal: ${e.message}`);
        failed++;
    } finally {
        await cleanup();
    }

    const elapsed = ((Date.now() - start) / 1000).toFixed(1);

    console.log("\n══════════════════════════════════════════");
    console.log(`  Results: ${passed} passed, ${failed} failed, ${skipped} skipped`);
    console.log(`  Time: ${elapsed}s`);
    console.log("══════════════════════════════════════════\n");

    process.exit(failed > 0 ? 1 : 0);
}

run();
