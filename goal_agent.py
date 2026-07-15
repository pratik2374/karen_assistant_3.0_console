"""
Autonomous Swarm  (v9 - gpt-5.4, wide search, append-merge)

ARCHITECTURE (unchanged):  PLAN -> EXECUTE -> STITCH
    1. PLAN    - planner breaks the goal into smaller subtasks.
    2. EXECUTE - each subtask runs one by one and produces a self-contained
                 FRAGMENT. Checkpointed after every fragment.
    3. STITCH  - stitcher reads ALL fragments, writes the connective logic
                 (summary + index + transitions), and Python MERGES by
                 APPENDING the full fragments underneath.

Public API (unchanged):
    launch_swarm_task(goal, instructions=None) -> task_id
    kill_swarm_task(task_id)
    get_swarm_status(task_id=None)
    read_swarm_result(task_id)
Connectors: OpenAI (agno) + MongoDB (swarm_tasks_col, live_alerts_col)
+ Notepad popup + autonomous live alerts.

NOTHING ABOUT ANY PARTICULAR USER IS HARDCODED.
All task-specific direction arrives at RUNTIME via `instructions` (free text),
which is threaded into the planner, executor and stitcher prompts. The prompts
in this file are goal-agnostic scaffolding only.

WHY THE OUTPUT USED TO BE THIN (and what changed)
-------------------------------------------------
Old flow was a compression funnel: N fragments -> ONE stitch call that had to
re-emit the entire deliverable in a single bounded reply. Length was capped by
the model's max output, so depth died at the last step. Fixes:
  * WIDE UPFRONT SWEEP: search first, collect/dedupe ~30-40 URLs, then hand a
    slice to each subtask. Breadth is guaranteed before any writing begins.
  * LONG SECTIONS: each fragment is written at length (SECTION_WORD_TARGET) with
    an explicit max output budget.
  * APPEND-MERGE: Python concatenates full fragments. The stitcher only writes
    the summary/index/connective tissue, so nothing is re-summarized away.
  * gpt-5.4 has a ~1.05M context window, so the old 128k-era caps are relaxed.

ENV:
    OPENAI_API_KEY (required)
    TAVILY_API_KEY / SERPER_API_KEY (optional; better search)
    SWARM_EXEC_MODEL    default gpt-5.4        (writes fragments)
    SWARM_STITCH_MODEL  default gpt-5.4        (connective logic)
    SWARM_PLANNER_MODEL default gpt-5.4-mini
    SWARM_EXTRACT_MODEL default gpt-5.4-mini
"""

import os
import re
import json
import time
import uuid
import subprocess
import urllib.request
import urllib.parse
from datetime import datetime
from concurrent.futures import ThreadPoolExecutor, as_completed

from agno.agent import Agent
from agno.models.openai import OpenAIChat

from db import swarm_tasks_col, live_alerts_col


# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
EXEC_MODEL    = os.getenv("SWARM_EXEC_MODEL",    "gpt-5.4")
STITCH_MODEL  = os.getenv("SWARM_STITCH_MODEL",  "gpt-5.4")
PLANNER_MODEL = os.getenv("SWARM_PLANNER_MODEL", "gpt-5.4-mini")
EXTRACT_MODEL = os.getenv("SWARM_EXTRACT_MODEL", "gpt-5.4-mini")

MAX_CONCURRENT_SWARMS = int(os.getenv("SWARM_MAX_CONCURRENT", "3"))
MAX_SUBTASKS          = int(os.getenv("SWARM_MAX_SUBTASKS", "8"))

# Wide upfront sweep: collect this many distinct URLs BEFORE any writing.
SWEEP_TARGET_URLS   = int(os.getenv("SWARM_SWEEP_TARGET_URLS", "40"))
SWEEP_QUERIES       = int(os.getenv("SWARM_SWEEP_QUERIES", "10"))
FETCH_WORKERS       = int(os.getenv("SWARM_FETCH_WORKERS", "8"))
TOPUP_PER_SUBTASK   = int(os.getenv("SWARM_TOPUP_PER_SUBTASK", "3"))  # extra targeted digs

ENABLE_REFINE = os.getenv("SWARM_REFINE", "1") != "0"
REFINE_MAX    = int(os.getenv("SWARM_REFINE_MAX", "3"))

# gpt-5.4 has ~1.05M context, so these are generous (still bounded on purpose).
PAGE_CHAR_CAP       = int(os.getenv("SWARM_PAGE_CHAR_CAP", "20000"))
SUBTASK_CONTEXT_CAP = int(os.getenv("SWARM_SUBTASK_CONTEXT_CAP", "160000"))
FRAGMENT_CAP        = int(os.getenv("SWARM_FRAGMENT_CAP", "30000"))
STITCH_BUNDLE_CAP   = int(os.getenv("SWARM_STITCH_BUNDLE_CAP", "300000"))

SECTION_WORD_TARGET = int(os.getenv("SWARM_SECTION_WORD_TARGET", "1000"))
SECTION_MAX_TOKENS  = int(os.getenv("SWARM_SECTION_MAX_TOKENS", "8000"))
STITCH_MAX_TOKENS   = int(os.getenv("SWARM_STITCH_MAX_TOKENS", "6000"))

TASK_DEADLINE_SECONDS = int(os.getenv("SWARM_DEADLINE_SECONDS", "10800"))  # 3 h
LLM_RETRIES           = int(os.getenv("SWARM_LLM_RETRIES", "5"))
NET_TIMEOUT           = int(os.getenv("SWARM_NET_TIMEOUT", "20"))

REPORTS_ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "research_reports")

_executor = ThreadPoolExecutor(max_workers=MAX_CONCURRENT_SWARMS, thread_name_prefix="swarm")
_active_swarms = {}


class SwarmKilled(Exception):
    """Raised at a control boundary when the task is killed or times out."""


# ---------------------------------------------------------------------------
# Infra helpers
# ---------------------------------------------------------------------------
def get_openai_api_key():
    key = os.getenv("OPENAI_API_KEY")
    if not key:
        raise ValueError("OPENAI_API_KEY environment variable is not set. The Swarm requires OpenAI.")
    return key


def _now():
    return datetime.now().isoformat()


def _update(task_id, **fields):
    fields["updated_at"] = _now()
    swarm_tasks_col.update_one({"task_id": task_id}, {"$set": fields})


def log_swarm_thought(task_id, thought):
    _update(task_id, current_thought=thought)
    return f"Thought logged: {thought}"


def check_kill_switch(task_id):
    t = swarm_tasks_col.find_one({"task_id": task_id}, {"kill_flag": 1})
    return "KILL_FLAG_TRUE" if (t and t.get("kill_flag")) else "CONTINUE"


def _ensure_alive(task_id, deadline):
    if check_kill_switch(task_id) == "KILL_FLAG_TRUE":
        raise SwarmKilled("killed by user")
    if time.time() > deadline:
        raise SwarmKilled("deadline exceeded")


def _retry(fn, tries=LLM_RETRIES, base=2.0, label="op"):
    last = None
    for attempt in range(1, tries + 1):
        try:
            return fn()
        except Exception as e:  # noqa: BLE001
            msg = str(e)
            if "context_length_exceeded" in msg or "maximum context length" in msg:
                raise
            last = e
            wait = base ** attempt
            m = re.search(r"try again in ([\d.]+)s", msg)
            if m:
                wait = max(wait, float(m.group(1)) + 0.5)
            if attempt < tries:
                time.sleep(wait)
    raise last if last else RuntimeError(f"{label} failed")


# ---------------------------------------------------------------------------
# Retrieval - Python, tiered search (Tavily -> Serper -> DuckDuckGo)
# ---------------------------------------------------------------------------
def _tavily_search(query, k):
    key = os.getenv("TAVILY_API_KEY")
    if not key:
        return None
    body = json.dumps({"query": query, "search_depth": "advanced",
                       "max_results": k, "include_raw_content": True}).encode("utf-8")
    req = urllib.request.Request(
        "https://api.tavily.com/search", data=body,
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {key}"})
    try:
        with urllib.request.urlopen(req, timeout=NET_TIMEOUT) as r:
            data = json.loads(r.read().decode("utf-8", errors="ignore"))
    except Exception:  # noqa: BLE001
        return None
    hits = []
    for o in (data.get("results") or [])[:k]:
        text = (o.get("raw_content") or o.get("content") or "")[:PAGE_CHAR_CAP]
        hits.append({"title": o.get("title", ""), "url": o.get("url", ""),
                     "snippet": o.get("content", ""), "text": text})
    return hits or None


def _serper_search(query, k):
    key = os.getenv("SERPER_API_KEY")
    if not key:
        return None
    body = json.dumps({"q": query, "num": k}).encode("utf-8")
    req = urllib.request.Request(
        "https://google.serper.dev/search", data=body,
        headers={"X-API-KEY": key, "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=NET_TIMEOUT) as r:
            data = json.loads(r.read().decode("utf-8", errors="ignore"))
    except Exception:  # noqa: BLE001
        return None
    return [{"title": o.get("title", ""), "url": o.get("link", ""),
             "snippet": o.get("snippet", "")} for o in (data.get("organic") or [])[:k]] or None


def _ddg_search(query, k):
    def _do():
        url = f"https://html.duckduckgo.com/html/?q={urllib.parse.quote(query)}"
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=NET_TIMEOUT) as r:
            return r.read().decode("utf-8", errors="ignore")
    try:
        html = _retry(_do, tries=3, label="search")
    except Exception:  # noqa: BLE001
        return []
    clean = lambda x: re.sub(r"\s+", " ", re.sub(r"<[^>]+>", "", x)).strip()
    anchors = re.findall(r'<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>(.*?)</a>', html, re.S)
    snips = re.findall(r'class="result__snippet"[^>]*>(.*?)</a>', html, re.S)
    hits = []
    for i, (href, title) in enumerate(anchors[:k]):
        href = href.replace("&amp;", "&")
        real = urllib.parse.parse_qs(urllib.parse.urlparse(href).query).get("uddg", [href])[0] \
            if "uddg=" in href else href
        if real.startswith("//"):
            real = "https:" + real
        hits.append({"title": clean(title), "url": real,
                     "snippet": clean(snips[i]) if i < len(snips) else ""})
    return hits


def _search(query, k=10):
    return _tavily_search(query, k) or _serper_search(query, k) or _ddg_search(query, k)


def fetch_url(url):
    import random
    USER_AGENTS = [
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:123.0) Gecko/20100101 Firefox/123.0",
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    ]
    
    def _fetch_jina():
        jina_url = f"https://r.jina.ai/{url}"
        req = urllib.request.Request(jina_url, headers={
            "User-Agent": random.choice(USER_AGENTS),
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
        })
        with urllib.request.urlopen(req, timeout=NET_TIMEOUT) as r:
            return r.read(3_000_000).decode("utf-8", errors="ignore")

    def _fetch_direct():
        req = urllib.request.Request(url, headers={
            "User-Agent": random.choice(USER_AGENTS),
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.5",
            "Connection": "keep-alive",
            "Upgrade-Insecure-Requests": "1"
        })
        with urllib.request.urlopen(req, timeout=NET_TIMEOUT) as r:
            ctype = r.headers.get("Content-Type", "")
            if "html" not in ctype and "text" not in ctype:
                return ""
            return r.read(3_000_000).decode("utf-8", errors="ignore")

    try:
        # 1. Try Jina Reader first (handles JS, bypasses Cloudflare, returns Markdown)
        html = _retry(_fetch_jina, tries=2, label="fetch_jina")
        # Jina returns markdown, so we don't need heavy HTML stripping, but doing it just in case
        return re.sub(r"\s+", " ", html).strip()[:PAGE_CHAR_CAP]
    except Exception as e1:
        try:
            # 2. Fallback to direct fetch with robust headers if Jina fails or rate limits us
            html = _retry(_fetch_direct, tries=2, label="fetch_direct")
            html = re.sub(r"<(script|style|nav|footer|header)[^>]*>.*?</\1>", " ", html, flags=re.S | re.I)
            return re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", html)).strip()[:PAGE_CHAR_CAP]
        except Exception as e2:
            return f"(fetch failed: Jina={e1}, Direct={e2})"


def _materialize(task_id, hits, deadline):
    """Ensure each hit carries page text (Tavily already does; others get fetched)."""
    _ensure_alive(task_id, deadline)
    need = [h for h in hits if not h.get("text")]
    ready = [{**h, "text": h["text"][:PAGE_CHAR_CAP]} for h in hits if h.get("text")]
    with ThreadPoolExecutor(max_workers=FETCH_WORKERS) as ex:
        futs = {ex.submit(fetch_url, h["url"]): h for h in need}
        for fut in as_completed(futs):
            h = futs[fut]
            try:
                text = fut.result()
            except Exception as e:  # noqa: BLE001
                text = f"(fetch failed: {e})"
            ready.append({**h, "text": text})
    # Keep only pages that actually produced usable content.
    return [p for p in ready if p.get("text") and not p["text"].startswith("(fetch failed")
            and len(p["text"]) > 200]


def _build_context(pages, cap=SUBTASK_CONTEXT_CAP):
    blob, used = [], 0
    for p in pages:
        chunk = f"SOURCE: {p.get('title','')} ({p.get('url','')})\n{p.get('text','')}\n"
        if used + len(chunk) > cap:
            break
        blob.append(chunk)
        used += len(chunk)
    return "\n---\n".join(blob) if blob else "(no readable sources retrieved)"


# ---------------------------------------------------------------------------
# LLM (agno Agent, NO tools attached; runtime `instructions` threaded in)
# ---------------------------------------------------------------------------
def _model(model_id, max_tokens=None):
    kwargs = {"id": model_id, "api_key": get_openai_api_key()}
    if max_tokens:
        # OpenAI reasoning models (like gpt-5.4) require max_completion_tokens instead of max_tokens
        kwargs["max_completion_tokens"] = max_tokens
    try:
        return OpenAIChat(**kwargs)
    except TypeError:
        # Fallback if agno version strictly expects max_tokens
        kwargs.pop("max_completion_tokens", None)
        kwargs["max_tokens"] = max_tokens
        try:
            return OpenAIChat(**kwargs)
        except TypeError:
            kwargs.pop("max_tokens", None)
            return OpenAIChat(**kwargs)


def _ask(model_id, name, role, instructions, message, user_instructions=None, max_tokens=None):
    instr = list(instructions)
    if user_instructions:
        instr.append("USER INSTRUCTIONS (these take priority over the defaults above; "
                     f"follow them exactly): {user_instructions}")
    agent = Agent(name=name, role=role, model=_model(model_id, max_tokens),
                  instructions=instr, markdown=True)
    resp = _retry(lambda: agent.run(message), label=f"{name}.run")
    return (resp.content or "").strip()


def _extract_json(raw, want="array"):
    if not raw:
        return None
    fence = re.search(r"```(?:json)?\s*(.*?)```", raw, re.S)
    if fence:
        raw = fence.group(1)
    m = re.search(r"\[.*\]" if want == "array" else r"\{.*\}", raw, re.S)
    if not m:
        return None
    try:
        return json.loads(m.group(0))
    except Exception:  # noqa: BLE001
        return None


# ===========================================================================
# 0. WIDE SWEEP  (search first, gather 30-40 sources, THEN research them)
# ===========================================================================
def _sweep_queries(goal, user_instructions):
    raw = _ask(
        PLANNER_MODEL, "Sweep Query Writer",
        "You write broad, high-recall web search queries that map a topic's landscape.",
        [f"Write {SWEEP_QUERIES} diverse search queries that together surface the widest "
         "range of relevant, high-quality sources for the goal.",
         "Cover every distinct facet of the goal; vary angle, phrasing and specificity.",
         "Respond with ONLY a JSON array of strings."],
        f"GOAL:\n{goal}\n\nReturn the JSON array of queries.",
        user_instructions=user_instructions,
    )
    qs = _extract_json(raw, "array")
    qs = [str(q).strip() for q in qs if str(q).strip()] if isinstance(qs, list) else []
    return qs[:SWEEP_QUERIES] or [goal]


def _wide_sweep(task_id, goal, deadline, user_instructions):
    """Collect and READ ~SWEEP_TARGET_URLS distinct sources before any writing."""
    _ensure_alive(task_id, deadline)
    _update(task_id, current_thought="Wide sweep: mapping the landscape...")
    queries = _sweep_queries(goal, user_instructions)

    seen, hits = set(), []
    for q in queries:
        _ensure_alive(task_id, deadline)
        _update(task_id, current_thought=f"Sweeping: {q[:70]}")
        for h in _search(q, k=10):
            u = h.get("url")
            if not u or u in seen:
                continue
            seen.add(u)
            hits.append(h)
        if len(hits) >= SWEEP_TARGET_URLS:
            break

    hits = hits[:SWEEP_TARGET_URLS]
    _update(task_id, current_thought=f"Reading {len(hits)} sources...")
    pages = _materialize(task_id, hits, deadline)
    _update(task_id, sources_found=len(hits), sources_read=len(pages),
            current_thought=f"Read {len(pages)} usable sources.")
    return pages, seen


def _assign_sources(task_id, goal, subtasks, pages, user_instructions):
    """Map each fetched source to the subtask(s) it serves. Falls back to round-robin."""
    catalog = "\n".join(
        f"[{i}] {p.get('title','')} — {p.get('url','')} :: {(p.get('snippet') or p.get('text',''))[:200]}"
        for i, p in enumerate(pages))[:120000]
    subs = "\n".join(f"{i+1}. {s}" for i, s in enumerate(subtasks))
    raw = _ask(
        PLANNER_MODEL, "Source Router",
        "You route source documents to the subtasks they are most useful for.",
        ["For each subtask, list the indices of the sources most relevant to it.",
         "A source may serve several subtasks. Ignore irrelevant sources.",
         'Respond with ONLY a JSON object like {"1": [0,3,7], "2": [1,2]} '
         "keyed by subtask number."],
        f"GOAL: {goal}\n\nSUBTASKS:\n{subs}\n\nSOURCE CATALOG:\n{catalog}\n\nReturn the JSON object.",
        user_instructions=user_instructions,
    )
    mapping = _extract_json(raw, "object") or {}
    assigned = {}
    for i in range(len(subtasks)):
        idxs = mapping.get(str(i + 1)) or []
        picked = [pages[j] for j in idxs if isinstance(j, int) and 0 <= j < len(pages)]
        assigned[i] = picked
    # Round-robin fallback for any subtask the router left empty.
    for i in range(len(subtasks)):
        if not assigned[i] and pages:
            assigned[i] = [p for j, p in enumerate(pages) if j % len(subtasks) == i] or pages[:5]
    return assigned


# ===========================================================================
# 1. PLAN
# ===========================================================================
def _plan(task_id, goal, deadline, user_instructions, landscape=""):
    _ensure_alive(task_id, deadline)
    _update(task_id, current_thought="Planning: breaking the goal into subtasks...")
    raw = _ask(
        PLANNER_MODEL, "Planner",
        "Senior planner that breaks any goal into smaller, self-contained subtasks.",
        [f"Break the goal into 4-{MAX_SUBTASKS} concrete, ordered, NON-overlapping subtasks.",
         "Each must be independently executable and produce a substantial standalone section.",
         "Together they must fully cover every facet of the goal.",
         "Ground the plan in the landscape provided (if any); don't invent structure blindly.",
         "Respond with ONLY a JSON array of strings. No prose, no code fences."],
        f"GOAL:\n{goal}\n\nLANDSCAPE (from an initial sweep):\n{landscape[:40000]}\n\n"
        f"Return the JSON array of subtasks.",
        user_instructions=user_instructions,
    )
    steps = _extract_json(raw, "array")
    if not steps:
        steps = [l.strip("-*0123456789. )").strip()
                 for l in raw.splitlines() if len(l.strip()) > 5]
    steps = [str(s).strip() for s in (steps or [goal]) if str(s).strip()]
    return steps[:MAX_SUBTASKS]


# ===========================================================================
# 2. EXECUTE  (each subtask -> one LONG fragment)
# ===========================================================================
def _topup(task_id, subtask, goal, seen, deadline, user_instructions):
    """Targeted extra digging for a subtask, on top of its swept sources."""
    raw = _ask(
        PLANNER_MODEL, "Query Writer",
        "You write specific, high-yield web search queries.",
        [f"Write {TOPUP_PER_SUBTASK} specific queries to dig deeper into the subtask.",
         "Respond with ONLY a JSON array of strings."],
        f"GOAL: {goal}\nSUBTASK: {subtask}\nReturn the JSON array.",
        user_instructions=user_instructions,
    )
    qs = _extract_json(raw, "array") or [subtask]
    hits = []
    for q in [str(x) for x in qs][:TOPUP_PER_SUBTASK]:
        _ensure_alive(task_id, deadline)
        for h in _search(q, k=6):
            u = h.get("url")
            if u and u not in seen:
                seen.add(u)
                hits.append(h)
    return _materialize(task_id, hits, deadline)


def _execute(task_id, goal, subtasks, assigned, seen, deadline, user_instructions,
             label="Executing"):
    fragments, total = [], len(subtasks)
    for i, sub in enumerate(subtasks):
        _ensure_alive(task_id, deadline)
        _update(task_id, current_thought=f"{label} [{i+1}/{total}] {sub[:80]}",
                progress={"done": i, "total": total})

        pages = list(assigned.get(i, []))
        pages += _topup(task_id, sub, goal, seen, deadline, user_instructions)
        context = _build_context(pages)

        _ensure_alive(task_id, deadline)
        _update(task_id, current_thought=f"{label} [{i+1}/{total}] writing from {len(pages)} sources...")
        others = "\n".join(f"- {s}" for j, s in enumerate(subtasks) if j != i)
        fragment = _ask(
            EXEC_MODEL, "Executor",
            "Expert who fully completes one subtask and writes it up at depth from sources.",
            ["Complete THIS subtask and write a substantial, self-contained section.",
             f"Target roughly {SECTION_WORD_TARGET} words. Depth and specificity over brevity.",
             "Use ONLY the provided sources for facts. Be concrete: exact figures, names, "
             "exact URLs, emails, dates, and short quotes (<=15 words).",
             "Put the source URL next to each fact. Never invent facts, URLs or emails.",
             "Do NOT cover the other subtasks (listed below) - stay in your lane.",
             "Note anything this subtask asked that the sources did not answer.",
             "Start with a single markdown '## ' heading and nothing above it.",
             "No generic filler - every sentence must carry sourced substance."],
            f"OVERALL GOAL: {goal}\nYOUR SUBTASK ({i+1}/{total}): {sub}\n\n"
            f"OTHER SUBTASKS (do not cover these):\n{others}\n\nSOURCES:\n{context}\n\n"
            f"Write your section now.",
            user_instructions=user_instructions,
            max_tokens=SECTION_MAX_TOKENS,
        )
        fragments.append({
            "subtask": sub, "fragment": fragment[:FRAGMENT_CAP],
            "sources": [{"title": p.get("title", ""), "url": p.get("url", "")} for p in pages],
        })
        _update(task_id, partial_results=fragments, progress={"done": i + 1, "total": total},
                sources_read=len(seen))
    return fragments


# ===========================================================================
# 2b. REFINE  (optional gap-fill)
# ===========================================================================
def _refine(task_id, goal, fragments, deadline, user_instructions):
    _ensure_alive(task_id, deadline)
    _update(task_id, current_thought="Reviewing fragments for gaps...")
    condensed = "\n\n".join(f"## {f['subtask']}\n{f['fragment'][:2000]}" for f in fragments)[:120000]
    raw = _ask(
        STITCH_MODEL, "Critic", "Sharp reviewer who finds what's missing.",
        [f"Review the fragments against the goal. Identify up to {REFINE_MAX} important "
         "gaps, unanswered questions, or weakly-supported claims.",
         "Turn each into a concrete follow-up subtask.",
         "Respond with ONLY a JSON array of strings. Return [] if coverage is excellent."],
        f"GOAL: {goal}\n\nFRAGMENTS:\n{condensed}\n\nReturn the JSON array.",
        user_instructions=user_instructions,
    )
    subs = _extract_json(raw, "array") or []
    return [str(s).strip() for s in subs if str(s).strip()][:REFINE_MAX]


# ===========================================================================
# 3. STITCH  (connective logic only)  +  Python APPEND-MERGE
# ===========================================================================
def _dedup_sources(fragments):
    seen, out = set(), []
    for f in fragments:
        for s in f.get("sources", []):
            u = s.get("url")
            if u and u not in seen:
                seen.add(u)
                out.append(s)
    return out


def _stitch_glue(task_id, goal, fragments, deadline, user_instructions):
    """The stitcher reads ALL fragments and writes ONLY the connective tissue:
    title, executive summary, index, and how the sections relate. It does NOT
    rewrite the fragments - Python appends those in full underneath."""
    _ensure_alive(task_id, deadline)
    _update(task_id, current_thought="Stitching: writing summary, index and connective logic...")
    bundle = "\n\n".join(f"### FRAGMENT {i+1} — {f['subtask']}\n{f['fragment']}"
                         for i, f in enumerate(fragments))[:STITCH_BUNDLE_CAP]
    raw = _ask(
        STITCH_MODEL, "Stitcher",
        "Editor who reads all fragments and writes the connective tissue binding them.",
        ["You are given the FULL fragments produced by each subtask.",
         "The fragments will be APPENDED verbatim beneath what you write - so do NOT "
         "rewrite, summarize away, or reproduce them.",
         "Write ONLY the connective material, as a JSON object with these keys:",
         '  "title": a precise title for the deliverable',
         '  "summary": 2-3 line plain summary (what this is, what it concludes)',
         '  "gold": 6-12 bullet strings - the highest-value SPECIFIC findings across all '
         'fragments (names, numbers, URLs). This is the "read this first" section.',
         '  "direct_answer": markdown that directly answers the goal (a table/list if the '
         'answer is enumerable). Pull the actual items out of the fragments.',
         '  "how_it_fits": 1 short paragraph on how the sections relate / the through-line',
         '  "gaps": bullet strings - what remains uncertain, contradictory or unfound',
         "Respond with ONLY that JSON object. No prose, no code fences."],
        f"GOAL: {goal}\n\nFRAGMENTS:\n{bundle}\n\nReturn the JSON object.",
        user_instructions=user_instructions,
        max_tokens=STITCH_MAX_TOKENS,
    )
    return _extract_json(raw, "object") or {}


def _merge(goal, glue, fragments, all_sources):
    """Deterministic Python merge: glue on top, FULL fragments appended below."""
    title = str(glue.get("title") or goal).strip()
    summary = str(glue.get("summary") or "").strip()
    gold = glue.get("gold") or []
    direct = str(glue.get("direct_answer") or "").strip()
    fits = str(glue.get("how_it_fits") or "").strip()
    gaps = glue.get("gaps") or []

    parts = []
    # Keep the '---' contract: summary above, full document below.
    parts.append(summary or "Swarm task completed.")
    parts.append("")
    parts.append("---")
    parts.append("")
    parts.append(f"# {title}")
    if gold:
        parts.append("\n## Key Takeaways — The Gold\n")
        parts += [f"- {g}" for g in gold]
    if direct:
        parts.append("\n## Direct Answer\n")
        parts.append(direct)
    if fits:
        parts.append("\n## How It Fits Together\n")
        parts.append(fits)

    parts.append("\n## Contents\n")
    for i, f in enumerate(fragments, 1):
        parts.append(f"{i}. {f['subtask']}")

    parts.append("\n---\n")
    for f in fragments:                      # <-- FULL fragments, appended verbatim
        parts.append(f["fragment"])
        parts.append("")

    if gaps:
        parts.append("\n## Caveats & Gaps\n")
        parts += [f"- {g}" for g in gaps]

    if all_sources:
        parts.append(f"\n## Sources ({len(all_sources)})\n")
        parts += [f"- {s['title']} — {s['url']}" for s in all_sources if s.get("url")]

    return "\n".join(parts)


def _extract_records(task_id, goal, deliverable, deadline, user_instructions):
    _ensure_alive(task_id, deadline)
    _update(task_id, current_thought="Extracting structured records...")
    raw = _ask(
        EXTRACT_MODEL, "Extractor",
        "Precise data extractor converting a deliverable into structured JSON rows.",
        ["Extract the key items the goal asked for as JSON.",
         "Return ONLY a JSON array of objects. No prose, no code fences.",
         "Use whichever fields apply to the goal (e.g. title, name, url, email, "
         "organization, location, description, date, notes). Return [] if nothing fits."],
        f"GOAL: {goal}\n\nDELIVERABLE:\n{deliverable[:200000]}\n\nReturn the JSON array.",
        user_instructions=user_instructions,
    )
    recs = _extract_json(raw, "array")
    return recs if isinstance(recs, list) else []


# ---------------------------------------------------------------------------
# Storage (Notepad .txt only)
# ---------------------------------------------------------------------------
def _store_report(task_id, goal, text):
    os.makedirs(REPORTS_ROOT, exist_ok=True)
    safe = "".join(c if c.isalnum() else "_" for c in goal[:30])
    path = os.path.join(REPORTS_ROOT, f"SwarmReport_{safe}_{task_id[:6]}.txt")
    with open(path, "w", encoding="utf-8") as f:
        f.write(text)
    return path


# ---------------------------------------------------------------------------
# Worker loop:  SWEEP -> PLAN -> EXECUTE -> (REFINE) -> STITCH -> APPEND-MERGE
# ---------------------------------------------------------------------------
def worker_loop(task_id, goal, user_instructions=None):
    deadline = time.time() + TASK_DEADLINE_SECONDS
    try:
        _update(task_id, status="RUNNING", current_thought="Booting orchestrator...")

        pages, seen = _wide_sweep(task_id, goal, deadline, user_instructions)
        landscape = "\n".join(f"- {p.get('title','')} ({p.get('url','')}): "
                              f"{(p.get('snippet') or p.get('text',''))[:180]}" for p in pages)

        subtasks = _plan(task_id, goal, deadline, user_instructions, landscape)
        _update(task_id, plan=subtasks, progress={"done": 0, "total": len(subtasks)})

        assigned = _assign_sources(task_id, goal, subtasks, pages, user_instructions)
        fragments = _execute(task_id, goal, subtasks, assigned, seen, deadline,
                             user_instructions, label="Executing")

        if ENABLE_REFINE:
            follow = _refine(task_id, goal, fragments, deadline, user_instructions)
            if follow:
                _update(task_id, refine_subtasks=follow)
                fragments += _execute(task_id, goal, follow, {}, seen, deadline,
                                      user_instructions, label="Refining")

        glue = _stitch_glue(task_id, goal, fragments, deadline, user_instructions)
        all_sources = _dedup_sources(fragments)
        deliverable = _merge(goal, glue, fragments, all_sources)
        records = _extract_records(task_id, goal, deliverable, deadline, user_instructions)
        _ensure_alive(task_id, deadline)

        summary = deliverable.split("---", 1)[0].strip() or "Swarm task completed."
        txt_path = _store_report(task_id, goal, deliverable)

        _update(task_id, status="COMPLETED", result=deliverable, records=records,
                record_count=len(records), sources_read=len(all_sources),
                word_count=len(deliverable.split()), report_path=txt_path,
                current_thought="Finished successfully.")

        try:
            if os.name == "nt":
                subprocess.Popen(["notepad.exe", txt_path])
        except Exception as e:  # noqa: BLE001
            print(f"[Swarm] Failed to open Notepad: {e}")

        live_alerts_col.insert_one({
            "message": f"Swarm Task Completed! {summary}\n"
                       f"{len(fragments)} sections, {len(all_sources)} sources, "
                       f"~{len(deliverable.split())} words. Popped open in Notepad.",
            "mood": "proud", "created_at": _now(), "processed": False,
        })

    except SwarmKilled as k:
        _update(task_id, status="KILLED", current_thought=f"Terminated: {k}")
        live_alerts_col.insert_one({
            "message": f"Swarm Task stopped ({k}) on goal: {goal[:30]}...",
            "mood": "neutral", "created_at": _now(), "processed": False,
        })
    except Exception as e:  # noqa: BLE001
        _update(task_id, status="FAILED", current_thought=f"Crashed: {e}", error=str(e))
        live_alerts_col.insert_one({
            "message": f"Swarm Task crashed on goal: {goal[:30]}... Error: {e}",
            "mood": "annoyed", "created_at": _now(), "processed": False,
        })
    finally:
        _active_swarms.pop(task_id, None)


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------
def launch_swarm_task(goal: str, instructions: str = None) -> str:
    """Launch a swarm task.

    goal:         what to do (free text, supplied at runtime).
    instructions: OPTIONAL free-text direction supplied at runtime - tone, depth,
                  format, must-haves, who it's for, anything. It is threaded into
                  the planner, executor and stitcher and TAKES PRIORITY over the
                  generic defaults. Nothing task-specific is hardcoded in this file.
    """
    task_id = str(uuid.uuid4())
    swarm_tasks_col.insert_one({
        "task_id": task_id, "goal": goal, "instructions": instructions,
        "status": "QUEUED", "current_thought": "Waiting for a free worker slot...",
        "result": None, "plan": None, "partial_results": [], "records": [],
        "progress": {"done": 0, "total": 0}, "sources_found": 0, "sources_read": 0,
        "kill_flag": False, "created_at": _now(), "updated_at": _now(),
    })
    fut = _executor.submit(worker_loop, task_id, goal, instructions)
    _active_swarms[task_id] = fut
    return task_id


def kill_swarm_task(task_id: str) -> str:
    res = swarm_tasks_col.update_one({"task_id": task_id}, {"$set": {"kill_flag": True}})
    if res.matched_count == 0:
        return f"Task {task_id} not found."
    return f"Task {task_id} marked for termination. It stops at the next control boundary."


def get_swarm_status(task_id: str = None) -> str:
    if task_id:
        t = swarm_tasks_col.find_one({"task_id": task_id})
        if not t:
            return "Not found."
        p = t.get("progress") or {}
        s = (f"Task: {t['goal'][:50]}...\nStatus: {t['status']}\n"
             f"Sections: {p.get('done', 0)}/{p.get('total', 0)} | "
             f"Sources: {t.get('sources_read', 0)}\n"
             f"Current Thought: {t.get('current_thought')}")
        if t.get("word_count"):
            s += f"\nLength: ~{t['word_count']} words"
        if t.get("record_count"):
            s += f"\nStructured records: {t['record_count']}"
        if t["status"] == "COMPLETED" and t.get("result"):
            s += f"\nResult: {t['result'][:200]}..."
        return s

    active = list(swarm_tasks_col.find({"status": {"$in": ["RUNNING", "QUEUED"]}}))
    out = ""
    if active:
        out += "Active Swarms:\n"
        for t in active:
            p = t.get("progress") or {}
            out += (f"- ID: {t['task_id']} | {t['status']} "
                    f"| {p.get('done', 0)}/{p.get('total', 0)} sections "
                    f"| {t.get('sources_read', 0)} sources "
                    f"| Doing: {t.get('current_thought')}\n")
    else:
        out += "No active swarm tasks right now.\n"
    recent = list(swarm_tasks_col.find(
        {"status": {"$in": ["COMPLETED", "FAILED", "KILLED"]}}
    ).sort("created_at", -1).limit(3))
    if recent:
        out += "\nRecently Finished Swarms:\n"
        for t in recent:
            out += f"- ID: {t['task_id']} | Goal: {t['goal'][:50]}... | {t['status']}\n"
    return out


def read_swarm_result(task_id: str) -> str:
    t = swarm_tasks_col.find_one({"task_id": task_id})
    if not t:
        return f"Task {task_id} not found."
    if t["status"] == "COMPLETED":
        res = t.get("result", "No result found.")
        if t.get("records"):
            res += f"\n\n--- STRUCTURED RECORDS ({len(t['records'])}) ---\n"
            res += json.dumps(t["records"], ensure_ascii=False, indent=2)
        return res
    frags = t.get("partial_results") or []
    if frags:
        joined = "\n\n".join(f["fragment"] for f in frags)
        return f"Task {task_id} is {t['status']} (sections so far):\n\n{joined}"
    return f"Task {task_id} is currently {t['status']}. No result yet."