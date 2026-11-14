"""Unit tests of walle-kube-bridge. Run: python3 host/roles/walle/files/test_walle_kube_bridge.py"""

import importlib.util
import os
import pathlib
import socket
import tempfile
import threading
import unittest

spec = importlib.util.spec_from_file_location("bridge", pathlib.Path(__file__).with_name("walle-kube-bridge.py"))
kb = importlib.util.module_from_spec(spec)
spec.loader.exec_module(kb)

# /proc/net/tcp: a client on port 0xC350 (50000) connected to the bridge on 0x22C3 (8899),
# owned by uid 995, and the bridge's accepted end (uid 61234).
PROC_NET_TCP = """\
  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 0100007F:22C3 00000000:0000 0A 00000000:00000000 00:00000000 00000000 61234        0 1001 1 0 100 0 0 10 0
   1: 0100007F:C350 0100007F:22C3 01 00000000:00000000 00:00000000 00000000   995        0 1002 1 0 20 4 30 10 -1
   2: 0100007F:22C3 0100007F:C350 01 00000000:00000000 00:00000000 00000000 61234        0 1003 1 0 20 4 30 10 -1
   3: 0100007F:C351 0100007F:1F90 01 00000000:00000000 00:00000000 00000000  1000        0 1004 1 0 20 4 30 10 -1
"""


class PeerUid(unittest.TestCase):
    def test_finds_the_owner_of_the_connecting_socket(self):
        self.assertEqual(kb.peer_uid(50000, 8899, PROC_NET_TCP), 995)

    def test_unknown_connection(self):
        self.assertIsNone(kb.peer_uid(50001, 8899, PROC_NET_TCP))
        self.assertIsNone(kb.peer_uid(50002, 8080, PROC_NET_TCP))
        self.assertEqual(kb.peer_uid(50001, 8080, PROC_NET_TCP), 1000)


class Bridge(unittest.TestCase):
    """End to end on this machine: a unix echo server stands in for kubectl proxy."""

    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.sock_path = os.path.join(self.dir.name, "api.sock")
        self.upstream = socket.socket(socket.AF_UNIX)
        self.upstream.bind(self.sock_path)
        self.upstream.listen()
        threading.Thread(target=self._echo, daemon=True).start()

    def tearDown(self):
        self.upstream.close()
        self.dir.cleanup()

    def _echo(self):
        while True:
            try:
                c, _ = self.upstream.accept()
            except OSError:
                return
            with c:
                while data := c.recv(4096):
                    c.sendall(data)

    def start(self, uids):
        server = kb.make_server(("127.0.0.1", 0), self.sock_path, uids)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.shutdown)
        self.addCleanup(server.server_close)
        return server.server_address[1]

    def talk(self, port):
        with socket.create_connection(("127.0.0.1", port), timeout=5) as c:
            c.sendall(b"GET /api HTTP/1.1\r\n\r\n")
            c.shutdown(socket.SHUT_WR)
            out = b""
            while data := c.recv(4096):
                out += data
            return out

    def test_the_allowed_user_reaches_the_api(self):
        self.assertEqual(self.talk(self.start({os.getuid()})), b"GET /api HTTP/1.1\r\n\r\n")

    def test_other_users_are_cut_off(self):
        self.assertEqual(self.talk(self.start({os.getuid() + 1})), b"")


if __name__ == "__main__":
    unittest.main()
