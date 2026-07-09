"""
Autonomous Research Swarm  (v2 - heavy lifting edition)

Same public flow / connectors as before:
    launch_swarm_task(goal, ...) -> task_id
    kill_swarm_task(task_id)
    get_swarm_status(task_id=None)
    read_swarm_result(task_id)
Connectors unchanged: Groq (agno) + MongoDB (swarm_tasks_col, live_alerts_col)
+ Notepad popup + autonomous live alerts.

What v2 adds so it can REALLY grind:
  * Uses agno's real toolkits instead of a hand-rolled search:
      - search:   DuckDuckGo, GoogleSearch, Wikipedia, Arxiv, HackerNews
                  (+ Exa / Tavily / Serper if their API keys are in env)
      - read:     Crawl4ai, Newspaper4k, Website (+ Firecrawl if key present)
      - think:    ReasoningTools -> think()/analyze() scratchpad ("thinks a lot")
      - pace:     SleepTools -> it can slow down / respect rate limits
      - files:    FileTools -> save scraped material to disk
    Every toolkit is loaded behind a guard: if its pip package or API key is
    missing, it is silently skipped and the swarm still runs.
  * Deep loop: PLAN -> RESEARCH each subtask across many sources -> SYNTHESIZE
    -> STRUCTURED EXTRACT. Worker is told to consult 15-30 distinct sources.
  * Structured output: results are also parsed into clean JSON records
    (title/url/email/detail...) and stored to Mongo + .json + .csv, so tasks
    like "20 job links + JD" or "professor email + best works" come out tidy.
  * Hard kill + deadline enforced in Python between every subtask (not reliant
    on the LLM), per-subtask checkpointing, retries w/ backoff, bounded pool.

Optional installs to unlock more (swarm works without them):
    pip install duckduckgo-search googlesearch-python wikipedia arxiv \
                crawl4ai newspaper4k lxml_html_clean
Optional premium keys (auto-detected from env):
    EXA_API_KEY, TAVILY_API_KEY, FIRECRAWL_API_KEY, SERPER_API_KEY
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
from datetime import datetime
from concurrent.futures import ThreadPoolExecutor

from agno.agent import Agent
from agno.models.groq import Groq

from db import swarm_tasks_col, live_alerts_col


# ---------------------------------------------------------------------------
# Config (env-overridable; tuned for slow background heavy lifting)
# ---------------------------------------------------------------------------
PLANNER_MODEL = os.getenv("SWARM_PLANNER_MODEL", "llama-3.3-70b-versatile")
WORKER_MODEL  = os.getenv("SWARM_WORKER_MODEL",  "llama-3.3-70b-versatile")
SYNTH_MODEL   = os.getenv("SWARM_SYNTH_MODEL",   "llama-3.3-70b-versatile")

MAX_CONCURRENT_SWARMS = int(os.getenv("SWARM_MAX_CONCURRENT", "3"))
MAX_SUBTASKS          = int(os.getenv("SWARM_MAX_SUBTASKS", "10"))
TARGET_SOURCES        = int(os.getenv("SWARM_TARGET_SOURCES", "20"))   # 15-30 sites
TASK_DEADLINE_SECONDS = int(os.getenv("SWARM_DEADLINE_SECONDS", "5400"))  # 90 min
LLM_RETRIES           = int(os.getenv("SWARM_LLM_RETRIES", "3"))
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
def get_groq_api_key():
    key = os.getenv("GROQ_API_KEY")
    if not key:
        raise ValueError("GROQ_API_KEY environment variable is not set. The Swarm requires Groq.")
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


def _retry(fn, tries=LLM_RETRIES, base=1.6, label="op"):
    last = None
    for attempt in range(1, tries + 1):
        try:
            return fn()
        except Exception as e:  # noqa: BLE001
            last = e
            if attempt < tries:
                time.sleep(base ** attempt)
    raise last if last else RuntimeError(f"{label} failed")


# ---------------------------------------------------------------------------
# Built-in fallback tools (always available, need no extra pip packages)
# ---------------------------------------------------------------------------
def search_web(query: str) -> str:
    """Fallback web search via DuckDuckGo HTML. Returns parsed title/url/snippet."""
    def _do():
        url = f"https://html.duckduckgo.com/html/?q={urllib.parse.quote(query)}"
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=NET_TIMEOUT) as r:
            return r.read().decode("utf-8", errors="ignore")
    try:
        html = _retry(_do, label="search")
    except Exception as e:  # noqa: BLE001
        return f"Search failed for '{query}': {e}"
    titles = re.findall(r'result__a[^>]*>(.*?)</a>', html, re.S)
    snips  = re.findall(r'result__snippet[^>]*>(.*?)</a>', html, re.S)
    links  = re.findall(r'result__url"[^>]*>(.*?)</a>', html, re.S)
    clean = lambda x: re.sub(r"<[^>]+>", "", x).strip()
    if not titles:
        return f"No results for '{query}'."
    out = [f"Search results for: {query}"]
    for i in range(min(8, len(titles))):
        out.append(f"{i+1}. {clean(titles[i])}\n   {clean(links[i]) if i < len(links) else ''}"
                   f"\n   {clean(snips[i]) if i < len(snips) else ''}")
    return "\n".join(out)


def fetch_url(url: str) -> str:
    """Fallback page reader. Returns readable text (tags stripped)."""
    def _do():
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=NET_TIMEOUT) as r:
            return r.read().decode("utf-8", errors="ignore")
    try:
        html = _retry(_do, label="fetch")
    except Exception as e:  # noqa: BLE001
        return f"Fetch failed for '{url}': {e}"
    html = re.sub(r"<(script|style)[^>]*>.*?</\1>", " ", html, flags=re.S | re.I)
    text = re.sub(r"<[^>]+>", " ", html)
    return re.sub(r"\s+", " ", text).strip()[:8000]


# ---------------------------------------------------------------------------
# agno toolkit assembly (guarded: skip anything not installed / no key)
# ---------------------------------------------------------------------------
def _load(modpath, clsname, **kwargs):
    """Import agno.tools.<modpath>.<clsname>(**kwargs); return instance or None."""
    try:
        mod = __import__(f"agno.tools.{modpath}", fromlist=[clsname])
        return getattr(mod, clsname)(**kwargs)
    except Exception as e:  # noqa: BLE001  (missing pip pkg / bad key / api change)
        print(f"[Swarm] toolkit {clsname} unavailable: {e}")
        return None


def _build_research_tools(task_id, task_dir):
    """Curated toolset for the worker. Everything optional degrades gracefully."""
    tools = []

    # --- search (free, no key) ---
    for mod, cls in [("duckduckgo", "DuckDuckGoTools"),
                     ("googlesearch", "GoogleSearchTools"),
                     ("wikipedia", "WikipediaTools"),
                     ("arxiv", "ArxivTools"),
                     ("hackernews", "HackerNewsTools")]:
        tk = _load(mod, cls)
        if tk:
            tools.append(tk)

    # --- search (premium, only if API key present) ---
    if os.getenv("EXA_API_KEY"):
        tools.append(_load("exa", "ExaTools", text_length_limit=1500))
    if os.getenv("TAVILY_API_KEY"):
        tools.append(_load("tavily", "TavilyTools"))
    if os.getenv("SERPER_API_KEY"):
        tools.append(_load("serper", "SerperApiTools"))

    # --- read / crawl pages ---
    for mod, cls, kw in [("crawl4ai", "Crawl4aiTools", {"max_length": None}),
                         ("newspaper4k", "Newspaper4kTools", {}),
                         ("website", "WebsiteTools", {})]:
        tk = _load(mod, cls, **kw)
        if tk:
            tools.append(tk)
    if os.getenv("FIRECRAWL_API_KEY"):
        tools.append(_load("firecrawl", "FirecrawlTools", scrape=True, formats=["markdown"]))

    # --- think / pace / store ---
    if ENABLE_REASONING:
        tools.append(_load("reasoning", "ReasoningTools", add_instructions=True))
    tools.append(_load("sleep", "SleepTools"))
    tools.append(_load("calculator", "CalculatorTools"))
    tools.append(_load("file", "FileTools", base_dir=task_dir, save_files=True, read_files=True))

    tools = [t for t in tools if t is not None]

    # Always include our own hardened fallbacks + live status logger.
    def bound_log(thought: str):
        """Report live status to the DB so the user can watch progress."""
        return log_swarm_thought(task_id, thought)

    tools.extend([bound_log, search_web, fetch_url])
    return tools


# ---------------------------------------------------------------------------
# Agents
# ---------------------------------------------------------------------------
def _agent(name, role, model_id, instructions, tools=None):
    return Agent(
        name=name, role=role,
        model=Groq(id=model_id, api_key=get_groq_api_key()),
        instructions=instructions, tools=tools or [], markdown=True,
    )


def _run(agent, message):
    resp = _retry(lambda: agent.run(message), label="agent.run")
    return (resp.content or "").strip()


def _extract_json(raw, want="array"):
    """Pull a JSON array/object out of a possibly-chatty model reply."""
    if not raw:
        return None
    fence = re.search(r"```(?:json)?\s*(.*?)```", raw, re.S)
    if fence:
        raw = fence.group(1)
    pat = r"\[.*\]" if want == "array" else r"\{.*\}"
    m = re.search(pat, raw, re.S)
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
        "Senior research planner that decomposes a big goal into concrete search steps.",
        PLANNER_MODEL,
        instructions=[
            "Break the user's goal into 3-10 concrete, ordered research subtasks.",
            "Think about coverage: different angles, sources, and verification steps.",
            "Each subtask must be independently executable and specific.",
            "Respond with ONLY a JSON array of strings. No prose, no code fences.",
        ],
    )
    raw = _run(planner, f"GOAL:\n{goal}\n\nReturn the JSON array of subtasks.")
    steps = _extract_json(raw, "array")
    if not steps:
        steps = [l.strip("-*0123456789. )").strip()
                 for l in raw.splitlines() if len(l.strip()) > 5]
    steps = [str(s).strip() for s in (steps or [goal]) if str(s).strip()]
    return steps[:MAX_SUBTASKS]


def _research(task_id, goal, subtasks, task_dir, deadline):
    tools = _build_research_tools(task_id, task_dir)
    worker = _agent(
        "Groq Research Worker",
        "Relentless background researcher and data grinder. You work for Karen.",
        WORKER_MODEL,
        instructions=[
            "You execute ONE subtask of a larger research goal. Be exhaustive and factual.",
            "Use think() to plan and analyze() to check your findings when unsure.",
            f"Consult MANY distinct sources - aim for {TARGET_SOURCES} across the whole task.",
            "Workflow: search (try several engines/queries) -> open promising results with "
            "the crawl/read tools -> extract concrete facts, names, URLs, emails, dates.",
            "Prefer primary sources. Record the exact URL next to every fact.",
            "Call bound_log before each major step so the user can watch progress.",
            "If you hit rate limits, use sleep() briefly and continue - latency is fine.",
            "Output a focused, source-cited result for THIS subtask only.",
        ],
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
            ctx = f"\nEarlier findings to build on (don't repeat sources blindly):\n{prev}\n"
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
        "Swarm Synthesizer",
        "Editor that fuses many subtask findings into one detailed, cited report.",
        SYNTH_MODEL,
        instructions=[
            "Fuse the subtask findings into ONE cohesive report.",
            "Deduplicate, resolve conflicts, keep concrete facts, URLs and sources.",
            "CRITICAL FORMAT: start with a 2-3 line summary, then a line '---', "
            "then the full detailed report with sources.",
        ],
        tools=[_load("reasoning", "ReasoningTools", add_instructions=True)] if ENABLE_REASONING else [],
    )
    bundle = "\n\n".join(f"## {r['subtask']}\n{r['output']}" for r in results)
    return _run(synth, f"GOAL: {goal}\n\nSUBTASK FINDINGS:\n{bundle}\n\nWrite the final report.")


def _extract_records(task_id, goal, report, deadline):
    """Pull the report into clean JSON records for tidy storage. Best-effort."""
    _ensure_alive(task_id, deadline)
    _update(task_id, current_thought="Extracting structured records...")
    extractor = _agent(
        "Swarm Extractor",
        "Precise data extractor that converts a report into structured JSON rows.",
        SYNTH_MODEL,
        instructions=[
            "From the report, extract the key items the goal asked for as JSON.",
            "Return ONLY a JSON array of objects. No prose, no code fences.",
            "Each object uses whatever of these fields apply: "
            "title, name, url, email, organization, location, description, date, notes.",
            "Omit fields you don't have. If nothing structured fits, return [].",
        ],
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

    json_path = None
    if records:
        json_path = os.path.join(task_dir, "records.json")
        with open(json_path, "w", encoding="utf-8") as f:
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
    return txt_path, json_path, task_dir


# ---------------------------------------------------------------------------
# Worker loop
# ---------------------------------------------------------------------------
def worker_loop(task_id, goal):
    deadline = time.time() + TASK_DEADLINE_SECONDS
    task_dir = os.path.join(REPORTS_ROOT, task_id[:8])
    os.makedirs(task_dir, exist_ok=True)
    try:
        _update(task_id, status="RUNNING", current_thought="Booting Groq research orchestrator...")

        subtasks = _plan(task_id, goal, deadline)
        _update(task_id, plan=subtasks)

        results = _research(task_id, goal, subtasks, task_dir, deadline)
        report  = _synthesize(task_id, goal, results, deadline)
        records = _extract_records(task_id, goal, report, deadline)
        _ensure_alive(task_id, deadline)

        summary = report.split("---", 1)[0].strip() if "---" in report else \
            "Swarm research completed."
        txt_path, json_path, _ = _store(task_id, goal, report, records)

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
# Public API (backward compatible)
# ---------------------------------------------------------------------------
def launch_swarm_task(goal: str) -> str:
    """Launches a background research swarm and returns the task_id."""
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
        return f"Task {task_id} is {t['status']} (partial results so far):\n\n{joined}"
    return f"Task {task_id} is currently {t['status']}. No result yet."