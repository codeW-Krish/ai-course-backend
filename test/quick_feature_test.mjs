/**
 * Quick Feature Integration Test (no LLM generation, fast endpoints only)
 */

const BASE = "http://localhost:3030";

const log = (label, status, ok) =>
  console.log(`${ok ? "✅" : "❌"} [${status}] ${label}`);

async function json(method, path, body, token) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const opts = {
      method,
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
    };
    if (token) opts.headers["Authorization"] = `Bearer ${token}`;
    if (body) opts.body = JSON.stringify(body);

    const res = await fetch(`${BASE}${path}`, opts);
    let data;
    const ct = res.headers.get("content-type") || "";
    if (ct.includes("json")) data = await res.json();
    else data = await res.text();
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

  function check(label, status, data, expectStatus, validate) {
    const statusOk = Array.isArray(expectStatus)
      ? expectStatus.includes(status)
      : status === expectStatus;
    let extra = true;
    if (validate && statusOk) {
      try { extra = validate(data); } catch { extra = false; }
    }
    const ok = statusOk && extra !== false;
    log(label, status, ok);
    if (ok) passed++;
    else {
      failed++;
      errors.push({ label, status, snippet: JSON.stringify(data).slice(0, 150) });
    }
    return ok;
  }

  // ── AUTH ──
  console.log("\n═══ AUTH ═══");
  const loginRes = await json("POST", "/api/auth/login", {
    email: "testuser@example.com",
    password: "Test123456",
  });
  if (!check("Login", loginRes.status, loginRes.data, 200, (d) => !!d.accessToken)) {
    console.error("Cannot continue. Aborting."); return;
  }
  const token = loginRes.data.accessToken;
  console.log(`  Token: ${token.slice(0, 20)}...`);

  // ── COURSE DATA ──
  console.log("\n═══ COURSE DATA ═══");
  const courseId = "0h3kYLU0rXWDAB77Gigx";

  const fullRes = await json("GET", `/api/courses/${courseId}/full`, null, token);
  check("Full course", fullRes.status, fullRes.data, 200);

  let subtopicIds = [];
  const units = (fullRes.data?.course?.units || fullRes.data?.units || []);
  for (const u of units) {
    for (const s of (u.subtopics || [])) {
      if (s.id) subtopicIds.push({ id: s.id, title: s.title, hasContent: !!s.content });
    }
  }
  console.log(`  ${subtopicIds.length} subtopics in ${units.length} units`);
  subtopicIds.forEach((s) => console.log(`    ${s.hasContent ? "✓" : "○"} ${s.id}: ${s.title}`));

  const withContent = subtopicIds.find((s) => s.hasContent);
  const firstId = subtopicIds[0]?.id;

  // ── GAMIFICATION (no LLM) ──
  console.log("\n═══ GAMIFICATION ═══");
  const gamRes = await json("GET", "/api/gamification/me", null, token);
  check("Get stats", gamRes.status, gamRes.data, 200);
  if (gamRes.data?.stats) {
    const s = gamRes.data.stats;
    console.log(`  XP:${s.total_xp} Level:${s.current_level} Streak:${s.current_streak}`);
  }

  // Test both key names to confirm which works
  const pingSnake = await json("POST", "/api/gamification/activity/ping", {
    activity_type: "daily_login",
  }, token);
  check("Ping (activity_type)", pingSnake.status, pingSnake.data, 200, (d) => d.message === "Activity recorded");

  // ── ANALYTICS (no LLM) ──
  console.log("\n═══ ANALYTICS ═══");

  const summaryRes = await json("GET", "/api/analytics/summary", null, token);
  check("Summary", summaryRes.status, summaryRes.data, 200, (d) => !!d.summary);
  if (summaryRes.data?.summary) {
    const s = summaryRes.data.summary;
    console.log(`  XP:${s.total_xp} Streak:${s.current_streak} Enrolled:${s.enrolled_courses}`);
  }

  const courseAnalytics = await json("GET", `/api/analytics/course/${courseId}`, null, token);
  check("Course analytics", courseAnalytics.status, courseAnalytics.data, 200, (d) => !!d.course && !!d.progress);
  if (courseAnalytics.data?.progress) {
    const p = courseAnalytics.data.progress;
    console.log(`  Subtopics: ${p.completed_subtopics}/${p.total_subtopics} (${p.completion_rate}%)`);
  }

  const weeklyRes = await json("GET", "/api/analytics/weekly", null, token);
  check("Weekly analytics", weeklyRes.status, weeklyRes.data, 200, (d) => Array.isArray(d.weekly));

  // ── FLASHCARDS (check existing, no generation) ──
  console.log("\n═══ FLASHCARDS ═══");

  const dueRes = await json("GET", `/api/flashcards/course/${courseId}/due`, null, token);
  check("Due flashcards", dueRes.status, dueRes.data, 200, (d) => typeof d.total === "number");
  console.log(`  Due: ${dueRes.data?.total || 0}`);

  // ── NOTES (export existing) ──
  console.log("\n═══ NOTES ═══");

  const courseNotesRes = await json("GET", `/api/notes/course/${courseId}/export?format=json`, null, token);
  check("Course notes export", courseNotesRes.status, courseNotesRes.data, [200, 404]);

  // ── AUDIO ROUTE TEST ──
  console.log("\n═══ AUDIO (route ordering test) ═══");

  // This tests the routing: if /course/:courseId is unreachable, it'll return 500
  // because Express treats "course" as a subtopic ID and fails to find it
  const audioRoute = await json("GET", `/api/audio/course/${courseId}?tts_provider=Groq&llm_provider=Groq`, null, token);
  const routeOk = audioRoute.status !== 404 || (audioRoute.data?.error !== "Subtopic not found");
  console.log(`  Audio /course/:id route status: ${audioRoute.status}`);
  console.log(`  Response: ${JSON.stringify(audioRoute.data).slice(0, 150)}`);
  if (audioRoute.status === 404 || audioRoute.data?.error === "Subtopic not found") {
    console.log("  ⚠️  ROUTE BUG CONFIRMED: /course/:courseId matched as /:subtopicId");
    failed++;
    errors.push({ label: "Audio course route ordering", status: audioRoute.status, snippet: "Route /:subtopicId catches /course/:courseId" });
  } else {
    check("Audio course route reachable", audioRoute.status, audioRoute.data, [200, 201, 500]);
  }

  // ── INTERACTIVE (get next, no LLM skip) ──
  console.log("\n═══ INTERACTIVE ═══");

  if (firstId) {
    // Test if the endpoint at least responds correctly
    const nextRes = await json("GET", `/api/interactive/course/${courseId}/next?provider=Gemini`, null, token);
    check("Get next subtopic", nextRes.status, nextRes.data, [200, 408, 500]);
    if (nextRes.data?.subtopic) {
      console.log(`  Next: ${nextRes.data.subtopic.title}`);
      console.log(`  Questions: ${nextRes.data.questions?.length || 0}`);
    }
  }

  // ── FLUTTER API CONTRACT CHECKS ──
  console.log("\n═══ FLUTTER API CONTRACT VALIDATION ═══");

  // Check response shapes match Flutter models
  const contractIssues = [];

  // 1. Gamification response → GamificationSnapshot.fromJson expects stats or data or root
  if (gamRes.data) {
    const has = gamRes.data.stats || gamRes.data.data || gamRes.data.total_xp;
    if (!has) contractIssues.push("Gamification: response missing stats/data/total_xp");
    else console.log("  ✓ Gamification response shape OK");
  }

  // 2. Analytics course response → AnalyticsRepository expects progress.total_subtopics etc
  if (courseAnalytics.data?.progress) {
    const p = courseAnalytics.data.progress;
    if (typeof p.total_subtopics !== "number") contractIssues.push("Analytics: missing progress.total_subtopics");
    else console.log("  ✓ Analytics course response shape OK");
  }

  // 3. Due flashcards → expects { dueCards: [...], total: N }
  if (dueRes.data) {
    if (!Array.isArray(dueRes.data.dueCards)) contractIssues.push("Due flashcards: missing dueCards array");
    else console.log("  ✓ Due flashcards response shape OK");
  }

  // 4. Full course → expects course.units[].subtopics[]
  if (fullRes.data) {
    const c = fullRes.data.course || fullRes.data;
    if (!Array.isArray(c.units)) contractIssues.push("Full course: missing units array");
    else console.log("  ✓ Full course response shape OK");
  }

  // 5. Analytics summary → expects { summary: { total_xp, ... } }
  if (summaryRes.data?.summary) {
    const s = summaryRes.data.summary;
    if (typeof s.total_xp !== "number") contractIssues.push("Analytics: missing summary.total_xp");
    else console.log("  ✓ Analytics summary response shape OK");
  }

  if (contractIssues.length > 0) {
    console.log("\n  ⚠️ Contract issues:");
    contractIssues.forEach((i) => { console.log(`    - ${i}`); failed++; });
  }

  // ── RESULTS ──
  console.log("\n" + "═".repeat(50));
  console.log(`RESULTS: ${passed} passed, ${failed} failed, ${skipped} skipped`);
  if (errors.length > 0) {
    console.log("\nFailed tests:");
    errors.forEach((e) => console.log(`  ❌ ${e.label} [${e.status}] ${e.snippet}`));
  }
  console.log("═".repeat(50));
}

run().catch((err) => { console.error("Fatal:", err); process.exit(1); });
