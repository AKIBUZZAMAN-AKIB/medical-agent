#!/usr/bin/env python3
"""Tiny password gate for nginx auth_request.

Listens on 127.0.0.1 only. nginx calls /check on every request; a valid
signed cookie returns 204, anything else 401. /__gate/login shows a password
form and sets the cookie. No secrets are ever logged or returned.
"""
import hashlib
import hmac
import json
import os
import threading
import time
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
with open(os.path.join(HERE, 'gate.json')) as f:
    CFG = json.load(f)
SALT = bytes.fromhex(CFG['salt'])
HASH = bytes.fromhex(CFG['hash'])
KEY = bytes.fromhex(CFG['cookie_key'])
COOKIE = '__Host-ma_gate'
TTL = 7 * 24 * 3600

# Failed-login throttling: per client IP and global.
_lock = threading.Lock()
_fails = {}
_global = []
MAX_PER_IP = 5      # per 15 minutes
MAX_GLOBAL = 30     # per 15 minutes
WINDOW = 900


def _prune(now):
    for ip in list(_fails):
        _fails[ip] = [t for t in _fails[ip] if now - t < WINDOW]
        if not _fails[ip]:
            del _fails[ip]
    _global[:] = [t for t in _global if now - t < WINDOW]


def throttled(ip):
    now = time.time()
    with _lock:
        _prune(now)
        return len(_fails.get(ip, [])) >= MAX_PER_IP or len(_global) >= MAX_GLOBAL


def record_fail(ip):
    now = time.time()
    with _lock:
        _fails.setdefault(ip, []).append(now)
        _global.append(now)


def sign(host, exp):
    msg = f'{host}|{exp}'.encode()
    return hmac.new(KEY, msg, hashlib.sha256).hexdigest()


def valid_cookie(header, host):
    if not header:
        return False
    for part in header.split(';'):
        name, _, value = part.strip().partition('=')
        if name != COOKIE:
            continue
        exp_s, _, sig = value.partition('.')
        try:
            exp = int(exp_s)
        except ValueError:
            return False
        if exp < time.time():
            return False
        return hmac.compare_digest(sig, sign(host, exp))
    return False


def check_password(pw):
    h = hashlib.scrypt(pw.encode(), salt=SALT, n=2**14, r=8, p=1)
    return hmac.compare_digest(h, HASH)


def page(title, msg=''):
    note = f'<p class="err">{msg}</p>' if msg else ''
    return f"""<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>{title}</title>
<style>body{{font-family:system-ui,sans-serif;background:#0f172a;color:#e2e8f0;display:flex;
min-height:100vh;align-items:center;justify-content:center;margin:0}}
form{{background:#1e293b;padding:28px;border-radius:12px;width:min(340px,90vw)}}
h1{{font-size:20px;margin:0 0 6px}}p{{font-size:14px;color:#94a3b8}}
input{{width:100%;box-sizing:border-box;padding:12px;font-size:16px;border-radius:8px;border:1px solid #334155;
background:#0f172a;color:#e2e8f0;margin:10px 0}}button{{width:100%;padding:12px;font-size:16px;border:0;
border-radius:8px;background:#3b82f6;color:white}}.err{{color:#f87171}}</style></head><body>
<form method="post" action="/__gate/login"><h1>{title}</h1><p>Enter the access password.</p>{note}
<input type="password" name="password" autocomplete="current-password" autofocus required>
<button type="submit">Continue</button></form></body></html>"""


class H(BaseHTTPRequestHandler):
    server_version = 'gate'
    sys_version = ''

    def log_message(self, fmt, *args):  # never log request lines (no secrets in them, but keep quiet)
        pass

    def _host(self):
        return (self.headers.get('X-Gate-Host') or self.headers.get('Host') or '').lower()

    def _ip(self):
        return self.headers.get('X-Real-IP') or self.client_address[0]

    def _send(self, code, body=b'', ctype='text/html; charset=utf-8', extra=None):
        self.send_response(code)
        self.send_header('Content-Type', ctype)
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Frame-Options', 'DENY')
        self.send_header('Referrer-Policy', 'no-referrer')
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _title(self):
        return self.headers.get('X-Gate-Title') or 'Medical Agent'

    def do_GET(self):
        path = urllib.parse.urlsplit(self.path).path
        if path == '/check':
            ok = valid_cookie(self.headers.get('Cookie'), self._host())
            return self._send(204 if ok else 401)
        if path == '/__gate/login':
            if valid_cookie(self.headers.get('Cookie'), self._host()):
                return self._send(302, extra={'Location': '/'})
            return self._send(200, page(self._title()).encode())
        return self._send(404, b'not found', 'text/plain')

    def do_POST(self):
        path = urllib.parse.urlsplit(self.path).path
        if path != '/__gate/login':
            return self._send(404, b'not found', 'text/plain')
        ip = self._ip()
        if throttled(ip):
            return self._send(429, page(self._title(), 'Too many attempts. Try again in 15 minutes.').encode())
        try:
            n = min(int(self.headers.get('Content-Length') or 0), 4096)
        except ValueError:
            n = 0
        form = urllib.parse.parse_qs(self.rfile.read(n).decode('utf-8', 'replace'))
        pw = (form.get('password') or [''])[0].strip()
        if not pw or not check_password(pw):
            record_fail(ip)
            time.sleep(1)
            return self._send(401, page(self._title(), 'Wrong password.').encode())
        with _lock:  # a correct password clears this IP's earlier typos (shared mobile IPs)
            _fails.pop(ip, None)
        exp = int(time.time()) + TTL
        cookie = (f'{COOKIE}={exp}.{sign(self._host(), exp)}; Max-Age={TTL}; Path=/; '
                  'Secure; HttpOnly; SameSite=Lax')
        return self._send(303, extra={'Location': '/', 'Set-Cookie': cookie})


if __name__ == '__main__':
    ThreadingHTTPServer(('127.0.0.1', 9099), H).serve_forever()
