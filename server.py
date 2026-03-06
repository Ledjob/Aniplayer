#!/usr/bin/env python3
"""
Mini proxy server for aniplayer.html
Proxies Jisho API requests to avoid CORS when opening the HTML from file://

Usage:
    python server.py

Then open aniplayer.html in your browser.
Server runs on http://localhost:8765
"""

from http.server import HTTPServer, SimpleHTTPRequestHandler
from urllib.request import urlopen, Request
from urllib.parse import urlparse, parse_qs, urlencode
import json
import os

PORT = 8765
HTML_DIR = os.path.dirname(os.path.abspath(__file__))

class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=HTML_DIR, **kwargs)

    def do_GET(self):
        parsed = urlparse(self.path)

        # ── /lookup?w=word  →  proxy to Jisho ──
        if parsed.path == '/lookup':
            params = parse_qs(parsed.query)
            word = params.get('w', [''])[0]
            if not word:
                self.send_json({'meanings': []})
                return
            try:
                encoded = urlencode({'keyword': word})
                url = f'https://jisho.org/api/v1/search/words?{encoded}'
                req = Request(url, headers={'User-Agent': 'aniplayer/1.0'})
                with urlopen(req, timeout=5) as resp:
                    data = json.loads(resp.read().decode('utf-8'))

                meanings = []
                if data.get('data'):
                    entry = data['data'][0]
                    for sense in entry.get('senses', []):
                        meanings.extend(sense.get('english_definitions', []))
                        if len(meanings) >= 6:
                            break

                self.send_json({'meanings': meanings[:6], 'word': word})
            except Exception as e:
                print(f'  Jisho error for "{word}": {e}')
                self.send_json({'meanings': [], 'error': str(e)})

        # ── serve static files (aniplayer.html etc.) ──
        else:
            super().do_GET()

    def send_json(self, data):
        body = json.dumps(data, ensure_ascii=False).encode('utf-8')
        self.send_response(200)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', len(body))  # type: ignore
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):
        # only log lookup requests, skip static file noise
        if '/lookup' in (args[0] if args else ''):
            word = ''
            try:
                word = parse_qs(urlparse(args[0].split()[1]).query).get('w', [''])[0]
            except:
                pass
            print(f'  [{args[1]}] lookup: {word}')


if __name__ == '__main__':
    server = HTTPServer(('localhost', PORT), Handler)
    print(f'')
    print(f'  字幕プレイヤー · Proxy Server')
    print(f'  ─────────────────────────────')
    print(f'  Running on http://localhost:{PORT}')
    print(f'  Open: http://localhost:{PORT}/aniplayer.html')
    print(f'')
    print(f'  (Ctrl+C to stop)')
    print(f'')
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print('\n  Server stopped.')