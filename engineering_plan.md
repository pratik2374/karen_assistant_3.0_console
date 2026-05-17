# Karen: Complete Engineering Plan & System Architecture

This document fulfills the output requirements for the design of **Karen**, a production-grade autonomous AI assistant.

---

## 1. Complete Architecture

**Overview:** Karen is designed as an event-driven, zero-trust AI orchestrator. 

*   **Ingestion:** WhatsApp Cloud API Webhooks push events into a Redis queue.
*   **Orchestration:** A Node.js (TypeScript) backend pops events, processes them via a safety layer, and passes them to the **Karen Agent** (GPT-4o) to determine intent.
*   **Execution:** Based on intent, the Orchestrator delegates to specific agents (Planner, Scheduler, Memory, Email, Calendar).
*   **Safety Layer:** All AI output must pass through deterministic middleware. Sensitive tools are wrapped in permissions logic and executed on the backend, not directly by the model.

---

## 2. Folder Structure

```text
karen-backend/
├── src/
│   ├── agents/               # AI reasoning layers (Karen, Planner, Reflection)
│   ├── config/               # Environment configs, AI routing rules
│   ├── core/                 # Orchestrator, Context Builder, Event Bus
│   ├── database/             # MongoDB schemas, repositories, migrations
│   ├── events/               # BullMQ producers, consumers, and workers
│   ├── middleware/           # Zero-trust safety, confirmation, auth
│   ├── security/             # Field-level AES-256-GCM, Permission Validators
│   ├── services/             # Deterministic logic (WhatsApp API, Calendar syncing)
│   ├── tools/                # Secure wrappers (AI has access to metadata only)
│   ├── utils/                # Logging, telemetry, utilities
│   └── index.ts              # Express initialization
├── tests/                    # Unit & integration tests, Simulation environment
├── .env.example
├── package.json
└── tsconfig.json
```

---

## 3. Database Schemas (MongoDB)

**Task Schema:**
```typescript
{
  title: String,
  state: { type: String, enum: ['CREATED', 'SCHEDULED', 'ACTIVE', 'ACKNOWLEDGED', 'IN_PROGRESS', 'MISSED', 'RESCHEDULED', 'COMPLETED', 'ARCHIVED'] },
  scheduledFor: Date,
  reminderState: { type: String, enum: ['PENDING', 'SENT', 'FOLLOWUP_1', 'FOLLOWUP_2', 'ESCALATED', 'STOPPED'] },
  escalationLevel: Number,
  goalId: ObjectId,
  tags: [String],
  userId: String,
  createdAt: Date
}
```

**Memory (Tiered) Schema:**
```typescript
{
  type: { type: String, enum: ['WORKING', 'EPISODIC', 'SEMANTIC', 'BEHAVIORAL', 'RESOURCE'] },
  summary: String, // AI-visible sanitized context
  tags: [String],
  encryptedPayload: { // ONLY accessible via secure backend tools
    encrypted_value: String,
    iv: String,
    auth_tag: String,
    encryption_version: String
  },
  importanceScore: Number,
  expiryDate: Date,
  embedding: [Number], // Vector search for Semantic Memory
  createdAt: Date
}
```

---

## 4. Event Flows

*   **Inbound:** `WhatsApp Webhook` -> `Express Route` -> `BullMQ (InboundQueue)` -> `Orchestrator Worker`.
*   **Task Lifecycle:** `Orchestrator` -> emits `TASK_CREATED` -> `BullMQ (SchedulerQueue)` -> waits for timestamp -> executes `SEND_REMINDER` -> emits `REMINDER_SENT`.
*   **Nightly Routine:** `Cron Job (00:00)` -> emits `NIGHTLY_REFLECTION` -> `Compression Agent` & `Reflection Agent` process memory and behavior.

---

## 5. Agent Workflows

1.  **Karen Agent:** Entry point. Maintains conversational continuity, adapts tone, routes to specialized agents.
2.  **Planner Agent:** Breaks down goals (e.g., "Crack placements") into `Task` entries. Determines optimal time blocks.
3.  **Scheduler Agent:** Purely deterministic state machine. Handles follow-ups, handles DND (11 PM-5 AM).
4.  **Memory Agent:** Tags inbound context, performs semantic vector search for retrieval.
5.  **Compression Agent:** Summarizes the day's `Working Memory` into `Episodic Memory` at midnight.
6.  **Reflection Agent:** Analyzes completed vs missed tasks, identifies burnout, adjusts "Behavior Config" (e.g., shifting from "Discipline Mode" to "Recovery Mode").
7.  **Security Agent:** Enforces permission boundaries before allowing decrypted tool access.
8.  **Calendar/Email Agents:** Read/Summarize states, generate drafts. Never auto-send without Level 2 confirmation.

---

## 6. Queue Architecture

Using **BullMQ (Redis-backed)**:
*   `inbound-messages`: High priority, fast processing for chat responsiveness.
*   `scheduler-queue`: Uses delayed jobs based on `scheduledFor` timestamps.
*   `escalation-queue`: Follow-ups (5m, 15m delays) queued immediately upon initial reminder sent; cancelled if `REMINDER_ACKNOWLEDGED` is fired.
*   `batch-processing`: Low priority (nightly compression, vector embedding generation).

---

## 7. Memory Lifecycle

1.  **Creation:** Chat context enters **Working Memory**.
2.  **Context Builder:** Injects active goals, recent context, and relevant Semantic memories (retrieved via vector search) into the prompt.
3.  **Nightly Compression:** Working Memory expires. The Compression Agent summarizes the day and stores it as **Episodic Memory**.
4.  **Pruning:** Low-importance Episodic memories are archived over time.
5.  **Resources:** Links/PDFs are stored in an encrypted **Resource Vault**, surfaced only as AI-visible tags (e.g., `[Document: Aadhaar]`).

---

## 8. Security Design

*   **Zero-Trust:** AI is a reasoning engine, NOT a source of truth or secure storage layer.
*   **Data Isolation:** Sensitive data (Drive links, credentials) is field-level encrypted (AES-256-GCM). AI models receive ONLY summaries and tags.
*   **Secure Retrieval:** AI says "Send Aadhaar link". The **Security Agent** intercepts, evaluates Security Confidence Score (risk, authentication validity), and executes a deterministic backend tool to decrypt and send. AI never sees the decrypted link.

---

## 9. API Structure

*   `POST /webhook/whatsapp` (Inbound messages, read receipts)
*   `GET /webhook/whatsapp` (Verification)
*   `GET /api/v1/health` (Queue health, system status)
*   `GET /api/v1/dashboard/metrics` (CLI Dashboard stats: streaks, behavior scores)
*   `POST /api/v1/admin/sync-calendar` (Force manual sync)

---

## 10. State Machines

**Task Escalation State Machine (Deterministic):**
*   `PENDING` --(Time Reached)--> `SENT`
*   `SENT` --(No reply 5m)--> `FOLLOWUP_1`
*   `FOLLOWUP_1` --(No reply 15m)--> `FOLLOWUP_2`
*   `FOLLOWUP_2` --(No reply 30m)--> `ESCALATED`
*   Any State --(User says "Done/Later")--> `ACKNOWLEDGED` (Stops escalation)

---

## 11. Scheduling Engine

*   **Time Rules:** Evening = 4 PM, Night = 8 PM. DND = 11 PM to 5 AM.
*   **Logic:** If the Planner suggests a task at 11:30 PM, the deterministic Scheduler intercepts and pushes it to 9 AM the next day, notifying the user of the DND enforcement.

---

## 12. Confirmation Middleware

*   **Level 0 (Auto):** Safe operations (Searching memory, summarizing).
*   **Level 1 (Soft):** Modifying minor states (Rescheduling a task).
*   **Level 2 (Hard):** Destructive/External operations (Auto-sending an email, deleting a calendar event, sharing a secure resource). Requires explicit user reply: "Yes, do it."
*   **Level 3 (Restricted):** System configs (Rotating keys). Requires CLI/Admin auth.

---

## 13. Deployment Strategy

*   **Local (Initial):** Docker Compose (Node.js App, MongoDB, Redis, Ngrok for WhatsApp Webhook).
*   **Cloud (Phase 2):** 
    *   App: AWS ECS / Google Cloud Run (Containerized stateless instances).
    *   DB: MongoDB Atlas (Encrypted at rest).
    *   Cache: AWS ElastiCache (Redis).
    *   Secrets: AWS KMS / GCP Secret Manager for master keys.

---

## 14. Scaling Recommendations

*   **Stateless Orchestrator:** The Node.js tier must remain stateless. All state lives in Redis/Mongo.
*   **Queue Sharding:** Separate queues for NLP inference vs. deterministic cron jobs to prevent AI latency from blocking task executions.
*   **Token Optimization:** Aggressive nightly memory compression to keep Context Builder payloads small and cost-effective.

---

## 15. Cost Optimization Strategies

*   **Model Routing:** Use GPT-4o-mini for 80% of tasks (classification, tagging, basic summaries). Reserve GPT-4o/o1 for complex planning, deep reflection, and empathy generation.
*   **Vector DB:** Use MongoDB Atlas Vector Search to avoid paying for a separate vector database.
*   **Caching:** Redis caches frequent semantic memory queries to reduce DB hits.

---

## 16. Future Extensibility Plan

*   **Biometric/Multi-device:** Future support for a React Native companion app requiring FaceID for Level 2/3 confirmations.
*   **Audio Pipelines:** Extending WhatsApp integration to handle voice notes via Whisper API.
*   **Hardware Modules:** YubiKey integration for the CLI dashboard administration.
