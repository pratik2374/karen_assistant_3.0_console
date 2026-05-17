You are a senior AI systems architect and principal engineer.

Your task is to design and generate the complete backend architecture, implementation roadmap, codebase structure, and engineering plan for a production-grade autonomous AI assistant named “Karen”.

Karen is NOT a simple chatbot.

Karen is:
- a persistent AI operating assistant
- a multi-agent orchestration system
- a behavioral learning assistant
- a scheduling and productivity intelligence engine
- a WhatsApp-based personal cognitive operating system

The system must be designed for:
- scalability
- modularity
- long-term maintainability
- privacy-first architecture
- deterministic execution
- agent separation
- low hallucination risk
- event-driven design
- autonomous reminder systems
- memory compression and retrieval
- adaptive personality evolution

The implementation stack MUST use:
- Node.js
- Express.js
- MongoDB
- Redis
- WhatsApp Cloud API
- OpenAI APIs
- Google Calendar API
- Gmail API

The system will initially run locally on PC and later deploy to cloud services.

========================================
CORE SYSTEM PHILOSOPHY
========================================

Karen must:
- behave like a calm, competent, mature AI assistant
- be concise
- respectful
- slightly sarcastic/roasty when appropriate
- inspired by JARVIS-like communication
- never excessively verbose
- never overly emotional
- never manipulative
- interrupt minimally
- remember deeply
- prioritize usefulness over conversation fluff

Karen is proactive.
Karen can initiate conversations.
Karen learns user behavior over time.

========================================
CRITICAL ARCHITECTURAL RULES
========================================

1. GPT MUST NEVER directly control deterministic systems.

GPT is ONLY responsible for:
- reasoning
- classification
- summarization
- planning
- intent understanding
- conversational responses

Deterministic logic MUST be implemented in backend code.

Examples of deterministic systems:
- reminder timing
- cron jobs
- retries
- escalation states
- database writes
- queue management
- rate limiting
- conflict resolution
- calendar synchronization

2. All important actions must pass through:
- safety middleware
- confirmation middleware
- permission validation

3. Never expose encrypted personal data to OpenAI APIs.

4. WhatsApp is ONLY the communication layer.
All logic must exist in backend systems.

5. Memory retrieval must NEVER dump raw history into prompts.
Use retrieval pipelines and summarization.

========================================
SYSTEM ARCHITECTURE
========================================

Generate architecture for the following layers:

1. Communication Layer
2. Orchestrator Layer
3. Agent Layer
4. Memory Layer
5. Tool Layer
6. Safety Layer
7. Scheduling Layer
8. Reflection Layer
9. Analytics Layer

========================================
MULTI-AGENT SYSTEM
========================================

Karen is the user-facing orchestrator.

Generate architecture and workflows for the following agents:

1. Karen Agent
- user-facing personality
- conversational orchestration
- high-level reasoning
- tone adaptation

2. Planner Agent
- task decomposition
- planning
- priority reasoning
- scheduling suggestions

3. Scheduler Agent
- reminder timing
- retries
- escalation flow
- DND handling
- state transitions

4. Memory Agent
- memory storage
- retrieval
- tagging
- importance scoring
- semantic search

5. Compression Agent
- nightly summarization
- memory compression
- archive generation

6. Reflection Agent
- behavioral analysis
- productivity analysis
- personality adjustment proposals
- rhythm detection
- burnout detection

7. Security Agent
- sanitization
- encryption routing
- permission enforcement

8. Calendar Agent
- Google Calendar synchronization
- shadow calendar database
- conflict resolution

9. Email Agent
- draft generation
- email summarization
- approval workflows

10. Context Builder Agent
- builds safe context windows
- retrieves only relevant memories
- injects goals + active tasks + recent context
- minimizes token usage

========================================
AI MODEL ROUTING
========================================

Implement AI routing logic.

Use:
- GPT-5.2 for deep reasoning
- GPT-4o for medium tasks
- lightweight models for small tasks

Generate routing strategy for:
- reminder classification
- task extraction
- memory compression
- reflection analysis
- scheduling optimization
- conversational responses
- tagging
- summaries
- planning

========================================
MEMORY SYSTEM
========================================

Design a tiered memory architecture.

Layers:

1. Working Memory
- today’s active conversations
- expires nightly

2. Episodic Memory
- compressed conversation summaries
- recent historical context

3. Semantic Memory
- long-term persistent knowledge
- resources
- habits
- preferences
- important links
- goals

4. Behavioral Memory
- productivity patterns
- reminder effectiveness
- focus patterns
- sleep/work cycles

========================================
MEMORY REQUIREMENTS
========================================

Each memory item must support:
- tags
- categories
- summaries
- embeddings
- encrypted payloads
- importance scores
- expiry dates
- timestamps
- retrieval scores

Implement:
- nightly compression
- rolling summarization
- memory pruning
- archive generation
- vector search
- semantic retrieval

Generate MongoDB schemas.

========================================
SECURITY REQUIREMENTS
========================================

ALL sensitive information MUST be encrypted.

Examples:
- Aadhaar links
- drive links
- credentials
- tokens
- personal documents

OpenAI APIs MUST NEVER see:
- raw encrypted URLs
- tokens
- credentials
- personal identifiers

AI should only receive:
- tags
- summaries
- categories
- safe metadata

Implement:
- encryption strategy
- access control
- permission middleware
- secure retrieval pipeline

---

# You Should Add This Entire Section

Add this near the:

```text id="g7n2m4"
SECURITY REQUIREMENTS
```

section.

---

```text id="e9m4q2"
========================================
ENCRYPTION + DATA ISOLATION SYSTEM
========================================

The system MUST implement strict encryption and AI-isolation architecture.

Sensitive data MUST NEVER be directly exposed to OpenAI APIs.

Examples of sensitive data:
- Google Drive links
- Aadhaar links
- credentials
- OAuth tokens
- personal identifiers
- emails
- private documents
- calendar IDs
- API keys
- phone numbers
- attachment URLs

========================================
FIELD-LEVEL ENCRYPTION
========================================

Implement field-level encryption for all sensitive values.

Use:
- AES-256-GCM encryption
- per-field encryption
- secure IV generation
- authentication tags

Encrypted fields must include:
- encrypted_value
- iv
- auth_tag
- encryption_version
- created_at

Generate encryption utility architecture.

========================================
KEY MANAGEMENT
========================================

Encryption keys MUST NEVER be stored in source code.

Generate architecture for:
- environment-based master keys
- key rotation support
- future cloud KMS integration
- local secure secret management

Keys should support:
- versioning
- rotation
- revocation

========================================
AI-SAFE MEMORY PIPELINE
========================================

OpenAI models MUST NEVER receive:
- raw encrypted values
- decrypted URLs
- credentials
- private identifiers

Instead, AI models should ONLY receive:
- tags
- summaries
- categories
- metadata
- importance scores

Example:

Stored:
{
  encrypted_url: "..."
}

AI-visible:
{
  summary: "Government ID document",
  tags: ["aadhaar", "document"]
}

========================================
DECRYPTION RULES
========================================

Decryption MUST ONLY occur:
- inside trusted backend services
- during approved tool execution
- after permission validation

Examples:
- opening Drive link
- fetching resource
- calendar synchronization
- Gmail actions

OpenAI MUST NEVER directly trigger decryption.

========================================
SECURE TOOL EXECUTION
========================================

Generate:
- secure tool wrapper architecture
- permission-scoped decryption
- access validation middleware
- audit logging for sensitive access

All sensitive accesses must create audit logs.

========================================
ZERO-TRUST AI DESIGN
========================================

Treat OpenAI models as untrusted external reasoning systems.

AI models:
- cannot access raw databases
- cannot access decrypted memory
- cannot access credentials
- cannot access tokens
- cannot directly call sensitive tools

All AI actions must pass through:
- validation middleware
- security middleware
- confirmation middleware

========================================
RESOURCE VAULT SYSTEM
========================================

Implement encrypted resource vault.

Features:
- encrypted link storage
- categorized resources
- access scopes
- expiry rules
- retrieval logs
- secure metadata indexing

========================================
SANITIZED CONTEXT BUILDER
========================================

Context Builder Agent MUST:
- sanitize memory
- remove sensitive fields
- redact identifiers
- minimize context exposure
- inject only relevant summaries

Generate secure context-building pipeline.

========================================
AUDIT + SECURITY LOGGING
========================================

Generate:
- decryption logs
- sensitive-access logs
- permission audit trails
- failed-access monitoring
- suspicious activity detection

========================================
FUTURE SECURITY SUPPORT
========================================

Architecture must support future:
- cloud KMS integration
- multi-device authentication
- biometric approvals
- hardware security modules
- end-to-end encrypted memory sync
```

---

# MOST IMPORTANT SECURITY RULE

This is the biggest conceptual rule:

```text id="j2m8q4"
AI SHOULD NEVER BE THE SOURCE OF TRUTH
```

GPT is:

* reasoning engine
* planner
* conversational layer

NOT:

* secure storage layer
* permission authority
* cryptographic authority

This separation is absolutely critical.

---

# One More VERY Important Recommendation

Add:

```text id="y5r1k9"
Security Confidence Scoring
```

Example:

If AI says:

```text id="c8m4n1"
"send Aadhaar link"
```

The system should verify:

* who requested it
* context validity
* authentication confidence
* conversation continuity
* risk level

before decrypting.

This prevents prompt-injection style attacks.

---

# Also Add This Rule

```text id="v1m7q3"
Sensitive memory retrieval requires deterministic verification, not AI confidence alone.
```

VERY important.

---

# Final Security Architecture You Actually Want

```text id="u4n2k7"
OpenAI Models
    ↓
Context Builder (sanitized)
    ↓
Orchestrator
    ↓
Security Middleware
    ↓
Permission Validator
    ↓
Tool Wrapper
    ↓
Decryption Layer
    ↓
Encrypted Vault
```

This is the correct production architecture.


========================================
CONFIRMATION LAYER
========================================

Design a multi-level confirmation system.

LEVEL 0:
safe automatic actions

LEVEL 1:
soft confirmation

LEVEL 2:
hard confirmation

LEVEL 3:
restricted actions

Generate:
- middleware design
- confirmation rules
- confidence thresholds
- rollback strategy

========================================
TASK SYSTEM
========================================

Generate a complete task engine.

Task states:
- CREATED
- SCHEDULED
- ACTIVE
- ACKNOWLEDGED
- IN_PROGRESS
- MISSED
- RESCHEDULED
- COMPLETED
- ARCHIVED

Reminder states:
- PENDING
- SENT
- FOLLOWUP_1
- FOLLOWUP_2
- ESCALATED
- STOPPED

Generate:
- task schemas
- scheduling workflows
- reminder escalation logic
- retry systems
- acknowledgment detection
- natural-language completion detection

========================================
REMINDER LOGIC
========================================

Reminder flow:
- initial reminder
- 5 minute followup
- 15 minute followup
- escalation
- optional reschedule proposal

Reminder escalation must stop when:
- acknowledged
- snoozed
- task started
- task completed

Karen must:
- understand natural replies
- detect “started”
- detect “done”
- detect “later”
- detect scheduling hints

========================================
TIME RULES
========================================

Implement deterministic interpretation rules.

Definitions:
- evening = 4 PM
- night = 8 PM

DND:
11 PM → 5 AM

Tasks should sync every morning using Google Calendar.

Generate:
- timezone handling
- recurring task logic
- overdue handling
- conflict resolution
- sleep-aware scheduling

========================================
GOAL SYSTEM
========================================

Implement hierarchical goal architecture.

Example:
Goal:
“Crack placements”

Subgoals:
- DSA
- projects
- resume
- mock interviews

Karen should:
- prioritize tasks based on goals
- adapt reminders
- detect progress trends
- suggest optimization

========================================
BEHAVIORAL LEARNING
========================================

Karen must learn:
- productive hours
- reminder effectiveness
- focus patterns
- skipped-task patterns
- sleep/work cycles
- preferred tone styles

Generate:
- analytics architecture
- learning pipelines
- behavioral scoring systems

========================================
PERSONALITY SYSTEM
========================================

Karen’s personality must be:
- mature
- feminine
- concise
- intelligent
- slightly sarcastic
- respectful
- accountability-focused

Generate:
- personality engine
- dynamic tone modulation
- operational modes
- behavior configs

Modes:
- Focus Mode
- Discipline Mode
- Chill Mode
- Deep Work Mode
- Recovery Mode
- Emergency Mode
- Silent Intelligence Mode

Generate config schema.

========================================
REFLECTION SYSTEM
========================================

At midnight:
Reflection Agent must:
- analyze productivity
- compress memories
- detect burnout
- evaluate reminder effectiveness
- propose personality adjustments
- update behavior configs
- generate daily summaries

IMPORTANT:
Reflection Agent MUST NOT rewrite system prompts directly.

Instead:
- generate adjustment proposals
- modify structured behavior configs

========================================
EVENT BUS ARCHITECTURE
========================================

Implement event-driven architecture.

Generate event system for:
- TASK_CREATED
- TASK_COMPLETED
- REMINDER_ACKNOWLEDGED
- MEMORY_EXPIRED
- EMAIL_DRAFTED
- GOAL_UPDATED
- RESOURCE_SAVED
- CALENDAR_SYNCED

Use Redis/BullMQ.

========================================
CALENDAR SYSTEM
========================================

Implement:
- Google Calendar integration
- local shadow calendar
- safe synchronization
- conflict detection
- rollback support

Karen can:
- read
- create
- update
- suggest changes

But destructive operations require confirmation.

========================================
EMAIL SYSTEM
========================================

Karen can:
- read emails
- summarize emails
- generate drafts

Karen CANNOT auto-send emails without approval.

Generate:
- Gmail integration architecture
- approval workflow
- draft pipeline

========================================
RESOURCE MEMORY
========================================

Karen must remember resources.

Examples:
- saved links
- tutorials
- PDFs
- documents
- learning materials

Generate:
- resource schemas
- encrypted storage
- retrieval systems
- tagging pipelines

========================================
CLI DASHBOARD
========================================

Generate CLI dashboard architecture.

Features:
- task stats
- reminder analytics
- streaks
- memory metrics
- system status
- queue health
- behavior analytics

========================================
LOGGING + OBSERVABILITY
========================================

Generate:
- structured logs
- action journals
- confidence logs
- agent tracing
- debugging tools
- simulation environment
- dry-run mode

========================================
PROJECT STRUCTURE
========================================

Generate:
- production-grade folder structure
- service boundaries
- module separation
- environment structure
- config architecture

========================================
IMPLEMENTATION ROADMAP
========================================

Generate phased implementation.

Phase 1:
WhatsApp messaging

Phase 2:
Task system

Phase 3:
Reminder engine

Phase 4:
Memory system

Phase 5:
Calendar/email integration

Phase 6:
Behavior learning

Phase 7:
Reflection + adaptive personality

Phase 8:
Optimization/scaling

========================================
OUTPUT REQUIREMENTS
========================================

Generate:
1. Complete architecture
2. Folder structure
3. Database schemas
4. Event flows
5. Agent workflows
6. Queue architecture
7. Memory lifecycle
8. Security design
9. API structure
10. State machines
11. Scheduling engine
12. Confirmation middleware
13. Deployment strategy
14. Scaling recommendations
15. Cost optimization strategies
16. Future extensibility plan

The output must be:
- production-grade
- implementation-oriented
- deeply detailed
- scalable
- security-first
- modular
- maintainable
- realistic