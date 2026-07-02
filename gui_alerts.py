import sys
import os
import time
import argparse
import winsound
import csv
from datetime import datetime
import tkinter as tk
import voice_service

# Ensure environment is loaded for voice speech
import db
db.load_env()

# Pre-defined witty and cute hydration reminders (2-5 words limit)
WATER_QUOTES = [
    "Time to hydrate, cutie.",
    "Drink water, mortal.",
    "Stay juicy, human.",
    "Hydrate or die-drate."
]

def play_water_audio_and_animation():
    """Renders a frameless screen overlay of a water drop falling and splashing with chimes."""
    import random
    
    # 1. Start vocal speech in background thread and set flag when finished
    quote = random.choice(WATER_QUOTES)
    speech_finished = False
    
    def run_speech():
        nonlocal speech_finished
        voice_service.speak_conversation(quote)
        speech_finished = True
        
    import threading
    threading.Thread(target=run_speech, daemon=True).start()

    # 2. Setup Tkinter overlay
    root = tk.Tk()
    root.title("Water Splash Overlay")
    
    # Set window transparent, topmost, frameless
    root.overrideredirect(True)
    root.attributes("-topmost", True)
    root.attributes("-transparentcolor", "#010101")
    root.config(bg="#010101")
    
    accent_color = "#00adb5"
    
    # Position in center of screen
    screen_w = root.winfo_screenwidth()
    screen_h = root.winfo_screenheight()
    width = 300
    height = 400
    x = (screen_w - width) // 2
    y = (screen_h - height) // 2
    root.geometry(f"{width}x{height}+{x}+{y}")
    
    canvas = tk.Canvas(root, bg="#010101", highlightthickness=0)
    canvas.pack(fill="both", expand=True)
    
    # Sound chime
    try:
        winsound.Beep(523, 80)  # C5
        winsound.Beep(659, 80)  # E5
        winsound.Beep(784, 120) # G5
    except Exception:
        pass
        
    # Animation states: drop_y, splash_radius, stage
    # stage: 0 = falling, 1 = splashing, 2 = holding/fading
    state = {
        "drop_y": 70,
        "splash_r": 0,
        "stage": 0,
        "particles": []
    }
    
    def animate():
        canvas.delete("drop")
        canvas.delete("splash")
        
        if state["stage"] == 0:
            # Stage 0: Droplet falling
            state["drop_y"] += 6
            y1 = state["drop_y"]
            canvas.create_oval(
                width // 2 - 6, y1 - 4,
                width // 2 + 6, y1 + 10,
                fill=accent_color, outline="#00e5ff", width=2, tags="drop"
            )
            # Check collision with water level (y = 250)
            if state["drop_y"] >= 250:
                state["stage"] = 1
                
        elif state["stage"] == 1:
            # Stage 1: Splashing ripples & scattering droplets
            state["splash_r"] += 4
            r = state["splash_r"]
            canvas.create_oval(
                width // 2 - r, 250 - r // 3,
                width // 2 + r, 250 + r // 3,
                outline="#00e5ff", width=2, tags="splash"
            )
            
            # Generate droplets on first splash frame
            if not state["particles"]:
                for i in range(8):
                    import math
                    angle = i * (math.pi / 4)
                    speed = random.uniform(2, 5)
                    state["particles"].append({
                        "x": width // 2,
                        "y": 250,
                        "vx": math.cos(angle) * speed,
                        "vy": math.sin(angle) * speed - random.uniform(1, 4)
                    })
                    
            # Draw splashing particles
            for p in state["particles"]:
                p["x"] += p["vx"]
                p["y"] += p["vy"]
                p["vy"] += 0.3  # Gravity
                canvas.create_oval(
                    p["x"] - 3, p["y"] - 3,
                    p["x"] + 3, p["y"] + 3,
                    fill=accent_color, outline="#00e5ff", tags="splash"
                )
                
            if state["splash_r"] >= 65:
                state["stage"] = 2
                
        elif state["stage"] == 2:
            # Stage 2: Hold open until speech finishes
            # Draw static calm water line
            canvas.create_line(
                width // 2 - 40, 250,
                width // 2 + 40, 250,
                fill=accent_color, width=2, tags="splash"
            )
            if speech_finished:
                root.destroy()
                return
            
        root.after(16, animate) # ~60fps
        
    animate()
    root.mainloop()

def run_diary_checkin_gui():
    """Renders a beautiful split-screen dark-themed task diary input window."""
    root = tk.Tk()
    root.title("Task Diary Check-in")
    root.overrideredirect(True)
    root.attributes("-topmost", True)
    
    # Style configuration
    bg_color = "#121212"
    pane_color = "#1E1E1E"
    text_color = "#EEEEEE"
    accent_color = "#00adb5"
    border_color = "#333333"
    
    # 800x450 centered screen geometry
    screen_w = root.winfo_screenwidth()
    screen_h = root.winfo_screenheight()
    width = 800
    height = 450
    x = (screen_w - width) // 2
    y = (screen_h - height) // 2
    root.geometry(f"{width}x{height}+{x}+{y}")
    root.configure(bg=bg_color)
    
    # Double border frame styling
    outer_frame = tk.Frame(root, bg=bg_color, highlightbackground=accent_color, highlightthickness=3)
    outer_frame.pack(fill="both", expand=True, padx=4, pady=4)
    
    title_label = tk.Label(
        outer_frame,
        text="📓  TASK DIARY CHECK-IN  📓",
        bg=bg_color,
        fg=accent_color,
        font=("Segoe UI", 16, "bold")
    )
    title_label.pack(pady=15)
    
    # Split Pane layout
    panes_frame = tk.Frame(outer_frame, bg=bg_color)
    panes_frame.pack(fill="both", expand=True, padx=20, pady=10)
    
    # Left Page: What should I be doing?
    left_pane = tk.Frame(panes_frame, bg=pane_color, bd=2, relief="groove", highlightbackground=border_color)
    left_pane.pack(side="left", fill="both", expand=True, padx=10, pady=5)
    
    left_title = tk.Label(
        left_pane,
        text="WHAT I SHOULD BE DOING",
        bg=pane_color,
        fg=accent_color,
        font=("Segoe UI", 12, "bold")
    )
    left_title.pack(pady=15)
    
    left_desc = tk.Label(
        left_pane,
        text="Describe target task or active category:",
        bg=pane_color,
        fg="#888888",
        font=("Segoe UI", 9)
    )
    left_desc.pack()
    
    should_input = tk.Text(
        left_pane,
        bg="#121212",
        fg=text_color,
        insertbackground=accent_color,
        font=("Consolas", 11),
        bd=1,
        relief="solid",
        width=30,
        height=6
    )
    should_input.pack(padx=20, pady=15, fill="both", expand=True)
    should_input.focus_set()
    
    # Right Page: What am I doing?
    right_pane = tk.Frame(panes_frame, bg=pane_color, bd=2, relief="groove", highlightbackground=border_color)
    right_pane.pack(side="right", fill="both", expand=True, padx=10, pady=5)
    
    right_title = tk.Label(
        right_pane,
        text="WHAT I AM ACTUALLY DOING",
        bg=pane_color,
        fg="#e53935",
        font=("Segoe UI", 12, "bold")
    )
    right_title.pack(pady=15)
    
    right_desc = tk.Label(
        right_pane,
        text="Be honest. Are you procrastinating?",
        bg=pane_color,
        fg="#888888",
        font=("Segoe UI", 9)
    )
    right_desc.pack()
    
    actually_input = tk.Text(
        right_pane,
        bg="#121212",
        fg=text_color,
        insertbackground=accent_color,
        font=("Consolas", 11),
        bd=1,
        relief="solid",
        width=30,
        height=6
    )
    actually_input.pack(padx=20, pady=15, fill="both", expand=True)
    
    # Sound double beeps on open
    try:
        winsound.Beep(880, 150)
        winsound.Beep(1100, 200)
    except Exception:
        pass
        
    # Speak prompts in parallel
    import threading
    threading.Thread(
        target=voice_service.speak_conversation,
        args=("Task diary check-in. What should you be doing right now?",),
        daemon=True
    ).start()
    
    def on_submit():
        should = should_input.get("1.0", "end-1c").strip()
        actual = actually_input.get("1.0", "end-1c").strip()
        
        # Save to CSV
        csv_file = "task_diary.csv"
        file_exists = os.path.exists(csv_file)
        try:
            with open(csv_file, "a", newline="", encoding="utf-8") as f:
                writer = csv.writer(f)
                if not file_exists:
                    writer.writerow(["Timestamp", "Should Be Doing", "Actually Doing"])
                writer.writerow([
                    datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
                    should,
                    actual
                ])
        except Exception:
            pass
            
        # Voice confirm and exit
        def speak_and_close():
            voice_service.speak_conversation("Diary entry logged. Back to work.")
            root.destroy()
            
        threading.Thread(target=speak_and_close, daemon=True).start()
        
    button_frame = tk.Frame(outer_frame, bg=bg_color)
    button_frame.pack(pady=15)
    
    submit_btn = tk.Button(
        button_frame,
        text="SUBMIT DIARY ENTRY",
        command=on_submit,
        bg=accent_color,
        fg=bg_color,
        activebackground="#00e5ff",
        activeforeground=bg_color,
        font=("Segoe UI", 10, "bold"),
        padx=20,
        pady=8,
        bd=0,
        cursor="hand2"
    )
    submit_btn.pack()
    
    root.mainloop()

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Karen GUI Alerts Overlay")
    parser.add_argument("--type", type=str, required=True, choices=["water", "diary"], help="Type of overlay to display")
    args = parser.parse_args()
    
    if args.type == "water":
        play_water_audio_and_animation()
    elif args.type == "diary":
        run_diary_checkin_gui()
