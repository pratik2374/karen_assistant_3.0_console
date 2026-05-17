# Karen: Complete Engineering Plan & System Architecture

This document fulfills the output requirements for the design of **Karen**, a production-grade autonomous AI assistant, and incorporates critical production guardrails.

---

## 1. Complete Architecture

**Overview:** Karen is designed as an event-driven, zero-trust AI orchestrator. 

*   **Ingestion:** WhatsApp Cloud API Webhooks push events into a Redis queue.
*   **Orchestration:** A Node.js (TypeScript) backend pops events, processes them via a safety layer, and passes them to the **Karen Agent** to determine intent.
*   **Execution:** Based on intent, the Orchestrator delegates to specific agents (Planner, Scheduler, Memory).
*   **Safety Layer:** All AI output must pass through deterministic middleware. 

---

## 2. AI Tool Invocation Protocol (CRITICAL)

To prevent orchestration chaos, GPT does NOT directly execute tools. It outputs structured `AgentAction` requests which the backend orchestrator validates.

```typescript
type AgentAction = {
  actionType: "CREATE_TASK" | "UPDATE_TASK" | "SEND_REMINDER" | "QUERY_MEMORY" | "SAVE_RESOURCE" | "CREATE_CALENDAR_EVENT";
  payload: any;
  confidence: number;
  requiresConfirmation: boolean;
  reasoning: string;
}
```
*Flow:* GPT Output -> Orchestrator Validation -> Confirmation Middleware -> Deterministic Tool Execution.

---

## 3. Action Confidence Thresholds & Overrides

### Confidence Matrix
| Confidence | Action Requirement |
| ---------- | ------------------ |
| > 0.9      | Auto-safe Execution |
| 0.7 – 0.9  | Soft Confirmation required |
| < 0.7      | Clarification / Hard Confirmation |

### Human Override Layer (Emergency Controls)
Autonomy requires strict global overrides. Admin commands exist outside the AI loop:
*   `/pause-reminders`, `/silent-mode`, `/disable-learning`, `/reset-personality`, `/wipe-memory`, `/stop-escalation`.

---

## 4. Idempotency & Failure Recovery

### Idempotency System
To prevent duplicate reminders or tasks due to webhook retries or BullMQ restarts, all deterministic actions require **Idempotency Keys**.
*   `task_creation_key`
*   `reminder_execution_key`
*   `calendar_write_key`

### Failure Recovery Architecture
*   **Retries & Dead-Letter Queues (DLQ):** Failed BullMQ jobs route to DLQ.
*   **Partial-Failure Handling:** If Calendar write succeeds but DB fails, automatic rollback strategies trigger.

---

## 5. Security & Prompt Injection Defense

*   **Zero-Trust Boundaries:** AI is a reasoning engine, NOT a source of truth.
*   **Prompt Injection Defense:** Input sanitization and strict system-rule precedence. AI can never directly decide "this is safe to execute". Backend middleware MUST validate permissions.
*   **Data Isolation:** Sensitive data (Drive links, credentials) is field-level encrypted (AES-256-GCM). AI receives ONLY summaries and tags.

---

## 6. Token Budget Manager

To prevent GPT costs from exploding, the architecture includes a strict token budget manager:
*   Context size budgeting per request.
*   Memory ranking & retrieval scoring.
*   Token-aware summarization before injection into the prompt.

---

## 7. Queue Priority System

Using **BullMQ (Redis-backed)** with explicit priorities to prevent background tasks from blocking critical UX flows:

| Queue | Priority | Description |
| --- | --- | --- |
| `reminder-execution` | CRITICAL | Must execute exactly on time. |
| `incoming-chat` | HIGH | User messages needing fast responses. |
| `memory-compression` | LOW | Nightly summarization tasks. |
| `analytics` | LOWEST | Telemetry and dashboard updates. |

---

## 8. Database Schemas (MongoDB)

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
  createdAt: Date
}
```

**Memory (Tiered) Schema:**
```typescript
{
  type: { type: String, enum: ['WORKING', 'EPISODIC', 'SEMANTIC', 'BEHAVIORAL', 'RESOURCE'] },
  summary: String, // AI-visible sanitized context
  encryptedPayload: { // ONLY accessible via secure backend tools
    encrypted_value: String,
    iv: String,
    auth_tag: String
  },
  importanceScore: Number,
  expiryDate: Date,
  embedding: [Number]
}
```

---

## 9. State Machines & Scheduling Engine

**Task Escalation State Machine (Deterministic):**
`PENDING` -> `SENT` -> `FOLLOWUP_1` (5m) -> `FOLLOWUP_2` (15m) -> `ESCALATED` (30m).
Stops immediately upon user acknowledgment.

**Time Rules:** DND = 11 PM to 5 AM. Scheduler deterministically intercepts and pushes tasks out of DND bounds.

---

## 10. Behavioral Learning Guardrails

Karen learns behavior patterns, but uses **bounded adaptation** to ensure personality consistency:
*   Max roast level limits.
*   Max reminder frequency caps.
*   Burnout overrides & cooldown systems (prevents overly aggressive pacing).

---

## 11. Adaptive Reminder Strategy Engine (Future Feature)

A dynamic strategy engine that learns:
*   Which reminder tone works best for you.
*   When you are likely to ignore tasks.
*   The best intervention timing.
It then dynamically alters the tone, frequency, and escalation style based on behavioral history.

---

## 12. Observability: Audit Replay & Simulation

*   **Audit Replay System:** Beyond standard logs, the system supports Event Replay for reminders, scheduling events, and memory writes to recreate bugs exactly as they happened.
*   **Internal Simulation Environment:** A mock harness to test missed reminders, calendar conflicts, and burnout detection locally before WhatsApp deployment.

---

## 13. Implementation Roadmap

Building the foundational determinism before the AI layers.

*   **Phase 1: Core Contracts** (Schemas, events, state machines, action protocols, permission rules, queue contracts)
*   **Phase 2: Event Bus** (Redis / BullMQ setup, idempotency keys, priority queues)
*   **Phase 3: Task Engine** (CRUD operations, state transitions)
*   **Phase 4: Reminder Engine** (Cron scheduling, escalation logic, DND boundaries)
*   **Phase 5: Memory System** (Encryption, working/episodic boundaries)
*   **Phase 6: WhatsApp Integration** (Webhooks, human override commands)
*   **Phase 7: AI Orchestration** (Agent invocation protocol, Context Builder, OpenAI routing)
