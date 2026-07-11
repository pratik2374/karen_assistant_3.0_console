"""
Autonomous Swarm  (v8 - universal PLAN -> EXECUTE -> STITCH)

One architecture for EVERY task:
    1. PLAN    - a planner breaks the goal into smaller subtasks.
    2. EXECUTE - each subtask runs one by one and produces a self-contained
                 FRAGMENT (gathering sources / info as needed). Checkpointed.
    3. STITCH  - a stitcher agent reads the fragments of ALL subtasks, works out
                 how they relate, writes the connective logic, and merges them
                 into one coherent deliverable that best satisfies the goal.
    (optional REFINE round between execute and stitch: a critic finds gaps and
     spawns a few more subtasks, which are executed and folded in.)

Public flow / connectors unchanged:
    launch_swarm_task(goal) -> task_id
    kill_swarm_task(task_id)
    get_swarm_status(task_id=None)
    read_swarm_result(task_id)
Connectors: OpenAI (agno) + MongoDB (swarm_tasks_col, live_alerts_col)
+ Notepad popup + autonomous live alerts.

Reliability: retrieval is done in Python with hard size caps; the LLM is called
with NO tools, so context can never overflow the 128k window and there are no
tool-call format errors. Search is tiered Tavily -> Serper -> DuckDuckGo
(snippets/content only, never a scrape endpoint).

ENV:
    OPENAI_API_KEY (required)
    TAVILY_API_KEY / SERPER_API_KEY (optional; better search)
    SWARM_EXEC_MODEL   default gpt-4o     (executes subtasks -> fragments)
    SWARM_STITCH_MODEL default gpt-4o     (merges fragments -> deliverable)
    SWARM_PLANNER_MODEL default gpt-4o-mini
    SWARM_EXTRACT_MODEL default gpt-4o-mini
    SWARM_REFINE       "0" to skip the gap-filling round
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
EXEC_MODEL    = os.getenv("SWARM_EXEC_MODEL",    "gpt-4o")
STITCH_MODEL  = os.getenv("SWARM_STITCH_MODEL",  "gpt-4o")
PLANNER_MODEL = os.getenv("SWARM_PLANNER_MODEL", "gpt-4o-mini")
EXTRACT_MODEL = os.getenv("SWARM_EXTRACT_MODEL", "gpt-4o-mini")

MAX_CONCURRENT_SWARMS = int(os.getenv("SWARM_MAX_CONCURRENT", "3"))
MAX_SUBTASKS          = int(os.getenv("SWARM_MAX_SUBTASKS", "8"))
TARGET_SOURCES        = int(os.getenv("SWARM_TARGET_SOURCES", "30"))
SOURCES_PER_SUBTASK   = int(os.getenv("SWARM_SOURCES_PER_SUBTASK", "6"))
FETCH_WORKERS         = int(os.getenv("SWARM_FETCH_WORKERS", "5"))
ENABLE_REFINE         = os.getenv("SWARM_REFINE", "1") != "0"
REFINE_MAX            = int(os.getenv("SWARM_REFINE_MAX", "4"))

# Hard caps that keep context safely under the 128k window.
PAGE_CHAR_CAP       = int(os.getenv("SWARM_PAGE_CHAR_CAP", "6000"))
SUBTASK_CONTEXT_CAP = int(os.getenv("SWARM_SUBTASK_CONTEXT_CAP", "40000"))
FRAGMENT_CAP        = int(os.getenv("SWARM_FRAGMENT_CAP", "8000"))
STITCH_BUNDLE_CAP   = int(os.getenv("SWARM_STITCH_BUNDLE_CAP", "90000"))

TASK_DEADLINE_SECONDS = int(os.getenv("SWARM_DEADLINE_SECONDS", "7200"))
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
# Retrieval - Python, size-capped, tiered search (Tavily -> Serper -> DDG)
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


def _search(query, k=8):
    return _tavily_search(query, k) or _serper_search(query, k) or _ddg_search(query, k)


def fetch_url(url):
    def _do():
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=NET_TIMEOUT) as r:
            ctype = r.headers.get("Content-Type", "")
            if "html" not in ctype and "text" not in ctype:
                return ""
            return r.read(2_000_000).decode("utf-8", errors="ignore")
    try:
        html = _retry(_do, tries=2, label="fetch")
    except Exception as e:  # noqa: BLE001
        return f"(fetch failed: {e})"
    html = re.sub(r"<(script|style|nav|footer|header)[^>]*>.*?</\1>", " ", html, flags=re.S | re.I)
    return re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", html)).strip()[:PAGE_CHAR_CAP]


def _gather(task_id, queries, seen, deadline, max_new):
    hits = []
    for q in queries:
        _ensure_alive(task_id, deadline)
        for h in _search(q, k=8):
            u = h.get("url")
            if not u or u in seen:
                continue
            seen.add(u)
            hits.append(h)
            if len(hits) >= max_new:
                return hits
    return hits


def _materialize(task_id, hits, deadline):
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
    return ready


def _build_context(pages):
    blob, used = [], 0
    for p in pages:
        chunk = f"SOURCE: {p.get('title','')} ({p.get('url','')})\n{p.get('text','')}\n"
        if used + len(chunk) > SUBTASK_CONTEXT_CAP:
            break
        blob.append(chunk)
        used += len(chunk)
    return "\n---\n".join(blob) if blob else "(no readable sources retrieved)"


# ---------------------------------------------------------------------------
# LLM (agno Agent, NO tools attached)
# ---------------------------------------------------------------------------
def _ask(model_id, name, role, instructions, message):
    agent = Agent(name=name, role=role,
                  model=OpenAIChat(id=model_id, api_key=get_openai_api_key()),
                  instructions=instructions, markdown=True)
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
# 1. PLAN
# ===========================================================================
def _plan(task_id, goal, deadline):
    _ensure_alive(task_id, deadline)
    _update(task_id, current_thought="Planning: breaking the goal into subtasks...")
    raw = _ask(
        PLANNER_MODEL, "Planner",
        "Senior planner that breaks any goal into smaller, self-contained subtasks.",
        ["Break the goal into 4-8 concrete, ordered, NON-overlapping subtasks.",
         "Each subtask should be independently executable and produce a useful fragment.",
         "Together they must fully cover the goal (include a verification/cross-check step).",
         "Respond with ONLY a JSON array of strings. No prose, no code fences."],
        f"GOAL:\n{goal}\n\nReturn the JSON array of subtasks.",
    )
    steps = _extract_json(raw, "array")
    if not steps:
        steps = [l.strip("-*0123456789. )").strip()
                 for l in raw.splitlines() if len(l.strip()) > 5]
    steps = [str(s).strip() for s in (steps or [goal]) if str(s).strip()]
    return steps[:MAX_SUBTASKS]


# ===========================================================================
# 2. EXECUTE  (each subtask -> one fragment)
# ===========================================================================
def _queries_for(subtask, goal):
    raw = _ask(
        PLANNER_MODEL, "Query Writer", "You write high-recall web search queries.",
        ["Given a subtask, output 3 diverse, specific web search queries.",
         "Respond with ONLY a JSON array of strings."],
        f"GOAL: {goal}\nSUBTASK: {subtask}\nReturn 3 queries as a JSON array.",
    )
    qs = _extract_json(raw, "array")
    qs = [str(q).strip() for q in qs if str(q).strip()] if isinstance(qs, list) else []
    return qs[:3] or [subtask]


def _execute(task_id, goal, subtasks, deadline, seen, label="Executing"):
    fragments, total = [], len(subtasks)
    per_task = max(SOURCES_PER_SUBTASK, TARGET_SOURCES // max(len(subtasks), 1))
    for i, sub in enumerate(subtasks, 1):
        _ensure_alive(task_id, deadline)
        _update(task_id, current_thought=f"{label} [{i}/{total}] {sub[:80]}")
        queries = _queries_for(sub, goal)
        hits = _gather(task_id, queries, seen, deadline, per_task)
        _update(task_id, current_thought=f"{label} [{i}/{total}] reading {len(hits)} sources...")
        pages = _materialize(task_id, hits, deadline)
        context = _build_context(pages)

        _ensure_alive(task_id, deadline)
        _update(task_id, current_thought=f"{label} [{i}/{total}] producing fragment...")
        fragment = _ask(
            EXEC_MODEL, "Executor",
            "Focused worker that fully completes one subtask using the gathered material.",
            ["Complete THIS subtask and produce a self-contained fragment of the answer.",
             "Use ONLY the provided sources for facts. Be concrete and specific: exact "
             "figures, names, exact URLs, emails, dates, short quotes (<=15 words).",
             "Put the source URL next to each fact. Never invent facts or URLs.",
             "Note anything the subtask asked that the sources did NOT answer.",
             "Drop vague/generic filler - keep only sourced specifics."],
            f"OVERALL GOAL: {goal}\nSUBTASK ({i}/{total}): {sub}\n\nSOURCES:\n{context}\n\n"
            f"Produce the fragment for this subtask.",
        )
        fragments.append({
            "subtask": sub, "fragment": fragment[:FRAGMENT_CAP],
            "sources": [{"title": p.get("title", ""), "url": p.get("url", "")} for p in pages],
        })
        _update(task_id, partial_results=fragments, sources_read=len(seen))
    return fragments


# ===========================================================================
# 2b. REFINE  (optional: find gaps -> more subtasks)
# ===========================================================================
def _refine(task_id, goal, fragments, deadline):
    _ensure_alive(task_id, deadline)
    _update(task_id, current_thought="Reviewing fragments for gaps...")
    condensed = "\n\n".join(f"## {f['subtask']}\n{f['fragment'][:1500]}" for f in fragments)[:40000]
    raw = _ask(
        STITCH_MODEL, "Critic", "Sharp reviewer who finds what's missing.",
        [f"Review the fragments against the goal. Identify the {REFINE_MAX} most important "
         "gaps, unanswered questions, or weakly-supported claims.",
         "Turn each into a concrete follow-up subtask.",
         "Respond with ONLY a JSON array of strings. Return [] if coverage is excellent."],
        f"GOAL: {goal}\n\nFRAGMENTS:\n{condensed}\n\nReturn the JSON array of follow-ups.",
    )
    subs = _extract_json(raw, "array") or []
    return [str(s).strip() for s in subs if str(s).strip()][:REFINE_MAX]


# ===========================================================================
# 3. STITCH  (read all fragments -> connective logic -> merged deliverable)
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


def _stitch(task_id, goal, fragments, deadline):
    _ensure_alive(task_id, deadline)
    _update(task_id, current_thought="Stitching fragments into the final deliverable...")
    bundle = "\n\n".join(f"### FRAGMENT {i+1} — {f['subtask']}\n{f['fragment']}"
                         for i, f in enumerate(fragments))[:STITCH_BUNDLE_CAP]
    all_sources = _dedup_sources(fragments)
    src_list = "\n".join(f"- {s['title']} — {s['url']}" for s in all_sources)[:8000]
    return _ask(
        STITCH_MODEL, "Stitcher",
        "Editor who merges independent fragments into one coherent, gold-first deliverable.",
        ["You are given the FRAGMENTS produced by each subtask.",
         "Work out how they relate, resolve overlaps and conflicts, add the connective "
         "reasoning/logic needed, and MERGE them into ONE coherent deliverable.",
         "Choose the format that best fits the goal (briefing, structured answer, list/table, "
         "plan, document...). Don't just concatenate - integrate.",
         "Be specific; keep every concrete fact and put its source URL alongside it.",
         "REQUIRED SHAPE: first a 2-3 line plain summary, then a line with only '---', then:",
         "  ## Key Takeaways — The Gold  (the most valuable specific findings)",
         "  ## Direct Answer  (deliver EXACTLY what the goal asked; use a table/list if enumerable)",
         "  ## Details  (integrated depth from the fragments, all cited)",
         "  ## Caveats & Gaps",
         "  ## Sources  (deduped URLs actually used)"],
        f"GOAL: {goal}\n\nFRAGMENTS:\n{bundle}\n\nSOURCES AVAILABLE:\n{src_list}\n\n"
        f"Merge everything into the final deliverable.",
    )


def _extract_records(task_id, goal, deliverable, deadline):
    _ensure_alive(task_id, deadline)
    _update(task_id, current_thought="Extracting structured records...")
    raw = _ask(
        EXTRACT_MODEL, "Extractor",
        "Precise data extractor converting a deliverable into structured JSON rows.",
        ["Extract the key items the goal asked for as JSON.",
         "Return ONLY a JSON array of objects. No prose, no code fences.",
         "Use whichever apply: title, name, url, email, organization, location, "
         "description, date, notes. Omit missing fields. Return [] if nothing fits."],
        f"GOAL: {goal}\n\nDELIVERABLE:\n{deliverable[:14000]}\n\nReturn the JSON array.",
    )
    recs = _extract_json(raw, "array")
    return recs if isinstance(recs, list) else []


# ---------------------------------------------------------------------------
# Storage (Notepad .txt only)
# ---------------------------------------------------------------------------
def _store_report(task_id, goal, text, prefix="SwarmReport"):
    os.makedirs(REPORTS_ROOT, exist_ok=True)
    safe = "".join(c if c.isalnum() else "_" for c in goal[:30])
    path = os.path.join(REPORTS_ROOT, f"{prefix}_{safe}_{task_id[:6]}.txt")
    with open(path, "w", encoding="utf-8") as f:
        f.write(text)
    return path


# ---------------------------------------------------------------------------
# Worker loop:  PLAN -> EXECUTE -> (REFINE -> EXECUTE) -> STITCH -> extract
# ---------------------------------------------------------------------------
def worker_loop(task_id, goal):
    deadline = time.time() + TASK_DEADLINE_SECONDS
    try:
        _update(task_id, status="RUNNING", current_thought="Booting orchestrator...")

        subtasks = _plan(task_id, goal, deadline)
        _update(task_id, plan=subtasks, progress={"done": 0, "total": len(subtasks)})

        seen = set()
        fragments = _execute(task_id, goal, subtasks, deadline, seen, label="Executing")

        if ENABLE_REFINE:
            follow = _refine(task_id, goal, fragments, deadline)
            if follow:
                _update(task_id, refine_subtasks=follow)
                fragments += _execute(task_id, goal, follow, deadline, seen, label="Refining")

        deliverable = _stitch(task_id, goal, fragments, deadline)
        records = _extract_records(task_id, goal, deliverable, deadline)
        _ensure_alive(task_id, deadline)

        summary = deliverable.split("---", 1)[0].strip() if "---" in deliverable \
            else "Swarm task completed."
        txt_path = _store_report(task_id, goal, deliverable)

        _update(task_id, status="COMPLETED", result=deliverable, records=records,
                record_count=len(records), sources_read=len(seen),
                report_path=txt_path, current_thought="Finished successfully.")

        try:
            if os.name == "nt":
                subprocess.Popen(["notepad.exe", txt_path])
        except Exception as e:  # noqa: BLE001
            print(f"[Swarm] Failed to open Notepad: {e}")

        extra = f" Read {len(seen)} sources; {len(records)} records in DB." if records \
            else f" Read {len(seen)} sources."
        live_alerts_col.insert_one({
            "message": f"I've finished the deep research report for you! Here's the summary: {summary}\n"
                       f"({extra})\n"
                       f"I just popped the full detailed result open in Notepad for you. Read it when you have a minute.",
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
# Public API (unchanged signatures)
# ---------------------------------------------------------------------------
def launch_swarm_task(goal: str) -> str:
    task_id = str(uuid.uuid4())
    swarm_tasks_col.insert_one({
        "task_id": task_id, "goal": goal, "status": "QUEUED",
        "current_thought": "Waiting for a free worker slot...",
        "result": None, "plan": None, "partial_results": [], "records": [],
        "progress": {"done": 0, "total": 0}, "sources_read": 0,
        "kill_flag": False, "created_at": _now(), "updated_at": _now(),
    })
    fut = _executor.submit(worker_loop, task_id, goal)
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
             f"Subtasks: {p.get('total', 0)} | Sources read: {t.get('sources_read', 0)}\n"
             f"Current Thought: {t.get('current_thought')}")
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
            out += (f"- ID: {t['task_id']} | {t['status']} "
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
        joined = "\n\n".join(f"## {f['subtask']}\n{f['fragment']}" for f in frags)
        return f"Task {task_id} is {t['status']} (fragments so far):\n\n{joined}"
    return f"Task {task_id} is currently {t['status']}. No result yet."