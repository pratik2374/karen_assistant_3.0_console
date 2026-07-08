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
            
        def bound_check_kill():
            """Checks if the user killed this task."""
            return check_kill_switch(task_id)

        agent = Agent(
            name="Groq Worker Swarm",
            role="Relentless background researcher and data grinder. You work for Karen.",
            model=Groq(id="llama3-70b-8192", api_key=get_groq_api_key()),
            instructions=[
                "You are an autonomous background worker.",
                "Your job is to relentlessly research and execute the given goal.",
                "CRITICAL: Before taking any major step, you MUST call bound_log_thought to tell the database what you are doing (e.g. 'Scraping LinkedIn for recruiters').",
                "CRITICAL: Periodically call bound_check_kill. If it returns 'KILL_FLAG_TRUE', you MUST immediately stop all work and output 'KILLED BY USER' as your final response.",
                "Use search_web to find information.",
                "Once you have a complete and detailed answer, formulate your final response."
            ],
            tools=[bound_log_thought, bound_check_kill, search_web],
            show_tool_calls=True,
            markdown=True
        )
        
        swarm_tasks_col.update_one({"task_id": task_id}, {"$set": {"status": "RUNNING", "current_thought": "Booting up Groq Llama3 instance..."}})
        
        response = agent.run(goal)
        
        task = swarm_tasks_col.find_one({"task_id": task_id})
        if task and task.get("kill_flag", False):
            swarm_tasks_col.update_one({"task_id": task_id}, {"$set": {"status": "KILLED", "current_thought": "Terminated by user."}})
            return
            
        swarm_tasks_col.update_one(
            {"task_id": task_id},
            {"$set": {
                "status": "COMPLETED",
                "result": response.content,
                "current_thought": "Finished successfully."
            }}
        )
    except Exception as e:
        swarm_tasks_col.update_one(
            {"task_id": task_id},
            {"$set": {
                "status": "FAILED",
                "current_thought": f"Crashed: {str(e)}"
            }}
        )
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
    if not active:
        return "No active swarm tasks right now."
    out = "Active Swarms:\n"
    for t in active:
        out += f"- ID: {t['task_id']} | Status: {t['status']} | Doing: {t.get('current_thought')}\n"
    return out
