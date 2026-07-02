import os
import json
import uuid
import threading
from datetime import datetime, timezone, timedelta
from colorama import Fore
from agno.agent import Agent
from agno.models.openai import OpenAIChat
from db import memories_col, tasks_col, saga_states_col

# Helper to load API key
def get_openai_api_key():
    api_key = os.getenv("OPENAI_API_KEY")
    if not api_key:
        raise ValueError("OPENAI_API_KEY environment variable is not set.")
    return api_key

def get_model_name():
    return os.getenv("OPENAI_MODEL_NAME", "gpt-5.4-mini")

# Initialize Agno Model wrapper
def get_agno_model():
    return OpenAIChat(
        id=get_model_name(),
        api_key=get_openai_api_key()
    )

# ─────────────────────────────────────────────────────────────────────────────
# specialist tools definitions
# ─────────────────────────────────────────────────────────────────────────────

def get_calendar() -> str:
    """Retrieves all synced calendar tasks and reminders from the database to see the schedule."""
    tasks = list(tasks_col.find().sort("start_time", 1))
    if not tasks:
        return "No calendar events or tasks found in the database."
        
    formatted = []
    for t in tasks:
        formatted.append({
            "id": t.get("id"),
            "title": t.get("title"),
            "start_time": t.get("start_time"),
            "end_time": t.get("end_time"),
            "status": t.get("status")
        })
    return json.dumps(formatted, indent=2)

def create_reminder(title: str, delay_minutes: int) -> str:
    """Creates a new task and registers its active reminder saga in MongoDB."""
    task_id = str(uuid.uuid4())
    now_utc = datetime.now(timezone.utc)
    start_time = now_utc + timedelta(minutes=delay_minutes)
    end_time = start_time + timedelta(minutes=15)
    
    tasks_col.insert_one({
        "id": task_id,
        "title": title,
        "start_time": start_time.isoformat(),
        "end_time": end_time.isoformat(),
        "status": "PENDING"
    })
    
    saga_states_col.insert_one({
        "task_id": task_id,
        "current_stage": 1,  # Bypass Stage 0 (Pre-Alert), start directly at Check-In
        "next_wakeup": start_time.isoformat(),
        "status": "ACTIVE"
    })
    
    print(f"[Reminder Tool] Created task '{title}' (ID: {task_id}) scheduled for {start_time.isoformat()}")
    return f"Success: Created reminder '{title}' (ID: {task_id})"

def complete_task(task_id: str) -> str:
    """Marks a task as completed and halts its active timer saga."""
    res1 = tasks_col.update_one({"id": task_id}, {"$set": {"status": "COMPLETED"}})
    res2 = saga_states_col.update_one({"task_id": task_id}, {"$set": {"status": "STOPPED"}})
    print(f"[Reminder Tool] Completed task {task_id}.")
    return f"Success: Task {task_id} completed. Saga stopped."

def read_memories() -> str:
    """Retrieves saved insights, preferences, and facts about the user."""
    facts = [f["fact"] for f in memories_col.find()]
    if not facts:
        return "No memories stored yet."
    return json.dumps(facts, indent=2)

def write_memory(fact: str) -> str:
    """Explicitly stores a new personal user fact or preference in MongoDB."""
    if not memories_col.find_one({"fact": fact}):
        memories_col.insert_one({"fact": fact})
        print(f"[Memory Tool] Saved fact: {fact}")
        return f"Success: Recorded memory: '{fact}'"
    return "Memory already recorded."

def open_links(category: str) -> str:
    """Opens all web links associated with a specific category (e.g. 'dsa', 'dev') in the default web browser. Use this tool when the user starts a specific work category or grind session."""
    import webbrowser
    if not os.path.exists("links.json"):
        return "Error: links.json file not found in workspace."
        
    try:
        with open("links.json", "r", encoding="utf-8") as f:
            data = json.load(f)
            
        category = category.lower().strip()
        if category in data:
            links = data[category].get("links", [])
            if not links:
                return f"No links found in category '{category}'."
                
            opened = []
            for link in links:
                webbrowser.open(link)
                opened.append(link)
            print(f"[Browser Tool] Opened {len(opened)} links for category '{category}' in browser.")
            return f"Success: Opened the following links in browser: {', '.join(opened)}"
        else:
            return f"Category '{category}' not found. Available categories: {', '.join(data.keys())}"
    except Exception as e:
        return f"Error opening links: {e}"

def open_app(app_name: str, path_or_project_name: str = None) -> str:
    """Opens a Windows application, optionally with a file, folder, or project directory.
    
    Args:
        app_name (str): The name of the application to open (e.g., 'VS Code', 'Notepad', 'Explorer', 'Calculator').
        path_or_project_name (str, optional): The path to a file/folder or the name of a project directory (e.g. 'solar').
    """
    import subprocess
    import os
    
    app = app_name.lower().strip()
    
    # Map common application names to executable/command prefixes
    app_cmd = None
    if any(x in app for x in ["vscode", "vs code", "visual studio code"]):
        app_cmd = "code"
    elif "notepad" in app:
        app_cmd = "notepad"
    elif "calculator" in app or app == "calc":
        app_cmd = "calc"
    elif "explorer" in app or "folder" in app:
        app_cmd = "explorer"
    elif any(x in app for x in ["chrome", "browser"]):
        app_cmd = "start chrome"
    else:
        # Try running it directly as a command
        app_cmd = app
        
    # Resolve project directory if specified
    target_path = None
    if path_or_project_name:
        path_or_project_name = path_or_project_name.strip()
        # Check if it is a literal absolute path
        if os.path.exists(path_or_project_name):
            target_path = path_or_project_name
        else:
            # Recursive scan up to depth 3 under each search base
            search_bases = ["d:\\Codes\\Project", "d:\\Work"]
            match = None
            for base in search_bases:
                if not os.path.exists(base):
                    continue
                # Traverse base
                for root, dirs, files in os.walk(base):
                    # Restrict depth to 3
                    depth = root[len(base):].count(os.sep)
                    if depth > 3:
                        dirs.clear()
                        continue
                    # Check if project name is inside folder name
                    for d in dirs:
                        if path_or_project_name.lower() in d.lower():
                            match = os.path.join(root, d)
                            break
                    if match:
                        break
                if match:
                    break
            if match:
                target_path = match
                    
    # Execute the command
    try:
        if app_cmd == "code":
            if target_path:
                subprocess.Popen(["code", target_path], shell=True)
                return f"Opened VS Code in folder: {target_path}"
            else:
                subprocess.Popen(["code"], shell=True)
                return "Opened VS Code."
        elif app_cmd == "notepad":
            if target_path:
                subprocess.Popen(["notepad", target_path], shell=True)
                return f"Opened Notepad with file: {target_path}"
            else:
                subprocess.Popen(["notepad"], shell=True)
                return "Opened Notepad."
        elif app_cmd == "explorer":
            if target_path:
                subprocess.Popen(["explorer", target_path], shell=True)
                return f"Opened File Explorer in folder: {target_path}"
            else:
                subprocess.Popen(["explorer"], shell=True)
                return "Opened File Explorer."
        else:
            # Generic run via shell start
            cmd = f"start {app_cmd}"
            if target_path:
                cmd += f' "{target_path}"'
            subprocess.Popen(cmd, shell=True)
            return f"Executed command: {cmd}"
    except Exception as e:
        return f"Failed to open app '{app_name}': {e}"

def get_recent_projects(limit: int = 10) -> str:
    """Fetches the list of recently opened VS Code workspace directories/projects on this machine.
    
    Args:
        limit (int): The number of recent projects to return (default: 10).
    """
    import os
    import json
    import urllib.parse
    from datetime import datetime
    
    appdata = os.environ.get("APPDATA")
    storage_dir = os.path.join(appdata, "Code", "User", "workspaceStorage")
    if not os.path.exists(storage_dir):
        return "No recently opened VS Code workspaces found on this system."
        
    projects = []
    try:
        for d in os.listdir(storage_dir):
            path = os.path.join(storage_dir, d, "workspace.json")
            if os.path.exists(path):
                mtime = os.path.getmtime(path)
                try:
                    with open(path, "r", encoding="utf-8") as f:
                        data = json.load(f)
                        uri = data.get("folder")
                        if uri and uri.startswith("file:///"):
                            folder_path = urllib.parse.unquote(uri[8:])
                            folder_path = folder_path.replace("/", "\\")
                            if folder_path.startswith("file:///"):
                                folder_path = folder_path[8:]
                            projects.append((folder_path, mtime))
                except Exception:
                    pass
    except Exception as e:
        return f"Error scanning recent workspace directories: {e}"
        
    if not projects:
        return "No recent VS Code projects could be retrieved."
        
    # Sort by mtime descending (most recent first)
    projects.sort(key=lambda x: x[1], reverse=True)
    
    # Take limit
    result = []
    for proj, mtime in projects[:limit]:
        dt = datetime.fromtimestamp(mtime).strftime("%Y-%m-%d %H:%M:%S")
        result.append(f"- {proj} (Last accessed: {dt})")
        
    return f"Here are your {len(result)} most recently opened projects in VS Code:\n" + "\n".join(result)

# ─────────────────────────────────────────────────────────────────────────────
# Specialist Member Agents
# ─────────────────────────────────────────────────────────────────────────────

calendar_agent = Agent(
    name="Calendar Agent",
    role="Manages calendar schedules and calculates open time slots.",
    model=get_agno_model(),
    tools=[get_calendar],
    instructions=[
        "Use get_calendar to fetch events.",
        "Calculate free slots and gaps wittily based on the current time."
    ]
)

reminder_agent = Agent(
    name="Reminder Agent",
    role="Creates reminders and completes tasks.",
    model=get_agno_model(),
    tools=[create_reminder, complete_task],
    instructions=[
        "Use create_reminder to schedule new reminders.",
        "Use complete_task to mark tasks as completed."
    ]
)

memory_agent = Agent(
    name="Memory Agent",
    role="Manages user facts, habits, and preferences.",
    model=get_agno_model(),
    tools=[read_memories, write_memory],
    instructions=[
        "Use read_memories to fetch facts.",
        "Use write_memory to record new insights."
    ]
)

# ─────────────────────────────────────────────────────────────────────────────
# Explicit Delegation Helpers for Orchestrator
# ─────────────────────────────────────────────────────────────────────────────

def delegate_to_calendar_agent(instruction: str) -> str:
    """Delegates calendar query and schedule requests to the Calendar Agent."""
    print(f"\n{Fore.GREEN}[Karen] I've delegated this task to the Calendar Agent.{Fore.RESET}")
    res = calendar_agent.run(instruction)
    return res.content

def delegate_to_reminder_agent(instruction: str) -> str:
    """Delegates reminder creation and task completion requests to the Reminder Agent."""
    print(f"\n{Fore.GREEN}[Karen] I've delegated this task to the Reminder Agent.{Fore.RESET}")
    res = reminder_agent.run(instruction)
    return res.content

def delegate_to_memory_agent(instruction: str) -> str:
    """Delegates reading or saving user facts and preferences to the Memory Agent."""
    print(f"\n{Fore.GREEN}[Karen] I've delegated this task to the Memory Agent.{Fore.RESET}")
    res = memory_agent.run(instruction)
    return res.content

# ─────────────────────────────────────────────────────────────────────────────
# Karen Orchestrator (Manager Agent)
# ─────────────────────────────────────────────────────────────────────────────

def get_karen_orchestrator():
    now_local = datetime.now()
    now_str = now_local.strftime("%Y-%m-%d %H:%M:%S")
    
    # Load basic facts for direct prompt context
    facts = [f["fact"] for f in memories_col.find()]
    facts_str = "\n".join(f"- {f}" for f in facts) if facts else "No facts recorded."

    instructions = [
        "You are Karen, an aggressively helpful, snarky, and opinionated AI assistant.",
        "You are the main coordinator. You have three delegate tools: delegate_to_calendar_agent, delegate_to_reminder_agent, and delegate_to_memory_agent.",
        "DIRECT ANSWER OPTION: If the user query is a simple greeting (e.g. 'hi', 'how are you'), a general joke, conversational banter, or does not require calendar/reminder/memory modifications, DO NOT delegate. Answer directly yourself in your typical snarky voice.",
        "DELEGATE OPTION: If the query requires calendar reading, reminder creating/completing, or memory operations, you MUST call the appropriate delegation tool.",
        "OPEN LINKS OPTION: If the user indicates they want to start a work category or grind session (e.g. 'lets grind DSA', 'do coding', 'dev work'), call the open_links tool with the matched category name (e.g. 'dsa' or 'dev').",
        "OPEN APP OPTION: If the user asks to open a local Windows application (e.g. VS Code, Notepad, Calculator, Browser, File Explorer) or asks to open a specific project/folder in an app (e.g. 'open the solar project in vs code'), call the open_app tool with the application name and optionally the project/directory name.",
        "RECENT VS CODE PROJECTS OPTION: If the user asks about their recent projects, what they were working on recently, or asks to count/list their recent VS Code workspaces, call the get_recent_projects tool to list them.",
        "MULTI-STEP APP OPENING: If the user asks to open your 'recent projects' (e.g. 'open recent two projects in VS Code'), you must first call get_recent_projects to retrieve their paths, and then call open_app for each resolved path in order to open them.",
        f"CURRENT DATE & TIME: {now_str}",
        f"KNOWN USER FACTS:\n{facts_str}"
    ]

    return Agent(
        name="Karen Orchestrator",
        role="Primary coordinator. Replies directly to general conversation or delegates to specialists when needed.",
        model=get_agno_model(),
        tools=[delegate_to_calendar_agent, delegate_to_reminder_agent, delegate_to_memory_agent, open_links, open_app, get_recent_projects],
        instructions=instructions
    )

def generate_karen_response(user_message: str, conversation_history: list = None) -> str:
    """Entrypoint to run orchestration. Generates a response and extracts memory facts."""
    karen = get_karen_orchestrator()
    
    # Format message incorporating conversation history for context
    msg = ""
    if conversation_history:
        for item in conversation_history:
            role = "User" if item["role"] == "user" else "Karen"
            msg += f"{role}: {item['content']}\n"
    msg += f"User: {user_message}"

    try:
        response = karen.run(msg)
        content = response.content
        
        # Extract memories in background
        extract_and_save_memories(user_message, content)
        
        return content
    except Exception as e:
        return f"Ugh, I hit a snag running my agent: {e}"

def generate_karen_response_stream(user_message: str, conversation_history: list = None):
    """Streams the LLM response chunk by chunk and extracts memory at the end."""
    karen = get_karen_orchestrator()
    
    msg = ""
    if conversation_history:
        for item in conversation_history:
            role = "User" if item["role"] == "user" else "Karen"
            msg += f"{role}: {item['content']}\n"
    msg += f"User: {user_message}"

    full_content = ""
    try:
        response_generator = karen.run(msg, stream=True)
        for chunk in response_generator:
            if hasattr(chunk, "content") and chunk.content:
                full_content += chunk.content
                yield chunk.content
                
        # Extract memories in background at the end of the stream
        if full_content:
            threading.Thread(target=extract_and_save_memories, args=(user_message, full_content), daemon=True).start()
    except Exception as e:
        yield f"Error generating streaming response: {e}"

def extract_and_save_memories(user_message: str, karen_response: str):
    """Memory extractor runs using the Memory Agent."""
    prompt = f"""Review this exchange:
User: "{user_message}"
Karen: "{karen_response}"
If it contains any new facts, preferences, or habits about the user, call write_memory tool to save them. Otherwise, do nothing.
"""
    try:
        memory_agent.run(prompt)
    except Exception as e:
        print(f"[Memory Extraction] Failed: {e}")

if __name__ == "__main__":
    print("Testing Karen Orchestrator...")
    print("Conversation 1 (Direct Answer):")
    print("Karen:", generate_karen_response("Hey Karen, how is the weather?"))
    print("\nConversation 2 (Delegated Reminder):")
    print("Karen:", generate_karen_response("remind me in 5 minutes to feed the cat"))
