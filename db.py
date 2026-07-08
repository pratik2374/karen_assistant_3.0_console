import os
from pymongo import MongoClient

def load_env():
    """Manually parse .env file to load configuration settings into os.environ."""
    base_dir = os.path.dirname(os.path.abspath(__file__))
    env_path = os.path.join(base_dir, ".env")
    if os.path.exists(env_path):
        with open(env_path, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if "=" in line and not line.startswith("#"):
                    key, val = line.split("=", 1)
                    os.environ[key.strip()] = val.strip().strip('"').strip("'")

# Load environment configuration
load_env()

# Retrieve database connection URI
MONGO_URI = os.getenv("MONGO_URI", "mongodb://localhost:27017")
MONGO_DB_NAME = os.getenv("MONGO_DB_NAME", "karen_python")

# Initialize client
client = MongoClient(MONGO_URI)
db = client[MONGO_DB_NAME]

# Collections
tasks_col = db["tasks"]
saga_states_col = db["saga_states"]
memories_col = db["memories"]
sessions_col = db["sessions"]
live_alerts_col = db["live_alerts"]
recent_emails_col = db["recent_emails"]
missed_reasons_col = db["missed_reasons"]
recurring_reminders_col = db["recurring_reminders"]
diary_prompts_col = db["diary_prompts"]
conversation_sessions_col = db["conversation_sessions"]
email_sync_state_col = db["email_sync_state"]
email_priorities_col = db["email_priorities"]
activity_logs_col = db["activity_logs"]
swarm_tasks_col = db["swarm_tasks"]
karen_state_col = db["karen_state"]

def init_db():
    """Initializes indexes on the collections for optimal query performance."""
    tasks_col.create_index("id", unique=True)
    saga_states_col.create_index("task_id", unique=True)
    conversation_sessions_col.create_index("session_id", unique=True)
    email_sync_state_col.create_index("email", unique=True)
    swarm_tasks_col.create_index("task_id", unique=True)
    print(f"[DB] Initialized MongoDB database '{MONGO_DB_NAME}' with indexes.")

if __name__ == "__main__":
    init_db()
