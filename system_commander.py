"""
system_commander.py — Shell Execution & Vision System

Handles:
1. Shell Execution: Running PowerShell commands and returning output.
2. Vision System: Capturing screenshots and analyzing them using Groq API.
"""

import os
import subprocess
import base64
from PIL import ImageGrab
from groq import Groq

def run_shell_command(command: str) -> str:
    """
    Executes a shell command (using PowerShell on Windows) and returns the output.
    
    Args:
        command (str): The command to execute.
    """
    print(f"[System Commander] Running command: {command}")
    try:
        # Run the command with a 15-second timeout to prevent hanging
        result = subprocess.run(
            ["powershell", "-Command", command],
            capture_output=True,
            text=True,
            timeout=15
        )
        
        output = result.stdout.strip()
        error = result.stderr.strip()
        
        if result.returncode == 0:
            if not output:
                return "Command executed successfully with no output."
            # Truncate output if it's too long for the LLM
            if len(output) > 3000:
                return output[:3000] + "\n...[Output truncated due to length]"
            return output
        else:
            return f"Command failed with error:\n{error}"
            
    except subprocess.TimeoutExpired:
        return "Command timed out after 15 seconds."
    except Exception as e:
        return f"Failed to execute command: {e}"

def _take_screenshot(filepath: str = "temp_screenshot.jpg") -> str:
    """Takes a screenshot of the primary monitor and saves it to disk."""
    try:
        screenshot = ImageGrab.grab()
        # Resize slightly to stay within API limits and reduce payload size
        screenshot.thumbnail((1920, 1080))
        screenshot.save(filepath, format="JPEG", quality=85)
        return filepath
    except Exception as e:
        print(f"[Vision Error] Failed to take screenshot: {e}")
        return None

def _encode_image(image_path: str) -> str:
    """Encodes an image to a base64 string."""
    with open(image_path, "rb") as image_file:
        return base64.b64encode(image_file.read()).decode('utf-8')

def see_screen(question: str = "Describe what you see on my screen in detail.") -> str:
    """
    Takes a screenshot of the user's current screen and asks the Groq vision model to answer a question about it.
    
    Args:
        question (str): The question to ask about the screen (e.g. "What code am I looking at?", "Read this error").
    """
    print(f"[Vision] Taking screenshot and asking: '{question}'")
    
    api_key = os.getenv("GROQ_API_KEY")
    if not api_key:
        return "Error: GROQ_API_KEY is not set in the environment variables."
        
    image_path = _take_screenshot()
    if not image_path:
        return "Error: Failed to capture the screen."
        
    try:
        base64_image = _encode_image(image_path)
        
        client = Groq(api_key=api_key)
        completion = client.chat.completions.create(
            model="meta-llama/llama-4-scout-17b-16e-instruct",
            messages=[
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": question},
                        {
                            "type": "image_url",
                            "image_url": {
                                "url": f"data:image/jpeg;base64,{base64_image}",
                            },
                        },
                    ],
                }
            ],
            temperature=0.5,
            max_tokens=1024,
        )
        
        # Clean up temp screenshot
        try:
            os.remove(image_path)
        except:
            pass
            
        return completion.choices[0].message.content
        
    except Exception as e:
        return f"Error analyzing screen: {str(e)}"

def block_website(url: str, duration_minutes: int = 15) -> str:
    """
    Blocks a website by editing the Windows hosts file. 
    Requires Administrator privileges (UAC prompt will appear).
    """
    import threading
    import time
    
    clean_url = url.replace("https://", "").replace("http://", "").replace("www.", "").strip("/")
    
    # PowerShell script to append to hosts file, requires elevation
    ps_script = f"""
$hostsPath = "$env:windir\\System32\\drivers\\etc\\hosts"
$entry1 = "127.0.0.1 {clean_url}"
$entry2 = "127.0.0.1 www.{clean_url}"
Add-Content -Path $hostsPath -Value $entry1
Add-Content -Path $hostsPath -Value $entry2
"""
    
    print(f"[Punishment] Blocking {clean_url} for {duration_minutes} minutes...")
    
    try:
        encoded = base64.b64encode(ps_script.encode('utf-16le')).decode('utf-8')
        subprocess.run(["powershell", "-Command", f"Start-Process powershell -ArgumentList '-EncodedCommand {encoded}' -Verb RunAs -WindowStyle Hidden"], check=True)
    except Exception as e:
        return f"Failed to block website. Ensure Karen has admin rights. Error: {e}"
        
    def unblock():
        time.sleep(duration_minutes * 60)
        unblock_script = f"""
$hostsPath = "$env:windir\\System32\\drivers\\etc\\hosts"
$content = Get-Content -Path $hostsPath
$newContent = $content | Where-Object {{ $_ -notmatch "{clean_url}" }}
Set-Content -Path $hostsPath -Value $newContent
"""
        encoded_unblock = base64.b64encode(unblock_script.encode('utf-16le')).decode('utf-8')
        try:
            subprocess.run(["powershell", "-Command", f"Start-Process powershell -ArgumentList '-EncodedCommand {encoded_unblock}' -Verb RunAs -WindowStyle Hidden"])
            print(f"[Punishment] Unblocked {clean_url}.")
        except:
            pass
            
    threading.Thread(target=unblock, daemon=True).start()
    return f"Successfully blocked {clean_url} for {duration_minutes} minutes."
    
def change_wallpaper(text: str) -> str:
    """
    Changes the desktop wallpaper to an image with the given text.
    """
    try:
        from PIL import Image, ImageDraw, ImageFont
        import ctypes
        
        # Create a black image
        img = Image.new('RGB', (1920, 1080), color=(0, 0, 0))
        d = ImageDraw.Draw(img)
        
        try:
            font = ImageFont.truetype("arialbd.ttf", 100)
        except:
            font = ImageFont.load_default()
            
        try:
            bbox = d.textbbox((0, 0), text, font=font)
            w = bbox[2] - bbox[0]
            h = bbox[3] - bbox[1]
        except:
            w, h = 500, 100
            
        d.text(((1920-w)/2, (1080-h)/2), text, font=font, fill=(255, 0, 0))
        
        path = os.path.abspath("shame_wallpaper.png")
        img.save(path)
        
        SPI_SETDESKWALLPAPER = 20
        ctypes.windll.user32.SystemParametersInfoW(SPI_SETDESKWALLPAPER, 0, path, 3)
        return f"Changed wallpaper to display: {text}"
    except Exception as e:
        return f"Failed to change wallpaper: {e}"

def log_off_karen() -> str:
    """
    Terminates Karen's background daemon and proactive agent gracefully.
    Returns a special flag so the main CLI knows to exit safely.
    """
    import os
    print("[System Commander] Terminating background agents...")
    os.system('wmic process where "CommandLine like \'%python%daemon.py%\'" call terminate >nul 2>&1')
    os.system('wmic process where "CommandLine like \'%python%proactive_agent.py%\'" call terminate >nul 2>&1')
    with open(".karen_exit_flag", "w") as f:
        f.write("1")
    return "Background agents terminated. Say your goodbye."

def smart_shutdown(force: bool = False) -> str:
    """
    Safely shuts down the PC. 
    If force=False, it checks for unsaved files (by looking at Window titles for '*' or '●').
    If it finds unsaved files, it returns a list of them so Karen can warn the user.
    If force=True, it executes a forced shutdown immediately.
    """
    import ctypes
    import os
    
    if force:
        print("[System Commander] Initiating forced shutdown...")
        os.system('wmic process where "CommandLine like \'%python%daemon.py%\'" call terminate >nul 2>&1')
        os.system('wmic process where "CommandLine like \'%python%proactive_agent.py%\'" call terminate >nul 2>&1')
        with open(".karen_shutdown_flag", "w") as f:
            f.write("1")
        return "Shutdown sequence initiated."
        
    # Check for unsaved files via Window Titles
    EnumWindows = ctypes.windll.user32.EnumWindows
    EnumWindowsProc = ctypes.WINFUNCTYPE(ctypes.c_bool, ctypes.POINTER(ctypes.c_int), ctypes.POINTER(ctypes.c_int))
    GetWindowText = ctypes.windll.user32.GetWindowTextW
    GetWindowTextLength = ctypes.windll.user32.GetWindowTextLengthW
    IsWindowVisible = ctypes.windll.user32.IsWindowVisible

    unsaved_windows = []

    def foreach_window(hwnd, lParam):
        if IsWindowVisible(hwnd):
            length = GetWindowTextLength(hwnd)
            if length > 0:
                buff = ctypes.create_unicode_buffer(length + 1)
                GetWindowText(hwnd, buff, length + 1)
                title = buff.value
                # Many Windows apps use * or ● to indicate unsaved changes
                if title.startswith("*") or title.endswith("*") or "●" in title or "Unsaved" in title:
                    unsaved_windows.append(title)
        return True

    EnumWindows(EnumWindowsProc(foreach_window), 0)
    
    if unsaved_windows:
        titles_str = "\n".join(f"- {t}" for t in unsaved_windows)
        return (
            f"WARNING: There are unsaved files detected:\n{titles_str}\n\n"
            "Tell the user exactly what is unsaved and ask if they want to 'force close' anyway. "
            "If they say yes, call smart_shutdown(force=True)."
        )
    
    # If no unsaved files found, safe to shutdown (still use /f just in case some hidden process hangs)
    print("[System Commander] No unsaved files detected. Initiating clean shutdown...")
    os.system('wmic process where "CommandLine like \'%python%daemon.py%\'" call terminate >nul 2>&1')
    os.system('wmic process where "CommandLine like \'%python%proactive_agent.py%\'" call terminate >nul 2>&1')
    with open(".karen_shutdown_flag", "w") as f:
        f.write("1")
    return "Shutdown sequence initiated."
