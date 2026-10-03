"""
Realistic API latency test — uses a ~100KB synthetic image (similar to actual screenshot size)
to measure the REAL Google AI Studio response time with full payloads.
"""
import os, sys, json, time, base64, requests

_BASE_DIR = os.path.dirname(os.path.abspath(__file__))
if _BASE_DIR not in sys.path:
    sys.path.insert(0, _BASE_DIR)

try:
    import api_keys
    GOOGLE_API_KEY = api_keys.GOOGLE_API_KEY
except ImportError:
    GOOGLE_API_KEY = os.environ.get("GOOGLE_API_KEY", "")

API_URL = "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions"
MODEL = "gemini-3.5-flash-lite"
HEADERS = {"Authorization": f"Bearer {GOOGLE_API_KEY}", "Content-Type": "application/json"}
session = requests.Session()

# Generate a synthetic JPEG-like payload of ~150KB (simulates a compressed screenshot)
FAKE_IMAGE_B64 = base64.b64encode(os.urandom(110000)).decode('ascii')

def test_with_size(label, img_b64):
    payload_size_kb = round(len(json.dumps({"img": img_b64}).encode()) / 1024)
    
    payload = {
        "model": MODEL,
        "messages": [
            {"role": "system", "content": "You are PrivaPilot. Respond with JSON: {\"thought\": \"...\", \"tool\": \"click\", \"args\": {\"selector\": \"#test\"}}"},
            {"role": "user", "content": [
                {"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{img_b64}"}},
                {"type": "text", "text": "GOAL: Click the search button. DOM: [0] <button id='search'>Search</button>. Respond JSON only."}
            ]}
        ],
        "max_tokens": 500,
        "temperature": 0.1
    }
    
    total_payload_kb = round(len(json.dumps(payload).encode()) / 1024)
    
    t0 = time.perf_counter()
    try:
        resp = session.post(API_URL, headers=HEADERS, json=payload, timeout=45)
        elapsed_ms = round((time.perf_counter() - t0) * 1000)
        status = f"HTTP {resp.status_code}"
        if resp.status_code == 200:
            content = resp.json()["choices"][0]["message"]["content"][:80]
        else:
            content = resp.text[:80]
    except Exception as e:
        elapsed_ms = round((time.perf_counter() - t0) * 1000)
        status = f"ERROR: {e}"
        content = ""
    
    print(f"  {label}: {elapsed_ms}ms | Payload: {total_payload_kb}KB | {status}")
    if content:
        print(f"    Response: {content}")
    return elapsed_ms

print("=" * 65)
print("  REALISTIC Image Size API Latency Test")
print(f"  Model: {MODEL}")
print("=" * 65)

# Test 1: Tiny image (like before)
tiny = base64.b64encode(b'\x89PNG\r\n' + os.urandom(50)).decode('ascii')
print("\nTest 1: Tiny image (~0.1KB)")
t1 = test_with_size("Tiny", tiny)

# Test 2: ~50KB image (compressed low-quality screenshot)
med = base64.b64encode(os.urandom(37000)).decode('ascii')
print(f"\nTest 2: Medium image (~50KB b64)")
t2 = test_with_size("50KB", med)

# Test 3: ~150KB image (typical full-quality screenshot)
large = base64.b64encode(os.urandom(110000)).decode('ascii')
print(f"\nTest 3: Large image (~150KB b64)")
t3 = test_with_size("150KB", large)

# Test 4: ~300KB image (high-DPI screenshot)
xlarge = base64.b64encode(os.urandom(220000)).decode('ascii')
print(f"\nTest 4: XLarge image (~300KB b64)")
t4 = test_with_size("300KB", xlarge)

print("\n" + "=" * 65)
print("  SUMMARY")
print("=" * 65)
for name, ms in [("Tiny", t1), ("50KB", t2), ("150KB", t3), ("300KB", t4)]:
    bar = "#" * min(50, ms // 100)
    print(f"  {name:<8} {ms:>6}ms  {bar}")
print()
