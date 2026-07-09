import os
import threading
import uuid
from datetime import datetime
from agno.agent import Agent
from agno.models.groq import Groq
from db import swarm_tasks_col

# A global dictionary to keep track of running agent threads
_active_swarms = {}

def get_groq_api_key():
    api_key = os.getenv("GROQ_API_KEY")
    if not api_key:
        raise ValueError("GROQ_API_KEY environment variable is not set. The Swarm requires Groq.")
    return api_key

def log_swarm_thought(task_id: str, thought: str):
    """Callback tool so the swarm can report what it is currently researching."""
    swarm_tasks_col.update_one(
        {"task_id": task_id}, 
        {"$set": {"current_thought": thought}}
    )
    return f"Thought logged: {thought}"

def check_kill_switch(task_id: str) -> str:
    """Tool for the swarm to check if it has been killed by the user."""
    task = swarm_tasks_col.find_one({"task_id": task_id})
    if task and task.get("kill_flag", False):
        return "KILL_FLAG_TRUE"
    return "CONTINUE"

def search_web(query: str) -> str:
    """Simulates a web search."""
    import urllib.request
    import urllib.parse
    try:
        url = f"https://html.duckduckgo.com/html/?q={urllib.parse.quote(query)}"
        req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
        with urllib.request.urlopen(req) as response:
            html = response.read().decode('utf-8')
            return f"Search executed for: {query}. Result snippet: {html[:1000]}"
    except Exception as e:
        return f"Search failed: {e}"

def worker_loop(task_id: str, goal: str):
    """The background execution loop for the Groq worker."""
    try:
        def bound_log_thought(thought: str):
            """Updates the swarm's live status in the database so the user can see what it's doing."""
            return log_swarm_thought(task_id, thought)
            
        def bound_check_kill(check: str = "status"):
            """Checks if the user killed this task."""
            return check_kill_switch(task_id)

        agent = Agent(
            name="Groq Worker Swarm",
            role="Relentless background researcher and data grinder. You work for Karen.",
            model=Groq(id="llama-3.3-70b-versatile", api_key=get_groq_api_key()),
            instructions=[
                "You are an autonomous background worker.",
                "Your job is to relentlessly research and execute the given goal.",
                "CRITICAL: Before taking any major step, you MUST call bound_log_thought to tell the database what you are doing (e.g. 'Scraping LinkedIn for recruiters').",
                "CRITICAL: Periodically call bound_check_kill. If it returns 'KILL_FLAG_TRUE', you MUST immediately stop all work and output 'KILLED BY USER' as your final response.",
                "Use search_web to find information.",
                "Once you have a complete and detailed answer, formulate your final response.",
                "CRITICAL FORMAT: You MUST start your final response with a 2-3 line summary of your findings. Then, put a separator '---', followed by your full detailed report.",
            ],
            tools=[bound_log_thought, bound_check_kill, search_web],
            markdown=True
        )
        
        swarm_tasks_col.update_one({"task_id": task_id}, {"$set": {"status": "RUNNING", "current_thought": "Booting up Groq Llama3 instance..."}})
        
        response = agent.run(goal)
        
        task = swarm_tasks_col.find_one({"task_id": task_id})
        if task and task.get("kill_flag", False):
            swarm_tasks_col.update_one({"task_id": task_id}, {"$set": {"status": "KILLED", "current_thought": "Terminated by user."}})
            return
            
        # Parse the output for summary and full report
        content = response.content
        summary = "Swarm task completed successfully."
        if "---" in content:
            parts = content.split("---", 1)
            summary = parts[0].strip()
        
        # Save to file
        import subprocess
        
        reports_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "research_reports")
        os.makedirs(reports_dir, exist_ok=True)
        
        # Create a safe filename from the goal
        safe_goal = "".join([c if c.isalnum() else "_" for c in goal[:30]])
        filepath = os.path.join(reports_dir, f"SwarmReport_{safe_goal}_{task_id[:6]}.txt")
        
        with open(filepath, "w", encoding="utf-8") as f:
            f.write(content)
            
        swarm_tasks_col.update_one(
            {"task_id": task_id},
            {"$set": {
                "status": "COMPLETED",
                "result": content,
                "current_thought": "Finished successfully."
            }}
        )
        
        # Pop it open in Notepad
        try:
            subprocess.Popen(["notepad.exe", filepath])
        except Exception as e:
            print(f"[Swarm] Failed to open Notepad: {e}")
        
        # Trigger an autonomous live alert to tell the user it's done, reading the summary!
        from db import live_alerts_col
        live_alerts_col.insert_one({
            "message": f"Swarm Task Completed! {summary}\nI've popped the full report open in Notepad for you.",
            "mood": "proud",
            "created_at": datetime.now().isoformat(),
            "processed": False
        })
        
    except Exception as e:
        swarm_tasks_col.update_one(
            {"task_id": task_id},
            {"$set": {
                "status": "FAILED",
                "current_thought": f"Crashed: {str(e)}"
            }}
        )
        from db import live_alerts_col
        live_alerts_col.insert_one({
            "message": f"Swarm Task crashed on goal: {goal[:30]}... Error: {str(e)}",
            "mood": "annoyed",
            "created_at": datetime.now().isoformat(),
            "processed": False
        })
    finally:
        if task_id in _active_swarms:
            del _active_swarms[task_id]

def launch_swarm_task(goal: str) -> str:
    """Launches a background swarm task and returns the task_id."""
    task_id = str(uuid.uuid4())
    swarm_tasks_col.insert_one({
        "task_id": task_id,
        "goal": goal,
        "status": "QUEUED",
        "current_thought": "Waiting to start...",
        "result": None,
        "kill_flag": False,
        "created_at": datetime.now().isoformat()
    })
    
    t = threading.Thread(target=worker_loop, args=(task_id, goal), daemon=True)
    _active_swarms[task_id] = t
    t.start()
    return task_id

def kill_swarm_task(task_id: str) -> str:
    """Flags a swarm task to stop."""
    res = swarm_tasks_col.update_one({"task_id": task_id}, {"$set": {"kill_flag": True}})
    if res.matched_count == 0:
        return f"Task {task_id} not found."
    return f"Task {task_id} marked for termination. The swarm will die on its next cycle."

def get_swarm_status(task_id: str = None) -> str:
    """Returns the status of all active swarm tasks, or a specific one."""
    if task_id:
        task = swarm_tasks_col.find_one({"task_id": task_id})
        if not task: return "Not found."
        status_str = f"Task: {task['goal'][:50]}...\nStatus: {task['status']}\nCurrent Thought: {task.get('current_thought')}"
        if task['status'] == "COMPLETED":
            status_str += f"\nResult: {task.get('result')[:200]}..."
        return status_str
        
    active = list(swarm_tasks_col.find({"status": {"$in": ["RUNNING", "QUEUED"]}}))
    out = ""
    if active:
        out += "Active Swarms:\n"
        for t in active:
            out += f"- ID: {t['task_id']} | Status: {t['status']} | Doing: {t.get('current_thought')}\n"
    else:
        out += "No active swarm tasks right now.\n"
        
    recent = list(swarm_tasks_col.find({"status": {"$in": ["COMPLETED", "FAILED"]}}).sort("created_at", -1).limit(3))
    if recent:
        out += "\nRecently Completed/Failed Swarms:\n"
        for t in recent:
            out += f"- ID: {t['task_id']} | Goal: {t['goal'][:50]}... | Status: {t['status']}\n"
    return out

def read_swarm_result(task_id: str) -> str:
    """Reads the full, detailed result of a completed swarm task."""
    task = swarm_tasks_col.find_one({"task_id": task_id})
    if not task:
        return f"Task {task_id} not found."
    if task['status'] != "COMPLETED":
        return f"Task {task_id} is currently {task['status']}. No final result yet."
    return task.get("result", "No result found.")
