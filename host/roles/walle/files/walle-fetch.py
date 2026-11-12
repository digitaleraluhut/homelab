#!/usr/bin/env python3
"""GET-only web access for WALL-E (host role walle).

WALL-E's service may only reach localhost. This proxy listens on 127.0.0.1 and
performs exactly one kind of request on its behalf: an HTTPS GET to a host on
an allowlist, without cookies or credentials, size- and time-limited. Every URL
is logged. It can never send another method or a request body, so "GET only"
is enforced by construction, not by agreement.

    GET http://127.0.0.1:<port>/?url=<urlencoded https URL>
    -> the upstream status, content type and body (at most MAX_BYTES)

Configuration (environment): WALLE_FETCH_PORT, WALLE_FETCH_ALLOW (space-separated
domains; a domain also allows its subdomains).
"""

import http.server
import ipaddress
import os
import socket
import sys
import urllib.error
import urllib.parse
import urllib.request

MAX_BYTES = 2 * 1024 * 1024
TIMEOUT = 20
MAX_REDIRECTS = 5
ACCEPT_ALLOWED = ("text/", "application/json", "application/vnd.", "application/xml", "*/*")


def host_allowed(host: str, allow: list[str]) -> bool:
    host = host.lower().rstrip(".")
    return any(host == d or host.endswith("." + d) for d in allow)


def check_url(url: str, allow: list[str], resolve=socket.getaddrinfo) -> str | None:
    """Why this URL may not be fetched, or None."""
    try:
        u = urllib.parse.urlsplit(url)
    except ValueError:
        return "not a URL"
    if u.scheme != "https":
        return "only https URLs"
    if u.username or u.password:
        return "no credentials in URLs"
    if not u.hostname or not host_allowed(u.hostname, allow):
        return f"host {u.hostname!r} is not on the allowlist"
    if u.port not in (None, 443):
        return "only port 443"
    try:
        addrs = {a[4][0] for a in resolve(u.hostname, 443, proto=socket.IPPROTO_TCP)}
    except OSError as e:
        return f"cannot resolve {u.hostname}: {e}"
    for a in addrs:
        if not ipaddress.ip_address(a.split("%")[0]).is_global:
            return f"{u.hostname} resolves to a non-public address"
    return None


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):  # redirects are followed by hand, each one checked
        return None


def fetch(url: str, accept: str, allow: list[str]):
    """Returns (status, content_type, body, final_url) or raises ValueError with the reason."""
    opener = urllib.request.build_opener(_NoRedirect)
    for _ in range(MAX_REDIRECTS + 1):
        reason = check_url(url, allow)
        if reason:
            raise ValueError(reason)
        req = urllib.request.Request(url, method="GET", headers={"Accept": accept, "User-Agent": "walle-fetch/1"})
        try:
            resp = opener.open(req, timeout=TIMEOUT)
        except urllib.error.HTTPError as e:
            if e.code in (301, 302, 303, 307, 308) and e.headers.get("Location"):
                url = urllib.parse.urljoin(url, e.headers["Location"])
                continue
            resp = e
        body = resp.read(MAX_BYTES + 1)
        if len(body) > MAX_BYTES:
            body = body[:MAX_BYTES]
        return resp.status, resp.headers.get("Content-Type", "application/octet-stream"), body, url
    raise ValueError("too many redirects")


class Handler(http.server.BaseHTTPRequestHandler):
    allow: list[str] = []

    def _deny(self, code: int, msg: str):
        self.send_response(code)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.end_headers()
        self.wfile.write(msg.encode())

    def do_GET(self):
        q = urllib.parse.parse_qs(urllib.parse.urlsplit(self.path).query)
        url = (q.get("url") or [""])[0]
        accept = self.headers.get("Accept", "*/*")
        if not accept.startswith(ACCEPT_ALLOWED):
            accept = "*/*"
        try:
            status, ctype, body, final = fetch(url, accept, self.allow)
        except ValueError as e:
            print(f"fetch DENIED {url} : {e}", flush=True)
            return self._deny(403, f"walle-fetch: {e}\n")
        except OSError as e:
            print(f"fetch FAILED {url} : {e}", flush=True)
            return self._deny(502, f"walle-fetch: {e}\n")
        print(f"fetch GET {url} -> {status} {len(body)} bytes" + (f" (via {final})" if final != url else ""), flush=True)
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("X-Final-Url", final)
        self.end_headers()
        self.wfile.write(body)

    def _only_get(self):
        self._deny(405, "walle-fetch: only GET\n")

    do_POST = do_PUT = do_DELETE = do_PATCH = do_HEAD = do_OPTIONS = _only_get

    def log_message(self, *args):  # the fetch lines above are the log
        pass


def main() -> int:
    Handler.allow = [d.lower() for d in os.environ.get("WALLE_FETCH_ALLOW", "").split()]
    port = int(os.environ.get("WALLE_FETCH_PORT", "8898"))
    server = http.server.ThreadingHTTPServer(("127.0.0.1", port), Handler)
    print(f"walle-fetch on 127.0.0.1:{port}, {len(Handler.allow)} allowed domains", flush=True)
    server.serve_forever()
    return 0


if __name__ == "__main__":
    sys.exit(main())
