# UpSkill AI - Architecture Diagrams

## 1) Full System Architecture (Client + Backend)
<p align="center">
  <img src="./diagrams/Dark Mode/1. Full System Architecture (Client + Backend) (Dark Mode).svg" alt="UpSkill AI Architecture" width="100%" />
</p>


## 2) Interactive Learning and Quiz-Gated Unlock Flow

```mermaid
sequenceDiagram
    participant U as User
    participant A as Android App
    participant API as Interactive API
    participant DB as Firestore
    participant LLM as LLM Provider

    U->>A: Start learning
    A->>API: GET /interactive/course/:courseId/next-content
    API->>DB: Find first uncompleted subtopic

    alt Content missing
        API->>LLM: Generate content only
        LLM-->>API: content JSON
        API->>DB: Save content
    end

    API-->>A: Return content and progress
    API->>LLM: Generate quiz in background
    LLM-->>API: quiz JSON
    API->>DB: Save quiz questions

    U->>A: Submit quiz answers
    A->>API: POST /interactive/:subtopicId/submit-quiz
    API->>DB: Update hearts, attempts, completion

    alt Passed
        API->>DB: Mark subtopic complete + grant XP
        API-->>A: unlocked = true
    else Failed
        API-->>A: unlocked = false
    end
```

## 3) LLM Routing Logic by Task Type

```mermaid
flowchart TD
    A[Incoming Generation Request] --> B{Task Type}

    B -->|Full-course batch generation| C[Cerebras Path]
    B -->|Low-latency interactive or default generation| D[Groq Path]
    B -->|Reasoning-heavy or explicitly requested| E[Gemini Path]

    C --> F[Generate in large batch]
    D --> G[Generate in small batches or single task]
    E --> H[Generate with reasoning-focused model]

    F --> I[Validate with Zod schema]
    G --> I
    H --> I

    I --> J[Persist to Firestore]
    J --> K[Return JSON or stream progress]
```

## 4) SSE Streaming Course Generation Lifecycle

```mermaid
sequenceDiagram
    participant A as Android App
    participant API as Course API
    participant LLM as LLM Provider
    participant DB as Firestore

    A->>API: POST /courses/:id/generate-content-stream
    API-->>A: event:start

    loop For each batch or generated subtopic
        API->>LLM: Generate subtopic content
        LLM-->>API: content JSON
        API->>DB: Save subtopic content
        API-->>A: event:progress
        API-->>A: event:chunk
    end

    API->>DB: Save generation status completed
    API-->>A: event:complete
```

## 5) Explanation Video Manifest-First Pipeline

```mermaid
flowchart LR
    A[Subtopic Content] --> B[Script Generation]
    B --> C[Scene Planning]

    C --> D{Scene Type}
    D -->|Illustration| E[Image Provider Pipeline]
    D -->|Diagram or Code or Timeline or Comparison or Quote| F[SVG Generation]

    E --> G[Upload Visual to ImageKit]
    F --> H[SVG to PNG Render]
    H --> G

    C --> I[TTS per Script Chunk]
    I --> J[Upload Audio to ImageKit]

    G --> K[Transition Planning]
    J --> K
    K --> L[Build Manifest JSON]
    L --> M[(Firestore video_manifests)]
    M --> N[Client Playback]
```

## 6) Notes Generation Pipeline

```mermaid
flowchart LR
    A[Request Notes for Subtopic] --> B[Check Firestore Cache\ngenerated_notes/{subtopicId}]
    B -->|Cache Hit| C[Return Existing Notes]
    B -->|Cache Miss| D[Resolve Course, Unit, Subtopic Context]

    D --> E[LLM Prompt for Structured Notes]
    E --> F[Validate with Zod\nGeneratedNotesSchema]
    F -->|Valid| G[Persist to Firestore\ngenerated_notes]
    F -->|Invalid| H[Return Validation Error]

    G --> I[Return Notes Payload]
    C --> I
```

## 7) Flashcards Generation and Review Pipeline

```mermaid
flowchart LR
    A[Request Flashcards for Subtopic] --> B[Query flashcards by subtopic_id]
    B -->|Found| C[Load User Progress\nuser_flashcard_progress]
    B -->|Not Found| D[Resolve Subtopic Context]

    D --> E[LLM Prompt for Flashcards]
    E --> F[Validate with Zod\nFlashcardArraySchema]
    F -->|Valid| G[Store Flashcards with Position]
    F -->|Invalid| H[Return Validation Error]

    G --> I[Return generated=true]
    C --> J[Return generated=false]

    K[Review Submission\nquality 0..5] --> L[Apply SM-2 Update\ninterval, ease_factor, repetitions]
    L --> M[Persist Review State]
    M --> N[Grant XP and Record Activity]
```

## 8) Audio Overview Generation Pipeline

```mermaid
flowchart LR
    A[Request Audio Overview] --> B[Check Firestore Cache\ngenerated_audio]
    B -->|Cache Hit| C[Return Cached Audio Metadata]
    B -->|Cache Miss| D[Resolve Subtopic or Course Context]

    D --> E[LLM Prompt for Audio Script]
    E --> F[Validate with Zod\nAudioScriptSchema]
    F -->|Valid| G[Synthesize Audio\nGroq or Resemble]
    F -->|Invalid| H[Return Validation Error]

    G --> I[Upload WAV to ImageKit]
    I --> J[Persist Metadata in Firestore]
    J --> K[Return Audio URL and Duration]

    L[Stream Endpoint] --> M[Try CDN Stream]
    M -->|CDN stale URL| N[Delete stale cache and regenerate]
    N --> G
```

## 9) Client-Side Manifest Playback Timeline

```mermaid
sequenceDiagram
    participant A as Android App
    participant API as Video API
    participant CDN as ImageKit CDN
    participant P as Player Engine

    A->>API: GET /videos/:subtopicId
    API-->>A: manifest JSON

    loop Each scene in manifest order
        A->>CDN: Preload visual_url
        A->>CDN: Preload audio_url
        A->>P: Start scene audio
        A->>P: Render visual
        loop Each subscene window
            P->>P: Apply overlay and highlight at start_ms
        end
        P->>P: Apply transition and move next scene
    end
```

## 10) Data Model Map for Learning State

```mermaid
flowchart TB
    U[(users)] --> UC[(user_courses)]
    U --> USP[(user_subtopic_progress)]

    C[(courses)] --> UN[(courses/{id}/units)]
    UN --> ST[(subtopics)]

    ST --> SQ[(subtopic_questions)]
    ST --> FL[(flashcards)]
    ST --> NT[(generated_notes)]
    ST --> AU[(generated_audio)]
    ST --> VM[(video_manifests)]

    C --> CG[(course_generation_status)]
    C --> CPS[(course_public_stats)]
```

## 11) Deployment and Runtime Topology

```mermaid
flowchart LR
    A[Android Client] --> B[HTTPS]
    B --> C[Express API Server]

    C --> D[Firebase Auth Verification]
    C --> E[Firestore]
    C --> F[Groq API]
    C --> G[Cerebras API]
    C --> H[Gemini API]
    C --> I[TTS Providers]
    C --> J[Image Providers]
    C --> K[ImageKit CDN]

    C --> L[SSE Response Channel]
    L --> A
```
