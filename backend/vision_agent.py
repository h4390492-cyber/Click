"""
NvidiaVisionAutomation - Command Pilot Vision Agent v4.0
Anti-Hallucination Edition

Builds on v3.0 (all bug fixes retained). New in v4.0:

  [H1] Own-UI masking  — agent's command overlay rectangle is blacked out in
       every screenshot before sending to the model.  The model never sees
       the "Enter command sequence…" bar and can't confuse it with the target
       app's input field.

  [H2] Contact / target name guard  — before any type-or-send action the agent
       reads the on-screen chat header with OCR and computes string similarity
       against the intended name.  "Harshit" is rejected when the goal says
       "Harsh" because similarity < threshold (tunable).

  [H3] Two-phase critical-action verification  — after clicking a contact /
       button the agent re-captures the screen, OCR-reads the active region,
       and only proceeds when the verified name matches the intent.

  [H4] Confidence gating  — model must return "confidence": 0-100 in its JSON.
       Actions below 65 are skipped and a forced verify step is injected.

  [H5] Input-field disambiguation in system prompt  — the exclusion-zone
       bounding box (in 0-1000 coords) is injected every step so the model
       knows exactly which region to never touch.

  [H6] Exact-match name normalisation  — strips punctuation, diacritics, and
       casing before comparison so "Harsh " ≠ "Harshit".

  [H7] Critical-action guard list  — user can declare action keywords that must
       pass name verification before executing (send, submit, post, delete…).
"""

import os
import re
import sys
import json
import base64
import hashlib
import platform
import subprocess
import time
import ctypes
import threading
import queue
import unicodedata
from difflib import SequenceMatcher
from io import BytesIO
from typing import Optional, Any

import pyautogui
import requests


# ─────────────────────────────────────────────────────────────────────────────
# String helpers
# ─────────────────────────────────────────────────────────────────────────────

def _strip_contact_suffixes(s: str) -> str:
    """
    Removes common WhatsApp / chat contact display suffixes and emojis
    before name comparison.

    Examples:
      "🔥Harsh🔥 (You)"    → "Harsh"
      "Priya (me)"          → "Priya"
      "Rohit 🎉"            → "Rohit"
      "Harshit"             → "Harshit"   (unchanged)
    """
    # 1. Strip known parenthetical labels that WhatsApp appends to your own contact
    s = re.sub(r'\s*\((?:You|you|me|Me|self|Self|myself|Myself)\)\s*', ' ', s)

    # 2. Remove all emoji / unicode symbols (categories So, Sm, Sk, Cs, Co, Cn)
    #    Keep only letters, digits, spaces, hyphens, apostrophes
    cleaned = []
    for ch in s:
        cat = unicodedata.category(ch)
        # Allow letters (L*), numbers (N*), spaces, hyphens, apostrophes
        if cat.startswith(("L", "N")) or ch in (" ", "-", "'"):
            cleaned.append(ch)
    s = "".join(cleaned)

    return s.strip()


def _normalise_name(s: str) -> str:
    """
    Full normalisation pipeline:
      emoji strip → suffix strip → diacritic strip → lowercase → collapse whitespace

    Used for contact-name comparison so 'Harshit' ≠ 'Harsh'
    but '🔥Harsh🔥 (You)' == 'Harsh'.
    """
    s = _strip_contact_suffixes(s)
    # Strip diacritics (é → e, ñ → n, etc.)
    s = unicodedata.normalize("NFD", s)
    s = "".join(c for c in s if unicodedata.category(c) != "Mn")
    s = s.lower().strip()
    s = re.sub(r"[^a-z0-9 '\-]", "", s)
    s = re.sub(r"\s+", " ", s)
    return s


def _name_similarity(a: str, b: str) -> float:
    """Sequence similarity of two normalised names (0.0–1.0)."""
    return SequenceMatcher(None, _normalise_name(a), _normalise_name(b)).ratio()


def _exact_name_match(target: str, found: str) -> bool:
    """
    Returns True when `found` (after normalisation + suffix stripping) matches
    `target` exactly OR `found` is the target name with benign extra words
    (e.g. a last name) but is NOT a different person whose name merely starts
    with the target letters.

    Key rules:
    - "Harsh"   == "🔥Harsh🔥 (You)"   → True   (same person, our own contact)
    - "Harsh"   == "Harshit"            → False  (longer — different person)
    - "Harshit" == "Harsh"              → False  (shorter — different person)
    - "Harsh"   == "Harsh Kumar"        → True   (last name appended — same person)
    - "Priya"   == "Priya S"            → True   (initial appended)
    - "Priya S" == "Priya"              → False  (target is more specific)
    """
    t = _normalise_name(target)
    f = _normalise_name(found)

    if not t or not f:
        return False

    # Exact match
    if t == f:
        return True

    t_words = t.split()
    f_words = f.split()

    # First-word must always match exactly (primary name must be right)
    if t_words[0] != f_words[0]:
        return False

    # Target has more words than found → target is more specific, reject
    # e.g. target="Harshit Kumar", found="Harshit" → reject (we need full name)
    if len(t_words) > len(f_words):
        return False

    # Found has more words than target → only allow benign extras (last name / initial)
    # Reject if the extra word looks like a continuation of the first name
    # (i.e. found starts with target's first word as a PREFIX of a longer word)
    # Example: target="Harsh", found="Harshit" — first word mismatch already caught above.
    # Example: target="Harsh", found="Harsh Kumar" — first words match → allow.
    return True


# ─────────────────────────────────────────────────────────────────────────────
# Coordinate helper
# ─────────────────────────────────────────────────────────────────────────────

def _to_screen_coords(x, y, screen_w: int, screen_h: int) -> tuple[int, int]:
    # Ensure we use logical coordinates for calculations but scale for drawing
    sw, sh = pyautogui.size()
    try:
        if isinstance(x, str):
            x = float(x.replace(",", ""))
        if isinstance(y, str):
            y = float(y.replace(",", ""))
        if 0.0 <= float(x) <= 1.0 and 0.0 <= float(y) <= 1.0:
            x, y = float(x) * 1000, float(y) * 1000
        px = int((float(x) / 1000.0) * screen_w)
        py = int((float(y) / 1000.0) * screen_h)
        # Allow 0,0 but let the grounding guard handle warnings
        return max(0, min(px, screen_w - 2)), max(0, min(py, screen_h - 2))
    except Exception as exc:
        print(f"⚠️  Coord error ({x},{y}): {exc}")
        return screen_w // 2, screen_h // 2


# ─────────────────────────────────────────────────────────────────────────────
# JSON extraction (brace-depth counter — handles nested braces correctly)
# ─────────────────────────────────────────────────────────────────────────────

def _extract_json_object(text: str) -> str:
    text = re.sub(r"```(?:json)?\s*", "", text).strip()
    start = text.find("{")
    if start == -1:
        raise ValueError("No JSON object found")
    depth, in_str, esc = 0, False, False
    for i, ch in enumerate(text[start:], start):
        if esc:
            esc = False; continue
        if ch == "\\" and in_str:
            esc = True; continue
        if ch == '"':
            in_str = not in_str; continue
        if in_str:
            continue
        if ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                return text[start: i + 1]
    raise ValueError("Unterminated JSON")


# ─────────────────────────────────────────────────────────────────────────────
# Screen-hash stall detection
# ─────────────────────────────────────────────────────────────────────────────

def _screen_hash(img) -> str:
    from PIL import Image
    w, h = img.size
    crop = img.crop((w // 4, h // 4, 3 * w // 4, 3 * h // 4))
    crop = crop.resize((64, 64), Image.BILINEAR).convert("L")
    return hashlib.md5(crop.tobytes()).hexdigest()


# ─────────────────────────────────────────────────────────────────────────────
# OCR helper (optional — requires pytesseract + Tesseract binary)
# ─────────────────────────────────────────────────────────────────────────────

def _ocr_region(img, box: tuple[int, int, int, int]) -> str:
    """
    Run OCR on a crop of `img` defined by (x1, y1, x2, y2) in pixels.
    Returns empty string if pytesseract is not installed.
    """
    try:
        import pytesseract                          # noqa: PLC0415
        from PIL import Image                       # noqa: PLC0415
        crop = img.crop(box)
        # Upscale for better OCR accuracy on small regions
        w, h = crop.size
        crop = crop.resize((w * 3, h * 3), Image.LANCZOS)
        text = pytesseract.image_to_string(
            crop,
            config="--psm 7 -c tessedit_char_whitelist="
                   "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789 .-_",
        )
        return text.strip()
    except ImportError:
        return ""          # pytesseract not installed — caller uses fallback
    except Exception as exc:
        print(f"⚠️  OCR error: {exc}")
        return ""


# ─────────────────────────────────────────────────────────────────────────────
# App launcher
# ─────────────────────────────────────────────────────────────────────────────

_APP_LAUNCH_MAP = {
    "whatsapp": {"Windows": ["WhatsApp"],        "Darwin": ["open", "-a", "WhatsApp"],           "Linux": ["whatsapp-desktop"]},
    "chrome":   {"Windows": ["chrome"],           "Darwin": ["open", "-a", "Google Chrome"],      "Linux": ["google-chrome"]},
    "notepad":  {"Windows": ["notepad.exe"],      "Darwin": ["open", "-a", "TextEdit"],           "Linux": ["gedit"]},
    "spotify":  {"Windows": ["Spotify"],          "Darwin": ["open", "-a", "Spotify"],            "Linux": ["spotify"]},
    "terminal": {"Windows": ["wt.exe"],           "Darwin": ["open", "-a", "Terminal"],           "Linux": ["x-terminal-emulator"]},
    "vscode":   {"Windows": ["code"],             "Darwin": ["open", "-a", "Visual Studio Code"], "Linux": ["code"]},
    "explorer": {"Windows": ["explorer.exe"],     "Darwin": ["open", "."],                        "Linux": ["nautilus"]},
    "instagram":{"Windows": ["instagram"],        "Darwin": ["open", "-a", "Instagram"],          "Linux": ["instagram"]},
}

def _launch_app(keyword: str) -> Optional[str]:
    os_name = platform.system()
    entry = _APP_LAUNCH_MAP.get(keyword)
    if not entry:
        return None
    cmd = entry.get(os_name) or entry.get("Linux")
    try:
        subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        time.sleep(2.5)
        return keyword.title()
    except FileNotFoundError:
        print(f"⚠️  App '{keyword}' not found on {os_name}")
        return None
    except Exception as exc:
        print(f"⚠️  Launch failed: {exc}")
        return None


# ─────────────────────────────────────────────────────────────────────────────
# Active window helper — cross-platform
# ─────────────────────────────────────────────────────────────────────────────

def _get_active_window() -> str:
    os_name = platform.system()
    if os_name == "Windows":
        try:
            import pygetwindow as gw                # noqa: PLC0415
            win = gw.getActiveWindow()
            if win and win.title:
                return win.title
        except Exception:
            pass
        try:
            import ctypes                           # noqa: PLC0415
            hwnd = ctypes.windll.user32.GetForegroundWindow()
            if hwnd:
                length = ctypes.windll.user32.GetWindowTextLengthW(hwnd)
                buf = ctypes.create_unicode_buffer(length + 1)
                ctypes.windll.user32.GetWindowTextW(hwnd, buf, length + 1)
                return buf.value or "Desktop"
        except Exception as exc:
            print(f"⚠️  Window title error: {exc}")
    elif os_name == "Darwin":
        try:
            script = ('tell application "System Events" to get name of '
                      'first process whose frontmost is true')
            r = subprocess.run(["osascript", "-e", script],
                               capture_output=True, text=True, timeout=3)
            if r.stdout.strip():
                return r.stdout.strip()
        except Exception as exc:
            print(f"⚠️  macOS window error: {exc}")
    else:
        try:
            win_id = subprocess.check_output(
                ["xdotool", "getactivewindow"], timeout=3).strip().decode()
            title = subprocess.check_output(
                ["xdotool", "getwindowname", win_id], timeout=3).strip().decode()
            if title:
                return title
        except FileNotFoundError:
            print("⚠️  xdotool not found — install with: sudo apt install xdotool")
        except Exception as exc:
            print(f"⚠️  Linux window error: {exc}")
    return "Unknown"



# ─────────────────────────────────────────────────────────────────────────────
# Voice Interrupt System — passive queue (NO separate mic thread!)
# ─────────────────────────────────────────────────────────────────────────────
#
# ARCHITECTURE:
#   jarvis_logic.listen_loop  ──(already has mic)──►  transcribes speech
#       │
#       ▼ if nvidia_vision._task_active:
#       │   check for wake word "hero"
#       │     ├─ has "hero" + message  → nvidia_vision.inject_voice_interrupt(msg)
#       │     ├─ has "hero" only       → ignore (wait for next phrase)
#       │     └─ no "hero"             → IGNORE (don't route as new command!)
#       │
#   analyze_and_act loop  ◄── checks _interrupt_queue each step
#       │
#       ▼ _process_voice_interrupt() → AI response → TTS
#
# NO separate mic thread. NO audio conflicts. NO crashes.
# ─────────────────────────────────────────────────────────────────────────────

# Unified Wake Words (Broadened for Hinglish accuracy)
_WAKE_WORDS = [
    "hero", "hiro", "heero", "hiiro", "hiero", "hero bro", "hey hero", "hey hiro",
    "hello hero", "hello hiro", "hero ji", "hero bhai", "hiro bhai", "ok hero",
    "hey hero", "hi hero", "hira", "hara", "herow", "heeroo", "heroine", "yero"
]

# Transcription hallucination phrases to ignore
_HALLUCINATION_PHRASES = [
    "subtitles by", "amara.org", "thank you", "copyright", "mbc",
    "subs by", "confer", "unseen", "o sen", "9434",
    "कर दो कर दो", "प्रभाव करते",
    "transcribe phonetically", "subtitle sent",
]


def _is_hallucination(text: str) -> bool:
    """Check if transcribed text is a Whisper hallucination or noise."""
    if not text:
        return True
    t = text.lower().strip()
    # Too short (1-2 chars are noise)
    if len(t) < 3:
        return True
    # Known hallucination patterns
    for h in _HALLUCINATION_PHRASES:
        if h in t:
            return True
    # Repeated words pattern (e.g. "कर दो कर दो कर दो कर दो")
    words = t.split()
    if len(words) >= 4:
        unique = set(words)
        if len(unique) <= 2:
            return True
    return False


def _extract_wake_message(text: str) -> tuple[bool, str]:
    """
    Check if text contains a wake word or something similar to "hero".
    Returns (has_wake_word, message_after_wake_word).
    """
    text_lower = text.lower().strip()
    if not text_lower: return False, ""
    
    # 1. Direct match check (Best performance)
    for wake in _WAKE_WORDS:
        if wake in text_lower:
            idx = text_lower.find(wake)
            msg = text[idx + len(wake):].strip().lstrip(",.!? ")
            return True, msg
    
    # 2. Fuzzy match check for "hero" using words
    words = text_lower.split()
    for i, w in enumerate(words):
        # Broadening "hero" search
        if w in ["hero", "hiro", "heero", "hiiro", "heelo", "hey", "her", "hero", "hi"]:
             msg = " ".join(words[i+1:]).strip()
             return True, msg
             
    # 3. Handle prompt/request format like "Amazon se..." (If you want)
    # But usually we stick to the hero wake word
    
    return False, ""


def _speak_tts_sarvam(text: str, jarvis: Optional[Any] = None) -> None:
    """
    Speaks text aloud. If jarvis instance is provided, uses its thread-safe
    speak method. Otherwise falls back to internal implementation.
    """
    if not text or not text.strip():
        return
    
    if jarvis and hasattr(jarvis, "speak"):
        jarvis.speak(text)
        return

    try:
        import api_keys as ak
        sarvam_key = getattr(ak, "SARVAM_API_KEY", "") or getattr(ak, "SARVAM_API_KEY_1", "")
        if not sarvam_key:
            print(f"🔇 [No TTS key] {text}")
            return

        payload = {
            "text": text,
            "target_language_code": "hi-IN",
            "speaker": "shubh",
            "model": "bulbul:v3",
            "pace": 1.0,
            "speech_sample_rate": 22050,
            "enable_preprocessing": True,
        }
        resp = requests.post(
            "https://api.sarvam.ai/text-to-speech",
            headers={
                "api-subscription-key": sarvam_key,
                "Content-Type": "application/json",
            },
            json=payload,
            timeout=15,
        )
        if resp.status_code == 200:
            data = resp.json()
            if "audios" in data and data["audios"]:
                import tempfile
                audio_bytes = base64.b64decode(data["audios"][0])
                tmp_file = os.path.join(
                    tempfile.gettempdir(), f"hero_tts_{int(time.time())}.wav"
                )
                with open(tmp_file, "wb") as f:
                    f.write(audio_bytes)

                # Play using pygame if available, else winsound
                try:
                    import pygame
                    if not pygame.mixer.get_init():
                        pygame.mixer.init()
                    pygame.mixer.music.load(tmp_file)
                    pygame.mixer.music.play()
                    while pygame.mixer.music.get_busy():
                        time.sleep(0.05)
                    pygame.mixer.music.unload()
                except ImportError:
                    if platform.system() == "Windows":
                        import winsound
                        winsound.PlaySound(tmp_file, winsound.SND_FILENAME)

                try:
                    os.remove(tmp_file)
                except Exception:
                    pass
        else:
            print(f"⚠️  Sarvam TTS error {resp.status_code}")
            print(f"🔇 [TTS failed] {text}")
    except Exception as exc:
        print(f"⚠️  TTS error: {exc}")
        print(f"🔇 [TTS failed] {text}")


# ─────────────────────────────────────────────────────────────────────────────
# Main Agent
# ─────────────────────────────────────────────────────────────────────────────

class NvidiaVisionAutomation:
    """
    Command Pilot Vision Agent v4.0 — Anti-Hallucination Edition.

    New guards vs v3.0:
    ┌─────────────────────────────────────────────────────────┐
    │  H1  Own-UI masking     — command bar blacked out        │
    │  H2  Name guard         — exact match before send        │
    │  H3  Two-phase verify   — click → OCR → confirm → type   │
    │  H4  Confidence gating  — skip actions below 65%         │
    │  H5  Exclusion zone     — injected into every prompt     │
    │  H6  Name normalisation — strips prefix collisions       │
    │  H7  Critical-action list — configurable danger actions  │
    └─────────────────────────────────────────────────────────┘
    """

    # Actions that require name-verification before executing
    CRITICAL_KEYWORDS = {"send", "submit", "post", "delete", "purchase", "confirm", "reply"}

    def __init__(self, jarvis: Optional[Any] = None):
        self.jarvis = jarvis
        self.nvidia_api_key: Optional[str] = None
        self.google_api_key: Optional[str] = None
        self._load_api_keys()

        self.screen_w, self.screen_h = pyautogui.size()

        # [H1] Exclusion zone
        self._exclusion_zones: list[tuple[int, int, int, int]] = []

        # Connection pool
        self.session = requests.Session()

        self.action_delays: dict[str, float] = {
            "click": 0.4, "double_click": 0.4, "right_click": 0.4,
            "type": 0.15, "key": 0.2, "hotkey": 0.2,
            "scroll": 0.3, "wait": 0.0,
        }

        # Extracted intent for the current mission
        self._target_contact: Optional[str] = None
        self._target_message: Optional[str] = None

        # ── Voice Interrupt System (passive queue — NO separate mic) ──────
        self._task_active: bool = False           # True while analyze_and_act is running
        self._interrupt_queue: queue.Queue = queue.Queue()   # jarvis_logic feeds into this
        self._asking_user: bool = False           # True when agent asked a question
        self._reply_queue: queue.Queue = queue.Queue()       # user replies go here
        self._voice_context: list[dict] = []      # conversation history for interrupts
        self._user_addendums: list[str] = []      # extra instructions from mid-task voice

        # ── Advanced Config (Settable via HeroAssistant) ──────────────────
        self.inter_step_delay: float = 2.0        # Seconds between AI steps
        self.max_steps: int = 15                  # Max steps per task
        
        print("👁️  Command Pilot v4.0 ONLINE  |  Anti-Hallucination: ACTIVE")

    @property
    def model(self) -> str:
        """
        Dynamically read the model setting to allow seamless switching.
        """
        settings_path = os.path.join(os.path.dirname(__file__), "models_setting.json")
        try:
            if os.path.exists(settings_path):
                with open(settings_path, "r", encoding="utf-8") as f:
                    settings = json.load(f)
                    model_val = settings.get("vision_agent_nvidia")
                    if model_val:
                        return model_val
        except Exception as e:
            print(f"⚠️  Error reading model setting: {e}")
        return "meta/muse-glimmer-30b"

    # ── API keys ──────────────────────────────────────────────────────────────

    def _load_api_keys(self) -> None:
        self.nvidia_api_key = os.environ.get("NVIDIA_API_KEY", "").strip().strip("'\"")
        self.google_api_key = os.environ.get("GOOGLE_API_KEY", "").strip().strip("'\"")
        
        try:
            import api_keys as ak          # noqa: PLC0415
            if not self.nvidia_api_key:
                self.nvidia_api_key = getattr(ak, "NVIDIA_API_KEY", "").strip().strip("'\"")
            if not self.google_api_key:
                self.google_api_key = getattr(ak, "GOOGLE_API_KEY", "").strip().strip("'\"")
        except ImportError:
            pass

        if not self.nvidia_api_key:
            print("❌ NVIDIA_API_KEY not set!")

    def _post_to_model(self, dummy_url: str, json: dict, timeout: int = 60) -> requests.Response:
        """Dynamically routes request to Google AI Studio or NVIDIA API."""
        current_model = self.model
        payload = json

        if "gemini" in current_model.lower() or "gemma" in current_model.lower():
            # Use Google AI Studio Endpoint
            m_name = current_model.split("/")[-1] if "/" in current_model else current_model
            payload["model"] = m_name
            
            # Remove "system" role for Google API
            if "messages" in payload:
                new_msgs = []
                system_text = ""
                for m in payload["messages"]:
                    if m.get("role") == "system":
                        system_text += m.get("content", "") + "\n\n"
                    else:
                        new_msgs.append(m)
                
                # Merge into the first user message
                if system_text and new_msgs and new_msgs[0].get("role") == "user":
                    u_content = new_msgs[0]["content"]
                    if isinstance(u_content, str):
                        new_msgs[0]["content"] = system_text + u_content
                    elif isinstance(u_content, list):
                        new_msgs[0]["content"].insert(0, {"type": "text", "text": system_text})
                
                payload["messages"] = new_msgs
                
            url = "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions"
            headers = {
                "Authorization": f"Bearer {self.google_api_key}",
                "Content-Type": "application/json"
            }
        else:
            # Use NVIDIA API
            payload["model"] = current_model
            url = "https://integrate.api.nvidia.com/v1/chat/completions"
            headers = {
                "Authorization": f"Bearer {self.nvidia_api_key}",
                "Content-Type": "application/json"
            }
            
        return self.session.post(url, headers=headers, json=payload, timeout=timeout)

    # ── [H1] Exclusion zone registration ─────────────────────────────────────

    # Maximum fraction of screen a single exclusion zone may cover.
    # Anything larger than this is the MAIN app window — not the overlay bar.
    _MAX_ZONE_COVERAGE = 0.20   # 20 % of screen area

    def set_exclusion_zone(self, x: int, y: int, w: int, h: int) -> None:
        """
        Register a rectangle (in screen pixels) that will be blacked out in
        every screenshot before it is sent to the model.

        SAFETY: zones covering more than 20% of the screen are rejected —
        that is the app window, not the overlay bar.  Only small command-bar
        sized regions are accepted.

        Call this from your overlay UI on startup:
            agent.set_exclusion_zone(overlay_x, overlay_y, overlay_w, overlay_h)
        """
        screen_area = self.screen_w * self.screen_h
        zone_area   = w * h
        coverage    = zone_area / screen_area

        if coverage > self._MAX_ZONE_COVERAGE:
            print(f"⚠️  Exclusion zone ({x},{y},{w},{h}) covers {coverage:.0%} of screen — "
                  f"REJECTED (max {self._MAX_ZONE_COVERAGE:.0%}). "
                  "Only register the command-bar overlay, not the whole app window.")
            return

        zone = (x, y, x + w, y + h)
        if zone not in self._exclusion_zones:
            self._exclusion_zones.append(zone)
            print(f"🚫 Exclusion zone registered: {zone}  ({coverage:.1%} of screen)")

    def _auto_detect_exclusion_zone(self) -> None:
        """
        Finds the agent's own small overlay bar and registers it.

        KEY FIX: only registers windows that are SMALL (< 20% screen area).
        This prevents accidentally registering the main Hero/Command Pilot
        application window and blocking the entire screen.
        """
        try:
            import pygetwindow as gw                    # noqa: PLC0415
            # Keywords that identify the floating command-bar overlay
            known_titles = ["command pilot", "enter command", "ask hero",
                            "command sequence", "hero bar", "hero input"]
            screen_area = self.screen_w * self.screen_h

            for win in gw.getAllWindows():
                title_lower = (win.title or "").lower()
                if not any(t in title_lower for t in known_titles):
                    continue

                w = getattr(win, "width",  0)
                h = getattr(win, "height", 0)
                if w <= 0 or h <= 0:
                    continue

                coverage = (w * h) / screen_area
                if coverage > self._MAX_ZONE_COVERAGE:
                    # This is the MAIN window — skip it
                    print(f"ℹ️  Skipping large window '{win.title}' "
                          f"({coverage:.0%} of screen) — not a command bar overlay")
                    continue

                # Small overlay bar — safe to register
                self.set_exclusion_zone(win.left, win.top, w, h)

        except Exception:
            pass  # Non-critical

    # ── Screenshot with own-UI masking ───────────────────────────────────────

    def capture_screen(self, img_format: str = "WEBP"):
        """
        Captures screen → overlays SoM grid → blacks out exclusion zones →
        encodes to base64. Returns (b64_string, PIL_Image).
        The raw PIL image is returned for later OCR verification.
        """
        try:
            from PIL import Image, ImageDraw          # noqa: PLC0415

            screenshot = pyautogui.screenshot()
            sw, sh = screenshot.size
            draw = ImageDraw.Draw(screenshot)

            # SoM grid
            for i in range(1, 11): # 100 to 1000
                gx = int(sw * (i / 10))
                draw.line([(gx, 0), (gx, sh)], fill=(120, 120, 120, 60), width=1)
                # Move labels AWAY from the edges so model doesn't hallucinate them as website content
                draw.text((gx + 5, 50), f"x={i*100}", fill=(255, 255, 255), stroke_width=1, stroke_fill=(0, 0, 0))
                
                gy = int(sh * (i / 10))
                draw.line([(0, gy), (sw, gy)], fill=(120, 120, 120, 60), width=1)
                draw.text((50, gy + 5), f"y={i*100}", fill=(255, 255, 255), stroke_width=1, stroke_fill=(0, 0, 0))

            # Red mouse dot
            mx, my = pyautogui.position()
            draw.ellipse((mx - 6, my - 6, mx + 6, my + 6),
                         fill=(255, 0, 0), outline=(255, 255, 255))

            # [H1] Apply DPI scaling to exclusion zones before drawing
            lw, lh = pyautogui.size()
            scale_x, scale_y = sw / lw, sh / lh
            
            # [H1] Black out every registered exclusion zone (SOLID BLACK, NO TEXT)
            for (x1, y1, x2, y2) in self._exclusion_zones:
                draw.rectangle([
                    x1 * scale_x, y1 * scale_y, 
                    x2 * scale_x, y2 * scale_y
                ], fill=(0, 0, 0))

            # Optimize for speed: smaller resolution = less CPU/IO lag for STT thread
            target_w = 1024
            target_h = int(target_w * sh / sw)
            screenshot = screenshot.resize((target_w, target_h), Image.LANCZOS)
 
            raw_pil = screenshot.copy()
 
            buf = BytesIO()
            screenshot.save(buf, format=img_format, quality=75)
            b64 = base64.b64encode(buf.getvalue()).decode("utf-8")
            return b64, raw_pil

        except Exception as exc:
            print(f"❌ Capture error: {exc}")
            return None, None

    def capture_screen_clean(self, img_format: str = "JPEG") -> str | None:
        """
        Captures a CLEAN screenshot with NO grid overlay, NO labels, NO dots.
        Used when the model needs to find exact UI element positions — the grid
        distorts coordinate perception and causes click misses on small targets.
        Returns base64 string only (no PIL needed).
        """
        try:
            from PIL import Image                     # noqa: PLC0415
            screenshot = pyautogui.screenshot()
            sw, sh     = screenshot.size

            # Only black out exclusion zones — no grid, no labels, no dots
            if self._exclusion_zones:
                from PIL import ImageDraw             # noqa: PLC0415
                draw = ImageDraw.Draw(screenshot)
                for (x1, y1, x2, y2) in self._exclusion_zones:
                    draw.rectangle([x1, y1, x2, y2], fill=(0, 0, 0))

            # Optimize for speed
            target_w = 1024
            target_h = int(target_w * sh / sw)
            screenshot = screenshot.resize((target_w, target_h), Image.LANCZOS)
 
            buf = BytesIO()
            screenshot.save(buf, format=img_format, quality=75)
            return base64.b64encode(buf.getvalue()).decode("utf-8")

        except Exception as exc:
            print(f"❌ Clean capture error: {exc}")
            return None

    # ── [H2/H3] Contact name verification via OCR ────────────────────────────

    # ── Intent parsing ────────────────────────────────────────────────────────

    def _extract_intent_via_ai(self, command: str) -> dict:
        """
        Uses a fast AI call to extract structured intent from the command.
        Returns dict with keys: contact, message, app, action
        Falls back to empty dict on failure.

        This replaces all fragile regex — the model understands Hinglish naturally.
        """
        if not getattr(self, "nvidia_api_key", None) and "gemma" not in self.model.lower():
            return {}
        try:
            payload = {
                "model": self.model,
                "messages": [{
                    "role": "user",
                    "content": (
                        "Extract the structured intent from this command. "
                        "The command may be in English, Hindi, or Hinglish (mix). "
                        "Return ONLY a JSON object with these keys:\n"
                        '  "contact": the person\'s name to send message to (just the name, no postpositions like ko/pe/to)\n'
                        '  "message": the message text to send\n'
                        '  "app": the app name mentioned (whatsapp/instagram/etc)\n'
                        '  "action": what to do (send_message/open_app/search/etc)\n'
                        "If a field is not present, use null.\n"
                        "IMPORTANT: For contact, extract ONLY the person's name. "
                        "'harsh ko hello bhej' → contact='Harsh', message='hello'\n"
                        "'Pe harsh ko msg karo' — 'Pe' is a Hinglish word, NOT a name. contact='Harsh'\n"
                        "'send hello to Priya' → contact='Priya', message='hello'\n\n"
                        f"Command: {command}"
                    )
                }],
                "max_tokens": 200,
                "temperature": 0.0,
            }
            resp = self._post_to_model(
                dummy_url="https://integrate.api.nvidia.com/v1/chat/completions",
                json=payload, timeout=60,
            )
            if resp.status_code == 200:
                raw = resp.json()["choices"][0]["message"]["content"]
                extracted = json.loads(_extract_json_object(raw), strict=False)
                print(f"🧠 AI intent: contact={extracted.get('contact')!r}  "
                      f"message={extracted.get('message')!r}  "
                      f"app={extracted.get('app')!r}")
                return extracted
        except Exception as exc:
            print(f"⚠️  Intent extraction failed: {exc}")
        return {}

    def _extract_target_contact(self, command: str) -> Optional[str]:
        """
        Extracts contact name using AI first, with a simple regex fallback.
        AI handles Hinglish naturally — no fragile pattern matching needed.
        """
        # AI extraction (primary)
        intent = self._extract_intent_via_ai(command)
        contact = intent.get("contact")
        if contact and isinstance(contact, str) and len(contact.strip()) >= 2:
            name = contact.strip()
            return name[0].upper() + name[1:]

        # Simple regex fallback (English only, no Hinglish — avoids "Pe harsh" bug)
        simple_patterns = [
            r"\bto\s+([A-Z][a-z]{1,20}(?:\s+[A-Z][a-z]{1,20})?)",   # "to Harsh"
            r"\bmessage\s+([A-Z][a-z]{1,20})",                         # "message Priya"
            r"\btell\s+([A-Z][a-z]{1,20})",                            # "tell Rohit"
            r"\btext\s+([A-Z][a-z]{1,20})",                            # "text Simran"
        ]
        stopwords = {"me","my","him","her","them","us","you","the",
                     "a","an","it","this","that","ko","pe","par","se","ka","ki","ke"}
        for pat in simple_patterns:
            m = re.search(pat, command)
            if m:
                name = m.group(1).strip()
                if name.lower() not in stopwords and len(name) >= 2:
                    return name
        return None

    def _extract_message_text(self, command: str) -> Optional[str]:
        """Returns the message body extracted from the command (used to inject into prompt)."""
        intent = self._extract_intent_via_ai(command)
        return intent.get("message")

    # ── [H5] Exclusion zone in 0-1000 model coords ───────────────────────────

    # ── App visibility & loading screen ─────────────────────────────────────

    # Maps app keywords → window title substrings to check for in the taskbar
    _APP_WINDOW_TITLES = {
        "whatsapp":  ["whatsapp"],
        "chrome":    ["google chrome", "chromium"],
        "notepad":   ["notepad"],
        "spotify":   ["spotify"],
        "terminal":  ["terminal", "windows terminal", "cmd", "powershell"],
        "vscode":    ["visual studio code", "vs code"],
        "instagram": ["instagram"],
        "explorer":  ["file explorer", "this pc"],
    }

    def _is_app_visible(self, app_keyword: str) -> bool:
        """
        Returns True if a window matching app_keyword EXISTS (active, minimized, or background).
        Does NOT require it to be the active window — just that it's open somewhere.
        """
        targets = self._APP_WINDOW_TITLES.get(app_keyword.lower(), [app_keyword.lower()])
        # Check active window
        if any(t in _get_active_window().lower() for t in targets):
            return True
        # Check all windows including minimized ones
        try:
            import pygetwindow as gw                    # noqa: PLC0415
            for win in gw.getAllWindows():
                if any(t in (win.title or "").lower() for t in targets):
                    return True  # Exists even if minimized
        except Exception:
            pass
        return False

    def _focus_existing_window(self, app_keyword: str) -> bool:
        """
        Brings an existing window to the foreground — handles minimized, background,
        and system-tray-hidden windows.

        Strategy waterfall:
          1. pygetwindow restore() + activate()
          2. PowerShell SetForegroundWindow (works when pygetwindow fails on minimized)
          3. Alt+Tab cycle (last resort)

        Returns True if the window is confirmed active after the attempt.
        """
        targets = self._APP_WINDOW_TITLES.get(app_keyword.lower(), [app_keyword.lower()])
        info    = self._APP_FRIENDLY.get(app_keyword, {"name": app_keyword.title()})

        # ── Method 1: pygetwindow ───────────────────────────────────────────
        try:
            import pygetwindow as gw                    # noqa: PLC0415
            for win in gw.getAllWindows():
                if any(t in (win.title or "").lower() for t in targets):
                    try:
                        win.restore()
                        time.sleep(0.4)
                        win.activate()
                        time.sleep(0.6)
                        if any(t in _get_active_window().lower() for t in targets):
                            print(f"✅ [Method 1] Activated: '{win.title}'")
                            return True
                    except Exception:
                        pass
        except Exception:
            pass

        # ── Method 2: PowerShell SetForegroundWindow (Windows only) ────────
        proc_names = {
            "whatsapp": "WhatsApp", "chrome": "chrome",
            "notepad": "notepad", "spotify": "Spotify",
            "instagram": "Instagram", "vscode": "Code",
            "terminal": "WindowsTerminal", "explorer": "explorer",
        }
        proc = proc_names.get(app_keyword)
        if proc and platform.system() == "Windows":
            try:
                ps_cmd = f"""
$p = Get-Process -Name '{proc}' -ErrorAction SilentlyContinue | Select-Object -First 1
if ($p -and $p.MainWindowHandle -ne 0) {{
    Add-Type -AssemblyName Microsoft.VisualBasic
    [Microsoft.VisualBasic.Interaction]::AppActivate($p.Id)
    Add-Type @'
    using System; using System.Runtime.InteropServices;
    public class WinFocus {{
        [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
        [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
    }}
'@ -ErrorAction SilentlyContinue
    [WinFocus]::ShowWindow($p.MainWindowHandle, 9)
    [WinFocus]::SetForegroundWindow($p.MainWindowHandle)
    Write-Output "ok"
}}
"""
                out = subprocess.run(
                    ["powershell", "-NoProfile", "-Command", ps_cmd],
                    capture_output=True, text=True, timeout=8
                ).stdout.strip()
                if out == "ok":
                    time.sleep(0.8)
                    if any(t in _get_active_window().lower() for t in targets):
                        print(f"✅ [Method 2] PowerShell activated {app_keyword}")
                        return True
            except Exception as exc:
                print(f"⚠️  PowerShell focus failed: {exc}")

        # ── Method 3: Click taskbar icon via Win+number or taskbar click ───
        # Just press Win key and type the app name — brings it to front
        try:
            display_name = info.get("name", app_keyword.title())
            print(f"⌨️  [Method 3] Win-search restore: '{display_name}'")
            pyautogui.hotkey("ctrl", "alt", "tab")  # Show all windows
            time.sleep(0.5)
            pyautogui.press("escape")
            time.sleep(0.3)
            # Try Alt+F4 nope — just use Win key search
            pyautogui.press("win")
            time.sleep(0.6)
            pyautogui.write(display_name, interval=0.05)
            time.sleep(0.8)
            pyautogui.press("enter")
            time.sleep(2.0)
            if any(t in _get_active_window().lower() for t in targets):
                print(f"✅ [Method 3] Win-search activated {app_keyword}")
                return True
        except Exception:
            pass

        return False

    def _wait_for_loading(self, timeout: float = 20.0) -> bool:
        """
        Waits until the screen stops changing (app finished loading).
        Returns True when stable, False on timeout.
        """
        print("⏳ Waiting for app to finish loading...")
        last_hash = None
        stable_count = 0
        deadline = time.time() + timeout
        while time.time() < deadline:
            time.sleep(0.8)
            try:
                h = _screen_hash(pyautogui.screenshot())
                if h == last_hash:
                    stable_count += 1
                    if stable_count >= 3:
                        print("✅ Screen stable — app loaded")
                        return True
                else:
                    stable_count = 0
                last_hash = h
            except Exception:
                pass
        print("⚠️  Loading wait timed out")
        return False

    def _launch_via_win_search(self, search_terms: list[str]) -> bool:
        """
        Opens Windows Start / Spotlight search, types each term in order until
        one results in the app being visible.  Returns True on success.
        """
        for term in search_terms:
            print(f"⌨️  Win-search: '{term}'")
            # Close any open Start menu first
            pyautogui.press("escape")
            time.sleep(0.3)
            pyautogui.press("win")
            time.sleep(0.7)
            # Clear the search box (Ctrl+A Delete) then type
            pyautogui.hotkey("ctrl", "a")
            time.sleep(0.2)
            pyautogui.write(term, interval=0.06)
            time.sleep(1.0)
            pyautogui.press("enter")
            time.sleep(3.0)
            # Check if it worked
            active = _get_active_window().lower()
            print(f"   Active after search: '{active}'")
            return True   # Return after first attempt — caller will verify
        return False

    # Friendly names and Win-search fallback terms for each app keyword
    _APP_FRIENDLY: dict[str, dict] = {
        "whatsapp":  {"name": "WhatsApp",          "search": ["WhatsApp", "whatsapp"]},
        "chrome":    {"name": "Google Chrome",      "search": ["Chrome", "Google Chrome"]},
        "notepad":   {"name": "Notepad",            "search": ["Notepad"]},
        "spotify":   {"name": "Spotify",            "search": ["Spotify"]},
        "terminal":  {"name": "Terminal",           "search": ["Windows Terminal", "Terminal"]},
        "vscode":    {"name": "VS Code",            "search": ["Visual Studio Code", "VS Code"]},
        "instagram": {"name": "Instagram",          "search": ["Instagram"]},
        "explorer":  {"name": "File Explorer",      "search": ["File Explorer", "explorer"]},
    }

    def _ensure_app_ready(self, app_keyword: str) -> bool:
        """
        BLOCKING guarantee: does not return until the target app is the active
        foreground window, or until all retry strategies are exhausted.

        Strategy waterfall (retried up to 3 rounds):
          1. Already visible → done instantly.
          2. Exists but minimised → restore + activate.
          3. subprocess.Popen launch (fast, PATH-based).
          4. Win key → short name search → Enter.
          5. Win key → full display name search → Enter.
          6. Wait for loading screen to settle after each launch attempt.

        Returns True if app is confirmed active, False if all attempts failed.
        """
        info         = self._APP_FRIENDLY.get(app_keyword, {"name": app_keyword.title(), "search": [app_keyword.title()]})
        display_name = info["name"]
        search_terms = info["search"]

        print(f"\n{'═'*50}")
        print(f"🎯 ENSURING APP IS READY: {display_name}")
        print(f"{'═'*50}")

        for attempt in range(1, 4):
            print(f"\n🔄 Attempt {attempt}/3")

            # 1. Already active?
            if self._is_app_visible(app_keyword):
                self._wait_for_loading(timeout=10)
                print(f"✅ {display_name} is active and ready")
                return True

            # 2. Minimised / background window?
            if self._focus_existing_window(app_keyword):
                self._wait_for_loading(timeout=10)
                if self._is_app_visible(app_keyword):
                    print(f"✅ {display_name} restored and active")
                    return True

            # 3. subprocess launch
            if attempt == 1:
                print(f"🚀 Launching {display_name} via subprocess...")
                _launch_app(app_keyword)
                time.sleep(2.0)
                if self._is_app_visible(app_keyword):
                    self._wait_for_loading()
                    if self._is_app_visible(app_keyword):
                        print(f"✅ {display_name} launched and active")
                        return True

            # 4 & 5. Win key search — try each term
            for term in search_terms:
                self._launch_via_win_search([term])
                self._wait_for_loading(timeout=15)
                if self._is_app_visible(app_keyword):
                    print(f"✅ {display_name} opened via Win search ('{term}')")
                    return True
                time.sleep(1.0)

        print(f"❌ Could not open {display_name} after 3 attempts")
        return False

    # ── [H5] Exclusion zone in 0-1000 model coords ───────────────────────────

    def _exclusion_zones_as_model_coords(self) -> list[dict]:
        """Convert pixel exclusion zones to 0-1000 model coordinate space."""
        result = []
        for (x1, y1, x2, y2) in self._exclusion_zones:
            result.append({
                "x1": round(x1 / self.screen_w * 1000),
                "y1": round(y1 / self.screen_h * 1000),
                "x2": round(x2 / self.screen_w * 1000),
                "y2": round(y2 / self.screen_h * 1000),
            })
        return result


    # ── Voice Interrupt — passive queue system ─────────────────────────────

    def inject_voice_interrupt(self, message: str) -> None:
        """
        Called by jarvis_logic.listen_loop when wake word 'hero' is detected
        and a task is active. The message (text AFTER 'hero') is put into
        the interrupt queue for analyze_and_act to consume.
        """
        if _is_hallucination(message):
            print(f"🔇 Ignoring hallucination in interrupt: '{message}'")
            return
        print(f"🔔 Voice interrupt queued: '{message}'")
        self._interrupt_queue.put(message)

    def inject_reply(self, reply: str) -> None:
        """
        Called by jarvis_logic.listen_loop when _asking_user is True.
        The reply goes into the reply queue (no wake word required).
        """
        if _is_hallucination(reply):
            print(f"🔇 Ignoring hallucination in reply: '{reply}'")
            return
        print(f"🎤 Reply injected: '{reply}'")
        self._asking_user = False
        self._reply_queue.put(reply)

    def _process_voice_interrupt(
        self, user_message: str, current_goal: str, history: list[str]
    ) -> tuple[str, Optional[str]]:
        """
        Process a mid-task voice interruption from the user.

        Takes a fresh screenshot, combines it with the user's spoken message
        and current task context, asks the AI for a natural response, and
        optionally extracts a goal modification.

        Returns:
            (ai_response_text, updated_goal_or_None)
        """
        print(f"\n{'🔔'*10}")
        print(f"🎙️  VOICE INTERRUPT: '{user_message}'")
        print(f"{'🔔'*10}")

        # Take a clean screenshot for context
        b64_screen = self.capture_screen_clean("JPEG")
        if not b64_screen:
            b64_screen = ""

        # Build the interrupt prompt
        history_summary = " → ".join(history[-6:]) if history else "just started"

        interrupt_prompt = f"""You are "Hero", an autonomous desktop controller assistant.
You are in the MIDDLE of doing a task for the user. The user just spoke to you mid-task.

ORIGINAL TASK: {current_goal}
WHAT YOU'VE DONE SO FAR: {history_summary}

THE USER JUST SAID (mid-task, via microphone): "{user_message}"

RULES FOR YOUR RESPONSE:
1. Reply NATURALLY in casual Hinglish (mix of Hindi + English, like a real bro talking)
2. Be conversational — "chal bhai dekta hu", "ha bhai ye sahi hai", "ruk abhi karta hu"
3. If the user is asking about something on screen, LOOK at the screenshot and answer
4. If the user wants you to change what you're doing, acknowledge it
5. If the user confirms something ("ha karde", "yes", "haan"), confirm back warmly
6. Keep responses SHORT (1-2 sentences max)
7. Do NOT be formal. No "certainly", "sure thing". Be a real Hinglish-speaking buddy.

Return JSON:
{{
  "response": "your Hinglish reply to speak aloud",
  "goal_update": "updated goal text if user changed the task, or null if no change",
  "acknowledge": "what user's intent was (1 word: confirm/question/redirect/comment)"
}}
Return ONLY JSON."""

        messages = []
        if b64_screen:
            messages.append({
                "role": "user",
                "content": [
                    {"type": "image_url",
                     "image_url": {"url": f"data:image/jpeg;base64,{b64_screen}"}},
                    {"type": "text", "text": interrupt_prompt},
                ],
            })
        else:
            messages.append({
                "role": "user",
                "content": interrupt_prompt,
            })

        try:
            resp = self._post_to_model(
                "https://integrate.api.nvidia.com/v1/chat/completions",
                json={
                    "model": self.model,
                    "messages": messages,
                    "max_tokens": 200,
                    "temperature": 0.7,
                },
                timeout=60,
            )
            if resp.status_code == 200:
                raw = resp.json()["choices"][0]["message"]["content"]
                try:
                    data = json.loads(_extract_json_object(raw), strict=False)
                except Exception:
                    # If JSON fails, use raw text as response
                    data = {"response": raw.strip(), "goal_update": None}

                ai_response = data.get("response", "Ha bhai, samjh gaya.")
                goal_update = data.get("goal_update")

                print(f"🤖 Hero says: {ai_response}")
                if goal_update:
                    print(f"🔄 Goal updated to: {goal_update}")

                # Speak the response
                _speak_tts_sarvam(ai_response, self.jarvis)

                # Track the conversation
                self._voice_context.append({
                    "user": user_message,
                    "hero": ai_response,
                })

                return ai_response, goal_update
            else:
                print(f"⚠️  Interrupt AI error {resp.status_code}")
        except Exception as exc:
            print(f"⚠️  Interrupt processing error: {exc}")

        # Fallback
        fallback = "Ha bhai sun raha hu, chal karta hu."
        _speak_tts_sarvam(fallback, self.jarvis)
        return fallback, None

    def ask_user(self, question: str, timeout: float = 60.0) -> Optional[str]:
        """
        Agent speaks a question aloud and waits for the user's voice reply.
        jarvis_logic.listen_loop will see _asking_user=True and route
        the next transcription directly to _reply_queue (no wake word needed).

        Returns the user's reply text, or None on timeout.
        """
        print(f"🤖❓ Asking user: {question}")
        _speak_tts_sarvam(question, self.jarvis)

        # Signal jarvis_logic to route next speech as reply
        self._asking_user = True

        try:
            reply = self._reply_queue.get(timeout=timeout)
            self._asking_user = False
            print(f"🎤 User replied: {reply}")
            return reply
        except queue.Empty:
            self._asking_user = False
            print("⏰ No reply from user (timeout)")
            return None

    # ── Autonomous conversation mode ─────────────────────────────────────────

    def autonomous_chat(self, command: str, max_turns: int = 10) -> str:
        """
        Autonomous conversation mode:
          Phase 0  — Ensure WhatsApp is open + navigate to the correct contact's chat
          Phase 1+ — Read latest received message → generate reply → send → wait → repeat
        """
        if not getattr(self, "nvidia_api_key", None) and "gemma" not in self.model.lower():
            return "Error: No API key."

        self._auto_detect_exclusion_zone()
        print(f"\n💬 Autonomous chat mode | max {max_turns} turns")

        # Extract contact name
        intent  = self._extract_intent_via_ai(command)
        contact = intent.get("contact") or ""
        if contact:
            contact = contact.strip()
            contact = contact[0].upper() + contact[1:]
        print(f"🎯 Contact: '{contact or 'currently open chat'}'")

        # ── PHASE 0: Open WhatsApp and navigate to correct chat ──────────────
        # Delegate entirely to analyze_and_act which already handles:
        #   - app launch, window focus, search bar, contact click
        # We just tell it: "open WhatsApp and open the chat with <contact>"
        print("\n📱 Phase 0: Opening chat via vision agent...")
        if contact:
            nav_task = f"open whatsapp and open the chat with {contact} — just open the chat, do not send any message"
        else:
            nav_task = "open whatsapp — just make sure it is open and in focus"

        nav_result = self.analyze_and_act(nav_task, max_steps=12)
        print(f"📱 Navigation result: {nav_result}")
        time.sleep(1.5)   # let chat fully load

        # Step 0c: Read full conversation context ONCE before starting replies
        # This gives the model the "story so far" so first reply is contextually perfect
        b64_ctx = self.capture_screen_clean("JPEG")
        conversation_context = ""
        if b64_ctx:
            try:
                ctx_resp = self._post_to_model(
                    "https://integrate.api.nvidia.com/v1/chat/completions",
                    json={
                        "model": self.model,
                        "messages": [{
                            "role": "user",
                            "content": [
                                {"type": "image_url",
                                 "image_url": {"url": f"data:image/jpeg;base64,{b64_ctx}"}},
                                {"type": "text", "text": (
                                    "Read this WhatsApp chat and summarize the conversation so far.\n"
                                    "List messages in order: who said what.\n"
                                    "  - LEFT side (dark gray bubbles) = messages from the OTHER person\n"
                                    "  - RIGHT side (dark green bubbles) = messages I (the user) sent\n"
                                    "Return plain text summary, 3-5 lines max. No JSON."
                                )}
                            ]
                        }],
                        "max_tokens": 200,
                        "temperature": 0.0,
                    },
                    timeout=20,
                )
                conversation_context = ctx_resp.json()["choices"][0]["message"]["content"].strip()
                print(f"📖 Conversation context:\n{conversation_context}\n")
            except Exception as e:
                print(f"⚠️  Context read failed: {e}")

        # ── CONVERSATION LOOP ─────────────────────────────────────────────────
        turns_done      = 0
        last_replied_to = ""

        for turn in range(1, max_turns + 1):
            print(f"\n{'─'*50}")
            print(f"💬 Turn {turn}/{max_turns}")

            # ── Step 1: Clean screenshot for reading ────────────────────────
            b64 = self.capture_screen_clean("JPEG")
            if not b64:
                return "Screen capture failed."

            # ── Step 2a: READ — find the latest received (LEFT-side) message ─
            try:
                read_resp = self._post_to_model(
                    "https://integrate.api.nvidia.com/v1/chat/completions",
                    json={
                        "model": self.model,
                        "messages": [{
                            "role": "user",
                            "content": [
                                {"type": "image_url",
                                 "image_url": {"url": f"data:image/jpeg;base64,{b64}"}},
                                {"type": "text", "text": (
                                    "WhatsApp Desktop screenshot. Read CAREFULLY.\n\n"
                                    "BUBBLE LAYOUT:\n"
                                    "  LEFT side  = dark GRAY/white bubbles  → messages from OTHER person\n"
                                    "  RIGHT side = dark GREEN bubbles        → messages I sent (ignore these)\n\n"
                                    "FIND: The LATEST (bottommost) LEFT-side gray bubble.\n"
                                    "Read its EXACT text.\n\n"
                                    "Return JSON:\n"
                                    "{\"received\": \"exact text\", \"found\": true/false}\n"
                                    "Return ONLY JSON."
                                )}
                            ]
                        }],
                        "max_tokens": 120,
                        "temperature": 0.0,
                    },
                    timeout=60,
                )
                rd = json.loads(_extract_json_object(
                    read_resp.json()["choices"][0]["message"]["content"]
                ), strict=False)
                latest_received = rd.get("received", "").strip()
                found           = rd.get("found", False)
                print(f"   📩 Received: '{latest_received[:80]}' (found={found})")

                if not found or not latest_received:
                    print("   ⏳ No received message — waiting 5s...")
                    time.sleep(5.0)
                    continue

                if latest_received == last_replied_to:
                    print("   ⏳ Already replied to this — waiting for new message...")
                    time.sleep(4.0)
                    continue

            except Exception as e:
                print(f"   ❌ Read failed: {e}")
                time.sleep(2.0)
                continue

            # ── Step 2b: GENERATE reply with full context ───────────────────
            try:
                ctx_line = f"\nConversation so far:\n{conversation_context}\n" if conversation_context else ""
                gen_resp = self._post_to_model(
                    "https://integrate.api.nvidia.com/v1/chat/completions",
                    json={
                        "model": self.model,
                        "messages": [{
                            "role": "user",
                            "content": [{
                                "type": "text",
                                "text": (
                                    f"You are replying on behalf of the user in a WhatsApp chat with '{contact}'.\n"
                                    f"{ctx_line}\n"
                                    f"They just said: \"{latest_received}\"\n\n"
                                    "Write a NATURAL, CASUAL reply (1-2 short sentences):\n"
                                    "  - Match their language (Hindi/Hinglish/English)\n"
                                    "  - Sound like a real young person texting\n"
                                    "  - Be warm and engaging — keep the conversation going\n"
                                    "  - Do NOT start with 'Sure', 'Certainly', 'Great'\n\n"
                                    "Return JSON: {\"reply\": \"text\", \"continue\": true}\n"
                                    "Set continue=false ONLY if they clearly said bye/done/ok bye."
                                )
                            }]
                        }],
                        "max_tokens": 120,
                        "temperature": 0.8,
                    },
                    timeout=60,
                )
                gd          = json.loads(_extract_json_object(
                    gen_resp.json()["choices"][0]["message"]["content"]
                ), strict=False)
                reply_text  = gd.get("reply", "").strip()
                should_cont = gd.get("continue", True)
                print(f"   💬 Reply: '{reply_text}'  continue={should_cont}")

                if not reply_text:
                    print("   ⚠️  Empty reply — skipping turn")
                    time.sleep(2.0)
                    continue

            except Exception as e:
                print(f"   ❌ Reply gen failed: {e}")
                continue

            # ── Step 3: Focus WhatsApp + find input bar (clean screenshot) ──
            try:
                import pygetwindow as gw                  # noqa
                for win in gw.getAllWindows():
                    if "whatsapp" in (win.title or "").lower():
                        win.restore(); time.sleep(0.2)
                        win.activate(); time.sleep(0.5); break
            except Exception:
                pass

            b64_input = self.capture_screen_clean("JPEG")
            nx, ny = 500, 930   # safe fallback
            if b64_input:
                try:
                    inp_resp = self._post_to_model(
                        "https://integrate.api.nvidia.com/v1/chat/completions",
                        json={
                            "model": self.model,
                            "messages": [{
                                "role": "user",
                                "content": [
                                    {"type": "image_url",
                                     "image_url": {"url": f"data:image/jpeg;base64,{b64_input}"}},
                                    {"type": "text", "text": (
                                        "Clean WhatsApp screenshot. "
                                        "Find the message INPUT BAR — the empty text field "
                                        "at the VERY BOTTOM of the chat area "
                                        "where you type new messages ('Type a message' placeholder).\n"
                                        "It should be at y > 850 (0-1000 scale).\n"
                                        "Return JSON: {\"x\": number, \"y\": number}. ONLY JSON."
                                    )}
                                ]
                            }],
                            "max_tokens": 50,
                            "temperature": 0.0,
                        },
                        timeout=60,
                    )
                    icd = json.loads(_extract_json_object(
                        inp_resp.json()["choices"][0]["message"]["content"]
                    ), strict=False)
                    nx = float(icd.get("x", 500))
                    ny = float(icd.get("y", 930))
                    if ny < 800:
                        print(f"   ⚠️  y={ny} too high, clamping to 930")
                        ny = 930
                except Exception as e:
                    print(f"   ⚠️  Input bar locate failed ({e}), using fallback")

            sx, sy = _to_screen_coords(nx, ny, self.screen_w, self.screen_h)
            print(f"   ⌨️  Input bar @({sx},{sy})")

            # Click, clear, type, send
            pyautogui.moveTo(sx, sy, duration=0.2, tween=pyautogui.easeInOutQuad)
            pyautogui.click();      time.sleep(0.4)
            pyautogui.press("end"); time.sleep(0.1)
            pyautogui.hotkey("shift", "home"); time.sleep(0.1)
            pyautogui.press("delete");         time.sleep(0.1)
            pyautogui.write(reply_text, interval=0.05)
            time.sleep(0.3)
            pyautogui.press("enter")
            turns_done      += 1
            last_replied_to  = latest_received
            print(f"   ✅ Sent: '{reply_text}'")

            if not should_cont:
                print("   🏁 They ended conversation")
                break

            # ── Step 4: Wait up to 30s for reply (10 × 3s) ─────────────────
            time.sleep(1.5)
            try:
                base_hash = _screen_hash(pyautogui.screenshot())
            except Exception:
                base_hash = None

            replied = False
            for wait_round in range(1, 11):   # 10 × 3s = 30s
                print(f"   ⏳ Waiting 3s (round {wait_round}/10)...")
                time.sleep(3.0)
                try:
                    chk_hash = _screen_hash(pyautogui.screenshot())
                    if base_hash and chk_hash != base_hash:
                        print("   ✉️  Reply received!")
                        time.sleep(0.5)   # let message fully render
                        replied = True
                        break
                    elif wait_round == 10:
                        print("   ⏰ No reply after 30s — offline? Stopping.")
                    else:
                        print("   ⏳ Still waiting...")
                except Exception:
                    pass

            if not replied:
                break

        return f"✅ Conversation done — {turns_done} message(s) sent to {contact or 'contact'}"

    # ── Main loop — clean Gemini-style architecture ──────────────────────────
    #
    # Key lessons from the working Gemini + Samba agents:
    #   1. Simple prompt: goal + history + screenshot → what's next?
    #   2. Allow multi-action batches (click+type TOGETHER = crucial for search)
    #   3. Trust the model — don't over-guard
    #   4. Auto-detect state from history, not from model flags
    #   5. pyautogui.write(interval=0.05) for reliable typing
    #
    # What was broken in the phase machine:
    #   - "Batching violation" blocked click+type → model clicks search but never types
    #   - phase_complete=true rarely set by model → stuck on phase 1 forever
    #   - Too many guards interrupted valid actions

    def analyze_and_act(self, command: str, max_steps: int = 30) -> str:
        current_model_id = self.model
        print(f"\n🚀 [VISION AGENT] Starting Task with Model: {current_model_id}")
        
        if not getattr(self, "nvidia_api_key", None) and "gemma" not in current_model_id.lower():
            return "Error: NVIDIA API key not configured."

        self._auto_detect_exclusion_zone()

        # ── Start voice interrupt tracking ────────────────────────────────
        self._voice_context.clear()
        self._user_addendums.clear()
        # Clear any stale messages from previous tasks
        while not self._interrupt_queue.empty():
            try: self._interrupt_queue.get_nowait()
            except: break
        
        self._task_active = True
        # The active command can be updated by voice interrupts
        active_command = command

        # ── AI intent extraction ────────────────────────────────────────────
        print(f"\n🧠 Extracting intent...")
        intent              = self._extract_intent_via_ai(command)
        contact_raw         = intent.get("contact")
        message_raw         = intent.get("message")

        if contact_raw and len(str(contact_raw).strip()) >= 2:
            n = str(contact_raw).strip()
            self._target_contact = n[0].upper() + n[1:]
        else:
            self._target_contact = self._extract_target_contact(command)

        self._target_message = str(message_raw).strip() if message_raw else None

        if self._target_contact:
            print(f"🎯 Contact: '{self._target_contact}'")
        if self._target_message:
            print(f"💬 Message: '{self._target_message}'")

        history: list[str] = []
        c_lower = command.lower()

        # ── App detection + guaranteed launch ──────────────────────────────
        _ALIASES: dict[str, str] = {
            "whatsapp":"whatsapp","whatsp":"whatsapp","whatsap":"whatsapp",
            "watsapp":"whatsapp","watsp":"whatsapp","whtsp":"whatsapp",
            "wp":"whatsapp","chrome":"chrome","googlechrome":"chrome",
            "notepad":"notepad","spotify":"spotify",
            "terminal":"terminal","cmd":"terminal","powershell":"terminal",
            "vscode":"vscode","vs code":"vscode","code":"vscode",
            "instagram":"instagram","insta":"instagram",
            "explorer":"explorer","files":"explorer",
        }
        target_app_kw: Optional[str] = None
        for alias, canonical in _ALIASES.items():
            if alias in c_lower:
                target_app_kw = canonical
                break
        if not target_app_kw:
            for word in re.findall(r"[a-z]+", c_lower):
                if len(word) < 4:
                    continue
                best_sim, best_kw = 0.0, None
                for alias, canonical in _ALIASES.items():
                    s = SequenceMatcher(None, word, alias).ratio()
                    if s > best_sim:
                        best_sim, best_kw = s, canonical
                if best_sim >= 0.75:
                    target_app_kw = best_kw
                    print(f"🔍 Fuzzy app: '{word}' → '{target_app_kw}' ({best_sim:.2f})")
                    break

        if target_app_kw:
            info    = self._APP_FRIENDLY.get(target_app_kw, {"name": target_app_kw.title()})
            friendly = info["name"]
            print(f"\n🎯 Target app: {friendly}")
            if not self._ensure_app_ready(target_app_kw):
                return f"❌ Could not open {friendly}. Please open it manually."
            history.append(f"Opened {friendly}")

        is_webp_supported  = True
        prev_hash: Optional[str] = None
        stall_count = 0
        refocus_attempts = 0   # count consecutive refocus failures
        MAX_REFOCUS = 3        # give up and proceed after this many failed attempts
        # Repeat-click detector — (sx//10, sy//10) snaps
        recent_clicks: list[tuple] = []

        # ── Simple system prompt (Gemini-style) ─────────────────────────────
        contact_line = ""
        if self._target_contact:
            msg_line = f'\n  - MESSAGE TO SEND: "{self._target_message}"' if self._target_message else ""
            contact_line = f"""
TARGET CONTACT: "{self._target_contact}"
  - Match the FIRST WORD only. Emojis and "(You)" are decorative — ignore them.
  - "{self._target_contact}it" or "{self._target_contact}a" are DIFFERENT people — skip them.{msg_line}
"""

        app_hint = ""
        if target_app_kw:
            app_hint = self._APP_FRIENDLY.get(target_app_kw, {"name": target_app_kw.title()})["name"]

        # ── Detect website tasks — build direct URL for step 1 ────────────
        # If command mentions a website, we navigate directly instead of
        # spending 5+ steps hunting for Chrome icon, typing in search bar, etc.
        _SITE_URLS = {
            "amazon":     "https://www.amazon.in",
            "flipkart":   "https://www.flipkart.com",
            "youtube":    "https://www.youtube.com",
            "instagram":  "https://www.instagram.com",
            "facebook":   "https://www.facebook.com",
            "twitter":    "https://www.twitter.com",
            "x.com":      "https://www.x.com",
            "linkedin":   "https://www.linkedin.com",
            "github":     "https://www.github.com",
            "reddit":     "https://www.reddit.com",
            "netflix":    "https://www.netflix.com",
            "hotstar":    "https://www.hotstar.com",
            "zomato":     "https://www.zomato.com",
            "swiggy":     "https://www.swiggy.com",
            "myntra":     "https://www.myntra.com",
            "paytm":      "https://www.paytm.com",
            "phonepe":    "https://www.phonepe.com",
            "google":     "https://www.google.com",
        }
        target_url: Optional[str] = None
        for site, url in _SITE_URLS.items():
            if site in c_lower:
                target_url = url
                break

        # ── Context blocks — injected only when relevant ───────────────────
        _SHOPPING_SITES = {"amazon", "flipkart", "myntra", "meesho", "snapdeal",
                           "ajio", "nykaa", "tata cliq", "jiomart"}
        _is_shopping = target_url is not None and any(s in c_lower for s in _SHOPPING_SITES)
        _is_web      = target_url is not None

        shopping_rules = ""
        if _is_shopping:
            shopping_rules = f"""
SHOPPING SITE RULES (Amazon, Flipkart, Myntra, etc.):
- NEVER click "Add to cart" / "Add to bag" on SEARCH RESULTS pages — buttons are too close together and you will add the WRONG product.
- CORRECT approach:
    1. Find the exact product in search results.
    2. Click the PRODUCT TITLE / IMAGE to open its dedicated product page.
    3. Wait for the product page to load (one big "Add to Cart" button visible).
    4. Click "Add to Cart" on the product's OWN page only.

PRECISION CLICKING ON PRODUCT LISTS:
  Step A — Avoid endless scrolling! If there are too many results, use the FILTERS or Short by (Price limits like 'Under ₹1000', Rating '4 Stars & Up', Brands) to narrow down the options first.
  Step B — IDENTIFY exact product: read its full title and price on screen.
  Step C — VERIFY in your thought: state the product name and price you see. If wrong, Go back and find another scroll more or apply a filter.
  Step D — CLICK the product title to open it. If title y < 200 or y > 850, little scroll first — you are too close to an edge.
  
ADD TO CART CLARIFICATION (CRITICAL):
- The "Add to Cart" button is a LARGE, bright YELLOW/ORANGE button located NEAR THE TOP of the product page (usually on the right side, right next to the pricing area).
- DO NOT SCROLL TO THE VERY BOTTOM looking for it! The button is always "above the fold" or just slightly below the title/price. Stop scrolling if you've passed the product details.
- NEVER click the top-right cart icon (y < 150) to add a product. That icon only VIEWs your cart, it does NOT add the product.
"""

        web_strategy = ""
        if _is_web:
            web_strategy = f"""
WEB TASK STRATEGY:
- STEP 1: Use "navigate" to go directly to {target_url} — do NOT hunt for Chrome icon.
- STEP 2 onwards: The website is now open in your browser.
- **REMEMBER**: You are using a browser. Do NOT click the top bar (y < 80) or you will accidentally switch tabs or close the browser. Everything you need is LOWER than y=80.
"""

        chat_strategy = f"""
CHAT APP STRATEGY (Instagram, WhatsApp, etc.):
- INBOX SHORTCUT: If asked to send a message on Instagram, your VERY FIRST ACTION should be to use the "navigate" action and set "text": "https://www.instagram.com/direct/inbox/" to bypass UI clutter!
- INSTAGRAM SEARCH: If you need to find a specific person on Instagram, DO NOT blindly scroll the algorithmic home feed! You MUST click the 'Search' button on the left sidebar (Magnifying Glass), type their name, and click their profile from the results!
- INSTAGRAM LIKES: To 'like' a post from a user's profile grid, you CANNOT like it directly. You MUST first click the post to open it in a popup. Then wait. Then click the Heart icon. Then click the X to close it. Repeat for other posts.
- BEFORE typing or sending any message, verify the person's name at the top of the chat area.
- If the chat panel/popup is ALREADY OPEN (e.g. bottom right corner on Instagram), DO NOT click the main profile "Message" button again. Look for the text input box ("Message...") and type there!
""" if (target_app_kw in ("whatsapp", "instagram") or (_is_web and any(s in c_lower for s in ("instagram", "whatsapp")))) else ""

        thought_prompt = "What do I see? Which parts of the user goal are ALREADY DONE based on the screen? What is the SINGLE NEXT THING I need to do?"
        if _is_shopping:
            thought_prompt = "What product am I targeting? What is its EXACT title and price on screen? Is its button safely in the middle of the viewport?"
        elif target_app_kw in ("whatsapp", "instagram") or (_is_web and any(s in c_lower for s in ("instagram", "whatsapp"))):
            thought_prompt = "Is the TARGET CONTACT's name visible? What messages are already visible in the chat history? Which parts of the original goal are DONE and what is pending? What is my next action?"

        system_prompt = f"""You are an autonomous desktop controller completing a user's task.
{contact_line}
RULES:
- Coordinates: STRICT 0-1000 scale. [0,0]=top-left, [1000,1000]=bottom-right.
- **CRITICAL**: If you send x > 1000 or y > 1000, you are hallucinating.
- **CRITICAL**: If you click at y=0, you will click the "X" button and CLOSE THE BROWSER. All website content is strictly BELOW y=120.
- **CRITICAL**: Search bars on Flipkart/Amazon are NEVER at y=0. They are around y=140.
- Check the grid labels (y=100, x=100) carefully. If an element is below the y=100 line, its y-coordinate MUST be greater than 100.
- If you find yourself repeatedly clicking y=0 or y=2, you are hallucinating. STOP and look at the actual website content lower down.
- STATE TRACKING: NEVER repeat a step you have already finished! Check the screen — if you see the message you just sent is ALREADY in the chat history, DO NOT type it again! Move on to the NEXT part of the user's command.
- BATCHING RULE: Do NOT generate more than 2 actions per step unless typing text! You MUST wait for visual confirmation before firing complex interaction sequences! Do not execute a click and type blind.
- If the SAME coordinate has been clicked 3+ times with no change, try a different approach.
{web_strategy}{shopping_rules}{chat_strategy}
- APP LAUNCHING: If the target website (like Instagram) is completely missing from the screen, DO NOT click random search bars on your own overlay UI! You MUST simply use the "navigate" action and set "text" to the direct URL (e.g. "https://www.instagram.com/direct/inbox/" or "https://www.instagram.com/").
DO NOT interact with CMD terminal, Hero controls, or any chat bar at the bottom of the screen. Those are NOT the target app! If you see a CMD window, just use "navigate" to explicitly open the URL instead.
- JSON FORMAT: NEVER use unescaped double quotes (") inside strings (thought, desc, text). Use single quotes (') instead.

OUTPUT — single JSON object only (NO comments inside JSON!):
{{
  "thought": "{thought_prompt}",
  "memory": ["List of sub-goals you have DEFINITELY completed so far."],
  "loading": false,
  "status": "continue" | "done",
  "finish_summary": "If status is 'done', provide a DETAILED summary here of everything you did, including any information you were asked to gather (like product specs, prices, options, etc.). If you visited multiple pages, summarize the key findings from each.",
  "wait_after": 0.0,
  "actions": [
    {{"action": "ACTION_NAME", "coordinates": [x,y], "text": "...", "key": "...", "end_coordinates": [x,y], "desc": "..."}}
  ]
}}
- Use "loading": true ONLY if the screen shows a loading spinner or is clearly transitioning between pages.
- INFORMATION GATHERING: If the user asks for information (e.g. 'find laptop specs'), you MUST read the information from the screen, include it in your 'thought', and provide the FINAL result in your 'finish_summary' when you set status to 'done'.
- Use "loading": true ONLY if the screen shows a loading spinner or is clearly transitioning between pages.

AVAILABLE ACTIONS (use exact names):
  click, double_click, right_click, triple_click
  type (click + type), clear_and_type (select-all + type), type_special (clipboard paste for URLs/Hindi)
  drag (add end_coordinates:[x,y]), drag_from_to, middle_click, move
  key (e.g. "enter","tab","escape","backspace","delete","f5","home","end","pagedown")
  hotkey (e.g. "ctrl+c","ctrl+v","ctrl+t","ctrl+l","alt+f4","ctrl+shift+t","win+d")
  go_back (performs 'Alt + Left Arrow' shortcut to return to previous browser page — ALWAYS use this instead of trying to click visual back arrows)
  press_and_hold (add key and duration:0.5)
  scroll — scroll the page. Fields:
    "direction": "up"/"down"/"left"/"right"
    "amount": how many scroll units (1=tiny, 3=normal, 8=large, 15=very far)
    "speed": "slow" (tiny) | "normal" (default, ~half viewport) | "fast" (large) | "page" (PageDown key)
    "coordinates": [x,y] — MUST be inside the scrollable content area
      • For web pages: hover over the main content, NOT the address bar or sidebar
      • For chat lists: hover over the chat list panel
      • For product pages: hover over the product description or image area
      • Rule: if unsure, use [500, 500] (screen center)
  navigate (add text:"https://..." to open URL directly in browser — USE THIS FIRST for web tasks)
  wait (add text:"2.0" for seconds)
  ask_user (SPECIAL: speak a question to the user via microphone and WAIT for their voice reply. Use this when you are STUCK and need human input!)
    - Example: login page needs OTP → {{"action": "ask_user", "text": "bro tere phone pe OTP aayi hogi, check karke bata de", "desc": "Asking user for OTP"}}
    - Example: need confirmation → {{"action": "ask_user", "text": "bhai ye vale kardu kya?", "desc": "Confirming product choice"}}
    - The user's reply will appear in your next step as USER_REPLY in the context.
    - Use ask_user ONLY when you genuinely need user input (OTP, password, confirmation, choice between options).
    - Speak in casual Hinglish like a friend would.

WHEN TO USE ask_user:
- Login page asking for OTP/password you dont have
- CAPTCHA or verification page
- Multiple very similar options and you are unsure which one user wants
- Any page that REQUIRES human input to proceed

CRITICAL — WHEN TO SET status="done":
- RULE: Never set "status": "done" in the SAME response that contains actions.
- CORRECT flow:
    Step N:   perform the last action  → "status": "continue", "actions": [last_action]
    Step N+1: screenshot shows result  → "status": "done",     "actions": []
- You MUST see the result on screen in a fresh screenshot before declaring done.

TASK SCOPE — VERY IMPORTANT:
- Complete EXACTLY what the user asked. Nothing more.
- If the user asked you to do multiple things, DO ALL OF THEM before returning status "done".
- Status "done" means the ENTIRE requested task is visually confirmed as complete on the screen."""

        # If we detected a website, open it immediately before the AI loop starts
        if target_url:
            import webbrowser as _wb
            print(f"🌐 Web task detected — navigating directly to {target_url}")
            _wb.open(target_url)
            time.sleep(3.0) # give browser time to become frontmost
            
            # After opening, we must check if we are actually at the browser now.
            # If the terminal is still frontmost, we might need a refocus.
            current_win = _get_active_window().lower()
            if not any(w in current_win for w in ["chrome", "edge", "firefox", "browser", "flipkart", "amazon"]):
                print("⚠️ Browser not active after navigation — attempting manual refocus")
                # Try to find a browser window to focus
                self._focus_existing_window("chrome") or self._focus_existing_window("browser") or pyautogui.hotkey('alt', 'tab')
            
            self._wait_for_loading(10.0)
            history.append(f"Opened {target_url}")

        ai_memory = []

        # --- Step 0: Ensure Browser/Target is Top-Most ---
        # If we see the terminal in the screenshots, we hallucinate.
        # This forces focus on the browser for web tasks.
        if any(w in command.lower() for w in ["amazon", "browser", "chrome", "edge", "google"]):
           print("🎯 Web task detected — initializing browser environment...")
           # Removed Alt+Tab sequence as it was switching AWAY from the browser intermittently
           time.sleep(0.2)

        for step in range(1, max_steps + 1):
            # --- PERIODIC RE-FOCUS (DEPRECATED: removed as requested) ---
            # ...

            # --- STALL PROTECTION (USER REQUESTED: Try new approach after 3 stalls) ---
            if stall_count >= 3:
                print("🚨 THREE STALLS DETECTED — Injecting 'New Approach' command...")
                # Force the model to try something else
                self._user_addendums.append(
                    "⚠️ STALL WARNING: Your previous approach (like clicking the back button or waiting) is not changing the screen. "
                    "STOP repeating this action. Try a DIFFERENT approach now. "
                    "If you have been scrolling down and can't find 'Add to Cart', SCROLL UP — it is usually at the top of the product page."
                )
                stall_count = 0 
            
            # Additional SCROLL-LOOP sensor
            down_scrolls = sum(1 for h in history[-5:] if "scroll: down" in h.lower())
            if down_scrolls >= 4:
                 self._user_addendums.append(
                    "⚠️ SCROLL ALERT: You have scrolled down 4 times. On shopping sites, the 'Add to Cart' button is HIGHER UP. "
                    "STOP scrolling down. Scroll UP or check for the price/title area near the top."
                )

            print(f"\n{'─'*50}")
            print(f"📸 Step {step}/{max_steps}")

            # ── Check for voice interrupts (mid-task discussion) ─────────
            try:
                interrupt_msg = self._interrupt_queue.get_nowait()
                if interrupt_msg:
                    ai_reply, goal_update = self._process_voice_interrupt(
                        interrupt_msg, active_command, history
                    )
                    if goal_update:
                        print(f"🔄 GOAL UPDATED: {active_command}  →  {goal_update}")
                        active_command = goal_update
                        # Also add as user addendum for AI context
                        self._user_addendums.append(f"User mid-task: '{interrupt_msg}' → Goal changed to: {goal_update}")
                        history.append(f"USER SPOKE: {interrupt_msg} → goal updated")
                    else:
                        self._user_addendums.append(f"User said mid-task: '{interrupt_msg}' → Hero replied: '{ai_reply}'")
                        history.append(f"USER SPOKE: {interrupt_msg}")
            except queue.Empty:
                pass

            img_format = "WEBP" if is_webp_supported else "JPEG"
            img_mime   = f"image/{img_format.lower()}"

            b64_img, raw_pil = self.capture_screen(img_format=img_format)
            if not b64_img:
                self._task_active = False
                return "Error: Screen capture failed."

            # Stall detection
            stall_warning = ""
            if raw_pil:
                h = _screen_hash(raw_pil)
                if prev_hash and h == prev_hash:
                    stall_count += 1
                    print(f"⚠️  Screen unchanged (stall #{stall_count})")
                    stall_warning = f"⚠️ WARNING: Your last action had NO EFFECT (screen identical). It failed or you clicked the wrong place. Try a different coordinate."
                else:
                    stall_count = 0
                prev_hash = h
                
            if stall_warning and any("BLOCKED repeat click" in h for h in history[-2:]):
                stall_warning += "\n🔥 CRITICAL: You are stuck in a loop clicking the SAME coordinate. Your last click was BLOCKED. YOU MUST TRY A COMPLETELY DIFFERENT APPROACH (e.g. if chat is already open, just type the message)."
            elif stall_warning and stall_count >= 3:
                stall_warning += "\n🔥 CRITICAL STALL: The screen has been completely unchanged for 3 steps! Whatever you are doing is completely failing. YOU MUST ABANDON THIS APPROACH AND TRY SOMETHING COMPLETELY NEW! Stop clicking the same dead elements!"
            elif stall_warning and stall_count > 1:
                stall_warning += "\n🔥 IMPORTANT: Are you clicking a button to open a popup that is ALREADY OPEN? Look around the screen carefully!"
                stall_warning += "\n🔥 SCROLLING HELP: If scrolling down had no effect, you might be at the bottom! Stop scrolling and try to click the FILTERS on the left sidebar (Price limits, Ratings, etc) to narrow down the results instead!"

            # Hard app enforcement — bring app to front if wrong window is active
            active_win = _get_active_window()
            if target_app_kw:
                targets = self._APP_WINDOW_TITLES.get(target_app_kw, [target_app_kw])
                if not any(t in active_win.lower() for t in targets):
                    if refocus_attempts >= MAX_REFOCUS:
                        # Give up re-focusing — let the model work with whatever is visible
                        print(f"⚠️  Wrong window after {MAX_REFOCUS} refocus attempts "
                              f"— proceeding anyway with '{active_win}'")
                        refocus_attempts = 0   # reset so it tries again later if needed
                    else:
                        refocus_attempts += 1
                        print(f"⚠️  Wrong window '{active_win}' — re-focusing "
                              f"(attempt {refocus_attempts}/{MAX_REFOCUS})...")
                        focused = self._focus_existing_window(target_app_kw)
                        if not focused:
                            # Only call _ensure_app_ready on FIRST refocus failure
                            # (avoids calling the full 3-attempt launcher every step)
                            if refocus_attempts == 1:
                                self._ensure_app_ready(target_app_kw)
                        stall_count = 0
                        continue
                else:
                    refocus_attempts = 0   # reset counter when correct window is active

            # Exclusion zone coords for prompt
            exclusion_info = self._exclusion_zones_as_model_coords()
            blocked_note   = ""
            if exclusion_info:
                zones = "; ".join(f"[{z['x1']},{z['y1']}]→[{z['x2']},{z['y2']}]"
                                  for z in exclusion_info)
                blocked_note = f"\n⛔ AGENT UI ZONES — NEVER CLICK: {zones}"

            # Build user message — always tell model exactly what window is active
            screen_context = f"ACTIVE WINDOW: '{active_win}'\n"
            if ai_memory:
                screen_context += f"🧠 YOUR INTERNAL MEMORY (COMPLETED SUB-GOALS): {ai_memory}\n"
            if stall_warning:
                screen_context += f"{stall_warning}\n"
            if target_url:
                screen_context += f"TARGET WEBSITE: {target_url}\n"
            if target_app_kw:
                tgts  = self._APP_WINDOW_TITLES.get(target_app_kw, [target_app_kw])
                match = any(t in active_win.lower() for t in tgts)
                fname = self._APP_FRIENDLY.get(target_app_kw, {"name": target_app_kw.title()})["name"]
                screen_context += f"TARGET APP: {fname} | MATCH: {'YES ✅' if match else 'NO ❌'}\n"

            # Tell model exactly what to do if it's on the wrong screen
            if target_url and not any(
                site in active_win.lower()
                for site in ["chrome","firefox","edge","opera","brave","internet"]
            ):
                screen_context += (
                    f"⚠️  WRONG SCREEN: You are NOT on {target_url} yet.\n"
                    f"   FIRST ACTION must be: navigate to {target_url}\n"
                    f"   Use: {{\"action\":\"navigate\",\"text\":\"{target_url}\",\"desc\":\"Open website\"}}\n"
                )

            # Build user context with voice addendums
            addendum_text = ""
            if self._user_addendums:
                addendum_text = "\n🎙️ MID-TASK VOICE DISCUSSION:\n" + "\n".join(
                    f"  • {a}" for a in self._user_addendums[-5:]
                ) + "\n"

            messages = [
                {"role": "system", "content": system_prompt + blocked_note},
                {"role": "user", "content": [
                    {"type": "image_url",
                     "image_url": {"url": f"data:{img_mime};base64,{b64_img}"}},
                    {"type": "text",
                     "text": f"{screen_context}{addendum_text}GOAL: {active_command}\nHISTORY (last 8): {json.dumps(history[-8:])}"},
                ]},
            ]

            try:
                resp = self._post_to_model(
                    "https://integrate.api.nvidia.com/v1/chat/completions",
                    json={"model": self.model, "messages": messages,
                          "max_tokens": 1024, "temperature": 0.1},
                    timeout=120,
                )

                if resp.status_code == 400 and is_webp_supported and "media" in resp.text.lower():
                    is_webp_supported = False
                    continue
                if resp.status_code != 200:
                    return f"API error {resp.status_code}: {resp.text[:200]}"

                raw = resp.json()["choices"][0]["message"]["content"]
                
                # Fix common unescaped quotes inside thought/desc before parsing
                # (e.g. "thought": "I need to type "gaming earbuds" here")
                # This is a bit unsafe but helps with common formatting errors
                raw = re.sub(r'("\s*(?:thought|desc|text)\s*"\s*:\s*")(.*?[^\\])("[,}\n])', 
                             lambda m: m.group(1) + m.group(2).replace('"', "'") + m.group(3), 
                             raw, flags=re.DOTALL)

                try:
                    json_str = _extract_json_object(raw)
                    # Fix common trailing commas
                    json_str = re.sub(r',\s*([\]}])', r'\1', json_str)
                    # Simplified quote fix: only fix interior quotes if they are clearly double quotes inside a string
                    # But don't use the previous DOTALL regex which was too greedy.
                    # We'll rely on strict=False for now and only fix trailing periods/commas outside.
                    json_str = json_str.replace("“", '"').replace("”", '"')
                except ValueError:
                    print("⚠️  JSON extract failed")
                    continue

                try:
                    data = json.loads(json_str, strict=False)
                except Exception as e:
                    print(f"⚠️  JSON parse error: {e}")
                    # If JSON fails, usually it's because of bad formatting, let's keep looping
                    continue

                thought    = data.get("thought", "")
                
                # Persist memory across steps
                new_mem = data.get("memory", [])
                if isinstance(new_mem, list) and new_mem:
                    for m in new_mem:
                        if m not in ai_memory:
                            ai_memory.append(m)
                    
                status     = data.get("status", "continue") or "continue"
                actions    = data.get("actions") or []
                wait_after = float(data.get("wait_after") or 0.0)

                print(f"   💭 {thought[:130]}")

                if data.get("loading"):
                    print("⏳ Loading screen — waiting...")
                    time.sleep(3.0)
                    self._wait_for_loading(12.0)
                    continue

                actions = data.get("actions", [])
                
                # PROGRAMMATIC BATCH ENFORCEMENT
                # Llama 3 is stubborn and frequently ignores the 'max 2 actions' rule.
                # If it batches 10 clicks predicting the entire workflow blind, slice it to 3!
                if len(actions) > 3:
                    print(f"✂️ Slicing batch of {len(actions)} actions down to 3 to prevent blind hallucination.")
                    actions = actions[:3]

            # Execute all actions in the batch
                for act in actions:
                    atype  = (act.get("action") or "").lower()
                    
                    coords_raw = act.get("coordinates")
                    # If AI omitted coords, or provided hallucinated [0,0]-[4,4] for non-type action, default to center
                    if type(coords_raw) is list and len(coords_raw) >= 2:
                        try:
                            cx, cy = float(coords_raw[0]), float(coords_raw[1])
                            if cx < 5 and cy < 5 and atype != "type":
                                coords = [500, 500]
                            else:
                                coords = coords_raw
                        except Exception:
                            coords = [500, 500]
                    else:
                        coords = [500, 500]
                        
                    text   = str(act.get("text") or "")
                    key    = str(act.get("key") or "")
                    desc   = act.get("desc") or atype

                    sx, sy = _to_screen_coords(
                        coords[0] if (coords and len(coords) > 0) else 500,
                        coords[1] if (coords and len(coords) > 1) else 500,
                        self.screen_w, self.screen_h,
                    )

                    # COORDINATE HALLUCINATION GUARD
                    if any(c > 1000 or c < 0 for c in coords):
                        print(f"   🚫 COORDINATE HALLUCINATION @{coords} — OUT OF BOUNDS")
                        history.append(f"BLOCKED: You sent coordinates {coords} which are outside the 0-1000 range. You are hallucinating coordinates. Look at the grid labels (100-900) to calibrate.")
                        stall_count += 1
                        continue

                    # y=0/close button guard
                    if sy < 20 and atype in ("click", "double_click"):
                        print(f"   🚫 CLOSE BUTTON GUARD @y={sy} — clicking would end task")
                        history.append(f"BLOCKED: You tried to click at y={sy} (very top edge). This is the CLOSE BUTTON area. Interaction with this will fail the task. All content is LOWER.")
                        stall_count += 1
                        continue

                    # ── Guard 2: Exclusion zone ─────────────────────────
                    zone_hit = False
                    for (x1, y1, x2, y2) in self._exclusion_zones:
                        if x1 <= sx <= x2 and y1 <= sy <= y2:
                            print(f"   🚫 EXCLUSION @({sx},{sy}) — blocked")
                            history.append(f"BLOCKED agent-UI: {desc}")
                            zone_hit = True
                            break
                    if zone_hit:
                        continue

                    # ── Guard 3: Repeat-click ───────────────────────────
                    if atype in ("click","double_click","right_click"):
                        snap = (sx // 10, sy // 10)
                        count = sum(1 for c in recent_clicks if c == snap)
                        if count >= 3:
                            print(f"   🚫 REPEAT ×{count+1} @({sx},{sy}) — try something else")
                            history.append(f"BLOCKED repeat click: {desc}")
                            continue
                        recent_clicks.append(snap)
                        if len(recent_clicks) > 20:
                            recent_clicks.pop(0)

                    # ── Guard 4: Web UI top-bar hallucination block ─────────────
                    # Loosened from 150 to 80 as requested to allow Search Bars (usually between 80-150)
                    if atype in ("click", "double_click") and sy < 100:
                        # If a web/shopping task, warn VERY AGGRESSIVELY about clicks in the tab area (y < 100)
                        if _is_web or _is_shopping:
                            print(f"   ⚠️ BROWSER UI WARNING @({sx},{sy}): HALLUCINATION DETECTED (y < 100).")
                            history.append(f"⚠️ CRITICAL ERROR: You clicked at y={sy}. This is the BROWSER TAB / TITLE BAR area. You are HALLUCINATING website content at the top of the monitor. The actual website starts much lower (y > 100). Move your click DOWN.")

                    print(f"   ► {atype}: {desc}  @({sx},{sy})")

                    try:
                        if atype == "click":
                            pyautogui.moveTo(sx, sy, duration=0.15,
                                             tween=pyautogui.easeInOutQuad)
                            pyautogui.click()
                            time.sleep(0.3)
                            if self._target_message and any(
                                w in desc.lower() for w in ("send", "submit", "bhej")
                            ):
                                message_was_sent = True
                                message_sent_step = step
                                print("✅ Send button clicked — message sent")

                        elif atype == "double_click":
                            pyautogui.moveTo(sx, sy, duration=0.15,
                                             tween=pyautogui.easeInOutQuad)
                            pyautogui.doubleClick()
                            time.sleep(0.3)

                        elif atype == "right_click":
                            pyautogui.moveTo(sx, sy, duration=0.15,
                                             tween=pyautogui.easeInOutQuad)
                            pyautogui.rightClick()
                            time.sleep(0.3)

                        elif atype == "triple_click":
                            # Select all text in a field
                            pyautogui.moveTo(sx, sy, duration=0.15,
                                             tween=pyautogui.easeInOutQuad)
                            pyautogui.tripleClick()
                            time.sleep(0.2)

                        elif atype in ("type", "clear_and_type", "type_special"):
                            # Click field, select all, clear, then type/paste
                            pyautogui.moveTo(sx, sy, duration=0.15, tween=pyautogui.easeInOutQuad)
                            pyautogui.click()
                            time.sleep(0.2)
                            pyautogui.hotkey("ctrl", "a")
                            pyautogui.press("backspace")
                            time.sleep(0.1)

                            if atype == "type_special":
                                try:
                                    import pyperclip
                                    pyperclip.copy(text)
                                    pyautogui.hotkey("ctrl", "v")
                                except:
                                    pyautogui.write(text, interval=0.03)
                            else:
                                pyautogui.write(text, interval=0.05)
                            time.sleep(0.3)

                        elif atype == "clear_and_type":
                            # Click field, select all, then type — replaces existing content
                            pyautogui.moveTo(sx, sy, duration=0.15,
                                             tween=pyautogui.easeInOutQuad)
                            pyautogui.click()
                            time.sleep(0.15)
                            pyautogui.hotkey("ctrl", "a")
                            time.sleep(0.1)
                            pyautogui.write(text, interval=0.05)
                            time.sleep(0.2)

                        elif atype == "drag":
                            # Drag from coordinates to end_coordinates
                            end_coords = act.get("end_coordinates") or [sx, sy]
                            ex, ey = _to_screen_coords(
                                end_coords[0], end_coords[1],
                                self.screen_w, self.screen_h
                            )
                            duration = float(act.get("duration") or 0.5)
                            pyautogui.moveTo(sx, sy, duration=0.15,
                                             tween=pyautogui.easeInOutQuad)
                            pyautogui.dragTo(ex, ey, duration=duration,
                                             tween=pyautogui.easeInOutQuad,
                                             button="left")
                            time.sleep(0.3)

                        elif atype == "drag_from_to":
                            # Explicit drag: start_coordinates → end_coordinates
                            end_coords = act.get("end_coordinates") or [sx, sy]
                            ex, ey = _to_screen_coords(
                                end_coords[0], end_coords[1],
                                self.screen_w, self.screen_h
                            )
                            pyautogui.moveTo(sx, sy, duration=0.2)
                            pyautogui.mouseDown(button="left")
                            time.sleep(0.1)
                            pyautogui.moveTo(ex, ey, duration=0.6,
                                             tween=pyautogui.easeInOutQuad)
                            pyautogui.mouseUp(button="left")
                            time.sleep(0.3)

                        elif atype == "middle_click":
                            pyautogui.moveTo(sx, sy, duration=0.15,
                                             tween=pyautogui.easeInOutQuad)
                            pyautogui.middleClick()
                            time.sleep(0.2)

                        elif atype == "mouse_down":
                            pyautogui.moveTo(sx, sy, duration=0.15,
                                             tween=pyautogui.easeInOutQuad)
                            button = (act.get("button") or "left").lower()
                            pyautogui.mouseDown(button=button)
                            time.sleep(0.1)

                        elif atype == "mouse_up":
                            button = (act.get("button") or "left").lower()
                            pyautogui.mouseUp(button=button)
                            time.sleep(0.1)

                        elif atype == "move":
                            # Move mouse without clicking
                            pyautogui.moveTo(sx, sy, duration=0.2,
                                             tween=pyautogui.easeInOutQuad)

                        elif atype == "key":
                            k = (key or text).lower().strip()
                            if k:
                                pyautogui.press(k)
                            time.sleep(0.2)
                            if k == "enter" and self._target_message:
                                message_was_sent = True
                                message_sent_step = step
                                print("✅ Enter pressed — message sent")

                        elif atype == "hotkey":
                            combo = (key or text).lower().replace(" ", "")
                            if combo:
                                pyautogui.hotkey(*combo.split("+"))
                            time.sleep(0.2)

                        elif atype == "type_special":
                            # For text with special chars (URLs, Hindi, etc.) — uses clipboard
                            import pyperclip                   # noqa: PLC0415
                            pyperclip.copy(text)
                            if coords and coords != [0, 0]:
                                pyautogui.moveTo(sx, sy, duration=0.15,
                                                 tween=pyautogui.easeInOutQuad)
                                pyautogui.click()
                                time.sleep(0.2)
                            pyautogui.hotkey("ctrl", "v")
                            time.sleep(0.2)

                        elif atype == "scroll":
                            direction = (act.get("direction") or "down").lower()
                            amount    = int(act.get("amount") or 3)
                            speed     = (act.get("speed") or "normal").lower()

                            # Move cursor to scroll target so correct panel gets event
                            pyautogui.moveTo(sx, sy, duration=0.1)
                            time.sleep(0.08)

                            if direction in ("down", "up"):
                                if speed == "page":
                                    key = "pagedown" if direction == "down" else "pageup"
                                    for _ in range(max(1, amount)):
                                        pyautogui.press(key)
                                        time.sleep(0.08)
                                else:
                                    # Windows WHEEL_DELTA = 120 per notch.
                                    # Multiplier per speed: slow=1 notch, normal=3, fast=8
                                    multiplier = {"slow": 1, "normal": 2, "fast": 6, "large": 10}.get(speed, 2)
                                    total_notches = amount * multiplier
                                    sign = -1 if direction == "down" else 1

                                    if platform.system() == "Windows":
                                        # Use ctypes SendInput — bypasses pyautogui
                                        # throttling and works reliably in Chrome/Edge
                                        INPUT_MOUSE   = 0
                                        MOUSEEVENTF_WHEEL = 0x0800
                                        MOUSEEVENTF_HWHEEL= 0x01000

                                        class MOUSEINPUT(ctypes.Structure):
                                            _fields_ = [
                                                ("dx",          ctypes.c_long),
                                                ("dy",          ctypes.c_long),
                                                ("mouseData",   ctypes.c_ulong),
                                                ("dwFlags",     ctypes.c_ulong),
                                                ("time",        ctypes.c_ulong),
                                                ("dwExtraInfo", ctypes.POINTER(ctypes.c_ulong)),
                                            ]

                                        class INPUT(ctypes.Structure):
                                            class _INPUT(ctypes.Union):
                                                _fields_ = [("mi", MOUSEINPUT)]
                                            _anonymous_ = ("_input",)
                                            _fields_   = [("type", ctypes.c_ulong),
                                                          ("_input", _INPUT)]

                                        WHEEL_DELTA = 120
                                        # Fire one notch at a time with tiny gap —
                                        # more reliable than one big delta value
                                        for _ in range(total_notches):
                                            inp = INPUT()
                                            inp.type = INPUT_MOUSE
                                            inp.mi.dwFlags = MOUSEEVENTF_WHEEL
                                            inp.mi.mouseData = ctypes.c_ulong(
                                                sign * WHEEL_DELTA & 0xFFFFFFFF
                                            )
                                            ctypes.windll.user32.SendInput(
                                                1, ctypes.byref(inp), ctypes.sizeof(INPUT)
                                            )
                                            time.sleep(0.02)   # 20ms between notches
                                    else:
                                        # macOS / Linux fallback — pyautogui burst
                                        burst = 5
                                        remaining = total_notches
                                        while remaining > 0:
                                            this = min(remaining, burst)
                                            pyautogui.scroll(sign * this, x=sx, y=sy)
                                            remaining -= this
                                            if remaining > 0:
                                                time.sleep(0.05)

                            elif direction == "right":
                                pyautogui.hscroll(amount * 3, x=sx, y=sy)
                            elif direction == "left":
                                pyautogui.hscroll(-amount * 3, x=sx, y=sy)

                            time.sleep(0.15)

                        elif atype == "go_back":
                            # Dedicated back action requested by user
                            print("🔙 Performing 'Go Back' (Alt + Left)...")
                            pyautogui.hotkey("alt", "left")
                            time.sleep(1.0) # wait for page transition
                        elif atype == "navigate":
                            # Open a URL in the default browser or address bar
                            url = text or act.get("url", "")
                            
                            # AI gracefully forgot the URL text field
                            if not url:
                                if "insta" in desc.lower() or (act.get("desc") and "navigate" in act.get("desc").lower()):
                                    if target_app_kw in ("insta", "instagram") or "insta" in str(desc).lower():
                                        url = "https://www.instagram.com/direct/inbox/"
                                    elif target_app_kw == "whatsapp" or "whatsapp" in str(desc).lower():
                                        url = "https://web.whatsapp.com/"
                                        
                            if url:
                                import webbrowser               # noqa: PLC0415
                                webbrowser.open(url)
                                time.sleep(2.0)

                        elif atype == "press_and_hold":
                            # Hold a key for a duration (e.g. for game controls)
                            k    = (key or text).lower().strip()
                            secs = float(act.get("duration") or 0.5)
                            if k:
                                pyautogui.keyDown(k)
                                time.sleep(secs)
                                pyautogui.keyUp(k)
                            time.sleep(0.1)

                        elif atype == "wait":
                            secs = float(text or act.get("seconds") or 1.0)
                            time.sleep(max(0.1, min(secs, 10.0)))

                        elif atype == "screenshot_region":
                            # Take screenshot of region and store — useful for verification
                            pass   # No-op, captured at start of each step

                        elif atype == "ask_user":
                            # Agent needs human input (OTP, confirmation, etc.)
                            question = text or desc or "Bhai kuch bata de?"
                            print(f"   🤖❓ ASKING USER: {question}")
                            reply = self.ask_user(question, timeout=60.0)
                            if reply:
                                # Inject reply into context for next step
                                self._user_addendums.append(
                                    f"Agent asked: '{question}' → User replied: '{reply}'"
                                )
                                history.append(f"ASKED: {question} → USER: {reply}")
                                print(f"   🎤 User replied: {reply}")
                            else:
                                self._user_addendums.append(
                                    f"Agent asked: '{question}' → No reply (timeout)"
                                )
                                history.append(f"ASKED: {question} → no reply")
                                print("   ⏰ No user reply (timeout)")
                        else:
                            print(f"   ⚠️  Unknown action '{atype}' — skipped")
                            continue

                        history.append(desc)

                    except Exception as exc:
                        print(f"   ❌ Action failed: {exc}")
                        history.append(f"FAILED: {desc}")

                # ── Done verification gate ─────────────────────────────────
                # If model said "done" but ALSO included actions in the same
                # response, those actions haven't been seen on screen yet.
                # Treat it as "continue" so we get one more screenshot to
                # confirm the result before declaring task complete.
                actions_executed = [a for a in actions
                                    if not any(w in (a.get("desc") or "")
                                               for w in ("BLOCKED", "FAILED"))]

                if status == "done" and actions_executed:
                    print("🔄 Done+actions detected — running one more verification step")
                    status = "continue"   # force one extra step to see the result

                if status == "done" and stall_count > 0:
                    print("⚠️  Status 'done' rejected — screen hasn't changed! Forcing continue.")
                    status = "continue"

                if status == "done":
                    # Final confirmation screenshot
                    time.sleep(0.8)
                    self._task_active = False
                    
                    finish_summary = data.get("finish_summary")
                    if finish_summary:
                        print(f"\n🏁 Task complete: {finish_summary}")
                        return f"✅ Done: {finish_summary}"
                    
                    print("🏁 Task complete (verified done ✅)")
                    return f"✅ Done: {' → '.join(history[-5:])}"

                if wait_after > 0:
                    wait_time = max(2.0, min(wait_after, 5.0))
                    print(f"⏳ Waiting {wait_time:.1f}s (model requested, minimum 2s)")
                    time.sleep(wait_time)
                else:
                    # Minimum 2s inter-step delay: Gives the UI time to perform and settle
                    # before taking the next screenshot for the next AI decision.
                    delay = max(2.0, getattr(self, "inter_step_delay", 2.0))
                    print(f"⏳ Waiting {delay:.1f}s for UI to settle before next screenshot...")
                    time.sleep(delay)

            except requests.exceptions.Timeout:
                print("⚠️  Timeout — retrying...")
                continue
            except Exception as exc:
                print(f"❌ Loop error: {exc}")
                self._task_active = False
                return f"Error: {exc}"

        self._task_active = False
        return f"Reached max steps. History: {' → '.join(history[-5:])}"


# ─────────────────────────────────────────────────────────────────────────────
# CLI entry point
# ─────────────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    agent = NvidiaVisionAutomation()
    cmd = " ".join(sys.argv[1:]) if len(sys.argv) > 1 else \
          "open whatsapp and send hello to Harsh"
    print(f"\n🎯 Command: {cmd}\n")
    result = agent.analyze_and_act(cmd)
    print(f"\n📋 Result: {result}")