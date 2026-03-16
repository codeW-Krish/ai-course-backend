  
<div align="center"> <img src="https://readme-typing-svg.demolab.com?font=Fira+Code&weight=600&size=27&pause=1000&color=6366F1&center=true&vCenter=true&width=700&lines=UpSkill+AI+%E2%80%94+Backend;AI+Course+Generation+%2B+Quiz-Gated+Progression;Generates+a+course.+Enforces+you+learn+it." alt="UpSkill AI Backend" /> <br/>


>  _"Generates a course. Then enforces that you actually learn it."_
>  

[![Walkthrough](https://img.shields.io/badge/Watch_Walkthrough-FF0000?style=for-the-badge&logo=youtube&logoColor=white)](https://your-demo-link/) [![Android Client](https://img.shields.io/badge/Android_Client-7F52FF?style=for-the-badge&logo=kotlin&logoColor=white)](https://github.com/codeW-Krish/ai-course-generator) [![Node.js](https://img.shields.io/badge/Node.js_20-339933?style=for-the-badge&logo=nodedotjs&logoColor=white)](https://nodejs.org/) [![Express](https://img.shields.io/badge/Express_5-000000?style=for-the-badge&logo=express&logoColor=white)](https://expressjs.com/) [![Firebase](https://img.shields.io/badge/Firestore-FFCA28?style=for-the-badge&logo=firebase&logoColor=black)](https://firebase.google.com/) [![Groq](https://img.shields.io/badge/Groq-F55036?style=for-the-badge)](https://groq.com/) [![Cerebras](https://img.shields.io/badge/Cerebras-2563eb?style=for-the-badge)](https://cerebras.ai/) [![Gemini](https://img.shields.io/badge/Gemini-1a73e8?style=for-the-badge&logo=google&logoColor=white)](https://deepmind.google/gemini) [![SSE](https://img.shields.io/badge/SSE_Streaming-9333ea?style=for-the-badge)](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events)

</div>

----------


A production-grade AI learning platform backend that generates structured courses with quizzes, flashcards, audio overviews, and explanation videos — then makes sure you go through them before moving on.

  

**The problem it solves:** Users generate a full 50-subtopic course (expensive), then abandon it after subtopic 2. UpSkill AI generates content interactively, one subtopic unlocks only after you pass a quiz on the previous one. No passing score, no next lesson. This enforces real learning checkpoints and eliminates wasted generation costs in a single architectural decision.

  

**What gets generated per subtopic:** structured notes -> audio overview -> short explanation video -> MCQ + fill-in-the-blank quiz -> flashcards

  

**The explanation video pipeline (the interesting part):** Generates narration script + synchronized visuals without calling a video-generation LLM. Narration audio and visual components are produced separately and assembled — same output quality at a fraction of the cost. No dependency on a single expensive video API. Dynamic routing across Groq, Cerebras, and Gemini based on latency requirements, throughput, and task complexity. Result: **50 subtopics generated in 24 seconds** via Groq inference with SSE streaming.

  

**Pedagogical design:** "Why-first" sequencing is built into the system prompt architecture — every subtopic opens with why this matters before teaching what it is. That is a deliberate content structure decision, not a template.

  

**Stack:** Kotlin (Android client) · Node.js + Express (backend) · Aiven Cloud PostgreSQL (previously in v1) · Firebase · Groq + Cerebras + Gemini APIs · SSE streaming · app write for object storage

In-depth

## What this is

UpSkill AI is the Node.js backend for a mobile-first AI learning platform. It generates structured courses — notes, quizzes, flashcards, audio overviews, and explanation videos — one subtopic at a time, and gates progression on quiz completion. The next subtopic only unlocks after the user passes the current quiz. This is not a UI constraint. It is an enforced backend contract: `getNextContent` checks progress state, `submitQuiz` writes completion, and content generation for subtopic N+1 does not begin until that completion record exists.

The core failure mode it solves: users generate a full 50-subtopic course (expensive API call), abandon it after subtopic 2, and the cost is gone with nothing learned. This architecture makes API spend scale with actual learning engagement, not with how much content someone requested and ignored.

----------


## Architecture

<p align="center">
  <img src="./diagrams/Light Mode/Backend Diagram 2.svg" alt="UpSkill AI Architecture" width="100%" />
</p>


> For extended architecture diagrams and data flow maps see [ARCHITECTURE.md](./ARCHITECTURE.md)

----------


## The interesting engineering

The first version of this backend did what every AI course platform does: generate everything upfront, hand it to the user, hope they finish it.They didn't. A 50-subtopic course would get generated, opened, and abandoned by subtopic 3 that leads to expensive API cost, zero learning. So the architecture changed.

Content now generates one subtopic at a time. The next one only exists after you pass a quiz on the current one. That single decision — moving the learning gate from a UI suggestion into a server-side contract enforced by `submitQuiz` writing to `user_subtopic_progress` — changed the entire system shape. More state transitions, more edge cases, but API spend now scales with actual engagement instead of optimism.

The video pipeline came from the same instinct. The obvious move was calling a video-generation model. The actual move was decomposing the problem: generate a narration script, synthesize chunked audio with measured WAV durations, render visuals from SVG or image providers, assemble a manifest the client plays in sync. No video model. Lower cost, deterministic scene timing, and if one scene breaks only that scene regenerates not the whole video. The multi-provider routing layer exists because Groq, Cerebras, and Gemini are not interchangeable. Groq wins on latency for interactive subtopic delivery. Cerebras wins on throughput when generating a full course in one pass. Gemini
handles the reasoning-heavy tasks. `getLLMProvider` in `providers/LLMProviders.js` gives every controller the same interface regardless of which engine runs underneath.

The pedagogical structure — every subtopic opening with *why this matters* before any concept explanation — is not a writing style. It is a required field in `llm/outlineSchemas.js`, validated by Zod before anything persists. If the model skips it, the response is rejected. Consistency enforced at the schema level, not hoped for at the prompt level.

> For the full technical breakdown of each decision — trade-offs, file references,
> routing tables, and the video manifest schema — see [ENGINEERING.md](./ENGINEERING.md)


----------

## Content generation pipeline

```
POST /api/courses/generate-outline
  → validate input
  → call LLM with OUTLINE_SYSTEM_PROMPT
  → persist: course → units → subtopics (empty placeholders)

Content generation — two strategies:
  ├── Batched streaming (non-Cerebras): 3 subtopics/batch, SSE progress per batch
  └── Full-course pass (Cerebras): single aggregated response, progress during persistence

Interactive progression loop:
  GET  /api/interactive/next-content
    → find next uncompleted subtopic from user_subtopic_progress
    → generate content if missing (generateContentOnly)
    → kick quiz generation to background (generateQuizOnly)
    → return content immediately

  POST /api/interactive/submit-quiz
    → validate answers against subtopic_questions
    → write completion + hearts/attempts to user_subtopic_progress
    → next subtopic becomes available

Per subtopic artifacts:
  ├── Structured notes        (why → what → how)
  ├── MCQ + fill-in-blank     (subtopic_questions collection)
  ├── Flashcards              (feature collection)
  ├── Audio overview          (TTS script → WAV → ImageKit URL)
  └── Explanation video       (script → scenes → visuals + audio → manifest JSON)

```


----------

## Tech stack

Layer

Technology

Why

API Server

Node.js · Express 5

Fast route orchestration, SSE-friendly response handling

Auth

Firebase Auth Admin SDK · JWT

Token verification across all protected routes

Data Store

Firebase Firestore

Document model maps naturally to course → unit → subtopic → artifact

LLM Router

Custom `getLLMProvider`

Per-request provider and model control without changing controller interfaces

LLM Providers

Groq · Cerebras · Gemini · GLM

Different latency/throughput/reasoning profiles per task type

Schema Validation

Zod

Strict JSON contracts — malformed responses rejected before persistence

Streaming

Server-Sent Events

Real-time generation progress with low mobile integration overhead

Audio / TTS

Groq TTS · Resemble

Chunked narration with WAV duration measurement for video sync

Visual Pipeline

SVG generator · Resvg/Sharp · image APIs

Structured scene rendering with provider fallback per scene

Asset CDN

ImageKit

Hosts generated images and audio for manifest playback

Video Delivery

Manifest-first JSON

Avoids server-side video rendering; client plays scene assets in sync

----------

## Running locally

**Prerequisites:** Node.js 20+, Firebase project with Firestore enabled, at least one LLM provider API key.

### 1 — Install

```bash
npm install

```

### 2 — Configure environment

Create `.env` in the project root (no `.env.example` is committed — add one if you fork):

```env
PORT=3030

ACCESS_TOKEN_SECRET=replace_with_long_random_string
REFRESH_TOKEN_SECRET=replace_with_long_random_string
JWT_SECRET=replace_with_long_random_string

# At minimum configure one LLM provider
GROQ_API_KEY=your_groq_key
CEREBRAS_API_KEY=your_cerebras_key
GEMINI_API_KEY=your_gemini_key

# Media pipeline
IMAGEKIT_PUBLIC_KEY=your_imagekit_public_key
IMAGEKIT_PRIVATE_KEY=your_imagekit_private_key
IMAGEKIT_URL_ENDPOINT=https://ik.imagekit.io/your_id

```

Firebase — one of two modes (see `db/firebase.js`):

```env
# Option A — JSON string in env (hosted environments)
FIREBASE_SERVICE_ACCOUNT={"type":"service_account","project_id":"..."}

# Option B — local file (local dev)
# Place file at: cert/serviceAccountKey.json

```

### 3 — Start

```bash
# Development
npm run dev

# Production
npm start

```

```bash
# Health check
curl http://localhost:3030/api/health

```

### 4 — Tests

```bash
npm run test:auth-contract
node test/integration-test.js
node test/p0-test.js
node test/db-test.js
node test/phaseab-smoke.js

```

----------

## What I learned

The hardest part was not the LLM calls — it was everything around them. Building the explanation video pipeline without a video-generation model taught me that you can decompose almost any "expensive API" problem into smaller, cheaper, more controllable pieces: generate the script, synthesize the audio, render the
visuals separately, measure the WAV duration, assemble the manifest. The output is equivalent and you own every stage. The audio overview pipeline followed the same logic — chunked TTS with measured durations so playback sync is deterministic, not estimated.

The gamification layer (hearts, retry limits, quiz-gated progression) taught me that keeping users in active learning mode is an architecture decision, not a UI decision. If the gate lives in the app it gets bypassed. If it lives in` user_subtopic_progress` and `submitQuiz` enforces it server-side, it cannot. The YouTube suggestion per subtopic was a small addition that had a disproportionate impact — giving users a "go deeper" path right after the quiz keeps them in the learning context instead of dropping them back to a home screen with nothing to do.

If I rebuilt this I would define the manifest schema and every content contract before writing a single prompt — fixing output format issues across six contenttypes mid-development is significantly more expensive than designing them upfront.

----------

## Related repos

Repo

Description

[ai-course-generator](https://github.com/codeW-Krish/ai-course-generator)

Android client — Kotlin, consumes this backend

[docu-chat](https://github.com/codeW-Krish/docu-chat)

Multi-document RAG with real-time passage highlighting

----------

<div align="center">

Made by [Krish Dalsaniya](https://github.com/codeW-Krish) · [LinkedIn](https://linkedin.com/in/YOUR-LINKEDIN) · [Watch Walkthrough](https://your-demo-link/)

</div>