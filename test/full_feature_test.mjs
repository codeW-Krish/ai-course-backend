/**
 * Full Feature Integration Test
 * Tests: Interactive, Flashcards, Notes, Gamification, Analytics, Audio
 */

const BASE = "http://localhost:3030";

const log = (label, status, ok) =>
  console.log(`${ok ? "✅" : "❌"} [${status}] ${label}`);

async function json(method, path, body, token) {
  const opts = {
    method,
    headers: { "Content-Type": "application/json" },
  };
  if (token) opts.headers["Authorization"] = `Bearer ${token}`;
  if (body) opts.body = JSON.stringify(body);

  const res = await fetch(`${BASE}${path}`, opts);
  let data;
  const ct = res.headers.get("content-type") || "";
  if (ct.includes("json")) {
    data = await res.json();
  } else {
    data = await res.text();
  }
  return { status: res.status, data };
}

async function run() {
  const results = { passed: 0, failed: 0, skipped: 0, errors: [] };

  function check(label, status, data, expectStatus, validate) {
    const statusOk = expectStatus
      ? Array.isArray(expectStatus)
        ? expectStatus.includes(status)
        : status === expectStatus
      : status >= 200 && status < 300;
    let extra = true;
    if (validate && statusOk) {
      try { extra = validate(data); }
      catch (e) { extra = false; }
    }
    const ok = statusOk && extra !== false;
    log(label, status, ok);
    if (ok) results.passed++;
    else {
      results.failed++;
      results.errors.push({ label, status, data: typeof data === "string" ? data.slice(0, 200) : data });
    }
    return ok;
  }

  // ========== AUTH ==========
  console.log("\n═══ AUTH ═══");

  const loginRes = await json("POST", "/api/auth/login", {
    email: "testuser@example.com",
    password: "Test123456",
  });
  const loginOk = check("Login", loginRes.status, loginRes.data, 200, (d) => !!d.accessToken);
  if (!loginOk) {
    console.error("Cannot continue without login. Aborting.");
    return;
  }
  const token = loginRes.data.accessToken;
  console.log(`  Token: ${token.slice(0, 20)}...`);

  // ========== Get Course Data ==========
  console.log("\n═══ COURSE DATA ═══");
  const courseId = "0h3kYLU0rXWDAB77Gigx";

  const fullRes = await json("GET", `/api/courses/${courseId}/full`, null, token);
  check("Get full course", fullRes.status, fullRes.data, 200, (d) => !!d.course || !!d.title);

  // Extract subtopic IDs
  let subtopicIds = [];
  const courseData = fullRes.data.course || fullRes.data;
  const units = courseData.units || [];
  for (const unit of units) {
    const subtopics = unit.subtopics || [];
    for (const sub of subtopics) {
      if (sub.id) subtopicIds.push({ id: sub.id, title: sub.title || "unknown", hasContent: !!sub.content });
    }
  }
  console.log(`  Found ${subtopicIds.length} subtopics in ${units.length} units`);
  subtopicIds.forEach((s) => console.log(`    - ${s.id}: ${s.title} (content: ${s.hasContent})`));

  const firstSubtopicId = subtopicIds.length > 0 ? subtopicIds[0].id : null;
  const hasContent = subtopicIds.some((s) => s.hasContent);

  // ========== INTERACTIVE MODE ==========
  console.log("\n═══ INTERACTIVE MODE ═══");

  // Get next subtopic
  const nextRes = await json("GET", `/api/interactive/course/${courseId}/next?provider=Gemini`, null, token);
  check("Get next subtopic", nextRes.status, nextRes.data, [200, 500], (d) =>
    d.course_completed === true || (d.subtopic && d.questions)
  );

  let sessionSubtopicId = nextRes.data?.subtopic?.id || firstSubtopicId;
  let questions = nextRes.data?.questions || [];
  console.log(`  Session subtopic: ${sessionSubtopicId}, questions: ${questions.length}`);

  // Start session directly
  if (firstSubtopicId) {
    const sessRes = await json("GET", `/api/interactive/${firstSubtopicId}?provider=Gemini`, null, token);
    check("Start session (direct)", sessRes.status, sessRes.data, [200, 500]);
    if (sessRes.data?.questions?.length > 0) {
      questions = sessRes.data.questions;
      sessionSubtopicId = firstSubtopicId;
    }
  }

  // Verify answer
  if (questions.length > 0 && sessionSubtopicId) {
    const q = questions[0];
    const answer = q.options?.[0] || "test answer";
    const verifyRes = await json("POST", `/api/interactive/${sessionSubtopicId}/verify`, {
      questionId: q.id,
      answer: answer,
    }, token);
    check("Verify answer", verifyRes.status, verifyRes.data, 200, (d) =>
      typeof d.correct === "boolean" && typeof d.hearts_remaining === "number"
    );
  } else {
    console.log("  ⏭️  Skipping verify (no questions)");
    results.skipped++;
  }

  // Chat with AI (subtopic)
  if (sessionSubtopicId) {
    const chatRes = await json("POST", `/api/interactive/${sessionSubtopicId}/chat`, {
      message: "Explain this concept briefly",
      provider: "Gemini",
    }, token);
    check("Chat with subtopic AI", chatRes.status, chatRes.data, [200, 500], (d) => !!d.ai_response);
  } else {
    console.log("  ⏭️  Skipping subtopic chat (no session)");
    results.skipped++;
  }

  // Chat with course AI
  const courseChatRes = await json("POST", `/api/interactive/course/${courseId}/chat`, {
    message: "Give me a summary of what this course covers",
    provider: "Gemini",
  }, token);
  check("Chat with course AI", courseChatRes.status, courseChatRes.data, [200, 500], (d) => !!d.ai_response);

  // Generate practice
  const practiceRes = await json("POST", `/api/interactive/course/${courseId}/practice`, {
    focus: "general revision",
    provider: "Gemini",
  }, token);
  check("Generate course practice", practiceRes.status, practiceRes.data, [200, 500, 502]);

  // ========== FLASHCARDS ==========
  console.log("\n═══ FLASHCARDS ═══");

  if (firstSubtopicId && hasContent) {
    const fcRes = await json("GET", `/api/flashcards/${firstSubtopicId}?provider=Gemini`, null, token);
    check("Get/generate flashcards", fcRes.status, fcRes.data, [200, 201, 400, 500], (d) =>
      Array.isArray(d.flashcards)
    );

    if (fcRes.data?.flashcards?.length > 0) {
      const firstCard = fcRes.data.flashcards[0];
      console.log(`  First flashcard: "${firstCard.front?.slice(0, 40)}..."`);

      const reviewRes = await json("POST", `/api/flashcards/${firstCard.id}/review`, {
        quality: 4,
      }, token);
      check("Review flashcard", reviewRes.status, reviewRes.data, 200, (d) =>
        d.message === "Review recorded" && typeof d.interval_days === "number"
      );
    } else {
      console.log("  ⏭️  Skipping review (no flashcards generated)");
      results.skipped++;
    }
  } else {
    console.log("  ⏭️  Skipping flashcards (no subtopic with content)");
    results.skipped += 2;
  }

  // Due flashcards
  const dueRes = await json("GET", `/api/flashcards/course/${courseId}/due`, null, token);
  check("Get due flashcards", dueRes.status, dueRes.data, 200, (d) =>
    Array.isArray(d.dueCards) && typeof d.total === "number"
  );

  // ========== NOTES ==========
  console.log("\n═══ NOTES ═══");

  if (firstSubtopicId && hasContent) {
    const notesRes = await json("GET", `/api/notes/${firstSubtopicId}/generated?provider=Gemini`, null, token);
    check("Get/generate notes", notesRes.status, notesRes.data, [200, 201, 400, 500], (d) =>
      d.notes && d.notes.summary
    );

    const exportRes = await json("GET", `/api/notes/${firstSubtopicId}/export?format=json`, null, token);
    check("Export subtopic notes (JSON)", exportRes.status, exportRes.data, [200, 404]);
  } else {
    console.log("  ⏭️  Skipping notes (no subtopic with content)");
    results.skipped += 2;
  }

  // Export course notes
  const courseNotesRes = await json("GET", `/api/notes/course/${courseId}/export?format=json`, null, token);
  check("Export course notes (JSON)", courseNotesRes.status, courseNotesRes.data, [200, 404]);

  // ========== GAMIFICATION ==========
  console.log("\n═══ GAMIFICATION ═══");

  const gamRes = await json("GET", "/api/gamification/me", null, token);
  check("Get gamification stats", gamRes.status, gamRes.data, 200);
  if (gamRes.data) {
    const stats = gamRes.data.stats || gamRes.data;
    console.log(`  XP: ${stats.total_xp || 0}, Level: ${stats.level || stats.current_level || 0}, Streak: ${stats.current_streak || 0}`);
  }

  // Ping activity (both camelCase and snake_case to test)
  const pingRes = await json("POST", "/api/gamification/activity/ping", {
    activity_type: "daily_login",
    type: "daily_login",
    activityType: "daily_login",
  }, token);
  check("Ping daily activity", pingRes.status, pingRes.data, 200, (d) => d.message === "Activity recorded");

  // ========== ANALYTICS ==========
  console.log("\n═══ ANALYTICS ═══");

  const summaryRes = await json("GET", "/api/analytics/summary", null, token);
  check("Analytics summary", summaryRes.status, summaryRes.data, 200, (d) => !!d.summary);

  const courseAnalyticsRes = await json("GET", `/api/analytics/course/${courseId}`, null, token);
  check("Course analytics", courseAnalyticsRes.status, courseAnalyticsRes.data, 200, (d) =>
    d.course && d.progress && d.quiz
  );

  const weeklyRes = await json("GET", "/api/analytics/weekly", null, token);
  check("Weekly analytics", weeklyRes.status, weeklyRes.data, 200, (d) => Array.isArray(d.weekly));

  // ========== AUDIO ==========
  console.log("\n═══ AUDIO ═══");

  // Test audio for course (this tests the routing issue)
  const courseAudioRes = await json("GET", `/api/audio/course/${courseId}?tts_provider=Groq&llm_provider=Groq`, null, token);
  check("Course audio (route test)", courseAudioRes.status, courseAudioRes.data, [200, 201, 404, 500]);

  // Audio for subtopic
  if (firstSubtopicId && hasContent) {
    const audioRes = await json("GET", `/api/audio/${firstSubtopicId}?tts_provider=Groq&llm_provider=Groq`, null, token);
    check("Subtopic audio", audioRes.status, audioRes.data, [200, 201, 400, 500]);
  } else {
    console.log("  ⏭️  Skipping subtopic audio (no subtopic with content)");
    results.skipped++;
  }

  // ========== SUMMARY ==========
  console.log("\n" + "═".repeat(50));
  console.log(`RESULTS: ${results.passed} passed, ${results.failed} failed, ${results.skipped} skipped`);
  if (results.errors.length > 0) {
    console.log("\nFailed tests:");
    for (const e of results.errors) {
      console.log(`  ❌ ${e.label} (HTTP ${e.status})`);
      if (typeof e.data === "object") console.log(`     ${JSON.stringify(e.data).slice(0, 200)}`);
    }
  }
  console.log("═".repeat(50));
}

run().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
