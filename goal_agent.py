"""
Autonomous Research Swarm  (v4 - OpenAI GPT-4o + real agno tools)

Public flow / connectors unchanged (model is OpenAI now):
    launch_swarm_task(goal) -> task_id
    kill_swarm_task(task_id)
    get_swarm_status(task_id=None)
    read_swarm_result(task_id)
Connectors: OpenAI (agno) + MongoDB (swarm_tasks_col, live_alerts_col)
+ Notepad popup + autonomous live alerts.

The WORKER agent now has real agno tools (LLM decides when to use them).
This is safe on GPT-4o: the earlier `tool_use_failed` was Groq/llama emitting
its native <function=...> text instead of JSON tool-calls - an OpenAI model
does native function-calling correctly.

TOOL SYNTAX FIXED (verified against current agno docs):
    from agno.tools.serper import SerperTools          # NOT SerperApiTools
    from agno.tools.googlesearch import GoogleSearchTools
    FileTools(base_dir=Path(...))                       # needs Path, not str
Every toolkit is loaded behind a guard: if its pip package / API key is
missing it is skipped, and the swarm still runs on built-in Python fallbacks
(search_web / fetch_url) that need no dependencies at all.

TO LIGHT UP THE BEST TOOLS (any subset; all optional):
    export SERPER_API_KEY=...        # BEST: Google search + news + scholar + scrape
                                     #       (free tier at serper.dev, no pip needed)
    pip install ddgs                 # DuckDuckGoTools
    pip install googlesearch-python pycountry   # GoogleSearchTools
    pip install crawl4ai && crawl4ai-setup      # Crawl4aiTools (JS pages)
    pip install newspaper4k lxml_html_clean     # Newspaper4kTools

ENV (models):
    OPENAI_API_KEY (required)
    SWARM_WORKER_MODEL  default gpt-4o
    SWARM_SYNTH_MODEL   default gpt-4o
    SWARM_PLANNER_MODEL default gpt-4o-mini
    SWARM_EXTRACT_MODEL default gpt-4o-mini
"""

import os
import re
import csv
import json
import time
import uuid
import subprocess
import urllib.request
import urllib.parse
from pathlib import Path
from datetime import datetime
from concurrent.futures import ThreadPoolExecutor

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
TASK_DEADLINE_SECONDS = int(os.getenv("SWARM_DEADLINE_SECONDS", "5400"))  # 90 min
LLM_RETRIES           = int(os.getenv("SWARM_LLM_RETRIES", "5"))
ENABLE_REASONING      = os.getenv("SWARM_REASONING", "1") != "0"
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
            last = e
            wait = base ** attempt
            m = re.search(r"try again in ([\d.]+)s", str(e))
            if m:
                wait = max(wait, float(m.group(1)) + 0.5)
            if attempt < tries:
                time.sleep(wait)
    raise last if last else RuntimeError(f"{label} failed")


# ---------------------------------------------------------------------------
# Built-in fallback tools (plain functions, zero dependencies, always work)
# ---------------------------------------------------------------------------
def search_web(query: str) -> str:
    """Search the web (DuckDuckGo). Use this to find pages when other search tools fail."""
    def _do():
        url = f"https://html.duckduckgo.com/html/?q={urllib.parse.quote(query)}"
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=NET_TIMEOUT) as r:
            return r.read().decode("utf-8", errors="ignore")
    try:
        html = _retry(_do, tries=3, label="search")
    except Exception as e:  # noqa: BLE001
        return f"Search failed for '{query}': {e}"
    clean = lambda x: re.sub(r"\s+", " ", re.sub(r"<[^>]+>", "", x)).strip()
    anchors = re.findall(r'<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>(.*?)</a>', html, re.S)
    snips = re.findall(r'class="result__snippet"[^>]*>(.*?)</a>', html, re.S)
    if not anchors:
        return f"No results for '{query}'."
    out = [f"Search results for: {query}"]
    for i, (href, title) in enumerate(anchors[:8]):
        href = href.replace("&amp;", "&")
        real = urllib.parse.parse_qs(urllib.parse.urlparse(href).query).get("uddg", [href])[0] \
            if "uddg=" in href else href
        if real.startswith("//"):
            real = "https:" + real
        out.append(f"{i+1}. {clean(title)}\n   {real}\n   {clean(snips[i]) if i < len(snips) else ''}")
    return "\n".join(out)


def fetch_url(url: str) -> str:
    """Open a URL and return its readable text content (HTML tags stripped)."""
    def _do():
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=NET_TIMEOUT) as r:
            ctype = r.headers.get("Content-Type", "")
            if "html" not in ctype and "text" not in ctype:
                return f"(skipped non-text content: {ctype})"
            return r.read().decode("utf-8", errors="ignore")
    try:
        html = _retry(_do, tries=2, label="fetch")
    except Exception as e:  # noqa: BLE001
        return f"(fetch failed: {e})"
    html = re.sub(r"<(script|style|nav|footer|header)[^>]*>.*?</\1>", " ", html, flags=re.S | re.I)
    return re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", html)).strip()[:8000]


# ---------------------------------------------------------------------------
# agno toolkit loader (guarded) + curated worker toolset
# ---------------------------------------------------------------------------
def _load(modpath, clsname, **kwargs):
    """Import agno.tools.<modpath>.<clsname>(**kwargs); return instance or None."""
    try:
        mod = __import__(f"agno.tools.{modpath}", fromlist=[clsname])
        return getattr(mod, clsname)(**kwargs)
    except Exception as e:  # noqa: BLE001
        print(f"[Swarm] toolkit {clsname} unavailable: {e}")
        return None


def _first(*candidates):
    """Return the first toolkit that loads, or None."""
    for modpath, clsname, kwargs in candidates:
        tk = _load(modpath, clsname, **kwargs)
        if tk:
            return tk
    return None


def _build_worker_tools(task_dir):
    """Curated, deduped toolset for the worker. Everything degrades gracefully."""
    tools = []

    # --- SEARCH: prefer Serper (Google + news + scholar + scrape), else free ---
    search = None
    if os.getenv("SERPER_API_KEY"):
        search = _load("serper", "SerperTools", num_results=10)
    if search is None:
        search = _first(("duckduckgo", "DuckDuckGoTools", {}),
                        ("googlesearch", "GoogleSearchTools", {}))
    if search:
        tools.append(search)

    # --- READ / CRAWL a page ---
    reader = _first(("crawl4ai", "Crawl4aiTools", {"max_length": None}),
                    ("newspaper4k", "Newspaper4kTools", {}),
                    ("website", "WebsiteTools", {}))
    if reader:
        tools.append(reader)

    # --- THINK (scratchpad) ---
    if ENABLE_REASONING:
        rt = _load("reasoning", "ReasoningTools", add_instructions=True)
        if rt:
            tools.append(rt)

    # --- SAVE scraped material to disk (FileTools needs a Path, not a str) ---
    ft = _load("file", "FileTools", base_dir=Path(task_dir), save_files=True, read_files=True)
    if ft:
        tools.append(ft)

    # --- Always-on Python fallbacks so search+read work with zero installs ---
    tools.extend([search_web, fetch_url])
    return tools


# ---------------------------------------------------------------------------
# Agents
# ---------------------------------------------------------------------------
def _agent(name, role, model_id, instructions, tools=None):
    return Agent(
        name=name, role=role,
        model=OpenAIChat(id=model_id, api_key=get_openai_api_key()),
        instructions=instructions, tools=tools or [], markdown=True,
    )


def _run(agent, message):
    resp = _retry(lambda: agent.run(message), label=f"{agent.name}.run")
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
    planner = _agent(
        "Swarm Planner",
        "Senior research planner that decomposes a goal into concrete search steps.",
        PLANNER_MODEL,
        ["Break the goal into 3-10 concrete, ordered research subtasks.",
         "Cover different angles, source types, and a verification step.",
         "Respond with ONLY a JSON array of strings. No prose, no code fences."],
    )
    raw = _run(planner, f"GOAL:\n{goal}\n\nReturn the JSON array of subtasks.")
    steps = _extract_json(raw, "array")
    if not steps:
        steps = [l.strip("-*0123456789. )").strip()
                 for l in raw.splitlines() if len(l.strip()) > 5]
    steps = [str(s).strip() for s in (steps or [goal]) if str(s).strip()]
    return steps[:MAX_SUBTASKS]


def _research(task_id, goal, subtasks, task_dir, deadline):
    tools = _build_worker_tools(task_dir)
    per_task = max(3, TARGET_SOURCES // max(len(subtasks), 1))
    worker = _agent(
        "Research Worker",
        "Relentless background researcher and data grinder. You work for Karen.",
        WORKER_MODEL,
        [f"You execute ONE subtask of a larger research goal. Be exhaustive and factual.",
         f"Use your search tool(s), then open promising results with the read/scrape tools.",
         f"Consult at least {per_task} distinct sources for this subtask.",
         "Extract concrete facts: names, exact URLs, emails, dates, numbers, job descriptions.",
         "Put the source URL next to every fact. Prefer primary sources.",
         "Use think()/analyze() to plan and self-check when the answer is non-obvious.",
         "Never invent facts, emails, or URLs. If sources are thin, say so plainly.",
         "Return a focused, source-cited result for THIS subtask only."],
        tools=tools,
    )
    results, total = [], len(subtasks)
    for i, sub in enumerate(subtasks, 1):
        _ensure_alive(task_id, deadline)   # hard kill / deadline boundary
        _update(task_id, current_thought=f"[{i}/{total}] {sub[:90]}",
                progress={"done": i - 1, "total": total})
        ctx = ""
        if results:
            prev = "\n\n".join(f"### {r['subtask']}\n{r['output'][:700]}" for r in results[-2:])
            ctx = f"\nEarlier findings to build on (don't refetch the same sources):\n{prev}\n"
        prompt = (f"OVERALL GOAL: {goal}\nYOUR SUBTASK ({i}/{total}): {sub}{ctx}\n"
                  f"Research this thoroughly and return your cited findings.")
        try:
            out = _run(worker, prompt)
        except SwarmKilled:
            raise
        except Exception as e:  # noqa: BLE001
            out = f"(subtask failed after retries: {e})"
        results.append({"subtask": sub, "output": out})
        _update(task_id, partial_results=results, progress={"done": i, "total": total})
    return results


def _synthesize(task_id, goal, results, deadline):
    _ensure_alive(task_id, deadline)
    _update(task_id, current_thought="Synthesizing the final report...")
    synth = _agent(
        "Synthesizer",
        "Editor that fuses subtask findings into one detailed, cited report.",
        SYNTH_MODEL,
        ["Fuse the findings into ONE cohesive report. Deduplicate and resolve conflicts.",
         "Keep concrete facts, URLs and sources.",
         "CRITICAL FORMAT: 2-3 line summary, then a line '---', then the full report."],
    )
    bundle = "\n\n".join(f"## {r['subtask']}\n{r['output']}" for r in results)
    if len(bundle) > 24000:
        bundle = bundle[:24000]
    return _run(synth, f"GOAL: {goal}\n\nSUBTASK FINDINGS:\n{bundle}\n\nWrite the final report.")


def _extract_records(task_id, goal, report, deadline):
    _ensure_alive(task_id, deadline)
    _update(task_id, current_thought="Extracting structured records...")
    extractor = _agent(
        "Extractor",
        "Precise data extractor converting a report into structured JSON rows.",
        EXTRACT_MODEL,
        ["Extract the key items the goal asked for as JSON.",
         "Return ONLY a JSON array of objects. No prose, no code fences.",
         "Use whichever apply: title, name, url, email, organization, location, "
         "description, date, notes. Omit missing fields. Return [] if nothing fits."],
    )
    raw = _run(extractor, f"GOAL: {goal}\n\nREPORT:\n{report[:12000]}\n\nReturn the JSON array.")
    recs = _extract_json(raw, "array")
    return recs if isinstance(recs, list) else []


# ---------------------------------------------------------------------------
# Storage
# ---------------------------------------------------------------------------
def _store(task_id, goal, report, records):
    os.makedirs(REPORTS_ROOT, exist_ok=True)
    task_dir = os.path.join(REPORTS_ROOT, task_id[:8])
    os.makedirs(task_dir, exist_ok=True)
    safe = "".join(c if c.isalnum() else "_" for c in goal[:30])

    txt_path = os.path.join(task_dir, f"SwarmReport_{safe}.txt")
    with open(txt_path, "w", encoding="utf-8") as f:
        f.write(report)
    with open(os.path.join(task_dir, "report.md"), "w", encoding="utf-8") as f:
        f.write(report)

    if records:
        with open(os.path.join(task_dir, "records.json"), "w", encoding="utf-8") as f:
            json.dump(records, f, ensure_ascii=False, indent=2)
        cols = []
        for r in records:
            for k in r:
                if k not in cols:
                    cols.append(k)
        with open(os.path.join(task_dir, "records.csv"), "w", newline="", encoding="utf-8") as f:
            w = csv.DictWriter(f, fieldnames=cols)
            w.writeheader()
            for r in records:
                w.writerow({k: r.get(k, "") for k in cols})
    return txt_path


# ---------------------------------------------------------------------------
# Worker loop
# ---------------------------------------------------------------------------
def worker_loop(task_id, goal):
    deadline = time.time() + TASK_DEADLINE_SECONDS
    task_dir = os.path.join(REPORTS_ROOT, task_id[:8])
    os.makedirs(task_dir, exist_ok=True)
    try:
        _update(task_id, status="RUNNING", current_thought="Booting OpenAI research orchestrator...")

        subtasks = _plan(task_id, goal, deadline)
        _update(task_id, plan=subtasks)

        results = _research(task_id, goal, subtasks, task_dir, deadline)
        report  = _synthesize(task_id, goal, results, deadline)
        records = _extract_records(task_id, goal, report, deadline)
        _ensure_alive(task_id, deadline)

        summary = report.split("---", 1)[0].strip() if "---" in report else "Swarm research completed."
        txt_path = _store(task_id, goal, report, records)

        _update(task_id, status="COMPLETED", result=report, records=records,
                record_count=len(records), report_path=txt_path,
                current_thought="Finished successfully.")

        try:
            if os.name == "nt":
                subprocess.Popen(["notepad.exe", txt_path])
        except Exception as e:  # noqa: BLE001
            print(f"[Swarm] Failed to open Notepad: {e}")

        extra = f" Extracted {len(records)} structured records." if records else ""
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
        "progress": {"done": 0, "total": 0}, "kill_flag": False,
        "created_at": _now(), "updated_at": _now(),
    })
    fut = _executor.submit(worker_loop, task_id, goal)
    _active_swarms[task_id] = fut
    return task_id


def kill_swarm_task(task_id: str) -> str:
    res = swarm_tasks_col.update_one({"task_id": task_id}, {"$set": {"kill_flag": True}})
    if res.matched_count == 0:
        return f"Task {task_id} not found."
    return f"Task {task_id} marked for termination. It stops at the next subtask boundary."


def get_swarm_status(task_id: str = None) -> str:
    if task_id:
        t = swarm_tasks_col.find_one({"task_id": task_id})
        if not t:
            return "Not found."
        p = t.get("progress") or {}
        s = (f"Task: {t['goal'][:50]}...\nStatus: {t['status']}\n"
             f"Progress: {p.get('done', 0)}/{p.get('total', 0)} subtasks\n"
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