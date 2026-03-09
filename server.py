#!/usr/bin/env python3
"""
字幕プレイヤー · Backend Server
────────────────────────────────
Routes:
  GET  /lookup?w=<word>     → proxy Jisho API (avoids CORS)
  POST /anki/add-card       → FFmpeg extract + storeMediaFile + addNote
  POST /chat                → Anthropic API grammar chat (SSE streaming)
  GET  /*                   → serve static files (aniplayer.html etc.)

Usage:
    python server.py

Then open: http://localhost:8766/aniplayer.html

Requirements:
  - FFmpeg in PATH  →  https://ffmpeg.org/download.html
  - Anki open with AnkiConnect plugin
  - ANTHROPIC_API_KEY env var (or set in server.py)
"""

from http.server import HTTPServer, SimpleHTTPRequestHandler
from urllib.request import urlopen, Request
from urllib.parse import urlparse, parse_qs, urlencode
import json, os, subprocess, tempfile, base64, uuid, sys

OUR_PORT  = 8766
ANKI_PORT = 8765
ANKI_URL  = f'http://127.0.0.1:{ANKI_PORT}'
HTML_DIR  = os.path.dirname(os.path.abspath(__file__))

# ── ANTHROPIC ─────────────────────────────────────────────────────────────────
# Set your API key here OR in the ANTHROPIC_API_KEY environment variable
ANTHROPIC_API_KEY = os.environ.get('ANTHROPIC_API_KEY', '')
ANTHROPIC_URL     = 'https://api.anthropic.com/v1/messages'
CHAT_MODEL        = 'claude-opus-4-5'


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
        elif p.path == '/chat':
            self._chat()
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

    # ── /chat ─────────────────────────────────────────────────────────────────

    def _chat(self):
        length = int(self.headers.get('Content-Length', 0))
        if not length:
            self.send_json({'error': 'Empty body'}, 400); return
        try:
            payload = json.loads(self.rfile.read(length).decode('utf-8'))
        except Exception as e:
            self.send_json({'error': f'Bad JSON: {e}'}, 400); return

        api_key = payload.get('api_key', '').strip() or ANTHROPIC_API_KEY
        if not api_key:
            self.send_json({'error': 'No API key — set ANTHROPIC_API_KEY or pass api_key in request'}, 400)
            return

        # Build system prompt with subtitle context
        current_jp  = payload.get('current_jp', '')
        current_fr  = payload.get('current_fr', '')
        context_subs = payload.get('context_subs', [])   # [{jp, fr, offset}, ...]
        selected_word = payload.get('selected_word', '')
        selected_meaning = payload.get('selected_meaning', '')
        messages    = payload.get('messages', [])

        ctx_lines = []
        for s in context_subs:
            off = s.get('offset', 0)
            marker = '▶' if off == 0 else f'  {off:+d}'
            jp_line = s.get('jp', '')
            fr_line = s.get('fr', '')
            ctx_lines.append(f'{marker}  {jp_line}' + (f'  [{fr_line}]' if fr_line else ''))

        system = f"""You are a Japanese grammar tutor embedded in an anime subtitle player.
The user is watching anime and studying Japanese. They will ask questions about the current subtitle.

CURRENT SUBTITLE:
  JP: {current_jp or '(none)'}
  FR: {current_fr or '(none)'}
{f'  Selected word: 「{selected_word}」 ({selected_meaning})' if selected_word else ''}

SURROUNDING CONTEXT (▶ = current line):
{chr(10).join(ctx_lines) if ctx_lines else '  (no context)'}

YOUR ROLE:
- Explain Japanese grammar structures in the current subtitle
- Break down particles, verb forms, conjugations, sentence patterns
- Identify grammar points (て-form, conditional, passive, causative, etc.)
- Give examples when helpful
- Be concise but thorough — the user is watching anime, keep it focused

LANGUAGE: Detect the user's language from their message and reply in the same language (French or English).
If the message is in French, answer in French. If in English, answer in English.
Use Japanese characters freely when discussing grammar points."""

        # SSE streaming response
        try:
            body = json.dumps({
                'model': CHAT_MODEL,
                'max_tokens': 1024,
                'system': system,
                'messages': messages,
                'stream': True,
            }).encode('utf-8')

            req = Request(
                ANTHROPIC_URL,
                data=body,
                headers={
                    'Content-Type':      'application/json',
                    'x-api-key':         api_key,
                    'anthropic-version': '2023-06-01',
                },
                method='POST'
            )

            self.send_response(200)
            self.send_header('Content-Type', 'text/event-stream; charset=utf-8')
            self.send_header('Cache-Control', 'no-cache')
            self.send_header('Connection', 'keep-alive')
            self._cors()
            self.end_headers()

            with urlopen(req, timeout=60) as resp:
                for raw_line in resp:
                    line = raw_line.decode('utf-8').rstrip('\n')
                    if not line.startswith('data: '):
                        continue
                    data_str = line[6:]
                    if data_str == '[DONE]':
                        self.wfile.write(b'data: [DONE]\n\n')
                        self.wfile.flush()
                        break
                    try:
                        chunk = json.loads(data_str)
                        if chunk.get('type') == 'content_block_delta':
                            delta = chunk.get('delta', {})
                            if delta.get('type') == 'text_delta':
                                text = delta.get('text', '')
                                out = json.dumps({'text': text}, ensure_ascii=False)
                                self.wfile.write(f'data: {out}\n\n'.encode('utf-8'))
                                self.wfile.flush()
                    except Exception:
                        pass

            # Explicitly close the connection so the browser reader finishes
            self.wfile.flush()
            self.close_connection = True

            self._log(f'✓ Chat | {current_jp[:30]}')

        except (ConnectionAbortedError, ConnectionResetError, BrokenPipeError):
            pass  # client closed connection mid-stream
        except Exception as e:
            self._log(f'✗ Chat error: {e}')
            try:
                err_out = json.dumps({'error': str(e)}, ensure_ascii=False)
                self.wfile.write(f'data: {err_out}\n\n'.encode('utf-8'))
                self.wfile.flush()
            except Exception:
                pass

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
    api_key_ok = bool(ANTHROPIC_API_KEY)
    server = HTTPServer(('localhost', OUR_PORT), Handler)
    print()
    print('  字幕プレイヤー · Backend Server')
    print('  ──────────────────────────────────────────────')
    print(f'  Server      → http://localhost:{OUR_PORT}')
    print(f'  AnkiConnect → http://localhost:{ANKI_PORT}')
    print(f'  FFmpeg      → {"✓ found" if ffmpeg_ok else "✗ NOT FOUND — install from ffmpeg.org"}')
    print(f'  Anthropic   → {"✓ API key set" if api_key_ok else "⚠ no key — set ANTHROPIC_API_KEY or enter in chat panel"}')
    print()
    print(f'  ▶  Open: http://localhost:{OUR_PORT}/aniplayer.html')
    print()
    print('  (Ctrl+C to stop)')
    print()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print('\n  Server stopped.')