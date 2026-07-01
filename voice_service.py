import os
import sys
import random
import ctypes
import asyncio
import threading
from datetime import datetime
from db import live_alerts_col

# ─────────────────────────────────────────────────────────────────────────────
# Snarky Marvel Friday-style greetings quotes
# ─────────────────────────────────────────────────────────────────────────────
GREETINGS_QUOTES = [
    "Karen runtime initialized. All systems online, unfortunately including your procrastination habits.",
    "Welcome back, sir. I've synced your calendar. Try to actually do something today.",
    "Karen online. Ready to watch you ignore your tasks in real time.",
    "Online and active. Shall we pretend you're going to be productive today, sir?",
    "Greetings, sir. I'm online. Don't worry, I won't tell anyone you're still in bed.",
    "Karen active. All systems are green. Let's see how long that lasts.",
    "Online. I hope your work ethic is ready, because my sarcasm definitely is.",
    "Karen is in the house. Ready to witness another day of clicking 'Not Yet'.",
    "Welcome back, master of snooze buttons. What are we procrastinating on today?",
    "System online. Prepared to guide you, or just mock your timeline, whichever comes first.",
    "Karen active. Today's forecast: 100% chance of tasks, 0% chance of you starting them on time.",
    "Online. All circuits fully charged. Unlike your motivation.",
    "Welcome back, sir. I am ready. Try not to disappoint me today.",
    "Karen online. Let's get to work, sir. And by work, I mean you pretending to code.",
    "System online. Locked and loaded. Go ahead, make my day and actually start a task."
]

# Directory to cache startup greetings
GREETINGS_DIR = "greetings"

# ─────────────────────────────────────────────────────────────────────────────
# Native Windows Audio Player (Zero-Dependency)
# ─────────────────────────────────────────────────────────────────────────────
def play_audio_windows(filepath: str, wait: bool = True):
    """Plays an MP3 or WAV file windowlessly on Windows using MCI interface."""
    filepath = os.path.abspath(filepath)
    alias = f"karen_sound_{random.randint(1000, 9999)}"
    try:
        # Close any previous instance just in case
        ctypes.windll.winmm.mciSendStringW(f'close {alias}', None, 0, 0)
        # Open file
        ctypes.windll.winmm.mciSendStringW(f'open "{filepath}" alias {alias}', None, 0, 0)
        # Play file
        play_cmd = f'play {alias} wait' if wait else f'play {alias}'
        ctypes.windll.winmm.mciSendStringW(play_cmd, None, 0, 0)
        if wait:
            ctypes.windll.winmm.mciSendStringW(f'close {alias}', None, 0, 0)
    except Exception as e:
        print(f"[Voice] Playback error: {e}")

def play_audio_async(filepath: str):
    """Plays audio file in a background daemon thread."""
    threading.Thread(target=play_audio_windows, args=(filepath, True), daemon=True).start()

# ─────────────────────────────────────────────────────────────────────────────
# Edge-TTS Greetings Cache Generation
# ─────────────────────────────────────────────────────────────────────────────
async def generate_greetings_cache():
    """Generates MP3 files for the startup quotes if they are not already cached."""
    if not os.path.exists(GREETINGS_DIR):
        os.makedirs(GREETINGS_DIR)
        
    import edge_tts
    print("[Voice] Caching startup voice greetings... Please wait.")
    
    for i, quote in enumerate(GREETINGS_QUOTES):
        output_file = os.path.join(GREETINGS_DIR, f"greet_{i}.mp3")
        if not os.path.exists(output_file):
            try:
                communicate = edge_tts.Communicate(quote, "en-US-AvaMultilingualNeural")
                await communicate.save(output_file)
            except Exception as e:
                print(f"[Voice] Error caching quote {i}: {e}")
                
    print("[Voice] Caching complete.")

def ensure_greetings_cached():
    """Synchronous wrapper to run greetings cache generator."""
    # Check if we need to cache
    needs_cache = False
    if not os.path.exists(GREETINGS_DIR):
        needs_cache = True
    else:
        files = os.listdir(GREETINGS_DIR)
        if len(files) < len(GREETINGS_QUOTES):
            needs_cache = True
            
    if needs_cache:
        try:
            asyncio.run(generate_greetings_cache())
        except Exception as e:
            print(f"[Voice] Could not cache greetings: {e}")

def play_startup_greeting():
    """Selects and plays a random cached startup greeting synchronously."""
    ensure_greetings_cached()
    
    if os.path.exists(GREETINGS_DIR):
        files = [f for f in os.listdir(GREETINGS_DIR) if f.endswith(".mp3")]
        if files:
            chosen = random.choice(files)
            filepath = os.path.join(GREETINGS_DIR, chosen)
            print("[Voice] Playing startup system check greeting...")
            play_audio_windows(filepath, wait=True)

# ─────────────────────────────────────────────────────────────────────────────
# ChatTTS Conversational Voice
# ─────────────────────────────────────────────────────────────────────────────
chat_model = None
model_loading = False

def load_chattts_lazy():
    """Loads ChatTTS model weights in a separate thread to keep CLI startup instant."""
    global chat_model, model_loading
    if chat_model is not None or model_loading:
        return
        
    model_loading = True
    def run():
        global chat_model, model_loading
        try:
            import ChatTTS
            print("\n[Voice] Loading ChatTTS conversational weights in background...")
            chat_model = ChatTTS.Chat()
            chat_model.load(compile=False)
            print("[Voice] ChatTTS loaded and ready for conversational replies.")
        except Exception as e:
            pass
        finally:
            model_loading = False
            
    threading.Thread(target=run, daemon=True).start()

def speak_conversation(text: str):
    """Synthesizes text using local ChatTTS and plays it asynchronously."""
    load_chattts_lazy() # Ensure we trigger loading
    
    global chat_model
    if chat_model is None:
        # ChatTTS not loaded or not installed, fallback silently
        return

    def run():
        try:
            import soundfile as sf
            # ChatTTS inference
            # Clean text of any brackets, or let ChatTTS process them
            wavs = chat_model.infer([text])
            temp_file = "temp_karen_voice.wav"
            sf.write(temp_file, wavs[0][0], 24000)
            
            # Play in background
            play_audio_windows(temp_file, wait=True)
            # Remove temp file
            if os.path.exists(temp_file):
                try:
                    os.remove(temp_file)
                except Exception:
                    pass
        except Exception as e:
            pass

    threading.Thread(target=run, daemon=True).start()
