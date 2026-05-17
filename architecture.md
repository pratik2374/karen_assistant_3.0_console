# Karen: Production-Grade Autonomous AI Assistant Architecture

This document outlines the complete backend architecture, engineering plan, and codebase structure for **Karen**—a persistent, privacy-first, multi-agent cognitive operating system.

---

## 1. Core Architecture

The system is built on an event-driven, zero-trust AI architecture.

### Technology Stack
*   **Runtime:** Node.js (TypeScript)
*   **Framework:** Express.js
*   **Database:** MongoDB (Persistent State, Memories, Tasks)
*   **Cache/Message Broker:** Redis / BullMQ (Event Bus, Queues)
*   **Integrations:** WhatsApp Cloud API, OpenAI API, Google Calendar API, Gmail API

### System Layers
1.  **Communication Layer:** Inbound/Outbound WhatsApp webhooks. Handles raw messaging, media, and parsing.
2.  **Safety Layer:** Validation, rate limiting, permissions, and request sanitization.
3.  **Orchestrator Layer:** Routes intent, delegates to specific agents, and aggregates results.
4.  **Agent Layer:** Specialized, isolated AI models handling specific domains (Planning, Memory, Email).
5.  **Tool Layer:** Deterministic execution wrappers (Calendar syncing, DB writes) with strict access controls.
6.  **Memory Layer:** Tiered storage (Working, Episodic, Semantic, Behavioral) with field-level encryption.
7.  **Scheduling Layer:** Deterministic CRON and Redis-backed queues for tasks and reminders.
8.  **Reflection Layer:** Nightly async jobs for compression, behavioral analysis, and system tuning.
9.  **Analytics Layer:** Telemetry, confidence logging, and performance metrics.

---

## 2. Zero-Trust AI & Security Architecture

AI models are treated as **untrusted reasoning engines**. They **never** interact with raw sensitive data.

### Security Components
*   **Field-Level Encryption:** AES-256-GCM is used for sensitive fields (URLs, OAuth tokens, API keys).
*   **Key Management:** Environment-based master keys with support for future KMS rotation.
*   **Context Builder:** Strips sensitive data, injecting only tags and summaries into AI prompts.
*   **Tool Execution Wrappers:** Decryption happens *only* inside deterministic tool functions when invoked by an authorized AI action, verified by a Permission Validator.

### Security Flow
`OpenAI Models -> Context Builder (Sanitized) -> Orchestrator -> Security Middleware -> Permission Validator -> Tool Wrapper -> Decryption Layer -> Encrypted Vault`

---

## 3. Multi-Agent System

Karen utilizes a multi-agent orchestration pattern to ensure domain separation and low hallucination risk.

1.  **Karen Agent (Orchestrator):** User-facing personality, tone adaptation, high-level intent routing.
2.  **Planner Agent:** Task decomposition, prioritization, and scheduling suggestions.
3.  **Scheduler Agent:** Deterministic state transitions, reminder timing, escalation flow, and DND handling.
4.  **Memory Agent:** Storage, retrieval, semantic search, and tagging of memory items.
5.  **Compression Agent:** Nightly summarization and archive generation of working memory.
6.  **Reflection Agent:** Analyzes productivity, adjusts personality configs, detects burnout.
7.  **Security Agent:** Enforces permissions, routes encryption, and sanitizes contexts.
8.  **Calendar Agent:** Two-way sync with Google Calendar, local shadow DB, conflict resolution.
9.  **Email Agent:** Summarization, draft generation, and approval workflows.
10. **Context Builder Agent:** Retrieves relevant memories, builds safe context windows, minimizes tokens.

### Model Routing Strategy
*   **Deep Reasoning (GPT-4o/o1):** Planning, Reflection, conversational responses.
*   **Medium/Lightweight Tasks (GPT-4o-mini):** Reminder classification, task extraction, tagging, summaries.

---

## 4. Memory Architecture

A tiered approach to optimize context windows and ensure long-term retention.

1.  **Working Memory:** Active conversational context (Expires nightly).
2.  **Episodic Memory:** Compressed conversational summaries.
3.  **Semantic Memory:** Persistent knowledge (habits, resources, goals, preferences).
4.  **Behavioral Memory:** Metrics on productivity, reminder effectiveness, sleep/work cycles.

### Nightly Pipeline
At midnight, the **Compression Agent** summarizes Working Memory into Episodic Memory, while the **Reflection Agent** updates Behavioral Memory and prunes outdated contexts.

---

## 5. Task & Reminder Engine (Deterministic)

**Rule:** AI models *never* control timers or state transitions directly.

### Task States
`CREATED -> SCHEDULED -> ACTIVE -> ACKNOWLEDGED -> IN_PROGRESS -> COMPLETED | MISSED | RESCHEDULED | ARCHIVED`

### Reminder States
`PENDING -> SENT -> FOLLOWUP_1 -> FOLLOWUP_2 -> ESCALATED -> STOPPED`

### Execution Flow
1.  User requests a reminder. Karen Agent extracts intent.
2.  Planner Agent formats the task.
3.  Backend creates a MongoDB `Task` document and queues a BullMQ job.
4.  At execution time, BullMQ triggers the `Scheduler Agent` (deterministic).
5.  Follow-ups (5m, 15m) are handled via delayed queues until the user acknowledges or snoozes.

---

## 6. Database Schemas (MongoDB)

### Task Schema
```typescript
const TaskSchema = new Schema({
  title: { type: String, required: true },
  state: { type: String, enum: ['CREATED', 'SCHEDULED', 'ACTIVE', ...], default: 'CREATED' },
  scheduledFor: { type: Date, required: true },
  reminderState: { type: String, enum: ['PENDING', 'SENT', 'FOLLOWUP_1', ...], default: 'PENDING' },
  escalationLevel: { type: Number, default: 0 },
  goalId: { type: ObjectId, ref: 'Goal' },
  tags: [String],
  createdAt: { type: Date, default: Date.now }
});
```

### Memory (Resource) Schema
```typescript
const MemorySchema = new Schema({
  type: { type: String, enum: ['EPISODIC', 'SEMANTIC', 'RESOURCE'] },
  summary: { type: String, required: true }, // AI-visible
  tags: [String],
  encryptedPayload: { // ONLY accessible by specific tools
    encrypted_value: String,
    iv: String,
    auth_tag: String,
    encryption_version: String
  },
  importanceScore: { type: Number, default: 1 },
  expiryDate: { type: Date },
  createdAt: { type: Date, default: Date.now }
});
```

---

## 7. Event Bus Architecture

Powered by **Redis & BullMQ** for decoupled, asynchronous processing.

*   `TASK_CREATED`: Triggers Scheduler to queue reminder jobs.
*   `REMINDER_ACKNOWLEDGED`: Clears pending escalation jobs.
*   `MESSAGE_RECEIVED`: Triggers orchestrator processing.
*   `NIGHTLY_REFLECTION`: Triggers memory compression and behavioral analysis.

---

## 8. Codebase Structure

```text
karen-backend/
├── src/
│   ├── agents/               # AI Agents (Karen, Planner, Memory)
│   │   ├── KarenAgent.ts
│   │   ├── PlannerAgent.ts
│   │   └── ReflectionAgent.ts
│   ├── config/               # Environment & system configurations
│   ├── core/                 # Core AI routing and Context Builder
│   │   ├── ContextBuilder.ts
│   │   ├── Orchestrator.ts
│   │   └── Routing.ts
│   ├── database/             # MongoDB Models & connections
│   │   ├── models/
│   │   └── repositories/
│   ├── events/               # BullMQ Queues and Event Bus handlers
│   │   ├── consumers/
│   │   └── publishers/
│   ├── middleware/           # Safety, Validation, Confirmation middleware
│   ├── security/             # Encryption, KMS, Permission Validators
│   │   ├── CryptoService.ts
│   │   └── PermissionValidator.ts
│   ├── services/             # Deterministic logic (WhatsApp, Tasks)
│   │   ├── TaskService.ts
│   │   ├── WhatsAppService.ts
│   │   └── CalendarService.ts
│   ├── tools/                # Secure deterministic tool wrappers
│   ├── utils/                # Loggers, helpers
│   └── index.ts              # Express App & Server entry point
├── tests/
├── .env.example
├── package.json
└── tsconfig.json
```

---

## 9. Implementation Roadmap

*   **Phase 1: Foundation & Communication:** Setup Node/Express, MongoDB, Redis, and WhatsApp Webhooks. Implement basic echoing and system logging.
*   **Phase 2: Security & Core Orchestration:** Implement AES-256-GCM encryption, Context Builder, and basic AI Orchestrator routing.
*   **Phase 3: Task & Reminder Engine:** Implement deterministic BullMQ task scheduling, states, and the Scheduler Agent.
*   **Phase 4: Memory System:** Implement Working, Episodic, and Semantic memory schemas, along with embedding-based semantic search.
*   **Phase 5: Integrations:** Secure tool wrappers for Google Calendar and Gmail integration (with approval workflows).
*   **Phase 6: Nightly Reflection:** Implement the Compression and Reflection agents for behavioral analysis and memory pruning.
*   **Phase 7: Personality & Refinement:** Tone modulation, dynamic behavior configs (Focus Mode, Chill Mode).
*   **Phase 8: Scale & CLI Dashboard:** Build the terminal observability dashboard, optimize DB indexes, and prep for cloud deployment.
