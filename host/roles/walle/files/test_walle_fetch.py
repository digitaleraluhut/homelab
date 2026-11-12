"""Unit tests of walle-fetch's checks. Run: python3 host/roles/walle/files/test_walle_fetch.py"""

import importlib.util
import pathlib
import socket
import unittest

spec = importlib.util.spec_from_file_location("walle_fetch", pathlib.Path(__file__).with_name("walle-fetch.py"))
wf = importlib.util.module_from_spec(spec)
spec.loader.exec_module(wf)

ALLOW = ["docs.gitea.com", "hub.docker.com", "kubernetes.io"]


def resolver(addr):
    return lambda host, port, proto=None: [(socket.AF_INET, 0, 0, "", (addr, port))]


class CheckUrl(unittest.TestCase):
    def check(self, url, addr="104.16.1.1"):
        return wf.check_url(url, ALLOW, resolve=resolver(addr))

    def test_allows_https_on_listed_hosts_and_subdomains(self):
        self.assertIsNone(self.check("https://docs.gitea.com/installation"))
        self.assertIsNone(self.check("https://v1-30.docs.kubernetes.io/x"))

    def test_rejects_other_schemes_hosts_ports_and_credentials(self):
        self.assertIn("https", self.check("http://docs.gitea.com/"))
        self.assertIn("allowlist", self.check("https://evil.example/"))
        self.assertIn("allowlist", self.check("https://docs.gitea.com.evil.example/"))
        self.assertIn("443", self.check("https://docs.gitea.com:8443/"))
        self.assertIn("credentials", self.check("https://user:pw@docs.gitea.com/"))

    def test_rejects_hosts_that_resolve_to_internal_addresses(self):
        for addr in ("127.0.0.1", "10.43.0.10", "192.168.1.5", "100.70.1.1", "169.254.169.254"):
            self.assertIn("non-public", self.check("https://docs.gitea.com/", addr), addr)


if __name__ == "__main__":
    unittest.main()
