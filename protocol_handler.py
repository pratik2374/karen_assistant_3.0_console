import sys
import os
import winreg
from urllib.parse import urlparse, parse_qs
from db import tasks_col, saga_states_col

def register_protocol():
    """Registers the custom 'karen://' URI protocol handler in the Windows Registry (User Scope)."""
    key_path = r"Software\Classes\karen"
    try:
        # Create/open HKEY_CURRENT_USER\Software\Classes\karen
        key = winreg.CreateKey(winreg.HKEY_CURRENT_USER, key_path)
        winreg.SetValueEx(key, "", 0, winreg.REG_SZ, "URL:karen Protocol")
        winreg.SetValueEx(key, "URL Protocol", 0, winreg.REG_SZ, "")
        
        # DefaultIcon path pointing to python
        icon_key = winreg.CreateKey(key, "DefaultIcon")
        winreg.SetValueEx(icon_key, "", 0, winreg.REG_SZ, sys.executable)
        
        # shell\open\command configuration
        cmd_key = winreg.CreateKey(key, r"shell\open\command")
        script_path = os.path.abspath(__file__)
        
        # Execute python in windowless mode (pythonw.exe) if available, or fallback to python.exe
        python_exe = sys.executable.replace("python.exe", "pythonw.exe")
        if not os.path.exists(python_exe):
            python_exe = sys.executable
            
        cmd_value = f'"{python_exe}" "{script_path}" "%1"'
        winreg.SetValueEx(cmd_key, "", 0, winreg.REG_SZ, cmd_value)
        
        print(f"[Protocol] Custom 'karen://' protocol registered successfully.")
        print(f"           Command: {cmd_value}")
    except Exception as e:
        print(f"[Protocol] Failed to register protocol: {e}")

def handle_protocol_action(url: str):
    """Parses actions and task details from the custom URI trigger and updates database states."""
    print(f"[Protocol] Triggered with URL: {url}")
    try:
        # Normalize and parse URL query parameters
        cleaned_url = url.strip().strip('"').strip("'").rstrip('/')
        parsed = urlparse(cleaned_url)
        params = parse_qs(parsed.query)

        action_list = params.get("name")
        task_id_list = params.get("task_id")

        if not action_list or not task_id_list:
            print("[Protocol] Error: Missing 'name' or 'task_id' parameters.")
            return

        action = action_list[0]
        task_id = task_id_list[0]

        print(f"[Protocol] Parsed Action: '{action}', Task ID: '{task_id}'")

        if action == "started":
            # 1. Update task state to STARTED
            res1 = tasks_col.update_one({"id": task_id}, {"$set": {"status": "STARTED"}})
            # 2. Stop the reminder saga
            res2 = saga_states_col.update_one({"task_id": task_id}, {"$set": {"status": "STOPPED"}})
            print(f"[Protocol] Task {task_id} marked as STARTED. Saga stopped. Update counts: tasks={res1.modified_count}, sagas={res2.modified_count}")
            
            # Show confirmation toast
            from notifier import show_basic_toast
            show_basic_toast("Success", f"Escalation stopped. I recorded that you started the task!")

        elif action == "not_yet":
            print(f"[Protocol] User selected 'Not Yet' for Task {task_id}. Saga remains active.")
            # Show brief confirmation toast
            from notifier import show_basic_toast
            show_basic_toast("Understood", "Reminder snoozed. Don't procrastinate too long!")

        else:
            print(f"[Protocol] Unknown action: {action}")

    except Exception as e:
        print(f"[Protocol] Exception occurred: {e}")

if __name__ == "__main__":
    if len(sys.argv) > 1:
        arg = sys.argv[1]
        if arg == "--register":
            register_protocol()
        elif arg.startswith("karen://"):
            handle_protocol_action(arg)
        else:
            print(f"Unknown argument: {arg}")
    else:
        print("Usage:")
        print("  python protocol_handler.py --register      (Register protocol handler)")
        print("  python protocol_handler.py karen://action  (Invoke handler manually)")
