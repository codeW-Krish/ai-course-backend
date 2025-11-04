# Optimization Guide for `controller/course.js`

## 1. Overview
`controller/course.js` handles the full lifecycle of a course:
- **Outline generation** (LLM call, validation, DB insert)
- **Unit & subtopic insertion**
- **Content generation** (batch LLM calls, YouTube video lookup)
- **Search, enrollment, and other CRUD operations**

The most time‑consuming part is the **LLM outline generation** and the **sub‑topic batch generation**, which involve network latency and multiple sequential DB writes.

---

## 2. Identified Performance Bottlenecks
| Area | Why it slows down | Current behavior |
|------|-------------------|------------------|
| **LLM call for outline** | Remote request to Gemini/Cerebras; waits for full response before proceeding. | `await llm(OUTLINE_SYSTEM_PROMPT, userInputs)` blocks the whole request. |
| **Sequential DB inserts** | Each unit and each subtopic is inserted one‑by‑one in a loop, causing many round‑trips to PostgreSQL. | `for (const unit ...) { await pool.query(...); for (const subtopic ...) { await pool.query(...); } }` |
| **Batch sub‑topic generation** | Generates content per unit, then iterates over each subtopic to update DB individually. | Multiple `await llm(SUBTOPIC_BATCH_PROMPT, batchInput)` + per‑subtopic `await pool.query` updates. |
| **YouTube video lookup** | Calls external API for every keyword, then checks/inserts each video separately. | `await fetchYoutubeVideos([...])` inside a loop, followed by `SELECT` + `INSERT` per video. |
| **No caching / reuse** | Same outline request may be repeated (e.g., retry) causing duplicate LLM calls. | No memoization or result caching. |

---

## 3. Optimizations

### 3.1 Parallel / Bulk Database Operations
- **Bulk insert units**: Build an array of unit values and use a single `INSERT ... VALUES (...), (...), ... RETURNING id`.
- **Bulk insert subtopics**: After unit IDs are known, insert all subtopics for a unit in one query (`INSERT INTO subtopics (id, unit_id, title, position) VALUES ...`).
- **Use `Promise.all`** for independent operations (e.g., inserting multiple units concurrently) while respecting transaction boundaries.

### 3.2 Reduce LLM Calls
- **Cache outline results**: Store the generated outline in a temporary cache (e.g., Redis) keyed by request hash. Reuse if the same parameters are requested within a short window.
- **Increase batch size**: Instead of chunking subtopics into groups of 3, send the maximum allowed batch (e.g., 10‑15) to the LLM to reduce the number of calls.
- **Pre‑fetch YouTube keywords**: Let the LLM return a list of all needed keywords for the whole outline, then perform a single batch YouTube search.

### 3.3 Asynchronous Background Generation
- **Move heavy content generation to a background worker** (already partially done via `generationQueue`). Ensure the initial outline response returns quickly, while sub‑topic content is generated asynchronously.
- **Use a job queue** (e.g., BullMQ) to schedule LLM calls and video lookups, allowing retries and concurrency limits.

### 3.4 Connection Pooling & Transaction Management
- Keep a single client connection for the whole outline creation (`await pool.connect();`), perform all inserts inside one transaction, then `COMMIT`. This avoids opening/closing connections per loop iteration.
- Set appropriate `max` pool size in `db/db.js` to handle concurrent requests.

### 3.5 HTTP/LLM Request Optimizations
- **Enable streaming** (if the provider supports it) to start processing partial responses earlier.
- **Compress request payloads** and enable keep‑alive on the HTTP client to reuse TCP connections.

### 3.6 Indexes & Query Tuning
- Ensure indexes on `courses(id)`, `units(course_id)`, `subtopics(unit_id)`, and `videos(subtopic_id)`.
- Use `SELECT ... WHERE id = $1` with primary key lookups (already optimal).

### 3.7 Code Refactor Using MCP Server
- Offload all LLM‑related logic to the **MCP server** (`mcp/tools/outlineTool.js`, `subtopicTool.js`). This isolates AI work, enables:
  - Centralized caching.
  - Rate‑limit handling.
  - Easier swapping of providers.
- The controller then becomes a thin wrapper that only validates input and persists results, dramatically reducing its execution time.

---

## 4. AI Agents & MCP Server – When & How to Use Them

| Task | Why use an AI agent (MCP tool) | Example MCP Tool |
|------|--------------------------------|------------------|
| **Course outline generation** | Centralizes prompt, validation, and caching; can be called from multiple services. | `generateOutline` (see `mcp/tools/outlineTool.js`) |
| **Batch sub‑topic content generation** | Handles large batches, can run in parallel workers, and returns structured JSON. | `generateSubtopics` (future tool) |
| **Search & filtering** | Provides a uniform API for full‑text or semantic search across courses. | `searchCourses` (could be added) |
| **YouTube video enrichment** | Encapsulates external API calls, adds retry/back‑off, and caches results. | `fetchYoutubeVideos` could be wrapped as an MCP resource. |
| **Background generation orchestration** | A dedicated MCP service can manage job queues, monitor progress, and expose status endpoints. | `generationQueue` integration with MCP. |
| **User‑specific personalization** | Agents can combine user profile data with LLM prompts to tailor outlines. | Custom `personalizeOutline` tool. |

**Benefits of MCP‑based agents**
- **Reusability**: Same tool can be invoked from any controller or micro‑service.
- **Scalability**: Deploy the MCP server separately, scale horizontally, and apply load‑balancing.
- **Observability**: Central logging, metrics, and error handling.
- **Security**: Enforce authentication/authorization once at the MCP layer.

---

## 5. Practical Steps to Apply Optimizations

1. **Refactor DB inserts**  
   - Replace per‑unit loops with bulk `INSERT` statements.  
   - Use a single transaction for the whole outline creation.

2. **Introduce caching**  
   - Add a Redis (or in‑memory) cache around `generateOutline`.  
   - Cache YouTube video results per keyword.

3. **Increase LLM batch size**  
   - Adjust `chunkArray` to send larger batches (up to provider limits).  

4. **Leverage MCP server**  
   - Ensure the controller calls `use_mcp_tool` for outline generation (already done in `testing-course.js`).  
   - Add a new MCP tool for sub‑topic generation and replace the inline LLM calls in `generateCourseContent`.

5. **Background processing**  
   - Confirm `generationQueue` runs as a separate process (e.g., `node mcp/server.js` + worker).  
   - Return early from the outline endpoint with a status URL for progress polling.

6. **Add indexes** (run once in DB migration):
   ```sql
   CREATE INDEX IF NOT EXISTS idx_courses_id ON courses(id);
   CREATE INDEX IF NOT EXISTS idx_units_course_id ON units(course_id);
   CREATE INDEX IF NOT EXISTS idx_subtopics_unit_id ON subtopics(unit_id);
   CREATE INDEX IF NOT EXISTS idx_videos_subtopic_id ON videos(subtopic_id);
   ```

7. **Monitor & profile**  
   - Use `pg_stat_activity` and request timing logs to identify remaining hot spots.  

---

## 6. Summary Checklist

- [x] Identify bottlenecks (LLM call, sequential DB writes, video lookups).
- [x] Propose bulk inserts and transaction usage.
- [x] Recommend caching for outline and YouTube results.
- [x] Suggest larger LLM batch sizes and streaming.
- [x] Outline MCP server benefits and use‑cases.
- [x] Provide concrete steps to refactor `controller/course.js`.
- [ ] Implement bulk insert queries in the controller.
- [ ] Add Redis cache layer around MCP outline tool.
- [ ] Create MCP sub‑topic generation tool.
- [ ] Adjust background generation queue to use new MCP tools.
- [ ] Deploy MCP server and verify endpoints.

---

*Apply these recommendations incrementally, testing each change for correctness and performance improvement.*
