#!/usr/bin/env python3
"""TCP-to-unix-socket bridge for WALL-E's cluster reads (host role walle).

WALL-E must use the Kubernetes API without ever being able to read the token
(owner, 2026-11-14). `kubectl proxy` (walle-kube.service) holds the token and
listens on a unix socket that only group walle can open. kubectl itself cannot
use a unix socket as its server (client-go accepts only host:port URLs), so
this bridge listens on 127.0.0.1 and passes connections through to the socket.

A TCP port on localhost is open to every local user and to host-network pods.
So the bridge looks up who owns the connecting socket (/proc/net/tcp, which the
kernel fills in for both ends of a loopback connection) and serves only the
allowed users. Everyone else is disconnected before a byte is passed on.

Configuration (environment): WALLE_KUBE_BRIDGE_PORT, WALLE_KUBE_SOCKET,
WALLE_KUBE_USERS (space-separated user names or uids).
"""

import os
import pwd
import socket
import socketserver
import sys
import threading


def peer_uid(peer_port: int, local_port: int, proc_net_tcp: str) -> int | None:
    """uid owning the loopback socket peer_port -> local_port, from /proc/net/tcp text."""
    for line in proc_net_tcp.splitlines()[1:]:
        f = line.split()
        if len(f) < 8:
            continue
        local, remote = f[1].split(":"), f[2].split(":")
        if int(local[1], 16) == peer_port and int(remote[1], 16) == local_port:
            return int(f[7])
    return None


def _pump(src: socket.socket, dst: socket.socket):
    try:
        while data := src.recv(65536):
            dst.sendall(data)
    except OSError:
        pass
    finally:
        try:
            dst.shutdown(socket.SHUT_WR)
        except OSError:
            pass


class _Handler(socketserver.BaseRequestHandler):
    def handle(self):
        peer_port, local_port = self.client_address[1], self.server.server_address[1]
        try:
            with open("/proc/net/tcp") as f:
                uid = peer_uid(peer_port, local_port, f.read())
        except OSError:
            uid = None
        if uid not in self.server.uids:
            print(f"bridge REFUSED connection from uid {uid}", flush=True)
            return
        upstream = socket.socket(socket.AF_UNIX)
        try:
            upstream.connect(self.server.socket_path)
        except OSError as e:
            print(f"bridge FAILED {self.server.socket_path}: {e}", flush=True)
            upstream.close()
            return
        with upstream:
            back = threading.Thread(target=_pump, args=(upstream, self.request), daemon=True)
            back.start()
            _pump(self.request, upstream)
            back.join()


class _Server(socketserver.ThreadingTCPServer):
    daemon_threads = True
    allow_reuse_address = True


def make_server(address, socket_path: str, uids: set[int]) -> _Server:
    server = _Server(address, _Handler)
    server.socket_path, server.uids = socket_path, uids
    return server


def _uid(name: str) -> int:
    return int(name) if name.isdigit() else pwd.getpwnam(name).pw_uid


def main() -> int:
    port = int(os.environ.get("WALLE_KUBE_BRIDGE_PORT", "8899"))
    path = os.environ.get("WALLE_KUBE_SOCKET", "/run/walle-kube/api.sock")
    uids = {_uid(u) for u in os.environ.get("WALLE_KUBE_USERS", "walle").split()}
    server = make_server(("127.0.0.1", port), path, uids)
    print(f"walle-kube-bridge on 127.0.0.1:{port} -> {path}, for uids {sorted(uids)}", flush=True)
    server.serve_forever()
    return 0


if __name__ == "__main__":
    sys.exit(main())
