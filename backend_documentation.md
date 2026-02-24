# Backend Documentation

## 1. Project Overview & Structure

**Directory Path**: `d:\AI Course Generator App\backend`
**Tech Stack**: Node.js, Express, PostgreSQL, Google Gemini / Groq / Cerebras (LLMs).

### File Structure and Purpose

- **`index.js`**: Application entry point. Sets up Express app, CORS, middleware, and mounts routes.
- **`routes/`**: API Route definitions.
    - `auth.js`: Authentication routes (Register, Login, etc.).
    - `course.js`: Core course generation and management endpoints.
    - `admin.js`: Admin-only endpoints for managing courses and settings.
    - `settings.js`: Public settings retrieval.
- **`controller/`**: Logic for handling API requests.
    - `auth.js`: Handles user authentication and token management.
    - `course.js`: **Core Logic**. Handles course creation, LLM interaction, content generation (streaming & batching), enrollment, and progress tracking.
- **`service/`**: External services and business logic.
    - `geminiService.js`: Integration with Google Gemini API.
    - `youtubeService.js`: Fetches relevant YouTube videos for course subtopics.
    - `generationQueue.js`: Manages background generation tasks.
    - `cerebrasService.js`, `groqService.js`: Integrations for other LLM providers.
- **`models/`**: Data Access Layer (DAL) classes wrapping SQL queries.
    - `User.js`, `Course.js`, `GlobalSettings.js`, `RefreshToken.js`.
- **`middleware/`**:
    - `authMiddleware.js`: Verifies JWT Access Tokens.
    - `adminMiddleware.js`: Verifies Admin role.
- **`llm/`**:
    - `outlineSchemas.js`: Zod schemas for validating LLM inputs/outputs (Course Outline, Subtopic Content).
- **`prompts/`**: System prompts for LLMs (Outline generation, Subtopic content generation).
- **`db/`**: Database connection configuration (`db.js`).

---

## 2. Application Workflow

### Course Generation Flow
1.  **Drafting**: User requests a course topic via `POST /api/courses/generate-outline`.
    -   Backend calls LLM (Gemini/Groq) to generate a structured outline (Units & Subtopics).
    -   Course is saved in DB with status `draft`.
2.  **Refinement**: User views the outline and can modify it via `PUT /api/courses/:id/outline` or `POST .../regenerate`.
3.  **Content Generation**:
    -   **Streaming (Interactive)**: User triggers `POST /api/courses/:id/generate-content-stream`. Backend uses Server-Sent Events (SSE) to stream generated subtopic content back to the client in real-time.
    -   **Batch (Background/Instant)**: User triggers `POST /api/courses/:id/generate-content`.
        -   If **Cerebras** provider: Generates all content instantly in one massive batch.
        -   Others: Queues background jobs to generate content unit-by-unit.
4.  **Enrichment**: For every generated subtopic, the backend asynchronously searches YouTube APIs for relevant videos based on keywords returned by the LLM.
5.  **Consumption**: User accesses full content via `GET /api/courses/:id/full`.

---

## 3. API Documentation

### **Authentication**
**Base URL**: `/api/auth`

#### `POST /register`
-   **Description**: Register a new user.
-   **Body**:
    ```json
    {
      "email": "user@example.com",
      "password": "password123", // min 8 chars
      "name": "John Doe"
    }
    ```
-   **Response (201)**:
    ```json
    {
      "message": "User Created",
      "user": { "id": "uuid", "email": "...", "username": "...", "role": "user" },
      "accessToken": "jwt_token",
      "refreshToken": "jwt_token"
    }
    ```

#### `POST /login`
-   **Description**: Authenticate user.
-   **Body**: `{ "email": "...", "password": "..." }`
-   **Response (200)**: Same as register.

#### `POST /logout`
-   **Description**: Revoke refresh token.
-   **Body**: `{ "refreshToken": "..." }` (or via `x-refresh-token` header)

#### `POST /refresh`
-   **Description**: Get new access token using refresh token.
-   **Body**: `{ "refreshToken": "..." }`
-   **Response (201)**: `{ "accessToken": "...", "refreshToken": "..." }`

---

### **Courses**
**Base URL**: `/api/courses`
**Auth**: Most endpoints require `Authorization: Bearer <token>` header.

#### `POST /generate-outline`
-   **Description**: Generates a course outline using LLM.
-   **Body**:
    ```json
    {
      "title": "Learn Python",
      "description": "Complete beginner guide...",
      "numUnits": 5,
      "difficulty": "Beginner", // "Beginner" | "Intermediate" | "Advanced"
      "includeVideos": true,
      "provider": "Gemini", // optional
      "model": "gemini-1.5-flash" // optional
    }
    ```
-   **Response (201)**:
    ```json
    {
      "courseId": "uuid",
      "status": "draft",
      "outline": {
        "course_title": "...",
        "units": [
          { "title": "Unit 1", "position": 1, "subtopics": ["Topic A", "Topic B"] }
        ]
      }
    }
    ```

#### `GET /:id/full`
-   **Description**: Get full course details including units, subtopics, content, and videos.
-   **Response (200)**:
    ```json
    {
      "course": { "id": "...", "title": "...", ... },
      "units": [
        {
          "id": "...",
          "title": "Unit 1",
          "subtopics": [
            {
              "id": "...",
              "title": "Topic A",
              "content": { ... }, // JSON content from LLM
              "videos": [ { "title": "...", "youtube_url": "..." } ]
            }
          ]
        }
      ]
    }
    ```

#### `POST /:id/generate-content`
-   **Description**: Trigger content generation for a course (Batch/Background).
-   **Body**: `{ "provider": "Groq", "model": "..." }`
-   **Response (200)**:
    ```json
    {
      "message": "First X units generated...",
      "status": "in_progress"
    }
    ```

#### `GET /:id/generate-content-stream`
-   **Type**: **Server-Sent Events (SSE)**
-   **Description**: Streams generation progress and content in real-time.
-   **Events**:
    -   `start`: `{ total, provider }`
    -   `chunk`: `{ subtopic: "...", chunk: "partial json..." }`
    -   `progress`: `{ subtopic: "...", progress: 50, generated: 1, total: 10 }`
    -   `complete`: `{ generated, total }`

#### `GET /search/full`
-   **Description**: Advanced search with filtering.
-   **Query Params**:
    -   `query`: Search text
    -   `difficulty`: Filter (e.g., "Beginner")
    -   `sortBy`: "Newest", "Most_Enrolled", "difficulty_asc", "difficulty_desc"
-   **Response**: `{ "courses": [ ... ] }`

#### `POST /:id/enroll`
-   **Description**: Enroll current user in a public course.
-   **Response**: `{ "message": "Enrolled Successfully" }`

#### `GET /me/enrolled`
-   **Description**: Get courses the user is enrolled in.

#### `POST /subtopics/:id/complete`
-   **Description**: Mark subtopic as complete/incomplete.
-   **Body**: `{ "completed": true }`

#### `POST /subtopics/:id/notes`
-   **Description**: Save user notes for a subtopic.
-   **Body**: `{ "note": "My study notes..." }`

---

### **Admin**
**Base URL**: `/api/admin`
**Auth**: Requires `role: "admin"` in JWT.

#### `GET /courses`
-   **Description**: List all courses in the system.

#### `DELETE /courses/:id`
-   **Description**: Delete any course.

#### `GET /settings`
-   **Description**: Get global system settings.

#### `PUT /settings/:key`
-   **Description**: Update a specific setting.

#### `PUT /providers/available`
-   **Description**: Update list of allowed LLM providers.
-   **Body**: `{ "providers": ["Groq", "Gemini"] }`

---

## 4. Database Schema (Inferred)

-   **users**: `id, email, password_hash, username, role, created_at`
-   **courses**: `id, created_by, title, description, difficulty, include_videos, status, outline_json, is_public, created_at`
-   **units**: `id, course_id, title, position`
-   **subtopics**: `id, unit_id, title, position, content (JSON), content_generated_at`
-   **videos**: `id, subtopic_id, title, youtube_url, thumbnail, duration_sec`
-   **user_courses**: `user_id, course_id, joined_at`
-   **user_progress**: `user_id, subtopic_id` (Tracks completion)
-   **user_notes**: `user_id, subtopic_id, note`
-   **refresh_tokens**: `id, user_id, token, expires_at`
-   **global_settings**: `key, value, description`
-   **course_public_stats**: `course_id, total_users_joined`
