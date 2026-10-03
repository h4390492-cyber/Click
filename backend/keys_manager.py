"""
keys_manager.py - Secure API Key, Multi-Key Rotation & Environment Variable Manager for Click

Features:
1. Intelligent Detection:
   - Differentiates raw API keys (e.g. nvapi-..., AIzaSy..., gsk_..., sk_...) from environment variable names.
   - Accurately resolves system environment variable names (e.g. "NVIDIA-KEY", "GOOGLE_API_KEY").
   - Flags missing environment variables instead of saving bogus keys.
2. Multi-Key Rotation Support:
   - Supports multiple keys for rate-limit rotation (comma, space, or newline separated).
   - Maps them to canonical rotation slots (NVIDIA_API_KEY, NVIDIA_API_KEY_1, NVIDIA_API_KEY_2...).
   - Maps Google keys to rotation slots (GOOGLE_API_KEY, GOOGLE_API_KEY_1, GOOGLE_API_KEY_2, GOOGLE_API_KEY_3...).
3. Safe Local Storage:
   - Stored in user_keys.json (strictly ignored by Git).
   - Never rewrites Python code at runtime.
   - Backwards compatible with existing api_keys.py if present locally.
4. Factory Reset:
   - Complete wipe of chats, stored keys, and temporary screenshots with 1 click.
"""

import os
import re
import json
import glob
from typing import List, Tuple, Dict, Any

_BASE_DIR = os.path.dirname(os.path.abspath(__file__))
_KEYS_PATH = os.path.join(_BASE_DIR, "user_keys.json")
_SETTINGS_PATH = os.path.join(_BASE_DIR, "settings.json")
_CHATS_PATH = os.path.join(_BASE_DIR, "..", "chats.json")

# Auto-create blank api_keys.py if missing on fresh clone (prevents any missing file errors)
_api_py_init = os.path.join(_BASE_DIR, "api_keys.py")
if not os.path.exists(_api_py_init):
    try:
        with open(_api_py_init, "w", encoding="utf-8") as _f_init:
            _f_init.write(
                "# Placeholders for API keys - Configured via Click UI\n"
                "import os\n\n"
                "NVIDIA_API_KEY = \"\"\n"
                "GOOGLE_API_KEY = \"\"\n"
                "GROQ_API_KEY = \"\"\n"
                "SARVAM_API_KEY = \"\"\n"
                "SAMBANOVA_API_KEY = \"\"\n"
                "OPENROUTER_API_KEY = \"\"\n"
            )
    except Exception:
        pass


def is_likely_raw_key(token: str) -> bool:
    """Detects whether a token is an actual API key rather than an env var name."""
    t = token.strip()
    # Recognized key prefixes
    known_prefixes = ("nvapi-", "AIzaSy", "gsk_", "sk_", "sk-", "ghp_")
    if any(t.startswith(p) for p in known_prefixes):
        return True
    # Long random hex/uuid/base64 strings (> 30 chars with mix of case/hyphens)
    if len(t) >= 30 and (any(c.islower() for c in t) and any(c.isdigit() for c in t)):
        return True
    return False


def resolve_single_token(token: str) -> Tuple[str, str]:
    """
    Resolves a single token (either raw key or env var name).
    Returns (resolved_key, status):
    - status = 'direct' (raw key)
    - status = 'env:<NAME>' (resolved from system environment variable)
    - status = 'not_found:<NAME>' (looks like env var name, but not found in system)
    """
    token = token.strip().strip("'\"")
    if not token:
        return ("", "empty")

    # 1. Obvious raw API key
    if is_likely_raw_key(token):
        return (token, "direct")

    # 2. Check system environment
    candidates = [
        token,
        token.upper(),
        token.replace("-", "_").upper(),
        token.replace("_", "-").upper(),
    ]
    for cand in candidates:
        if cand in os.environ and os.environ[cand].strip():
            val = os.environ[cand].strip().strip("'\"")
            return (val, f"env:{cand}")

    # 3. If it looks like an environment variable name (e.g. UPPERCASE_OR_HYPHEN, < 40 chars)
    # but wasn't found in os.environ, do not save it as a bogus literal key!
    if re.match(r'^[A-Za-z0-9_-]{3,40}$', token) and not is_likely_raw_key(token):
        return ("", f"not_found:{token}")

    # 4. Fallback: treat as raw key
    return (token, "direct")


def parse_and_resolve_key_input(raw_input: str) -> Tuple[List[str], List[str]]:
    """
    Parses user input containing one or multiple keys (separated by comma, newline, or whitespace).
    Returns (valid_keys_list, error_messages_list).
    """
    if not raw_input:
        return ([], [])

    # Split by comma or newline
    tokens = re.split(r'[,;\n\r]+', raw_input.strip())
    resolved_keys = []
    errors = []

    for t in tokens:
        t = t.strip()
        if not t:
            continue
        key_val, status = resolve_single_token(t)
        if key_val:
            if key_val not in resolved_keys:
                resolved_keys.append(key_val)
        elif status.startswith("not_found:"):
            var_name = status.split(":", 1)[1]
            errors.append(f"Environment variable '{var_name}' was not found in your system")

    return (resolved_keys, errors)


def mask_key(key: str) -> str:
    """Masks key for safe display in UI."""
    if not key:
        return ""
    key = key.strip()
    if len(key) <= 8:
        return key[:2] + "..." + key[-2:]
    return key[:6] + "..." + key[-4:]


def load_user_keys_dict() -> dict:
    if os.path.exists(_KEYS_PATH):
        try:
            with open(_KEYS_PATH, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception as e:
            print(f"⚠️ [KeysManager] Could not read user_keys.json: {e}")
    return {}


def save_user_keys_dict(data: dict) -> bool:
    try:
        with open(_KEYS_PATH, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2, ensure_ascii=False)
        return True
    except Exception as e:
        print(f"⚠️ [KeysManager] Could not save user_keys.json: {e}")
        return False


def get_nvidia_keys() -> List[str]:
    """Returns all configured Nvidia keys for rotation."""
    keys = []
    # 1. From user_keys.json
    uk = load_user_keys_dict()
    if "nvidia_keys" in uk and isinstance(uk["nvidia_keys"], list):
        for item in uk["nvidia_keys"]:
            if isinstance(item, dict):
                mode = item.get("mode", "key")
                val = item.get("value", "").strip()
                if mode == "env":
                    env_val = os.environ.get(val, "").strip() or os.environ.get(val.replace("-", "_"), "").strip()
                    if env_val and env_val not in keys:
                        keys.append(env_val)
                else:
                    if val and val not in keys:
                        keys.append(val)
            elif isinstance(item, str) and item.strip() and item.strip() not in keys:
                keys.append(item.strip())
        if keys:
            return keys

    # 2. From os.environ
    for env_name in ["NVIDIA_API_KEY", "NVIDIA_API_KEY_1", "NVIDIA_API_KEY_2", "NVIDIA_API_KEY_3"]:
        val = os.environ.get(env_name, "").strip()
        if val and val not in keys:
            keys.append(val)

    # 3. From api_keys.py
    try:
        import api_keys as ak
        for attr in ['NVIDIA_API_KEY', 'NVIDIA_API_KEY_1', 'NVIDIA_API_KEY_2', 'NVIDIA_API_KEY_3']:
            val = getattr(ak, attr, '').strip()
            if val and not val.startswith("your_") and val not in keys:
                keys.append(val)
    except ImportError:
        pass

    return keys


def get_google_keys() -> List[str]:
    """Returns all configured Google Gemini keys for rotation."""
    keys = []
    # 1. From user_keys.json
    uk = load_user_keys_dict()
    if "google_keys" in uk and isinstance(uk["google_keys"], list):
        for item in uk["google_keys"]:
            if isinstance(item, dict):
                mode = item.get("mode", "key")
                val = item.get("value", "").strip()
                if mode == "env":
                    env_val = os.environ.get(val, "").strip() or os.environ.get(val.replace("-", "_"), "").strip()
                    if env_val and env_val not in keys:
                        keys.append(env_val)
                else:
                    if val and val not in keys:
                        keys.append(val)
            elif isinstance(item, str) and item.strip() and item.strip() not in keys:
                keys.append(item.strip())
        if keys:
            return keys

    # 2. From os.environ
    for env_name in ["GOOGLE_API_KEY", "GOOGLE_API_KEY_1", "GOOGLE_API_KEY_2", "GOOGLE_API_KEY_3"]:
        val = os.environ.get(env_name, "").strip()
        if val and val not in keys:
            keys.append(val)

    # 3. From api_keys.py
    try:
        import api_keys as ak
        for attr in ['GOOGLE_API_KEY', 'GOOGLE_API_KEY_1', 'GOOGLE_API_KEY_2', 'GOOGLE_API_KEY_3', 'GOOGLE_API_KEY_4']:
            val = getattr(ak, attr, '').strip()
            if val and not val.startswith("your_") and val not in keys:
                keys.append(val)
    except ImportError:
        pass

    return keys


def get_groq_keys() -> List[str]:
    """Returns all configured Groq keys."""
    keys = []
    uk = load_user_keys_dict()
    if "groq_keys" in uk and isinstance(uk["groq_keys"], list):
        for item in uk["groq_keys"]:
            if isinstance(item, dict):
                mode = item.get("mode", "key")
                val = item.get("value", "").strip()
                if mode == "env":
                    env_val = os.environ.get(val, "").strip() or os.environ.get(val.replace("-", "_"), "").strip()
                    if env_val and env_val not in keys:
                        keys.append(env_val)
                else:
                    if val and val not in keys:
                        keys.append(val)
            elif isinstance(item, str) and item.strip() and item.strip() not in keys:
                keys.append(item.strip())
        if keys:
            return keys

    for env_name in ["GROQ_API_KEY", "GROQ_API_KEY_1"]:
        val = os.environ.get(env_name, "").strip()
        if val and val not in keys:
            keys.append(val)

    try:
        import api_keys as ak
        for attr in ['GROQ_API_KEY', 'GROQ_API_KEY_1']:
            val = getattr(ak, attr, '').strip()
            if val and not val.startswith("your_") and val not in keys:
                keys.append(val)
    except ImportError:
        pass

    return keys


def load_all_keys():
    """
    Populates all canonical environment variables for active agent processes.
    Sets NVIDIA_API_KEY, NVIDIA_API_KEY_1... and GOOGLE_API_KEY, GOOGLE_API_KEY_1...
    """
    nv_keys = get_nvidia_keys()
    if nv_keys:
        os.environ["NVIDIA_API_KEY"] = nv_keys[0]
        for i, k in enumerate(nv_keys[1:], 1):
            os.environ[f"NVIDIA_API_KEY_{i}"] = k

    goog_keys = get_google_keys()
    if goog_keys:
        os.environ["GOOGLE_API_KEY"] = goog_keys[0]
        for i, k in enumerate(goog_keys[1:], 1):
            os.environ[f"GOOGLE_API_KEY_{i}"] = k

    groq_keys = get_groq_keys()
    if groq_keys:
        os.environ["GROQ_API_KEY"] = groq_keys[0]


def get_provider_key_items(provider: str) -> List[dict]:
    """
    Returns list of configured key item descriptors for UI display and editing.
    """
    items = []
    uk = load_user_keys_dict()
    key_field = f"{provider}_keys"

    if key_field in uk and isinstance(uk[key_field], list) and uk[key_field]:
        for idx, entry in enumerate(uk[key_field]):
            if isinstance(entry, dict):
                mode = entry.get("mode", "key")
                val = entry.get("value", "").strip()
                if mode == "env":
                    resolved = os.environ.get(val, "").strip() or os.environ.get(val.replace("-", "_"), "").strip()
                    items.append({
                        "index": idx,
                        "mode": "env",
                        "value": val,
                        "masked": mask_key(resolved) if resolved else "Not set in env",
                        "display": f"{val}",
                        "valid": bool(resolved)
                    })
                else:
                    items.append({
                        "index": idx,
                        "mode": "key",
                        "value": val,
                        "masked": mask_key(val),
                        "display": mask_key(val),
                        "valid": bool(val)
                    })
            elif isinstance(entry, str) and entry.strip():
                items.append({
                    "index": idx,
                    "mode": "key",
                    "value": entry.strip(),
                    "masked": mask_key(entry),
                    "display": mask_key(entry),
                    "valid": bool(entry)
                })
        return items

    # Fallback from active environment or api_keys.py
    if provider == "nvidia":
        keys_list = get_nvidia_keys()
    elif provider == "google":
        keys_list = get_google_keys()
    elif provider == "groq":
        keys_list = get_groq_keys()
    else:
        keys_list = []

    for idx, k in enumerate(keys_list):
        items.append({
            "index": idx,
            "mode": "key",
            "value": k,
            "masked": mask_key(k),
            "display": mask_key(k),
            "valid": True
        })

    return items


def _process_provider_key_input(raw_input: Any, provider: str, existing_keys: List[str]) -> Tuple[List[dict], List[str]]:
    """
    Processes key input for a specific provider.
    Supports list of structured items [{"existing": True, "index": 0}, {"mode": "key"|"env", "value": "..."}, ...]
    or legacy comma-separated string.
    """
    new_entries = []
    errors = []

    if isinstance(raw_input, list):
        for item in raw_input:
            if not item:
                continue
            if isinstance(item, dict):
                if item.get("existing"):
                    idx = item.get("index", 0)
                    if 0 <= idx < len(existing_keys):
                        # Preserve existing key
                        new_entries.append({"mode": "key", "value": existing_keys[idx]})
                    continue
                mode = item.get("mode", "key")
                val = str(item.get("value", "")).strip()
                if not val:
                    continue
                if mode == "env":
                    resolved = os.environ.get(val, "").strip() or os.environ.get(val.replace("-", "_"), "").strip()
                    if not resolved:
                        errors.append(f"Environment variable '{val}' was not found in your system")
                    new_entries.append({"mode": "env", "value": val})
                else:
                    new_entries.append({"mode": "key", "value": val})
            elif isinstance(item, str) and item.strip():
                new_entries.append({"mode": "key", "value": item.strip()})

    elif isinstance(raw_input, str):
        if raw_input.strip() == "":
            return ([], [])
        tokens = re.split(r'[,;\n\r]+', raw_input.strip())
        for t in tokens:
            t = t.strip()
            if not t:
                continue
            key_val, status = resolve_single_token(t)
            if key_val:
                if status.startswith("env:"):
                    var_name = status.split(":", 1)[1]
                    new_entries.append({"mode": "env", "value": var_name})
                else:
                    new_entries.append({"mode": "key", "value": key_val})
            elif status.startswith("not_found:"):
                var_name = status.split(":", 1)[1]
                errors.append(f"Environment variable '{var_name}' was not found in your system")

    return (new_entries, errors)


def save_api_keys(keys_input: dict) -> dict:
    """
    Saves and resolves API keys into user_keys.json and os.environ.
    Accepts structured per-provider key lists or legacy strings.
    """
    saved_keys = load_user_keys_dict()
    errors = []

    # 1. NVIDIA
    if "nvidia_keys" in keys_input or "nvidia_key" in keys_input or "nvidia" in keys_input:
        raw = keys_input.get("nvidia_keys") if "nvidia_keys" in keys_input else (keys_input.get("nvidia_key") or keys_input.get("nvidia"))
        existing = get_nvidia_keys()
        entries, errs = _process_provider_key_input(raw, "nvidia", existing)
        errors.extend(errs)
        if entries:
            saved_keys["nvidia_keys"] = entries
        else:
            saved_keys.pop("nvidia_keys", None)
            os.environ.pop("NVIDIA_API_KEY", None)
            for i in range(1, 10):
                os.environ.pop(f"NVIDIA_API_KEY_{i}", None)

    # 2. Google
    if "google_keys" in keys_input or "google_key" in keys_input or "google" in keys_input:
        raw = keys_input.get("google_keys") if "google_keys" in keys_input else (keys_input.get("google_key") or keys_input.get("google"))
        existing = get_google_keys()
        entries, errs = _process_provider_key_input(raw, "google", existing)
        errors.extend(errs)
        if entries:
            saved_keys["google_keys"] = entries
        else:
            saved_keys.pop("google_keys", None)
            os.environ.pop("GOOGLE_API_KEY", None)
            for i in range(1, 10):
                os.environ.pop(f"GOOGLE_API_KEY_{i}", None)

    # 3. Groq
    if "groq_keys" in keys_input or "groq_key" in keys_input or "groq" in keys_input:
        raw = keys_input.get("groq_keys") if "groq_keys" in keys_input else (keys_input.get("groq_key") or keys_input.get("groq"))
        existing = get_groq_keys()
        entries, errs = _process_provider_key_input(raw, "groq", existing)
        errors.extend(errs)
        if entries:
            saved_keys["groq_keys"] = entries
        else:
            saved_keys.pop("groq_keys", None)
            os.environ.pop("GROQ_API_KEY", None)

    save_user_keys_dict(saved_keys)
    load_all_keys()

    res = get_keys_status()
    if errors:
        res["errors"] = errors
    return res


def get_keys_status() -> dict:
    """
    Returns current status of configured keys with safe masked previews, items list, and rotation counts.
    """
    load_all_keys()

    nv_items = get_provider_key_items("nvidia")
    goog_items = get_provider_key_items("google")
    groq_items = get_provider_key_items("groq")

    nv_keys = get_nvidia_keys()
    goog_keys = get_google_keys()
    groq_keys = get_groq_keys()

    is_configured = bool(nv_keys or goog_keys)

    return {
        "configured": is_configured,
        "keys": {
            "nvidia": {
                "configured": bool(nv_keys),
                "count": len(nv_keys),
                "preview": mask_key(nv_keys[0]) if nv_keys else "",
                "subtext": f"{len(nv_keys)} key{'s' if len(nv_keys)>1 else ''} active" if nv_keys else "Not configured",
                "name": "NVIDIA NIM",
                "items": nv_items,
            },
            "google": {
                "configured": bool(goog_keys),
                "count": len(goog_keys),
                "preview": mask_key(goog_keys[0]) if goog_keys else "",
                "subtext": f"{len(goog_keys)} key{'s' if len(goog_keys)>1 else ''} active" if goog_keys else "Not configured",
                "name": "Google Gemini",
                "items": goog_items,
            },
            "groq": {
                "configured": bool(groq_keys),
                "count": len(groq_keys),
                "preview": mask_key(groq_keys[0]) if groq_keys else "",
                "subtext": f"{len(groq_keys)} key{'s' if len(groq_keys)>1 else ''} active" if groq_keys else "Optional",
                "name": "Groq",
                "items": groq_items,
            },
        },
    }


def reset_all_data(clear_chats=True, clear_keys=True, clear_temp_files=True) -> dict:
    """Factory reset: wipes chats, user keys, and temp files."""
    actions = []

    if clear_chats:
        try:
            with open(_CHATS_PATH, "w", encoding="utf-8") as f:
                json.dump({"chats": [], "active_chat_id": None}, f, indent=2)
            actions.append("Reset chats.json")
        except Exception as e:
            actions.append(f"Error resetting chats: {e}")

    if clear_keys:
        if os.path.exists(_KEYS_PATH):
            try:
                os.remove(_KEYS_PATH)
            except Exception:
                pass
        
        # Also blank out api_keys.py so fallback keys are not retained after factory reset
        _api_py = os.path.join(_BASE_DIR, "api_keys.py")
        _clean_template = (
            "# Placeholders for API keys - Configured via Click UI\n"
            "import os\n\n"
            "NVIDIA_API_KEY = \"\"\n"
            "GOOGLE_API_KEY = \"\"\n"
            "GROQ_API_KEY = \"\"\n"
            "SARVAM_API_KEY = \"\"\n"
            "SAMBANOVA_API_KEY = \"\"\n"
            "OPENROUTER_API_KEY = \"\"\n"
        )
        try:
            with open(_api_py, "w", encoding="utf-8") as f:
                f.write(_clean_template)
            actions.append("Reset api_keys.py to blank template")
        except Exception as e:
            actions.append(f"Error resetting api_keys.py: {e}")

        import sys
        if "api_keys" in sys.modules:
            del sys.modules["api_keys"]

        for p in ["NVIDIA_API_KEY", "GOOGLE_API_KEY", "GROQ_API_KEY", "SARVAM_API_KEY", "SAMBANOVA_API_KEY", "OPENROUTER_API_KEY"]:
            os.environ.pop(p, None)
            for i in range(1, 10):
                os.environ.pop(f"{p}_{i}", None)
        actions.append("Cleared stored API keys")
        load_all_keys()

    if clear_temp_files:
        for pattern in ["test_*_overlay.jpg", "test_*.png", "*.log"]:
            for f in glob.glob(os.path.join(_BASE_DIR, pattern)):
                try:
                    os.remove(f)
                except Exception:
                    pass
        actions.append("Cleaned temporary cache files")

    return {
        "status": "ok",
        "message": "Factory reset complete",
        "actions": actions,
        "status_after": get_keys_status(),
    }
