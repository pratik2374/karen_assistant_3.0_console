import os
from pymongo import MongoClient

def load_env():
    """Manually parse .env file to load configuration settings into os.environ."""
    if os.path.exists(".env"):
        with open(".env", "r", encoding="utf-8") as f:
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

def init_db():
    """Initializes indexes on the collections for optimal query performance."""
    tasks_col.create_index("id", unique=True)
    saga_states_col.create_index("task_id", unique=True)
    print(f"[DB] Initialized MongoDB database '{MONGO_DB_NAME}' with indexes.")

if __name__ == "__main__":
    init_db()
