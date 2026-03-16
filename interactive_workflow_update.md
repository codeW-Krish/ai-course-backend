# Interactive Learning Mode - Workflow Update

## Goal
Simplify the frontend workflow by allowing sequential content generation using `courseId` instead of managing `subtopicId`s.

## New Endpoint
`GET /api/interactive/course/:courseId/next`

### Logic
1.  **Auth**: Require valid user token.
2.  **Lookup**: Find the *first* subtopic for this course that is **NOT completed** by the user.
    *   Join `subtopics` -> `units` -> `courses`.
    *   Left Join `user_subtopic_progress` on `user_id` and `subtopic_id`.
    *   Order by `units.position`, `subtopics.position`.
    *   Condition: `user_subtopic_progress.is_completed IS NULL OR user_subtopic_progress.is_completed = FALSE`.
3.  **Action**:
    *   If no incomplete subtopic found -> Return `{ message: "Course Completed!" }`.
    *   If found -> Redirect to (or reuse logic of) `startSession(subtopicId)`.
        *   This ensures content is generated if missing.
        *   Returns content, questions, and progress.

## Implementation Details
1.  **Controller**: Add `getNextSubtopic` to `interactiveController.js`.
2.  **Routes**: Add `router.get("/course/:courseId/next", ...)` to `interactive.js`.
    *   **Important**: Place this *before* `/:subtopicId` if the pattern matches, or use a distinct path. Since `course/:id` is distinct from `:id` (UUID), it's safe, but specific paths first is best practice.

## Benefit
Frontend just has a "Start Learning" or "Next" button that calls this one endpoint. It automatically advances the user through the course.
