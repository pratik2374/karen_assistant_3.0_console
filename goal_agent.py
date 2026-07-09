"""
Autonomous Research Swarm  (v6 - bounded-context, OpenAI GPT-4o)

Public flow / connectors unchanged (model is OpenAI):
    launch_swarm_task(goal) -> task_id
    kill_swarm_task(task_id)
    get_swarm_status(task_id=None)
    read_swarm_result(task_id)
Connectors: OpenAI (agno) + MongoDB (swarm_tasks_col, live_alerts_col)
+ Notepad popup + autonomous live alerts.

WHY THIS VERSION (the context_length_exceeded fix)
--------------------------------------------------
When the LLM held the tools, every fetched web page was appended to the
conversation and re-sent each turn. Big pages (e.g. a ScienceDirect article,
or Serper's uncapped scrape.serper.dev output) pushed the request past GPT-4o's
128k limit -> HTTP 400 context_length_exceeded, which is NON-retryable and
kills the subtask. Prompting can't fix that; it's structural.

FIX: retrieval happens in PYTHON with hard size caps; the LLM is called with
NO tools and only receives trimmed text. Context is therefore bounded and can
never overflow. Serper (if you set the key) is used for SEARCH ONLY (small
structured snippets) - never its scrape endpoint - so the 500s are gone too.

Every page is capped to PAGE_CHAR_CAP and the whole per-subtask context to
SUBTASK_CONTEXT_CAP, so a single request stays comfortably under the limit.

ENV:
    OPENAI_API_KEY (required)
    SERPER_API_KEY (optional; free at serper.dev -> better search, snippets only)
    SWARM_WORKER_MODEL  default gpt-4o
    SWARM_SYNTH_MODEL   default gpt-4o
    SWARM_PLANNER_MODEL default gpt-4o-mini
    SWARM_EXTRACT_MODEL default gpt-4o-mini
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
WORKER_MODEL  = os.getenv("SWARM_WORKER_MODEL",  "gpt-4o")
SYNTH_MODEL   = os.getenv("SWARM_SYNTH_MODEL",   "gpt-4o")
PLANNER_MODEL = os.getenv("SWARM_PLANNER_MODEL", "gpt-4o-mini")
EXTRACT_MODEL = os.getenv("SWARM_EXTRACT_MODEL", "gpt-4o-mini")

MAX_CONCURRENT_SWARMS = int(os.getenv("SWARM_MAX_CONCURRENT", "3"))
MAX_SUBTASKS          = int(os.getenv("SWARM_MAX_SUBTASKS", "10"))
TARGET_SOURCES        = int(os.getenv("SWARM_TARGET_SOURCES", "20"))
SOURCES_PER_SUBTASK   = int(os.getenv("SWARM_SOURCES_PER_SUBTASK", "5"))
FETCH_WORKERS         = int(os.getenv("SWARM_FETCH_WORKERS", "4"))

# --- Hard caps that make context overflow impossible ---
PAGE_CHAR_CAP         = int(os.getenv("SWARM_PAGE_CHAR_CAP", "3000"))     # per page
SUBTASK_CONTEXT_CAP   = int(os.getenv("SWARM_SUBTASK_CONTEXT_CAP", "12000"))  # per worker call
SYNTH_BUNDLE_CAP      = int(os.getenv("SWARM_SYNTH_BUNDLE_CAP", "24000"))
SUBTASK_OUTPUT_CAP    = int(os.getenv("SWARM_SUBTASK_OUTPUT_CAP", "4000"))

TASK_DEADLINE_SECONDS = int(os.getenv("SWARM_DEADLINE_SECONDS", "5400"))  # 90 min
LLM_RETRIES           = int(os.getenv("SWARM_LLM_RETRIES", "5"))
NET_TIMEOUT           = int(os.getenv("SWARM_NET_TIMEOUT", "15"))

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
            # context_length_exceeded is not fixable by retrying -> stop now.
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
# Retrieval - pure Python, size-capped (no LLM tool-calling anywhere)
# ---------------------------------------------------------------------------
def _serper_search(query, k=8):
    """High-quality search via Serper /search (snippets only, no scraping)."""
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
    hits = []
    for o in (data.get("organic") or [])[:k]:
        hits.append({"title": o.get("title", ""), "url": o.get("link", ""),
                     "snippet": o.get("snippet", "")})
    return hits


def _ddg_search(query, k=8):
    """Fallback search via DuckDuckGo HTML (no dependency)."""
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
    return _serper_search(query, k) or _ddg_search(query, k)


def fetch_url(url):
    """Fetch a page and return readable text, hard-capped to PAGE_CHAR_CAP."""
    def _do():
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=NET_TIMEOUT) as r:
            ctype = r.headers.get("Content-Type", "")
            if "html" not in ctype and "text" not in ctype:
                return ""
            return r.read(1_500_000).decode("utf-8", errors="ignore")  # cap raw bytes too
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


def _fetch_many(task_id, hits, deadline):
    _ensure_alive(task_id, deadline)
    out = []
    with ThreadPoolExecutor(max_workers=FETCH_WORKERS) as ex:
        futs = {ex.submit(fetch_url, h["url"]): h for h in hits}
        for fut in as_completed(futs):
            h = futs[fut]
            try:
                text = fut.result()
            except Exception as e:  # noqa: BLE001
                text = f"(fetch failed: {e})"
            out.append({**h, "text": text})
    return out


def _build_context(pages):
    """Assemble a size-capped context blob from fetched pages."""
    blob, used = [], 0
    for p in pages:
        chunk = f"SOURCE: {p.get('title','')} ({p.get('url','')})\n{p.get('text','')}\n"
        if used + len(chunk) > SUBTASK_CONTEXT_CAP:
            break
        blob.append(chunk)
        used += len(chunk)
    return "\n---\n".join(blob) if blob else "(no readable sources retrieved)"


# ---------------------------------------------------------------------------
# LLM (agno Agent, NO tools attached anywhere)
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


# ---------------------------------------------------------------------------
# Orchestration stages
# ---------------------------------------------------------------------------
def _plan(task_id, goal, deadline):
    _ensure_alive(task_id, deadline)
    _update(task_id, current_thought="Planning: decomposing the goal into subtasks...")
    raw = _ask(
        PLANNER_MODEL, "Swarm Planner",
        "Senior research planner that decomposes a goal into concrete search steps.",
        ["Break the goal into 3-10 concrete, ordered research subtasks.",
         "Cover different angles, source types, and a verification step.",
         "Respond with ONLY a JSON array of strings. No prose, no code fences."],
        f"GOAL:\n{goal}\n\nReturn the JSON array of subtasks.",
    )
    steps = _extract_json(raw, "array")
    if not steps:
        steps = [l.strip("-*0123456789. )").strip()
                 for l in raw.splitlines() if len(l.strip()) > 5]
    steps = [str(s).strip() for s in (steps or [goal]) if str(s).strip()]
    return steps[:MAX_SUBTASKS]


def _queries_for(subtask, goal):
    raw = _ask(
        PLANNER_MODEL, "Query Writer", "You write effective web search queries.",
        ["Given a research subtask, output 3 diverse web search queries.",
         "Respond with ONLY a JSON array of strings."],
        f"GOAL: {goal}\nSUBTASK: {subtask}\nReturn 3 queries as a JSON array.",
    )
    qs = _extract_json(raw, "array")
    qs = [str(q).strip() for q in qs if str(q).strip()] if isinstance(qs, list) else []
    return qs[:3] or [subtask]


def _research(task_id, goal, subtasks, deadline):
    seen, results, total = set(), [], len(subtasks)
    per_task = max(SOURCES_PER_SUBTASK, TARGET_SOURCES // max(total, 1))

    for i, sub in enumerate(subtasks, 1):
        _ensure_alive(task_id, deadline)
        _update(task_id, current_thought=f"[{i}/{total}] Searching: {sub[:80]}",
                progress={"done": i - 1, "total": total})

        queries = _queries_for(sub, goal)
        hits = _gather(task_id, queries, seen, deadline, per_task)
        _update(task_id, current_thought=f"[{i}/{total}] Reading {len(hits)} sources...")
        pages = _fetch_many(task_id, hits, deadline)
        context = _build_context(pages)

        _ensure_alive(task_id, deadline)
        _update(task_id, current_thought=f"[{i}/{total}] Analyzing findings...")
        out = _ask(
            WORKER_MODEL, "Research Worker",
            "Relentless researcher and data grinder. You work for Karen.",
            ["Using ONLY the provided sources, extract concrete findings for the subtask.",
             "Pull names, exact URLs, emails, dates, numbers, job descriptions.",
             "Put the source URL next to each fact. Do not invent facts or URLs.",
             "If the sources are thin, say so plainly."],
            f"OVERALL GOAL: {goal}\nSUBTASK ({i}/{total}): {sub}\n\nSOURCES:\n{context}\n\n"
            f"Write cited findings for this subtask.",
        )
        results.append({"subtask": sub, "output": out[:SUBTASK_OUTPUT_CAP],
                        "source_count": len(pages)})
        _update(task_id, partial_results=results, progress={"done": i, "total": total},
                sources_read=len(seen))
    return results


def _synthesize(task_id, goal, results, deadline):
    _ensure_alive(task_id, deadline)
    _update(task_id, current_thought="Synthesizing the final report...")
    bundle = "\n\n".join(f"## {r['subtask']}\n{r['output']}" for r in results)[:SYNTH_BUNDLE_CAP]
    return _ask(
        SYNTH_MODEL, "Synthesizer",
        "Editor that fuses subtask findings into one detailed, cited report.",
        ["Fuse the findings into ONE cohesive report. Deduplicate and resolve conflicts.",
         "Keep concrete facts, URLs and sources.",
         "CRITICAL FORMAT: 2-3 line summary, then a line '---', then the full report."],
        f"GOAL: {goal}\n\nSUBTASK FINDINGS:\n{bundle}\n\nWrite the final report.",
    )


def _extract_records(task_id, goal, report, deadline):
    _ensure_alive(task_id, deadline)
    _update(task_id, current_thought="Extracting structured records...")
    raw = _ask(
        EXTRACT_MODEL, "Extractor",
        "Precise data extractor converting a report into structured JSON rows.",
        ["Extract the key items the goal asked for as JSON.",
         "Return ONLY a JSON array of objects. No prose, no code fences.",
         "Use whichever apply: title, name, url, email, organization, location, "
         "description, date, notes. Omit missing fields. Return [] if nothing fits."],
        f"GOAL: {goal}\n\nREPORT:\n{report[:12000]}\n\nReturn the JSON array.",
    )
    recs = _extract_json(raw, "array")
    return recs if isinstance(recs, list) else []


# ---------------------------------------------------------------------------
# Storage (Notepad .txt only)
# ---------------------------------------------------------------------------
def _store_report(task_id, goal, report):
    os.makedirs(REPORTS_ROOT, exist_ok=True)
    safe = "".join(c if c.isalnum() else "_" for c in goal[:30])
    path = os.path.join(REPORTS_ROOT, f"SwarmReport_{safe}_{task_id[:6]}.txt")
    with open(path, "w", encoding="utf-8") as f:
        f.write(report)
    return path


# ---------------------------------------------------------------------------
# Worker loop
# ---------------------------------------------------------------------------
def worker_loop(task_id, goal):
    deadline = time.time() + TASK_DEADLINE_SECONDS
    try:
        _update(task_id, status="RUNNING", current_thought="Booting OpenAI research orchestrator...")

        subtasks = _plan(task_id, goal, deadline)
        _update(task_id, plan=subtasks)

        results = _research(task_id, goal, subtasks, deadline)
        report  = _synthesize(task_id, goal, results, deadline)
        records = _extract_records(task_id, goal, report, deadline)
        _ensure_alive(task_id, deadline)

        summary = report.split("---", 1)[0].strip() if "---" in report else "Swarm research completed."
        txt_path = _store_report(task_id, goal, report)

        _update(task_id, status="COMPLETED", result=report, records=records,
                record_count=len(records), report_path=txt_path,
                current_thought="Finished successfully.")

        try:
            if os.name == "nt":
                subprocess.Popen(["notepad.exe", txt_path])
        except Exception as e:  # noqa: BLE001
            print(f"[Swarm] Failed to open Notepad: {e}")

        extra = f" Extracted {len(records)} structured records (kept in DB)." if records else ""
        live_alerts_col.insert_one({
            "message": f"Swarm Task Completed! {summary}{extra}\n"
                       f"I've popped the full report open in Notepad for you.",
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
             f"Progress: {p.get('done', 0)}/{p.get('total', 0)} subtasks | "
             f"{t.get('sources_read', 0)} sources read\n"
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
            p = t.get("progress") or {}
            out += (f"- ID: {t['task_id']} | {t['status']} "
                    f"| {p.get('done', 0)}/{p.get('total', 0)} "
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
    partial = t.get("partial_results") or []
    if partial:
        joined = "\n\n".join(f"## {p['subtask']}\n{p['output']}" for p in partial)
        return f"Task {task_id} is {t['status']} (partial so far):\n\n{joined}"
    return f"Task {task_id} is currently {t['status']}. No result yet."