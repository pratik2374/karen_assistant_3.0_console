import os
import json
from openai import OpenAI
from db import memories_col

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

def generate_karen_response(user_message: str, conversation_history: list = None) -> str:
    """Generates a response in Karen's signature snarky and proactive persona."""
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
    
    # Append conversation history
    if conversation_history:
        for msg in conversation_history:
            messages.append(msg)
            
    messages.append({"role": "user", "content": user_message})

    try:
        completion = openai_client.chat.completions.create(
            model=model,
            messages=messages,
            temperature=0.7
        )
        return completion.choices[0].message.content
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
    import db
    print("Testing Karen's voice...")
    print("Karen:", generate_karen_response("I should work, but I want to watch TV."))
