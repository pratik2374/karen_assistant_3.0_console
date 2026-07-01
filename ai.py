import os
import json
import uuid
from datetime import datetime, timezone, timedelta
from openai import OpenAI
from db import memories_col, tasks_col, saga_states_col

# Initialize OpenAI client
client = None

def get_openai_client():
    global client
    if client is None:
        api_key = os.getenv("OPENAI_API_KEY")
        if not api_key:
            raise ValueError("OPENAI_API_KEY environment variable is not set.")
        client = OpenAI(api_key=api_key)
    return client

def get_model_name():
    return os.getenv("OPENAI_MODEL_NAME", "gpt-5.4-mini")

# ─────────────────────────────────────────────────────────────────────────────
# Python Tools / Functions
# ─────────────────────────────────────────────────────────────────────────────

def create_reminder(title: str, delay_minutes: int) -> str:
    """Creates a task and active saga state in MongoDB based on the title and delay minutes."""
    task_id = str(uuid.uuid4())
    now_utc = datetime.now(timezone.utc)
    
    # Calculate event start time
    start_time = now_utc + timedelta(minutes=delay_minutes)
    
    tasks_col.insert_one({
        "id": task_id,
        "title": title,
        "start_time": start_time.isoformat(),
        "status": "PENDING"
    })
    
    # For dynamic reminders, we skip Stage 0 (Pre-Alert) and initialize at Stage 1 (Check-In)
    saga_states_col.insert_one({
        "task_id": task_id,
        "current_stage": 1,  # 1 = Check-In
        "next_wakeup": start_time.isoformat(),
        "status": "ACTIVE"
    })
    
    print(f"[Tool] Created reminder '{title}' (ID: {task_id}) starting at {start_time.isoformat()}")
    return f"Success: Created reminder '{title}' (ID: {task_id})"

def complete_task(task_id: str) -> str:
    """Marks a task as COMPLETED and halts its escalating timer saga."""
    res1 = tasks_col.update_one({"id": task_id}, {"$set": {"status": "COMPLETED"}})
    res2 = saga_states_col.update_one({"task_id": task_id}, {"$set": {"status": "STOPPED"}})
    print(f"[Tool] Marked task {task_id} as COMPLETED. Saga stopped.")
    return f"Success: Task {task_id} completed and reminder saga stopped."

# ─────────────────────────────────────────────────────────────────────────────
# OpenAI Tool Specifications
# ─────────────────────────────────────────────────────────────────────────────

tools = [
    {
        "type": "function",
        "function": {
            "name": "create_reminder",
            "description": "Create a task/reminder with a title and a specific delay in minutes from now.",
            "parameters": {
                "type": "object",
                "properties": {
                    "title": {
                        "type": "string",
                        "description": "The title or content of the reminder (e.g. 'drink tea', 'call mom')."
                    },
                    "delay_minutes": {
                        "type": "integer",
                        "description": "The delay in minutes from the current time when the task starts."
                    }
                },
                "required": ["title", "delay_minutes"],
                "additionalProperties": False
            },
            "strict": True
        }
    },
    {
        "type": "function",
        "function": {
            "name": "complete_task",
            "description": "Mark a task/reminder as completed using its unique task ID.",
            "parameters": {
                "type": "object",
                "properties": {
                    "task_id": {
                        "type": "string",
                        "description": "The unique ID of the task to complete."
                    }
                },
                "required": ["task_id"],
                "additionalProperties": False
            },
            "strict": True
        }
    }
]

# ─────────────────────────────────────────────────────────────────────────────
# Core LLM Routine
# ─────────────────────────────────────────────────────────────────────────────

def generate_karen_response(user_message: str, conversation_history: list = None) -> str:
    """Generates a response in Karen's signature persona, executing tools if requested by the LLM."""
    openai_client = get_openai_client()
    model = get_model_name()

    # Load existing facts for context
    facts = [m["fact"] for m in memories_col.find()]
    facts_str = "\n".join(f"- {f}" for f in facts) if facts else "No personal facts loaded yet."

    system_prompt = f"""You are Karen, an aggressively helpful, snarky, and opinionated AI assistant.
Your main job is to keep the user productive and mock their procrastination attempts.
Always respond in a direct, highly conversational, and witty voice. Keep responses short and punchy.

KNOWN USER INFORMATION & MEMORIES:
{facts_str}
"""

    messages = [{"role": "system", "content": system_prompt}]
    
    if conversation_history:
        for msg in conversation_history:
            messages.append(msg)
            
    messages.append({"role": "user", "content": user_message})

    try:
        # Call OpenAI with tool support
        completion = openai_client.chat.completions.create(
            model=model,
            messages=messages,
            tools=tools,
            temperature=0.7
        )
        
        response_msg = completion.choices[0].message
        
        # Check if the model requested any tool executions
        if response_msg.tool_calls:
            # Append assistant message (with tool calls) to history
            messages.append(response_msg)
            
            # Execute each tool call
            for tool_call in response_msg.tool_calls:
                func_name = tool_call.function.name
                func_args = json.loads(tool_call.function.arguments)
                
                tool_result = ""
                if func_name == "create_reminder":
                    tool_result = create_reminder(
                        title=func_args.get("title"),
                        delay_minutes=func_args.get("delay_minutes")
                    )
                elif func_name == "complete_task":
                    tool_result = complete_task(
                        task_id=func_args.get("task_id")
                    )
                
                # Append tool execution response to thread
                messages.append({
                    "role": "tool",
                    "tool_call_id": tool_call.id,
                    "content": tool_result
                })
            
            # Request OpenAI for the final conversational reply now that tools have run
            final_completion = openai_client.chat.completions.create(
                model=model,
                messages=messages,
                temperature=0.7
            )
            return final_completion.choices[0].message.content
            
        return response_msg.content
    except Exception as e:
        return f"Ugh, I hit a snag talking to my brain: {e}"

def extract_and_save_memories(user_message: str, karen_response: str):
    """Analyzes the exchange to update personal insights/memories in the database."""
    openai_client = get_openai_client()
    model = get_model_name()

    prompt = f"""You are Karen's memory extraction daemon.
Review the following exchange and extract any key facts, preferences, habits, or schedule details about the user.
Format the output as a raw JSON array of strings (e.g. ["User drinks coffee in the morning", "User procrastinates on admin tasks"]).
If no new facts are found, return an empty array [].

Exchange:
User: "{user_message}"
Karen: "{karen_response}"
"""

    try:
        completion = openai_client.chat.completions.create(
            model=model,
            messages=[{"role": "user", "content": prompt}],
            temperature=0.1
        )
        content = completion.choices[0].message.content.strip()
        
        # Clean markdown wrapper if LLM returned it
        if content.startswith("```"):
            content = content.split("\n", 1)[1].rsplit("\n", 1)[0].strip()
            if content.startswith("json"):
                content = content[4:].strip()

        facts = json.loads(content)
        if isinstance(facts, list):
            for fact in facts:
                # Check for duplicates
                if not memories_col.find_one({"fact": fact}):
                    memories_col.insert_one({"fact": fact})
                    print(f"[Memory] Recorded new fact: {fact}")
    except Exception as e:
        print(f"[Memory] Error during extraction: {e}")

if __name__ == "__main__":
    # Quick test
    print("Testing Karen's voice and tools...")
    print("Karen:", generate_karen_response("remind me in 5 minutes to drink tea"))
