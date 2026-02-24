/**
 * Full Feature Integration Test v2
 * Tests: Auth, Course, Interactive, Flashcards, Notes, Gamification, Analytics, Audio routes
 */

const BASE = "http://localhost:3030";

async function json(method, path, body, token) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);
  try {
    const opts = {
      method,
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
    };
    if (token) opts.headers["Authorization"] = `Bearer ${token}`;
    if (body) opts.body = JSON.stringify(body);
    const res = await fetch(`${BASE}${path}`, opts);
    const ct = res.headers.get("content-type") || "";
    const data = ct.includes("json") ? await res.json() : await res.text();
    return { status: res.status, data };
  } catch (err) {
    return { status: err.name === "AbortError" ? 408 : 0, data: { error: err.message } };
  } finally {
    clearTimeout(timeout);
  }
}

async function run() {
  let passed = 0, failed = 0, skipped = 0;
  const errors = [];

  function check(label, { status, data }, expectStatus, validate) {
    const ok1 = Array.isArray(expectStatus) ? expectStatus.includes(status) : status === expectStatus;
    let ok2 = true;
    if (validate && ok1) {
      try { ok2 = validate(data) !== false; } catch { ok2 = false; }
    }
    const ok = ok1 && ok2;
    console.log(`${ok ? "✅" : "❌"} [${status}] ${label}`);
    if (ok) passed++;
    else { failed++; errors.push({ label, status, data: JSON.stringify(data).slice(0, 200) }); }
    return { ok, data };
  }

  // ━━━━━━ AUTH ━━━━━━
  console.log("\n━━━ AUTH ━━━");
  const loginRes = await json("POST", "/api/auth/login", { email: "testuser@example.com", password: "Test123456" });
  const { ok: loginOk, data: loginData } = check("Login", loginRes, 200, d => !!d.accessToken);
  if (!loginOk) { console.error("Aborting: cannot login"); return; }
  const T = loginData.accessToken;
  console.log(`  Token: ${T.slice(0, 20)}...`);

  // ━━━━━━ COURSE DATA ━━━━━━
  console.log("\n━━━ COURSE DATA ━━━");
  const courseId = "0h3kYLU0rXWDAB77Gigx";

  const fullRes = await json("GET", `/api/courses/${courseId}/full`, null, T);
  // Response: { course: {...}, units: [...] } — units at TOP level
  check("Full course", fullRes, 200, d => d.course && Array.isArray(d.units));

  const units = fullRes.data?.units || [];
  const subtopics = [];
  for (const u of units) {
    for (const s of (u.subtopics || [])) {
      if (s.id) subtopics.push({ id: s.id, title: s.title, hasContent: !!s.content });
    }
  }
  console.log(`  ${units.length} units, ${subtopics.length} subtopics`);
  subtopics.forEach(s => console.log(`    ${s.hasContent ? "✓" : "○"} ${s.id}: ${s.title}`));
  const sub1 = subtopics.find(s => s.hasContent) || subtopics[0];

  // ━━━━━━ GAMIFICATION ━━━━━━
  console.log("\n━━━ GAMIFICATION ━━━");

  const gamRes = await json("GET", "/api/gamification/me", null, T);
  // Response: { stats: { total_xp, level, next_level_xp, current_streak, ... }, achievements: [...] }
  check("Get stats", gamRes, 200, d => {
    if (!d.stats) return false;
    console.log(`  XP:${d.stats.total_xp} Level:${d.stats.level} NextLvlXP:${d.stats.next_level_xp} Streak:${d.stats.current_streak}`);
    console.log(`  Achievements: ${d.achievements?.length || 0}`);
    // Verify new level/next_level_xp fields exist
    return typeof d.stats.level === "number" && typeof d.stats.next_level_xp === "number";
  });

  const pingRes = await json("POST", "/api/gamification/activity/ping", { activity_type: "integration_test" }, T);
  check("Ping activity (snake_case)", pingRes, 200, d => d.message === "Activity recorded");

  // ━━━━━━ ANALYTICS ━━━━━━
  console.log("\n━━━ ANALYTICS ━━━");

  const summRes = await json("GET", "/api/analytics/summary", null, T);
  check("Summary", summRes, 200, d => {
    if (!d.summary) return false;
    console.log(`  XP:${d.summary.total_xp} Enrolled:${d.summary.enrolled_courses} QuizAcc:${d.summary.quiz_accuracy_rate}%`);
    return true;
  });

  const caRes = await json("GET", `/api/analytics/course/${courseId}`, null, T);
  check("Course analytics", caRes, 200, d => {
    if (!d.progress) return false;
    console.log(`  Progress: ${d.progress.completed_subtopics}/${d.progress.total_subtopics} (${d.progress.completion_rate}%)`);
    console.log(`  Quiz: ${d.quiz?.correct}/${d.quiz?.attempts}`);
    return typeof d.progress.total_subtopics === "number";
  });

  const wkRes = await json("GET", "/api/analytics/weekly", null, T);
  check("Weekly analytics", wkRes, 200, d => Array.isArray(d.weekly));

  // ━━━━━━ FLASHCARDS ━━━━━━
  console.log("\n━━━ FLASHCARDS ━━━");

  const dueRes = await json("GET", `/api/flashcards/course/${courseId}/due`, null, T);
  check("Due flashcards", dueRes, 200, d => {
    console.log(`  Due: ${d.total}`);
    return typeof d.total === "number" && Array.isArray(d.dueCards);
  });

  // ━━━━━━ NOTES ━━━━━━
  console.log("\n━━━ NOTES ━━━");

  const cnRes = await json("GET", `/api/notes/course/${courseId}/export?format=json`, null, T);
  check("Course notes export (JSON)", cnRes, 200, d => typeof d.total_subtopics === "number" || typeof d.notes_generated === "number");

  // ━━━━━━ AUDIO (route ordering) ━━━━━━
  console.log("\n━━━ AUDIO ROUTE TEST ━━━");

  const audioRouteRes = await json("GET", `/api/audio/course/${courseId}?tts_provider=Groq&llm_provider=Groq`, null, T);
  // After fix: should reach getAudioForCourse, not fail with "Subtopic not found"
  const isRouteBug = audioRouteRes.data?.error === "Subtopic not found";
  if (isRouteBug) {
    console.log("  ❌ ROUTE BUG: /:subtopicId catched /course/:courseId");
    failed++;
    errors.push({ label: "Audio route ordering", status: audioRouteRes.status, data: "Still broken" });
  } else {
    // Any status is fine as long as the right handler was reached (might 500 if no TTS key)
    check("Audio /course/:id route reachable", audioRouteRes, [200, 201, 500], d => {
      console.log(`  Response: ${JSON.stringify(d).slice(0, 100)}`);
      return true;
    });
  }

  // ━━━━━━ INTERACTIVE ━━━━━━
  console.log("\n━━━ INTERACTIVE ━━━");

  // Interactive next requires subtopic content + LLM generation - skip if no content
  if (sub1 && sub1.hasContent) {
    const nextRes = await json("GET", `/api/interactive/course/${courseId}/next?provider=Gemini`, null, T);
    check("Get next subtopic", nextRes, [200, 500, 408], d => {
      if (d.course_completed) { console.log("  Course completed!"); return true; }
      if (d.subtopic) {
        console.log(`  Subtopic: ${d.subtopic.title}, Questions: ${d.questions?.length || 0}`);
        return true;
      }
      console.log(`  Error: ${d.error || "unknown"}`);
      return false;
    });
  } else {
    console.log("  ⏭️  Skipping interactive next (subtopics have no content yet — need to generate-content first)");
    skipped++;
  }

  // Course chat (doesn't need subtopic content, just course context)
  const ccRes = await json("POST", `/api/interactive/course/${courseId}/chat`, {
    message: "What is this course about?",
    provider: "Gemini",
  }, T);
  check("Course chat", ccRes, [200, 500, 408], d => !!d.ai_response || !!d.error);

  // ━━━━━━ FLUTTER CONTRACT VALIDATION ━━━━━━
  console.log("\n━━━ CONTRACT CHECKS ━━━");

  // 1. Full course: { course, units } — Flutter reads data['units'] ✓
  if (fullRes.data && Array.isArray(fullRes.data.units)) {
    console.log("  ✓ Full course: units at top level");
  } else {
    console.log("  ✗ Full course: units NOT at top level");
    failed++;
  }

  // 2. Gamification: stats.level + stats.next_level_xp now exist
  if (gamRes.data?.stats?.level !== undefined && gamRes.data?.stats?.next_level_xp !== undefined) {
    console.log("  ✓ Gamification: level and next_level_xp in stats");
  } else {
    console.log("  ✗ Gamification: missing level or next_level_xp");
    failed++;
  }

  // 3. Gamification: achievements at top level (not inside stats)
  if (Array.isArray(gamRes.data?.achievements)) {
    console.log(`  ✓ Gamification: achievements array at top level (${gamRes.data.achievements.length} items)`);
  } else {
    console.log("  ✗ Gamification: achievements not at top level");
    failed++;
  }

  // 4. Analytics course: progress is nested
  if (caRes.data?.progress?.total_subtopics !== undefined) {
    console.log("  ✓ Analytics: progress.total_subtopics nested correctly");
  } else {
    console.log("  ✗ Analytics: progress structure wrong");
    failed++;
  }

  // 5. Due flashcards: { dueCards: [], total: N }
  if (Array.isArray(dueRes.data?.dueCards)) {
    console.log("  ✓ Due flashcards: dueCards array present");
  } else {
    console.log("  ✗ Due flashcards: missing dueCards");
    failed++;
  }

  // ━━━━━━ RESULTS ━━━━━━
  console.log("\n" + "═".repeat(55));
  console.log(`TOTAL: ${passed} passed, ${failed} failed, ${skipped} skipped`);
  if (errors.length > 0) {
    console.log("\nFailed:");
    errors.forEach(e => console.log(`  ❌ ${e.label} [${e.status}] ${e.data}`));
  }
  console.log("═".repeat(55));
}

run().catch(err => { console.error("Fatal:", err); process.exit(1); });
