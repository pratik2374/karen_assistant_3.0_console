import sys
import os
import threading
import time
from colorama import init, Fore, Style
from db import tasks_col, memories_col, saga_states_col, live_alerts_col
from calendar_service import sync_calendar_events
from protocol_handler import register_protocol
import ai
import voice_service

# Initialize Colorama for cross-platform colored terminal output
init(autoreset=True)

def print_banner():
    banner = f"""{Fore.CYAN}{Style.BRIGHT}
╔══════════════════════════════════════════════════╗
║        🎙️   KAREN  ·  Python CLI Console         ║
║          Standalone Python Orchestration         ║
╚══════════════════════════════════════════════════╝
"""
    print(banner)
    print(f"{Fore.WHITE}Type {Fore.YELLOW}/help{Fore.WHITE} for a list of commands, or type any natural language query.\n")

def print_help():
    print(f"\n{Fore.GREEN}{Style.BRIGHT}Available Commands:")
    print(f"  {Fore.YELLOW}/help{Fore.RESET}      - Show this commands list")
    print(f"  {Fore.YELLOW}/status{Fore.RESET}    - Display database statistics & active sagas")
    print(f"  {Fore.YELLOW}/tasks{Fore.RESET}     - List current Google Calendar tasks & statuses")
    print(f"  {Fore.YELLOW}/sync{Fore.RESET}      - Manually force a Google Calendar synchronization")
    print(f"  {Fore.YELLOW}/register{Fore.RESET}  - Register 'karen://' protocol in Windows Registry")
    print(f"  {Fore.YELLOW}/exit{Fore.RESET}      - Close this terminal session\n")

def print_status():
    total_tasks = tasks_col.count_documents({})
    pending = tasks_col.count_documents({"status": "PENDING"})
    started = tasks_col.count_documents({"status": "STARTED"})
    completed = tasks_col.count_documents({"status": "COMPLETED"})
    missed = tasks_col.count_documents({"status": "MISSED"})
    
    active_sagas = saga_states_col.count_documents({"status": "ACTIVE"})
    memories_count = memories_col.count_documents({})

    print(f"\n{Fore.CYAN}{Style.BRIGHT}Karen Status Snapshot:")
    print(f"  - Total Calendar Tasks:   {Fore.WHITE}{total_tasks}")
    print(f"    • {Fore.YELLOW}Pending:             {pending}")
    print(f"    • {Fore.GREEN}Started:             {started}")
    print(f"    • {Fore.BLUE}Completed:           {completed}")
    print(f"    • {Fore.RED}Missed:              {missed}")
    print(f"  - Active timer sagas:     {Fore.YELLOW}{active_sagas}")
    print(f"  - Recorded User Memories: {Fore.MAGENTA}{memories_count}")
    print("")

def print_tasks():
    tasks = list(tasks_col.find().sort("start_time", 1))
    if not tasks:
        print(f"\n{Fore.YELLOW}No tasks found in the database. Run {Fore.CYAN}/sync{Fore.YELLOW} to pull calendar events.")
        return

    print(f"\n{Fore.CYAN}{Style.BRIGHT}Local Tasks list:")
    print(f"{'Start Time':<25} | {'Status':<10} | {'Task Title'}")
    print("-" * 65)
    
    for task in tasks:
        status_color = Fore.YELLOW
        if task["status"] == "STARTED":
            status_color = Fore.GREEN
        elif task["status"] == "COMPLETED":
            status_color = Fore.BLUE
        elif task["status"] == "MISSED":
            status_color = Fore.RED

        # Format local ISO start time display
        start_time = task["start_time"]
        if start_time.endswith("Z"):
            start_time = start_time.replace("Z", " UTC")
            
        print(f"{start_time:<25} | {status_color}{task['status']:<10}{Fore.RESET} | {task['title']}")
    print("")

def listen_for_live_alerts():
    """Background thread polling live_alerts collection from MongoDB."""
    while True:
        try:
            alert = live_alerts_col.find_one_and_update(
                {"processed": False},
                {"$set": {"processed": True}}
            )
            if alert:
                # We output with a carriage return \r to clear the current prompt line cleanly
                print(f"\r\n{Fore.MAGENTA}{Style.BRIGHT}Karen: {Fore.WHITE}{alert['message']}\n")
                # Reprint the prompt so the user can continue typing seamlessly
                print(f"{Fore.CYAN}karen> {Fore.RESET}", end="", flush=True)
        except Exception:
            pass
        time.sleep(2)

def run_cli():
    # Start lazy loading ChatTTS
    voice_service.load_chattts_lazy()
    
    print_banner()
    
    # Start background live alerts listener
    t = threading.Thread(target=listen_for_live_alerts, daemon=True)
    t.start()
    
    conversation_history = []
    
    while True:
        try:
            # Prompt cyan format
            query = input(f"{Fore.CYAN}karen> {Fore.RESET}").strip()
        except (KeyboardInterrupt, EOFError):
            print(f"\n{Fore.YELLOW}Session closed. Bye!")
            break

        if not query:
            continue

        # Check for administrative slash commands
        if query.startswith("/"):
            cmd = query.lower()
            if cmd in ["/exit", "/quit"]:
                print(f"{Fore.YELLOW}Goodbye!")
                break
            elif cmd == "/help":
                print_help()
            elif cmd == "/status":
                print_status()
            elif cmd == "/tasks":
                print_tasks()
            elif cmd == "/sync":
                print(f"{Fore.CYAN}Forcing Google Calendar synchronization...")
                sync_calendar_events()
            elif cmd == "/register":
                print(f"{Fore.CYAN}Registering Windows custom protocol handler...")
                register_protocol()
            else:
                print(f"{Fore.RED}Unknown command: {query}. Type {Fore.YELLOW}/help{Fore.RED} for commands list.")
            continue

        # Process natural query via LLM
        print(f"{Fore.LIGHTBLACK_EX}Thinking...")
        response = ai.generate_karen_response(query, conversation_history)
        
        # Output chatbot styled text
        print(f"\n{Fore.MAGENTA}{Style.BRIGHT}Karen: {Fore.WHITE}{response}\n")
        
        # Speak conversational response
        voice_service.speak_conversation(response)
        
        # Append exchange to history
        conversation_history.append({"role": "user", "content": query})
        conversation_history.append({"role": "assistant", "content": response})
        # Cap history to keep context clean
        if len(conversation_history) > 10:
            conversation_history = conversation_history[-10:]

        # Extract memory in the background
        ai.extract_and_save_memories(query, response)

if __name__ == "__main__":
    import db
    run_cli()
