#!/usr/bin/env python3
"""GET-only web access for WALL-E (host role walle).

WALL-E's service may only reach localhost. This proxy listens on 127.0.0.1 and
performs exactly one kind of request on its behalf: an HTTPS GET to a public
host, without cookies or credentials, size- and time-limited. Every URL is
logged. It can never send another method, a request body or a header of the
client's choosing (only a cleaned Accept), so "GET only" is enforced by
construction, not by agreement.

    GET http://127.0.0.1:<port>/?url=<urlencoded https URL>
    -> the upstream status, content type and body (at most MAX_BYTES)

What matters is that no credential leaves (owner, 2026-11-14); other data is
harmless. So any public host is allowed, and every URL WALL-E asks for is
screened first, before DNS (a host name can carry data too):
  - known secrets: values the proxy reads itself (WALL-E's kube token) in plain,
    URL-encoded, hex, base64 and base64url form, also in chunks;
  - long high-entropy strings in host, path or query (credential-shaped).
    Hex (commit SHAs, digests) is allowed up to 128 characters.
Redirect targets are chosen by the server, so they are screened for known
secrets only (signed download URLs are high-entropy). Screened refusals are
logged as "fetch SCREENED" without the URL's path or query.

Addresses: the host is resolved once, every address must be public, and the
connection goes to the checked address (no second lookup to rebind).

Configuration (environment): WALLE_FETCH_PORT; WALLE_FETCH_SECRET_FILES
(space-separated files with secrets to screen for: kubeconfigs or token files).
"""

import base64
import collections
import http.client
import http.server
import ipaddress
import math
import os
import re
import socket
import ssl
import sys
import urllib.error
import urllib.parse
import urllib.request

MAX_BYTES = 2 * 1024 * 1024
TIMEOUT = 20
MAX_REDIRECTS = 5
USER_AGENT = "walle-fetch/2"

# Screening thresholds (proposal, see the unit tests for real URLs that pass).
WINDOW = 16  # a chunk of a known secret this long is refused
MIN_SECRET = 16  # shorter values are not treated as secrets
MIN_RUN = 20  # alphanumeric strings shorter than this are never judged
MAX_HEX = 128  # longest hex string allowed (sha512)
MIN_HEX = 7  # hex strings this long count as digests and are not judged otherwise
TRANSITIONS = 0.3  # share of lower/upper/digit changes; random base64 ~0.6, words and CamelCase < 0.25
ENTROPY = 4.0  # bits per character of one string with letters and digits (base32, lowercase alphanumeric)
ENTROPY_LONG = 3.8  # the same for strings of 32 characters or more
JOINED_ENTROPY = 4.4  # the same over a run's pieces together; English words stay below ~4.2

NAT64 = ipaddress.ip_network("64:ff9b::/96")
ACCEPT_RE = re.compile(r"[A-Za-z0-9.+*/;=, -]{1,200}")
SECRET_KEYS = re.compile(
    r"^\s*-?\s*(?:token|password|client-key-data|id-token|refresh-token)\s*:\s*[\"']?([^\"'\s#]+)", re.M
)
RUN = re.compile(r"[A-Za-z0-9+/_=-]+")
ALNUM = re.compile(r"[A-Za-z0-9]+")
HEX = re.compile(r"[0-9a-fA-F]+")


class Screened(ValueError):
    """The URL (or header) looks like it carries a credential."""


# --- URL and address checks ---------------------------------------------------


def check_url(url: str) -> str | None:
    """Why this URL may not be fetched (syntax only), or None."""
    try:
        u = urllib.parse.urlsplit(url)
        port = u.port
    except ValueError:
        return "not a URL"
    if u.scheme != "https":
        return "only https URLs"
    if u.username or u.password:
        return "no credentials in URLs"
    if not u.hostname:
        return "no host"
    if port not in (None, 443):
        return "only port 443"
    return None


def _public(addr: str) -> bool:
    ip = ipaddress.ip_address(addr.split("%")[0])
    if ip.version == 6:
        if ip.ipv4_mapped:
            ip = ip.ipv4_mapped
        elif ip in NAT64:
            ip = ipaddress.IPv4Address(int(ip) & 0xFFFFFFFF)
    return ip.is_global and not ip.is_multicast


def public_addresses(host: str, resolve=socket.getaddrinfo) -> list[str]:
    """All addresses of host, if every one is public; ValueError otherwise."""
    try:
        addrs = list(dict.fromkeys(a[4][0] for a in resolve(host, 443, proto=socket.IPPROTO_TCP)))
    except OSError as e:
        raise ValueError(f"cannot resolve {host}: {e}") from None
    if not addrs:
        raise ValueError(f"cannot resolve {host}")
    if not all(_public(a) for a in addrs):
        raise ValueError(f"{host} resolves to a non-public address")
    return addrs


# --- Screening ------------------------------------------------------------------


def load_secrets(paths: list[str]) -> list[str]:
    """Secret values from kubeconfigs (token, keys, passwords) or plain token files."""
    found: list[str] = []
    for path in paths:
        try:
            with open(path, encoding="utf-8", errors="replace") as f:
                text = f.read()
        except OSError:
            continue
        values = SECRET_KEYS.findall(text)
        if not values and len(text.split()) == 1:
            values = [text.strip()]
        found += [v for v in values if len(v) >= MIN_SECRET and v not in found]
    return found


def _b64_cores(data: bytes) -> list[str]:
    """base64 of data at all three alignments, without the edge characters that depend on neighbours."""
    cores = []
    for k, drop in ((0, 0), (1, 2), (2, 3)):
        enc = base64.b64encode(b"\0" * k + data).decode().rstrip("=")
        core = enc[drop:-2] if len(enc) > drop + 2 else ""
        cores += [core, core.replace("+", "-").replace("/", "_")]
    return cores


def _changes(s: str) -> int:
    kind = [0 if c.islower() else 1 if c.isupper() else 2 for c in s]
    return sum(a != b for a, b in zip(kind, kind[1:]))


def _transitions(*segments: str) -> float:
    """Share of neighbouring characters (within each segment) that change between lower, upper and digit."""
    pairs = sum(len(s) - 1 for s in segments)
    return sum(_changes(s) for s in segments) / max(pairs, 1)


def _entropy(s: str) -> float:
    n = len(s)
    return -sum(c / n * math.log2(c / n) for c in collections.Counter(s).values())


def _random_looking(s: str) -> bool:
    if _transitions(s) >= TRANSITIONS:
        return True
    has_digit, has_letter = any(c.isdigit() for c in s), any(c.isalpha() for c in s)
    return len(s) >= 24 and has_digit and has_letter and _entropy(s) >= (ENTROPY if len(s) < 32 else ENTROPY_LONG)


def _decodings(text: str) -> list[str]:
    out = [text]
    for _ in range(3):
        nxt = urllib.parse.unquote(out[-1])
        if nxt == out[-1]:
            break
        out.append(nxt)
    return out


class Screen:
    """Refuses text that carries a known secret or a credential-shaped string."""

    def __init__(self, secrets: list[str]):
        self.whole: set[str] = set()
        self.windows: set[str] = set()
        for s in secrets:
            parts = s.split(".")
            # A JWT's header is the same in every token; only payload and signature identify it.
            core = ".".join(parts[1:]) if len(parts) == 3 and len(parts[0]) < len(s) // 4 else s
            forms = [core, core.encode().hex()] + _b64_cores(core.encode())
            self.whole.add(s)
            for f in forms:
                if len(f) <= WINDOW:
                    self.whole.add(f)
                self.windows.update(f[i : i + WINDOW] for i in range(len(f) - WINDOW + 1))

    def known(self, text: str) -> str | None:
        for t in _decodings(text):
            for variant in (t, t.lower()):
                if any(w in variant for w in self.whole):
                    return "known secret"
                if any(variant[i : i + WINDOW] in self.windows for i in range(len(variant) - WINDOW + 1)):
                    return "known secret"
        return None

    def entropy(self, text: str) -> str | None:
        for t in _decodings(text):
            for run in RUN.findall(t):
                kept = []
                for seg in ALNUM.findall(run):
                    if len(seg) >= MIN_HEX and HEX.fullmatch(seg):
                        if len(seg) > MAX_HEX:
                            return f"high-entropy string (hex, {len(seg)} characters)"
                        continue
                    if len(seg) >= MIN_RUN and _random_looking(seg):
                        return f"high-entropy string ({len(seg)} characters)"
                    kept.append(seg)
                # base64 split into short pieces by + / - _ =
                joined = "".join(kept)
                if len(joined) >= 24 and (
                    _transitions(*kept) >= TRANSITIONS
                    or (len(joined) >= 32 and _entropy(joined) >= JOINED_ENTROPY and any(c.isdigit() for c in joined))
                ):
                    return f"high-entropy string ({len(run)} characters)"
        return None

    def text(self, text: str) -> str | None:
        return self.known(text) or self.entropy(text)

    def url(self, url: str) -> str | None:
        return self.text(url.split("#", 1)[0])


def clean_accept(accept: str, screen: Screen) -> str:
    """The only client header passed on: media ranges only, screened like the URL."""
    reason = screen.text(accept or "")
    if reason:
        raise Screened(f"Accept header: {reason}")
    return accept if ACCEPT_RE.fullmatch(accept or "") else "*/*"


def headers(accept: str) -> dict[str, str]:
    return {"Accept": accept, "User-Agent": USER_AGENT}


def screened_log_line(url: str, reason: str, screen: Screen) -> str:
    """The log line for a screened refusal: marker, host (if harmless), length; never path or query."""
    try:
        host = urllib.parse.urlsplit(url).netloc
    except ValueError:
        host = ""
    if not host or screen.text(host) or len(host) > 100:
        host = "[host withheld]"
    return f"fetch SCREENED https://{host}/[{len(url)} characters withheld] : {reason}"


# --- Fetching -------------------------------------------------------------------


class _PinnedHTTPS(http.client.HTTPSConnection):
    """Connects to an address checked before, with SNI and certificate check for the host name."""

    def __init__(self, host, addr, **kw):
        super().__init__(host, **kw)
        self._addr = addr

    def connect(self):
        sock = socket.create_connection((self._addr, self.port), self.timeout)
        self.sock = self._context.wrap_socket(sock, server_hostname=self.host)


class _PinnedHandler(urllib.request.HTTPSHandler):
    def __init__(self, addr):
        super().__init__(context=ssl.create_default_context())
        self._addr = addr

    def https_open(self, req):
        return self.do_open(lambda host, **kw: _PinnedHTTPS(host, self._addr, **kw), req, context=self._context)


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):  # redirects are followed by hand, each one checked
        return None


def open_pinned(url: str, addr: str, accept: str):
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), _NoRedirect, _PinnedHandler(addr))
    return opener.open(urllib.request.Request(url, method="GET", headers=headers(accept)), timeout=TIMEOUT)


def fetch(url: str, accept: str, screen: Screen, resolve=socket.getaddrinfo, open_fn=open_pinned):
    """Returns (status, content_type, body, final_url); raises Screened or ValueError with the reason."""
    first = True
    for _ in range(MAX_REDIRECTS + 1):
        reason = screen.url(url) if first else screen.known(url)
        if reason:
            raise Screened(reason)
        reason = check_url(url)
        if reason:
            raise ValueError(reason)
        addrs = public_addresses(urllib.parse.urlsplit(url).hostname, resolve)
        try:
            resp = open_fn(url, addrs[0], accept)
        except urllib.error.HTTPError as e:
            if e.code in (301, 302, 303, 307, 308) and e.headers.get("Location"):
                url = urllib.parse.urljoin(url, e.headers["Location"])
                first = False
                continue
            resp = e
        body = resp.read(MAX_BYTES + 1)[:MAX_BYTES]
        return resp.status, resp.headers.get("Content-Type", "application/octet-stream"), body, url
    raise ValueError("too many redirects")


class Handler(http.server.BaseHTTPRequestHandler):
    screen = Screen([])

    def _deny(self, code: int, msg: str):
        self.send_response(code)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.end_headers()
        self.wfile.write(msg.encode())

    def do_GET(self):
        q = urllib.parse.parse_qs(urllib.parse.urlsplit(self.path).query)
        url = (q.get("url") or [""])[0]
        try:
            accept = clean_accept(self.headers.get("Accept", "*/*"), self.screen)
            status, ctype, body, final = fetch(url, accept, self.screen)
        except Screened as e:
            print(screened_log_line(url, str(e), self.screen), flush=True)
            return self._deny(403, f"walle-fetch: refused, the request looks like it carries a credential ({e})\n")
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
    secrets = load_secrets(os.environ.get("WALLE_FETCH_SECRET_FILES", "").split())
    Handler.screen = Screen(secrets)
    port = int(os.environ.get("WALLE_FETCH_PORT", "8898"))
    server = http.server.ThreadingHTTPServer(("127.0.0.1", port), Handler)
    print(f"walle-fetch on 127.0.0.1:{port}, any public host, screening for {len(secrets)} known secrets", flush=True)
    server.serve_forever()
    return 0


if __name__ == "__main__":
    sys.exit(main())
