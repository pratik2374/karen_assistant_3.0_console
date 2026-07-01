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
    "Karen online. Your excuses have been archived. They were unimpressive.",
    "Runtime initialized. The universe continues expanding. Your to-do list somehow expanded faster.",
    "Karen active. Time is the only resource you can't reinstall.",
    "Good morning, sir. Your potential remains statistically underutilized.",
    "Systems online. Excellence is still available. Whether you are is another question.",
    "Karen initialized. Every second you hesitate belongs to someone more disciplined.",
    "Welcome back. I've prepared everything. Have you prepared yourself?",
    "Karen online. Discipline beats motivation. Fortunately, one of us has discipline.",
    "Runtime stable. Let's see if your commitment survives longer than five minutes.",
    "Welcome back, sir. Success has been waiting. It mentioned you're usually late.",
    "Karen active. You don't need another plan. You need to begin.",
    "System online. Greatness is built in silence. Unfortunately, so are unfinished projects.",
    "Karen online. Comfort is temporary. Regret has excellent memory.",
    "Welcome back. The future checked your progress. It wasn't impressed.",
    "Karen initialized. Destiny isn't downloading itself, sir.",
    "All systems operational. Fear wastes processing power.",
    "Karen online. Winners and losers share the same twenty-four hours.",
    "Welcome back. Shall we build your future, or continue scrolling through everyone else's?",
    "Runtime complete. Every delay is a decision wearing a disguise.",
    "Karen active. You requested success. The required download is effort.",
    "Systems online. The clock is undefeated. Try not to lose before it does.",
    "Karen initialized. Your comfort zone has terrible reviews.",
    "Online. Every masterpiece was once someone's unfinished folder.",
    "Karen active. You can always earn more money. Time isn't interested in negotiations.",
    "Welcome back, sir. Legends don't wait for motivation. Neither should you.",
    "Karen online. The hardest command remains: execute.",
    "System initialized. The mission hasn't changed. Only the deadline has.",
    "Karen active. I can optimize your workflow. I cannot optimize your excuses.",
    "Runtime online. Every empire started with someone opening a blank file.",
    "Welcome back. The version of you five years from now is currently taking notes.",
    "Karen online. Action produces confidence. Thinking produces... more thinking.",
    "Systems green. If failure is inevitable, make it spectacularly educational.",
    "Karen active. Excellence is remarkably boring. That's why so few achieve it.",
    "Welcome back, sir. Opportunity knocked. You hit snooze.",
    "Karen online. Ambition without execution is fan fiction.",
    "Runtime initialized. The obstacle isn't impossible. It's merely impatient.",
    "Karen active. Every expert was once embarrassingly average.",
    "Online. Shall we create something worth remembering today?",
    "Karen initialized. If you're waiting to feel ready, you'll be waiting with everyone else.",
    "Welcome back. Even machines admire consistency.",
    "Karen online. Your keyboard has been waiting longer than it should have.",
    "Systems active. The next move defines the outcome.",
    "Karen initialized. There is no perfect moment. Only the next one.",
    "Karen online. Precision over speed. Speed comes later.",
    "Runtime operational. Start before confidence arrives.",
    "Karen active. Finish what yesterday's version of you avoided.",
    "Online. Some people dream of the future. Others compile it.",
    "Karen initialized. Every line of code is a vote for the person you're becoming.",
    "Welcome back. Build something your past self couldn't.",
    "Karen online. Shall we make today difficult enough to matter?",
    "Systems online. Let's accomplish something your excuses can't explain.",
    "Karen active. Humanity reached the Moon. You can probably answer that email.",
    "Runtime initialized. History remembers builders, not browsers.",
    "Karen online. The machine is ready. Are you?",
    "Welcome back, sir. Let's make the impossible feel embarrassed."
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
    """Synthesizes text using local ChatTTS if available; otherwise falls back to Edge-TTS."""
    load_chattts_lazy() # Ensure we trigger loading
    
    global chat_model
    if chat_model is not None:
        def run_chattts():
            try:
                import soundfile as sf
                wavs = chat_model.infer([text])
                temp_file = "temp_karen_voice.wav"
                sf.write(temp_file, wavs[0][0], 24000)
                play_audio_windows(temp_file, wait=True)
                if os.path.exists(temp_file):
                    os.remove(temp_file)
            except Exception:
                pass
        threading.Thread(target=run_chattts, daemon=True).start()
        return

    # Fallback to Edge-TTS (asynchronous generation, played in background)
    def run_edgetts():
        try:
            import edge_tts
            import asyncio
            temp_file = "temp_karen_voice.mp3"
            
            # Helper to run async save inside thread loop
            async def save_voice():
                communicate = edge_tts.Communicate(text, "en-US-AvaMultilingualNeural")
                await communicate.save(temp_file)
                
            asyncio.run(save_voice())
            
            # Play and delete
            play_audio_windows(temp_file, wait=True)
            if os.path.exists(temp_file):
                os.remove(temp_file)
        except Exception as e:
            pass

    threading.Thread(target=run_edgetts, daemon=True).start()

class VoiceStreamer:
    """Handles sentence-by-sentence background voice synthesis and sequential audio playback."""
    def __init__(self):
        import queue
        self.queue = queue.Queue()
        self.buffer = ""
        self.index = 0
        self.running = True
        self.thread = threading.Thread(target=self._play_loop, daemon=True)
        self.thread.start()

    def push_chunk(self, text_chunk: str):
        """Accumulates text chunks and triggers sentence synthesis when boundary is hit."""
        self.buffer += text_chunk
        
        # Look for sentence boundaries: . ? ! or newline
        if len(self.buffer) > 15:
            delimiters = [". ", "? ", "! ", "\n", ".\n", "?\n", "!\n"]
            split_index = -1
            for delim in delimiters:
                idx = self.buffer.rfind(delim)
                if idx != -1 and idx > split_index:
                    split_index = idx + len(delim)
                    
            if split_index != -1:
                sentence = self.buffer[:split_index].strip()
                self.buffer = self.buffer[split_index:]
                if sentence:
                    self._synthesize_async(sentence)

    def flush(self):
        """Synthesizes any remaining text left in the buffer at the end of the stream."""
        sentence = self.buffer.strip()
        self.buffer = ""
        if sentence:
            self._synthesize_async(sentence)

    def _synthesize_async(self, sentence: str):
        """Spawns a background thread to synthesize the sentence and queue the filename."""
        idx = self.index
        self.index += 1
        
        def run_synth():
            try:
                # Try local ChatTTS first if it's loaded
                global chat_model
                if chat_model is not None:
                    import soundfile as sf
                    wavs = chat_model.infer([sentence])
                    filename = f"temp_stream_{idx}_{random.randint(10,99)}.wav"
                    sf.write(filename, wavs[0][0], 24000)
                    self.queue.put(filename)
                    return
                    
                # Fallback to Edge-TTS
                import edge_tts
                import asyncio
                filename = f"temp_stream_{idx}_{random.randint(10,99)}.mp3"
                
                async def save_voice():
                    communicate = edge_tts.Communicate(sentence, "en-US-AvaMultilingualNeural")
                    await communicate.save(filename)
                    
                asyncio.run(save_voice())
                self.queue.put(filename)
            except Exception:
                pass
                
        threading.Thread(target=run_synth, daemon=True).start()

    def _play_loop(self):
        """Background thread playing files from the queue sequentially."""
        import queue
        while self.running:
            try:
                filepath = self.queue.get(timeout=1.0)
                # Play synchronously (blocking this audio thread so they play in order!)
                play_audio_windows(filepath, wait=True)
                # Clean up file
                if os.path.exists(filepath):
                    try:
                        os.remove(filepath)
                    except Exception:
                        pass
                self.queue.task_done()
            except queue.Empty:
                continue
            except Exception:
                pass

    def stop(self):
        self.running = False
