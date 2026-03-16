# UpSkill AI - Architecture Diagrams

## 1) Full System Architecture (Client + Backend)
<p align="center">
  <img src="./diagrams/Dark Mode/1. Full System Architecture (Client + Backend) (Dark Mode).svg" alt="UpSkill AI Architecture" width="100%" />
</p>


## 2) Interactive Learning and Quiz-Gated Unlock Flow

<p align="center">
  <img src="./diagrams/Light Mode/2.Interactive Learning and Quiz-Gated Unlock Flow (Light Mode).svg" alt="UpSkill AI Architecture" width="100%" />
</p>


<details>
<summary>Text version (Mermaid)</summary>
```mermaid
sequenceDiagram
    autonumber

    box rgb(225, 245, 254) "Client Edge"
        participant U as User
        participant A as Android App
    end
    
    box rgb(243, 229, 245) "Backend API"
        participant API as Interactive API
    end
    
    box rgb(236, 239, 241) "Data & AI Intelligence"
        participant DB as Firestore
        participant LLM as LLM Provider
    end

    U->>+A: Start learning
    A->>+API: GET /interactive/course/:courseId/next-content
    API->>+DB: Find first uncompleted subtopic
    DB-->>-API: Return status

    alt Content missing
        Note over API,LLM: Just-In-Time Generation
        API->>+LLM: Generate content only
        LLM-->>-API: Yield content JSON
        API->>DB: Save generated content
    end

    API-->>A: Return content and progress
    
    Note over API,LLM: Async Quiz Preparation
    API->>+LLM: Generate quiz in background
    LLM-->>-API: Yield quiz JSON
    API->>DB: Save quiz questions

    U->>A: Submit quiz answers
    A->>+API: POST /interactive/:subtopicId/submit-quiz
    API->>DB: Update hearts, attempts, completion

    alt Passed Quiz
        API->>DB: Mark subtopic complete + grant XP
        API-->>A: { unlocked: true }
    else Failed Quiz
        API-->>-A: { unlocked: false }
    end
```
</details>


## 3) LLM Routing Logic by Task Type

<p align="center">
  <img src="./diagrams/Dark Mode/3. LLM Routing Logic by Task Type (Dark Mode).svg" alt="UpSkill AI Architecture" width="100%" />
</p>



<details>
<summary>Text version (Mermaid)</summary>

```mermaid
graph TD
    %% Styles
    classDef logic fill:#fff3e0,stroke:#e65100,stroke-width:2px,color:#e65100;
    classDef decision fill:#ffebee,stroke:#c62828,stroke-width:2px,color:#c62828;
    classDef llm fill:#e8f5e9,stroke:#2e7d32,stroke-width:2px,color:#2e7d32;
    classDef action fill:#f3e5f5,stroke:#7b1fa2,stroke-width:2px,color:#7b1fa2;
    classDef storage fill:#eceff1,stroke:#455a64,stroke-width:2px,color:#37474f;

    %% Nodes
    A1(["Incoming Generation Request"])
    B1{"Analyze Task Type"}

    subgraph Routing_Engine ["Provider Selection"]
        C1{{"Cerebras Path"}}
        D1{{"Groq Path"}}
        E1{{"Gemini Path"}}
    end

    subgraph Execution_Strategies ["Execution Plan"]
        F1("Generate in large batch")
        G1("Generate in small batches / single task")
        H1("Generate with reasoning-focused model")
    end

    subgraph Validation_Persistence ["Output Formatting"]
        I1{"Validate with Zod Schema"}
        J1[("Persist to Firestore")]
        K1(["Return JSON or Stream Progress"])
    end

    %% Flow
    A1 -- "Payload" --> B1
    
    B1 -- "Full-course batch generation" --> C1
    B1 -- "Low-latency interactive / default" --> D1
    B1 -- "Reasoning-heavy / explicit request" --> E1

    C1 -- "High Throughput" --> F1
    D1 -- "High Speed" --> G1
    E1 -- "High Context" --> H1

    F1 -- "Raw Response" --> I1
    G1 -- "Raw Response" --> I1
    H1 -- "Raw Response" --> I1

    I1 -- "Strict Typing Passed" --> J1
    J1 -- "State Saved" --> K1

    %% Classes
    class A1,K1 action;
    class B1,I1 decision;
    class C1,D1,E1 llm;
    class F1,G1,H1 logic;
    class J1 storage;
```
</details>

## 4) SSE Streaming Course Generation Lifecycle

<p align="center">
  <img src="./diagrams/Light Mode/4. SSE Streaming Course Generation Lifecycle (Light Mode).svg" alt="UpSkill AI Architecture" width="100%" />
</p>

<details>
<summary>Text version (Mermaid)</summary>
```mermaid
sequenceDiagram
    autonumber

    box rgb(225, 245, 254) "Client Edge"
        participant A as Android App
    end
    
    box rgb(243, 229, 245) "Backend API"
        participant API as Course API
    end
    
    box rgb(236, 239, 241) "Intelligence & State"
        participant LLM as LLM Provider
        participant DB as Firestore
    end

    A->>+API: POST /courses/:id/generate-content-stream
    API-->>A: [event: start]

    loop For each batch or generated subtopic
        Note over API,LLM: Batch Inference
        API->>+LLM: Generate subtopic content
        LLM-->>-API: Yield content JSON
        API->>DB: Save subtopic content
        
        Note over API,A: Real-time UI Hook
        API-->>A: [event: progress]
        API-->>A: [event: chunk]
    end

    API->>DB: Save generation_status = completed
    API-->>-A: [event: complete]
```
</details>


## 5) Explanation Video Manifest-First Pipeline
<p align="center">
  <img src="./diagrams/Dark Mode/5. Explanation Video Manifest-First Pipeline (Dark Mode).svg" alt="UpSkill AI Architecture" width="100%" />
</p>

<details>
<summary>Text version (Mermaid)</summary>
```mermaid
graph LR
    %% Styles
    classDef action fill:#f3e5f5,stroke:#7b1fa2,stroke-width:2px,color:#7b1fa2;
    classDef logic fill:#fff3e0,stroke:#e65100,stroke-width:2px,color:#e65100;
    classDef storage fill:#eceff1,stroke:#455a64,stroke-width:2px,color:#37474f;
    classDef primary fill:#e1f5fe,stroke:#01579b,stroke-width:2px,color:#01579b;

    %% Nodes
    A1(["Subtopic Content"])
    B1("Script Generation")
    C1("Scene Planning")
    D1{"Scene Type"}

    subgraph Visual_Pipeline ["Asset Generation"]
        E1("Image Provider Pipeline")
        F1("SVG Generation <br/>(Diagram/Code/Timeline)")
        H1("SVG to PNG Render")
    end

    subgraph Audio_Pipeline ["Voice Generation"]
        I1("TTS per Script Chunk")
    end

    G1[("Upload Visual to ImageKit")]
    J1[("Upload Audio to ImageKit")]
    
    K1("Transition Planning")
    L1("Build Manifest JSON")
    M1[("Firestore <br/>(video_manifests)")]
    N1(["Client Playback Engine"])

    %% Flow
    A1 -- "Input" --> B1
    B1 -- "Parsed Script" --> C1
    C1 -- "Evaluate" --> D1

    D1 -- "Illustration" --> E1
    D1 -- "Structural" --> F1
    
    F1 -- "Compile" --> H1
    E1 -- "Buffer" --> G1
    H1 -- "Buffer" --> G1

    C1 -- "Text to Speech" --> I1
    I1 -- "Audio Buffer" --> J1

    G1 -- "URLs" --> K1
    J1 -- "URLs" --> K1
    
    K1 -- "Assemble Timing" --> L1
    L1 -- "Save Document" --> M1
    M1 -- "Serve" --> N1

    %% Classes
    class A1,N1 primary;
    class B1,C1,K1,L1 action;
    class D1 logic;
    class E1,F1,H1,I1 logic;
    class G1,J1,M1 storage;
```
</details>


## 6) Client-Side Manifest Playback Timeline

<p align="center">
  <img src="./diagrams/Light Mode/6. Client-Side Manifest Playback Timeline (Light Mode).svg" alt="UpSkill AI Architecture" width="100%" />
</p>


<details>
<summary>Text version (Mermaid)</summary>
```mermaid
sequenceDiagram
    autonumber

    box rgb(225, 245, 254) "Client Edge Engine"
        participant A as Android App
        participant P as Player Engine
    end
    
    box rgb(236, 239, 241) "Network & Delivery"
        participant API as Video API
        participant CDN as ImageKit CDN
    end

    A->>+API: GET /videos/:subtopicId
    API-->>-A: Return manifest JSON

    loop Each scene in manifest order
        Note over A,CDN: Just-In-Time Asset Loading
        A->>CDN: Preload visual_url
        A->>CDN: Preload audio_url
        
        Note over A,P: Native Playback Orchestration
        A->>P: Start scene audio
        A->>P: Render visual
        
        loop Each subscene window
            P->>P: Apply overlay and highlight at start_ms
        end
        
        P->>P: Apply transition and move next scene
    end
```
</details>


## 7) Notes Generation Pipeline

<p align="center">
  <img src="./diagrams/Dark Mode/7. Notes Generation Pipeline (Dark Mode).svg" alt="UpSkill AI Architecture" width="100%" />
</p>

<details>
<summary>Text version (Mermaid)</summary>
```mermaid
graph LR
    %% Styles
    classDef input fill:#e1f5fe,stroke:#01579b,stroke-width:2px,color:#01579b;
    classDef decision fill:#ffebee,stroke:#c62828,stroke-width:2px,color:#c62828;
    classDef logic fill:#fff3e0,stroke:#e65100,stroke-width:2px,color:#e65100;
    classDef storage fill:#eceff1,stroke:#455a64,stroke-width:2px,color:#37474f;
    classDef action fill:#f3e5f5,stroke:#7b1fa2,stroke-width:2px,color:#7b1fa2;

    %% Nodes
    subgraph Client_Request ["Trigger"]
        A1(["Request Notes for Subtopic"])
    end

    subgraph Cache_Layer ["Caching Strategy"]
        B1{"Check Firestore Cache <br/>(generated_notes)"}
        C1[("Return Existing Notes")]
        D1("Resolve Context <br/>(Course/Unit/Subtopic)")
    end

    subgraph AI_Validation ["Generation & Schema Enforcement"]
        E1("LLM Prompt for Structured Notes")
        F1{"Validate with Zod <br/>(GeneratedNotesSchema)"}
        H1(["Return Validation Error"])
    end

    subgraph Persistence_Response ["State & Output"]
        G1[("Persist to Firestore <br/>(generated_notes)")]
        I1(["Return Notes Payload"])
    end

    %% Flow
    A1 -- "Fetch" --> B1
    
    B1 -- "Cache Hit" --> C1
    B1 -- "Cache Miss" --> D1
    
    D1 -- "Build Prompt" --> E1
    E1 -- "JSON Output" --> F1
    
    F1 -- "Invalid Schema" --> H1
    F1 -- "Valid Schema" --> G1
    
    G1 -- "Serve" --> I1
    C1 -- "Serve" --> I1

    %% Classes
    class A1,I1,H1 input;
    class B1,F1 decision;
    class D1,E1 logic;
    class C1,G1 storage;
```
</details>

## 8) Flashcards Generation and Review Pipeline

<p align="center">
  <img src="./diagrams/Dark Mode/8. Flashcards Generation and Review Pipeline (Dark Mode).svg" alt="UpSkill AI Architecture" width="100%" />
</p>


<details>
<summary>Text version (Mermaid)</summary>
```mermaid
graph LR
    %% Styles
    classDef input fill:#e1f5fe,stroke:#01579b,stroke-width:2px,color:#01579b;
    classDef decision fill:#ffebee,stroke:#c62828,stroke-width:2px,color:#c62828;
    classDef logic fill:#fff3e0,stroke:#e65100,stroke-width:2px,color:#e65100;
    classDef storage fill:#eceff1,stroke:#455a64,stroke-width:2px,color:#37474f;
    classDef success fill:#e8f5e9,stroke:#2e7d32,stroke-width:2px,color:#2e7d32;

    %% Nodes
    subgraph Flashcard_Generation ["Generation Lifecycle"]
        A1(["Request Flashcards"])
        B1{"Query DB <br/>(by subtopic_id)"}
        D1("Resolve Subtopic Context")
        E1("LLM Prompt for Flashcards")
        F1{"Validate with Zod <br/>(FlashcardArraySchema)"}
        G1[("Store Flashcards <br/>with Position")]
        H1(["Return Validation Error"])
        I1(["Return (generated=true)"])
    end

    subgraph Spaced_Repetition ["SM-2 Review Lifecycle"]
        C1[("Load User Progress")]
        J1(["Return (generated=false)"])
        
        K1(["Review Submission <br/>(quality 0..5)"])
        L1("Apply SM-2 Update <br/>(interval, ease_factor, reps)")
        M1[("Persist Review State")]
        N1("Grant XP & Record Activity")
    end

    %% Flow: Generation Path
    A1 -- "Fetch" --> B1
    B1 -- "Not Found" --> D1
    D1 -- "Build Prompt" --> E1
    E1 -- "JSON Output" --> F1
    
    F1 -- "Valid Schema" --> G1
    F1 -- "Invalid Schema" --> H1
    G1 -- "Serve" --> I1

    %% Flow: Retrieval Path
    B1 -- "Found" --> C1
    C1 -- "Serve" --> J1

    %% Flow: Review Path
    K1 -- "Calculate" --> L1
    L1 -- "Save" --> M1
    M1 -- "Gamification" --> N1

    %% Classes
    class A1,H1,I1,J1,K1 input;
    class B1,F1 decision;
    class D1,E1,L1 logic;
    class G1,C1,M1 storage;
    class N1 success;
```
</details>

## 9) Audio Overview Generation Pipeline

<p align="center">
  <img src="./diagrams/Dark Mode/9. Audio Overview Generation Pipeline (Dark Mode).svg" alt="UpSkill AI Architecture" width="100%" />
</p>


<details>
<summary>Text version (Mermaid)</summary>
```mermaid
graph LR
    %% Styles
    classDef input fill:#e1f5fe,stroke:#01579b,stroke-width:2px,color:#01579b;
    classDef decision fill:#ffebee,stroke:#c62828,stroke-width:2px,color:#c62828;
    classDef logic fill:#fff3e0,stroke:#e65100,stroke-width:2px,color:#e65100;
    classDef storage fill:#eceff1,stroke:#455a64,stroke-width:2px,color:#37474f;
    classDef external fill:#e8f5e9,stroke:#2e7d32,stroke-width:2px,color:#2e7d32;

    %% Nodes
    subgraph Audio_Trigger ["Request Phase"]
        A1(["Request Audio Overview"])
        L1(["Stream Endpoint Requested"])
    end

    subgraph AI_Scripting ["Script Intelligence"]
        B1{"Check DB Cache <br/>(generated_audio)"}
        C1[("Return Cached Metadata")]
        D1("Resolve Context")
        E1("LLM Prompt for Audio Script")
        F1{"Validate with Zod <br/>(AudioScriptSchema)"}
        H1(["Return Validation Error"])
    end

    subgraph Media_Synthesis ["TTS Synthesis & Delivery"]
        G1{{"Synthesize Audio <br/>(Groq / Resemble)"}}
        I1[("Upload WAV to ImageKit")]
        J1[("Persist Metadata (Firestore)")]
        K1(["Return Audio URL + Duration"])
        
        M1{"Try CDN Stream"}
        N1("Delete Stale Cache <br/>& Regenerate")
    end

    %% Flow: Generation/Cache
    A1 -- "Fetch" --> B1
    B1 -- "Cache Hit" --> C1
    B1 -- "Cache Miss" --> D1
    
    D1 -- "Build Prompt" --> E1
    E1 -- "JSON" --> F1
    F1 -- "Invalid" --> H1
    
    %% Flow: Synthesis
    F1 -- "Valid" --> G1
    G1 -- "Audio Buffer" --> I1
    I1 -- "Link Data" --> J1
    J1 -- "Serve" --> K1
    C1 -- "Serve" --> K1

    %% Flow: Self-Healing Stream
    L1 -- "Fetch" --> M1
    M1 -- "CDN Stale URL" --> N1
    N1 -- "Fallback Loop" --> G1

    %% Classes
    class A1,H1,K1,L1 input;
    class B1,F1,M1 decision;
    class D1,E1,N1 logic;
    class C1,I1,J1 storage;
    class G1 external;
```
</details>