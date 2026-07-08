import sys
import os
import threading
import time
from colorama import init, Fore, Style
from db import tasks_col, memories_col, saga_states_col, live_alerts_col, diary_prompts_col
from calendar_service import sync_calendar_events
from protocol_handler import register_protocol
import ai
import voice_service
import csv
from datetime import datetime, timezone
import uuid
from memory_engine import process_orphan_sessions, auto_save_session, save_and_process_session

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

def listen_for_live_alerts(conversation_history):
    """Background thread polling live_alerts collection from MongoDB."""
    while True:
        try:
            alert = live_alerts_col.find_one_and_update(
                {"processed": False},
                {"$set": {"processed": True}}
            )
            if alert:
                # Speak the reminder/reaction alert vocally with emotion support!
                mood = alert.get("mood", "neutral")
                voice_service.speak_conversation(alert['message'], mood)
                
                # Output with a carriage return \r to clear prompt line cleanly
                print(f"\r\n{Fore.MAGENTA}{Style.BRIGHT}Karen: {Fore.WHITE}{alert['message']}\n")
                
                # Append to conversation history so she remembers what she just autonomously said!
                if conversation_history is not None:
                    conversation_history.append({"role": "assistant", "content": alert['message']})
                    
                # Reprint the prompt so the user can continue typing
                print(f"{Fore.CYAN}karen> {Fore.RESET}", end="", flush=True)
        except Exception:
            pass
        time.sleep(2)

def stream_startup_greeting():
    """Selects a random snarky greeting and streams it token-by-token (text + audio) on startup."""
    import random
    from voice_service import GREETINGS_QUOTES, VoiceStreamer
    
    # Ensure offline warning file is pre-cached
    voice_service.ensure_utilities_cached()
    
    quote = random.choice(GREETINGS_QUOTES)
    
    print(f"{Fore.MAGENTA}{Style.BRIGHT}Karen: {Fore.WHITE}", end="", flush=True)
    
    # Initialize voice streamer
    streamer = VoiceStreamer()
    
    # Stream words with slight delay to mimic generation
    words = quote.split(" ")
    for i, word in enumerate(words):
        space = " " if i > 0 else ""
        chunk = space + word
        print(chunk, end="", flush=True)
        streamer.push_chunk(chunk)
        time.sleep(0.08) # Slower delay to simulate generation
        
    streamer.flush()
    print("\n")

def run_cli():
    # Initialize episodic memory session
    session_id = str(uuid.uuid4())
    session_started_at = datetime.now(timezone.utc).isoformat()
    
    # Process orphans on boot (background)
    threading.Thread(target=process_orphan_sessions, daemon=True).start()


    
    # Clear stale pending alerts and diary prompts from previous sessions
    try:
        live_alerts_col.update_many({"processed": False}, {"$set": {"processed": True}})
        diary_prompts_col.update_many({"processed": False}, {"$set": {"processed": True}})
    except Exception:
        pass
        
    # Stream the startup greeting quote (visual + audio streaming)
    stream_startup_greeting()
    
    print_banner()
    
    # Prompt user for voice input mode (default is N)
    print(f"{Fore.WHITE}Do you want to use voice input? [y/N]: ", end="", flush=True)
    try:
        choice = input().strip().lower()
    except (KeyboardInterrupt, EOFError):
        choice = ""
        
    voice_input_mode = False
    if choice == "y":
        try:
            import sounddevice as sd
            import speech_recognition as sr
            voice_input_mode = True
            print(f"{Fore.GREEN}[System] Voice mode activated. Speak after 'karen (listening...)>'.{Fore.RESET}\n")
        except ImportError:
            print(f"{Fore.RED}[System Error] Speech-to-Text dependencies not found. Falling back to text mode.{Fore.RESET}")
            print(f"{Fore.YELLOW}Please run: pip install sounddevice SpeechRecognition{Fore.RESET}\n")
            voice_input_mode = False
            
    conversation_history = []
    
    # Start background live alerts listener
    t = threading.Thread(target=listen_for_live_alerts, args=(conversation_history,), daemon=True)
    t.start()
    
    while True:
        try:
            if voice_input_mode:
                print(f"{Fore.CYAN}karen (listening...)> {Fore.RESET}", end="", flush=True)
                query = voice_service.get_voice_input().strip()
                # Print recognized text so it shows in the chat transcript log
                print(f"{Fore.WHITE}{query}")
            else:
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
            elif cmd.startswith("/water"):
                parts = cmd.split(" ")
                if len(parts) > 1 and parts[1] == "stop":
                    res = ai.stop_recurring_reminder("drink water")
                    print(f"{Fore.GREEN}{res}")
                else:
                    try:
                        interval = int(parts[1]) if len(parts) > 1 else 37
                        res = ai.start_recurring_reminder("drink water", interval)
                        print(f"{Fore.GREEN}{res}")
                    except ValueError:
                        print(f"{Fore.RED}Usage: /water <interval_minutes> or /water stop")
            elif cmd.startswith("/diary"):
                parts = cmd.split(" ")
                if len(parts) > 1 and parts[1] == "stop":
                    res = ai.stop_task_diary()
                    print(f"{Fore.GREEN}{res}")
                else:
                    try:
                        interval = int(parts[1]) if len(parts) > 1 else 60
                        res = ai.start_task_diary(interval)
                        print(f"{Fore.GREEN}{res}")
                    except ValueError:
                        print(f"{Fore.RED}Usage: /diary <interval_minutes> or /diary stop")
            else:
                print(f"{Fore.RED}Unknown command: {query}. Type {Fore.YELLOW}/help{Fore.RED} for commands list.")
            continue

        # Process natural query via LLM (streaming)
        print(f"{Fore.LIGHTBLACK_EX}Thinking...")
        
        # Initialize voice streamer
        streamer = voice_service.VoiceStreamer()
        
        print(f"\n{Fore.MAGENTA}{Style.BRIGHT}Karen: {Fore.WHITE}", end="", flush=True)
        
        response = ""
        try:
            for chunk in ai.generate_karen_response_stream(query, conversation_history):
                print(chunk, end="", flush=True)
                response += chunk
                streamer.push_chunk(chunk)
        finally:
            streamer.flush()
            print("\n")
            
        # Append exchange to history
        conversation_history.append({"role": "user", "content": query})
        conversation_history.append({"role": "assistant", "content": response})
        # Cap history to keep context clean
        if len(conversation_history) > 10:
            conversation_history = conversation_history[-10:]

        # Auto-save session every 5 exchanges (10 messages)
        # Note: Since we cap at 10, if it reaches 10 it means we've had 5 exchanges.
        if len(conversation_history) >= 10:
            auto_save_session(session_id, conversation_history, session_started_at)
            
    # Outside while loop: Handle session exit
    print(f"\n{Fore.CYAN}[Memory] Saving session {session_id[:8]}... Karen will remember this conversation.{Fore.RESET}")
    save_and_process_session(session_id, conversation_history, session_started_at)

if __name__ == "__main__":
    import db
    run_cli()
