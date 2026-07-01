import os
import json
import uuid
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
    
    tasks_col.insert_one({
        "id": task_id,
        "title": title,
        "start_time": start_time.isoformat(),
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
        f"CURRENT DATE & TIME: {now_str}",
        f"KNOWN USER FACTS:\n{facts_str}"
    ]

    return Agent(
        name="Karen Orchestrator",
        role="Primary coordinator. Replies directly to general conversation or delegates to specialists when needed.",
        model=get_agno_model(),
        tools=[delegate_to_calendar_agent, delegate_to_reminder_agent, delegate_to_memory_agent],
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
