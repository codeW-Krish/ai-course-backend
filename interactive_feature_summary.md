# Interactive Learning Mode - Backend Implementation Summary

✅ **Status**: Fully Implemented & Ready for Frontend Integration.
This feature includes persistent learning sessions, gamification (hearts), AI-generated interactive content (Micro-subtopics + MCQs), and context-aware chat.

---

## 📂 1. Code Locations & Files

| Component | File Path | Purpose |
| :--- | :--- | :--- |
| **Routes** | `backend/routes/interactive.js` | API Endpoints (`/api/interactive/...`) |
| **Controller** | `backend/controller/interactiveController.js` | Core logic: Start session, Verify answer, Chat |
| **Database** | `backend/db/init_interactive.sql` | SQL script that created the new tables |
| **Prompts** | `backend/prompts/interactivePrompts.js` | System prompts for generating content & chat |
| **Schemas** | `backend/llm/interactiveSchemas.js` | Zod schemas to ensure valid JSON from AI |
| **Entry Point** | `backend/index.js` | Mounted `/api/interactive` |

---

## 🗄️ 2. Database Changes (Persistence)
The following tables verify that all data is saved securely:

1.  **`subtopic_questions`**: Stores generated MCQs/Fill-in-the-blanks so they don't disappear.
    *   *Columns*: `subtopic_id`, `question_text`, `options`, `correct_answer`, `hint`.
2.  **`user_subtopic_progress`**: Tracks user's game state.
    *   *Columns*: `hearts_remaining` (Default 3), `attempts`, `is_completed`.
3.  **`subtopic_chat`**: Logs all Q&A with the AI tutor.
    *   *Columns*: `user_message`, `ai_response`.

---

## ⚡ 3. Logic & Workflow

### **A. Starting a Session (`GET /:subtopicId`)**
*   **Logic**:
    1.  Checks if `subtopics` table has `content` (the text explanation).
    2.  **If Missing**: Calls LLM (`Gemini`) with `INTERACTIVE_SUBTOPIC_PROMPT`.
        *   Generates a concise explanation.
        *   Generates 3-5 subtopic-specific questions.
        *   **SAVES** everything to DB (`subtopics` and `subtopic_questions`).
    3.  **If Exists**: Loads from DB.
    4.  **User State**: checks `user_subtopic_progress` to see if user has `hearts_remaining` or is already done.
*   **Result**: Returns the explanation text + questions (without answers) + user stats.

### **B. Verifying an Answer (`POST /:subtopicId/verify`)**
*   **Logic**:
    1.  Fetches the `correct_answer` from DB.
    2.  Compares with user input (case-insensitive).
    3.  **If Correct**: Returns `correct: true`.
    4.  **If Wrong**: Decrements `hearts_remaining` in DB. Returns `correct: false` and the `hint`.
    5.  **Game Over**: If hearts hit 0, frontend can trigger a "Review" or "Retry" flow.

### **C. Asking AI (`POST /:subtopicId/chat`)**
*   **Logic**:
    1.  Fetches full context (Course Title, Unit, Subtopic Content) from DB.
    2.  Injects this into `SUBTOPIC_CHAT_PROMPT`.
    3.  Calls LLM to answer the user's specific question **only** using that context.
    4.  Logs the conversation to `subtopic_chat`.

---

### D. Sequential Learning Flow (`GET /course/:courseId/next`)
*   **Purpose**: Automatically finds the next uncompleted subtopic for the user.
*   **Logic**:
    1.  Looks for the first subtopic in the course that is **NOT** marked as completed by the user.
    2.  If found, invokes the **Start Session** logic (Generates content if needed).
    3.  Returns a **Flat JSON Response** with content + questions.
    4.  If all subtopics are completed, returns `{ "message": "Course Completed", "course_completed": true }`.
*   **Frontend Usage**: Call this when "Start Learning" or "Next" is clicked.

---

## 🚀 4. How to Use (Frontend)

1.  **Start/Next**: Call `GET /api/interactive/course/{courseId}/next`.
    *   Result: flattened Subtopic Object OR `{ course_completed: true }`.
2.  **Specific/Resume**: Call `GET /api/interactive/{subtopic_id}`.
    *   Result: flattened Subtopic Object (Same format as Next).
3.  **Verify**: Call `POST /api/interactive/{subtopic_id}/verify` with `{ questionId, answer }`.
    *   Result: Feedback + Game state.
    *   If `is_is_completed: true`, show "Next" button.
4.  **Chat**: Call `POST /api/interactive/{subtopic_id}/chat` with `{ message }`.

---

## ✅ Final Confirmation
*   **Persistence**: Yes, questions and progress are stored in Postgres.
*   **AI Integration**: Yes, uses Gemini (via `LLMProviders`) with structured JSON prompts.
*   **Error Handling**: Yes, includes try/catch blocks and 404/500 checks.
