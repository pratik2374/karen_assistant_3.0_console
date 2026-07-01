import os
import sys
import random
import ctypes
import threading

# Directory where pre-generated startup greetings are stored
GREETINGS_DIR = "greetings"

# ─────────────────────────────────────────────────────────────────────────────
# Native Windows Audio Player (Zero-Dependency)
# ─────────────────────────────────────────────────────────────────────────────
def play_audio_windows(filepath: str, wait: bool = True):
    """Plays a WAV file windowlessly on Windows using MCI interface."""
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
# Startup Greeting Cues
# ─────────────────────────────────────────────────────────────────────────────
def play_startup_greeting():
    """Selects and plays a random cached startup greeting synchronously."""
    if os.path.exists(GREETINGS_DIR):
        files = [f for f in os.listdir(GREETINGS_DIR) if f.endswith(".wav")]
        if files:
            chosen = random.choice(files)
            filepath = os.path.join(GREETINGS_DIR, chosen)
            print("[Voice] Playing startup system check greeting...")
            play_audio_windows(filepath, wait=True)
            return
            
    print("[Voice] Note: No cached startup greetings found. Please run the generation script to create them.")

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
        return

    def run():
        try:
            import soundfile as sf
            import numpy as np
            wavs = chat_model.infer([text], show_tqdm=False)
            audio_data = np.squeeze(wavs[0])
            temp_file = "temp_karen_voice.wav"
            sf.write(temp_file, audio_data, 24000)
            
            play_audio_windows(temp_file, wait=True)
            if os.path.exists(temp_file):
                try:
                    os.remove(temp_file)
                except Exception:
                    pass
        except Exception as e:
            pass

    threading.Thread(target=run, daemon=True).start()
