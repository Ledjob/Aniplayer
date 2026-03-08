#!/usr/bin/env python3
"""
字幕プレイヤー · Backend Server
────────────────────────────────
Routes:
  GET  /lookup?w=<word>     → proxy Jisho API (avoids CORS)
  POST /anki/add-card       → FFmpeg extract + storeMediaFile + addNote
  GET  /*                   → serve static files (aniplayer.html etc.)

Usage:
    python server.py

Then open: http://localhost:8766/aniplayer.html

Requirements:
  - FFmpeg in PATH  →  https://ffmpeg.org/download.html
  - Anki open with AnkiConnect plugin
"""

from http.server import HTTPServer, SimpleHTTPRequestHandler
from urllib.request import urlopen, Request
from urllib.parse import urlparse, parse_qs, urlencode
import json, os, subprocess, tempfile, base64, uuid, sys

OUR_PORT  = 8766
ANKI_PORT = 8765
ANKI_URL  = f'http://127.0.0.1:{ANKI_PORT}'
HTML_DIR  = os.path.dirname(os.path.abspath(__file__))


# ── FFMPEG ────────────────────────────────────────────────────────────────────

def check_ffmpeg():
    try:
        subprocess.run(['ffmpeg', '-version'], capture_output=True, check=True)
        return True
    except (FileNotFoundError, subprocess.CalledProcessError):
        return False

def extract_audio(video_path, start, end, out_path):
    cmd = [
        'ffmpeg', '-y',
        '-ss', str(start),
        '-i', video_path,
        '-t', str(end - start),
        '-vn',
        '-acodec', 'libmp3lame',
        '-q:a', '3',
        '-ac', '2',
        out_path
    ]
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        raise RuntimeError(f'FFmpeg audio:\n{r.stderr[-500:]}')

def extract_screenshot(video_path, timestamp, out_path):
    cmd = [
        'ffmpeg', '-y',
        '-ss', str(timestamp),
        '-i', video_path,
        '-frames:v', '1',
        '-q:v', '3',
        '-vf', 'scale=1280:-1',
        out_path
    ]
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        raise RuntimeError(f'FFmpeg screenshot:\n{r.stderr[-500:]}')

def to_b64(path):
    with open(path, 'rb') as f:
        return base64.b64encode(f.read()).decode('ascii')


# ── ANKICONNECT ───────────────────────────────────────────────────────────────

def anki(action, **params):
    body = json.dumps({'action': action, 'version': 6, 'params': params}).encode()
    req = Request(ANKI_URL, data=body,
                  headers={'Content-Type': 'application/json'}, method='POST')
    with urlopen(req, timeout=10) as resp:
        return json.loads(resp.read().decode('utf-8'))

def anki_store_media(filename, data_b64):
    r = anki('storeMediaFile', filename=filename, data=data_b64)
    if r.get('error'):
        raise RuntimeError(f'storeMediaFile: {r["error"]}')

def anki_add_note(fields, tags):
    r = anki('addNote', note={
        'deckName':  'JapaneseMining',
        'modelName': 'SubMining',
        'fields':    fields,
        'options':   {'allowDuplicate': False, 'duplicateScope': 'deck'},
        'tags':      tags,
    })
    if r.get('error'):
        raise RuntimeError(r['error'])
    return r['result']


# ── HTTP HANDLER ──────────────────────────────────────────────────────────────

class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=HTML_DIR, **kwargs)

    def do_GET(self):
        p = urlparse(self.path)
        if p.path == '/':
            self.send_response(302)
            self.send_header('Location', '/aniplayer.html')
            self.end_headers()
        elif p.path == '/lookup':
            self._lookup(parse_qs(p.query))
        else:
            super().do_GET()

    def do_POST(self):
        p = urlparse(self.path)
        if p.path == '/anki/add-card':
            self._anki_add()
        else:
            self.send_error(404)

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    # ── lookup ────────────────────────────────────────────────────────────────

    def _lookup(self, params):
        word = params.get('w', [''])[0]
        if not word:
            self.send_json({'meanings': []}); return
        try:
            url = f'https://jisho.org/api/v1/search/words?{urlencode({"keyword": word})}'
            with urlopen(Request(url, headers={'User-Agent': 'aniplayer/1.0'}), timeout=5) as resp:
                data = json.loads(resp.read().decode('utf-8'))
            meanings = []
            if data.get('data'):
                for sense in data['data'][0].get('senses', []):
                    meanings.extend(sense.get('english_definitions', []))
                    if len(meanings) >= 6: break
            self.send_json({'meanings': meanings[:6], 'word': word})
            self._log(f'✓ lookup "{word}" → {len(meanings)} meanings')
        except Exception as e:
            self._log(f'✗ Jisho "{word}": {e}')
            self.send_json({'meanings': [], 'error': str(e)})

    # ── anki/add-card ─────────────────────────────────────────────────────────

    def _anki_add(self):
        length = int(self.headers.get('Content-Length', 0))
        if not length:
            self.send_json({'success': False, 'error': 'Empty body'}, 400); return
        try:
            payload = json.loads(self.rfile.read(length).decode('utf-8'))
        except Exception as e:
            self.send_json({'success': False, 'error': f'Bad JSON: {e}'}, 400); return

        jp             = payload.get('jp', '').strip()
        fr             = payload.get('fr', '')
        word           = payload.get('word', '')          # plain text — used for dedup
        jp_html        = payload.get('jp_html', '') or jp  # furigana ruby HTML
        meaning        = payload.get('meaning', '')
        source         = payload.get('source', '')
        video_path     = payload.get('video_path', '').strip()
        start_time     = float(payload.get('start_time', 0))
        end_time       = float(payload.get('end_time', 0))
        screenshot_b64 = payload.get('screenshot', '')   # canvas capture from browser

        if not jp:
            self.send_json({'success': False, 'error': '"jp" required'}, 400); return

        vname = os.path.basename(video_path) if video_path else '(no video — type path in controls bar)'
        self._log(f'→ Mining: "{word}" | {start_time:.2f}→{end_time:.2f}s | {vname}')

        uid          = uuid.uuid4().hex[:10]
        audio_field  = ''
        image_field  = ''
        warnings     = []

        video_ok = video_path and os.path.isfile(video_path)
        if video_path and not os.path.isfile(video_path):
            warnings.append(f'Video not found: {video_path}')
            self._log(f'  ⚠ Video not found: {video_path}')

        with tempfile.TemporaryDirectory() as tmp:

            # ── Screenshot ────────────────────────────────────────────────────
            img_path = None

            if screenshot_b64:
                # Browser canvas capture — fast and always available
                img_path = os.path.join(tmp, f'img_{uid}.jpg')
                try:
                    raw = screenshot_b64.split(',', 1)[-1]   # strip data:image/...;base64,
                    with open(img_path, 'wb') as f:
                        f.write(base64.b64decode(raw))
                    self._log('  ✓ Screenshot ← canvas')
                except Exception as e:
                    warnings.append(f'Screenshot decode: {e}')
                    img_path = None

            if img_path is None and video_ok:
                # Fallback: FFmpeg screenshot at midpoint of subtitle
                img_path = os.path.join(tmp, f'img_{uid}.jpg')
                try:
                    mid = (start_time + end_time) / 2
                    extract_screenshot(video_path, mid, img_path)
                    self._log(f'  ✓ Screenshot ← FFmpeg @{mid:.2f}s')
                except Exception as e:
                    warnings.append(f'FFmpeg screenshot: {e}')
                    img_path = None

            # ── Audio ─────────────────────────────────────────────────────────
            audio_path = None

            if video_ok and end_time > start_time:
                audio_path = os.path.join(tmp, f'audio_{uid}.mp3')
                try:
                    extract_audio(video_path, start_time, end_time, audio_path)
                    self._log(f'  ✓ Audio ← FFmpeg ({end_time-start_time:.2f}s)')
                except Exception as e:
                    warnings.append(f'FFmpeg audio: {e}')
                    audio_path = None

            # ── Upload media to Anki ───────────────────────────────────────────
            if img_path and os.path.isfile(img_path):
                try:
                    fname = f'submining_img_{uid}.jpg'
                    anki_store_media(fname, to_b64(img_path))
                    image_field = f'<img src="{fname}">'
                    self._log(f'  ✓ Image → Anki: {fname}')
                except Exception as e:
                    warnings.append(f'Image upload: {e}')

            if audio_path and os.path.isfile(audio_path):
                try:
                    fname = f'submining_audio_{uid}.mp3'
                    anki_store_media(fname, to_b64(audio_path))
                    audio_field = f'[sound:{fname}]'
                    self._log(f'  ✓ Audio → Anki: {fname}')
                except Exception as e:
                    warnings.append(f'Audio upload: {e}')

        # ── Create note ───────────────────────────────────────────────────────
        try:
            note_id = anki_add_note({
                'Word':    word,      # plain text → clean dedup
                'JP':      jp_html,   # furigana ruby HTML
                'FR':      fr,
                'Meaning': meaning,
                'Audio':   audio_field,
                'Image':   image_field,
                'Source':  source,
            }, tags=['subtitle_mining'])

            self._log(f'  ✓ Card #{note_id} | audio={bool(audio_field)} img={bool(image_field)}')
            if warnings:
                self._log(f'  ⚠ Warnings: {warnings}')

            self.send_json({
                'success':   True,
                'note_id':   note_id,
                'has_audio': bool(audio_field),
                'has_image': bool(image_field),
                'warnings':  warnings,
            })

        except ConnectionRefusedError:
            msg = f'Anki unreachable at {ANKI_URL} — is Anki open?'
            self._log(f'  ✗ {msg}')
            self.send_json({'success': False, 'error': msg})
        except Exception as e:
            self._log(f'  ✗ {e}')
            self.send_json({'success': False, 'error': str(e)})

    # ── helpers ───────────────────────────────────────────────────────────────

    def send_json(self, data, status=200):
        try:
            body = json.dumps(data, ensure_ascii=False).encode('utf-8')
            self.send_response(status)
            self.send_header('Content-Type', 'application/json; charset=utf-8')
            self.send_header('Content-Length', len(body))
            self._cors()
            self.end_headers()
            self.wfile.write(body)
        except (ConnectionAbortedError, ConnectionResetError, BrokenPipeError):
            pass

    def _cors(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')

    def _log(self, msg): print(f'  {msg}')
    def log_message(self, *a): pass

    def handle_error(self, request, client_address):
        exc = sys.exc_info()[1]
        if isinstance(exc, (ConnectionAbortedError, ConnectionResetError, BrokenPipeError)):
            return
        super().handle_error(request, client_address)


# ── MAIN ──────────────────────────────────────────────────────────────────────

if __name__ == '__main__':
    ffmpeg_ok = check_ffmpeg()
    server = HTTPServer(('localhost', OUR_PORT), Handler)
    print()
    print('  字幕プレイヤー · Backend Server')
    print('  ──────────────────────────────────────────────')
    print(f'  Server      → http://localhost:{OUR_PORT}')
    print(f'  AnkiConnect → http://localhost:{ANKI_PORT}')
    print(f'  FFmpeg      → {"✓ found" if ffmpeg_ok else "✗ NOT FOUND — install from ffmpeg.org"}')
    print()
    print(f'  ▶  Open: http://localhost:{OUR_PORT}/aniplayer.html')
    print()
    print('  (Ctrl+C to stop)')
    print()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print('\n  Server stopped.')