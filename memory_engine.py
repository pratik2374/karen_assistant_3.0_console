"""
memory_engine.py — Episodic Memory & Conversation Intelligence

Handles:
1. Session Persistence — save full conversation sessions to MongoDB
2. Session Summarization — generate concise summaries via LLM (background)
3. Embedding Generation — create vector embeddings for semantic search (background)
4. Semantic Search — find relevant past conversations by similarity
"""

import os
import json
import threading
import numpy as np
from datetime import datetime, timezone
from openai import OpenAI

from db import conversation_sessions_col


def _get_openai_client():
    """Initialize OpenAI client from environment."""
    return OpenAI(api_key=os.getenv("OPENAI_API_KEY"))


# ─────────────────────────────────────────────────────────────────────────────
# 1. Session Persistence
# ─────────────────────────────────────────────────────────────────────────────

def save_session(session_id: str, messages: list, started_at: str):
    """Save a conversation session to MongoDB."""
    ended_at = datetime.now(timezone.utc).isoformat()
    conversation_sessions_col.update_one(
        {"session_id": session_id},
        {"$set": {
            "session_id": session_id,
            "started_at": started_at,
            "ended_at": ended_at,
            "messages": messages,
            "message_count": len(messages),
        }},
        upsert=True
    )
    print(f"[Memory] Session {session_id[:8]}... saved ({len(messages)} messages).")


def save_and_process_session(session_id: str, messages: list, started_at: str):
    """Save session immediately, then generate summary + embedding in background."""
    if not messages:
        return
    save_session(session_id, messages, started_at)
    # Kick off summary + embedding generation in a background thread
    thread = threading.Thread(
        target=_generate_summary_and_embedding,
        args=(session_id, messages),
        daemon=True
    )
    thread.start()


def auto_save_session(session_id: str, messages: list, started_at: str):
    """Lightweight mid-session save (no summary/embedding yet). Runs in background."""
    if not messages:
        return
    thread = threading.Thread(
        target=save_session,
        args=(session_id, list(messages), started_at),
        daemon=True
    )
    thread.start()


# ─────────────────────────────────────────────────────────────────────────────
# 2. Session Summarization
# ─────────────────────────────────────────────────────────────────────────────

def generate_session_summary(messages: list) -> str:
    """Generate a concise summary of a conversation session using LLM."""
    if not messages:
        return None

    # Format conversation for the LLM
    conversation_text = ""
    for msg in messages:
        role = "User" if msg["role"] == "user" else "Karen"
        conversation_text += f"{role}: {msg['content']}\n"

    # Truncate if too long (keep last ~3000 chars)
    if len(conversation_text) > 3500:
        conversation_text = "...(earlier messages trimmed)...\n" + conversation_text[-3000:]

    try:
        client = _get_openai_client()
        response = client.chat.completions.create(
            model="gpt-4o-mini",
            messages=[
                {
                    "role": "system",
                    "content": (
                        "Summarize this conversation in 3-4 concise bullet points. "
                        "Focus on: topics discussed, tasks/reminders created or completed, "
                        "decisions made, and the user's general mood. "
                        "Keep each bullet under 20 words. No markdown formatting."
                    )
                },
                {"role": "user", "content": conversation_text}
            ],
            max_tokens=200,
            temperature=0.3
        )
        return response.choices[0].message.content.strip()
    except Exception as e:
        print(f"[Memory Error] Summary generation failed: {e}")
        return None


# ─────────────────────────────────────────────────────────────────────────────
# 3. Embedding Generation
# ─────────────────────────────────────────────────────────────────────────────

def generate_embedding(text: str) -> list:
    """Generate an embedding vector using OpenAI text-embedding-3-small."""
    try:
        client = _get_openai_client()
        response = client.embeddings.create(
            model="text-embedding-3-small",
            input=text
        )
        return response.data[0].embedding
    except Exception as e:
        print(f"[Memory Error] Embedding generation failed: {e}")
        return None


def _generate_summary_and_embedding(session_id: str, messages: list):
    """Background worker: generate session summary, then its embedding."""
    try:
        summary = generate_session_summary(messages)
        if summary:
            conversation_sessions_col.update_one(
                {"session_id": session_id},
                {"$set": {"summary": summary}}
            )
            # Now embed the summary for future semantic search
            embedding = generate_embedding(summary)
            if embedding:
                conversation_sessions_col.update_one(
                    {"session_id": session_id},
                    {"$set": {"embedding": embedding}}
                )
            print(f"[Memory] Session {session_id[:8]}... summary & embedding generated.")
    except Exception as e:
        print(f"[Memory Error] Failed to process session {session_id[:8]}...: {e}")


# ─────────────────────────────────────────────────────────────────────────────
# 4. Semantic Search
# ─────────────────────────────────────────────────────────────────────────────

def _cosine_similarity(a, b):
    """Compute cosine similarity between two vectors."""
    a = np.array(a, dtype=np.float32)
    b = np.array(b, dtype=np.float32)
    dot = np.dot(a, b)
    norm = np.linalg.norm(a) * np.linalg.norm(b)
    if norm == 0:
        return 0.0
    return float(dot / norm)


def search_sessions(query: str, top_k: int = 3) -> str:
    """Search past conversation sessions by semantic similarity to the query."""
    # Generate query embedding
    query_embedding = generate_embedding(query)
    if not query_embedding:
        return "Could not generate search embedding."

    # Fetch all sessions that have embeddings
    sessions = list(conversation_sessions_col.find(
        {"embedding": {"$ne": None}, "summary": {"$ne": None}},
        {"session_id": 1, "started_at": 1, "summary": 1, "embedding": 1, "messages": 1}
    ))

    if not sessions:
        return "No past conversation sessions found to search."

    # Score each session by cosine similarity
    scored = []
    for s in sessions:
        sim = _cosine_similarity(query_embedding, s["embedding"])
        scored.append((sim, s))

    # Sort descending by similarity
    scored.sort(key=lambda x: x[0], reverse=True)

    # Format the top results
    results = []
    for sim, s in scored[:top_k]:
        if sim < 0.15:
            continue  # Skip very low relevance matches

        # Format date
        try:
            dt = datetime.fromisoformat(s["started_at"].replace("Z", "+00:00"))
            date_str = dt.strftime("%b %d, %I:%M %p")
        except Exception:
            date_str = s["started_at"][:16]

        result = f"[{date_str}] (relevance: {sim:.0%})\n{s['summary']}"

        # Find the most relevant message snippets using keyword overlap
        if s.get("messages"):
            query_words = set(query.lower().split())
            best_snippets = []
            for msg in s["messages"]:
                content = msg.get("content", "")
                words = set(content.lower().split())
                overlap = len(query_words & words)
                if overlap > 0:
                    snippet = content[:150] + ("..." if len(content) > 150 else "")
                    best_snippets.append((overlap, msg["role"], snippet))

            best_snippets.sort(key=lambda x: x[0], reverse=True)
            for _, role, snippet in best_snippets[:2]:
                role_name = "User" if role == "user" else "Karen"
                result += f"\n  > {role_name}: {snippet}"

        results.append(result)

    if not results:
        return "No relevant past conversations found for that query."

    return "\n\n".join(results)


# ─────────────────────────────────────────────────────────────────────────────
# 5. Startup Utilities
# ─────────────────────────────────────────────────────────────────────────────

def get_recent_session_summaries(limit: int = 3) -> str:
    """Load the most recent session summaries for system prompt injection at startup."""
    sessions = list(conversation_sessions_col.find(
        {"summary": {"$ne": None}},
        {"started_at": 1, "summary": 1}
    ).sort("ended_at", -1).limit(limit))

    if not sessions:
        return "No previous conversation sessions recorded."

    # Reverse so they appear chronologically (oldest first)
    sessions.reverse()

    lines = []
    for s in sessions:
        try:
            dt = datetime.fromisoformat(s["started_at"].replace("Z", "+00:00"))
            date_str = dt.strftime("%b %d, %I:%M %p")
        except Exception:
            date_str = s["started_at"][:16]
        lines.append(f"- [{date_str}] {s['summary']}")

    return "\n".join(lines)


def process_orphan_sessions():
    """Generate summaries for sessions saved without one (e.g., process was killed mid-session)."""
    orphans = list(conversation_sessions_col.find(
        {"summary": None, "message_count": {"$gt": 0}}
    ))

    if not orphans:
        return

    print(f"[Memory] Found {len(orphans)} orphan session(s) without summaries. Processing...")
    for orphan in orphans:
        sid = orphan["session_id"]
        print(f"[Memory] Generating summary for orphan session {sid[:8]}...")
        _generate_summary_and_embedding(sid, orphan.get("messages", []))
