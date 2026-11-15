"""Unit tests of walle-fetch's checks. Run: python3 host/roles/walle/files/test_walle_fetch.py

Secret-looking values are generated at run time, so no fixture looks like a
credential to gitleaks.
"""

import base64
import importlib.util
import io
import json
import pathlib
import random
import socket
import string
import tempfile
import unittest
import urllib.error
import urllib.parse

spec = importlib.util.spec_from_file_location("walle_fetch", pathlib.Path(__file__).with_name("walle-fetch.py"))
wf = importlib.util.module_from_spec(spec)
spec.loader.exec_module(wf)

B64URL = string.ascii_letters + string.digits + "-_"
RNG = random.Random(20261114)  # fixed seed: random-looking values, reproducible results


def rand(n, alphabet=B64URL):
    return "".join(RNG.choice(alphabet) for _ in range(n))


def fake_token():
    """Shaped like a ServiceAccount token (JWT: header.payload.signature)."""
    return "eyJhbGciOiJSUzI1NiIsImtpZCI6I" + rand(20) + "." + rand(600) + "." + rand(342)


def resolver(*addrs):
    return lambda host, port, proto=None: [(socket.AF_INET6 if ":" in a else socket.AF_INET, 0, 0, "", (a, port)) for a in addrs]


def b64(s, alt=False):
    enc = base64.urlsafe_b64encode if alt else base64.b64encode
    return enc(s.encode()).decode()


# Real URLs WALL-E needs: documentation, registries, commit SHAs and digests (hex).
NORMAL_URLS = [
    "https://hub.docker.com/v2/repositories/library/postgres/tags?page_size=100&ordering=last_updated",
    "https://hub.docker.com/v2/namespaces/gitea/repositories/gitea/tags/1.24.5",
    "https://hub.docker.com/v2/repositories/library/postgres/tags?page_size=25&page=2&name=17.6-bookworm",
    "https://raw.githubusercontent.com/cloudnative-pg/cloudnative-pg/3f2a1c9e8b7d6a5f4e3d2c1b0a9f8e7d6c5b4a39/config/manager/manager.yaml",
    "https://raw.githubusercontent.com/digitaleraluhut/homelab/main/host/roles/walle/defaults/main.yml",
    "https://ghcr.io/v2/cloudnative-pg/postgresql/manifests/sha256:" + "9b2f6c0e1d4a7b3c8e5f2a1d0c9b8a7f6e5d4c3b2a1f0e9d8c7b6a5f4e3d2c1b",
    "https://registry.npmjs.org/@mariozechner/pi-coding-agent/-/pi-coding-agent-0.12.3.tgz",
    "https://registry.npmjs.org/@kubernetes%2fclient-node",
    "https://www.npmjs.com/package/@pulumi/kubernetes?activeTab=versions",
    "https://kubernetes.io/docs/reference/generated/kubernetes-api/v1.34/#configmap-v1-core",
    "https://kubernetes.io/docs/concepts/configuration/secret/#working-with-secrets",
    "https://docs.gitea.com/installation/install-on-kubernetes",
    "https://cloudnative-pg.io/documentation/1.27/postgresql_conf/#the-postgresql-section",
    "https://github.com/cloudnative-pg/cloudnative-pg/releases/download/v1.27.0/cnpg-1.27.0.yaml",
    "https://github.com/search?q=ExternalSecretsOperatorConfiguration&type=code",
    "https://github.com/traefik/traefik/blob/0a1b2c3d4e5f60718293a4b5c6d7e8f901234567/docs/content/middlewares/http/forwardauth.md",
    "https://api.github.com/repos/traefik/traefik/releases?per_page=5",
    "https://files.pythonhosted.org/packages/f9/9b/335f9764261e915ed497fcdeb11df5dfd6f7bf257d4a6a2a686d80da4d54/requests-2.32.3-py3-none-any.whl",
    "https://www.pulumi.com/registry/packages/kubernetes/api-docs/apiextensions/customresource/",
    "https://longhorn.io/docs/1.9.1/advanced-resources/deploy/customizing-default-settings/",
    "https://doc.traefik.io/traefik/v3.3/middlewares/http/forwardauth/",
    "https://pkg.go.dev/sigs.k8s.io/controller-runtime@v0.19.0/pkg/client",
    "https://proxy.golang.org/github.com/!azure/go-autorest/@v/v0.0.0-20240115120000-abcdef123456.info",
    "https://example.org/item/123e4567-e89b-12d3-a456-426614174000",
    "https://en.wikipedia.org/wiki/Kubernetes",
    "https://stackoverflow.com/questions/52369247/how-to-restart-a-kubernetes-pod",
    "https://quay.io/api/v1/repository/prometheus/node-exporter/tag/?limit=10&onlyActiveTags=true",
]


class CheckUrl(unittest.TestCase):
    def test_any_public_https_host_is_allowed(self):
        for url in ("https://docs.gitea.com/installation", "https://evil.example/", "https://v1-30.docs.kubernetes.io/x"):
            self.assertIsNone(wf.check_url(url), url)

    def test_rejects_other_schemes_ports_credentials_and_missing_hosts(self):
        self.assertIn("https", wf.check_url("http://docs.gitea.com/"))
        self.assertIn("https", wf.check_url("file:///etc/passwd"))
        self.assertIn("443", wf.check_url("https://docs.gitea.com:8443/"))
        self.assertIn("credentials", wf.check_url("https://user:pw@docs.gitea.com/"))
        self.assertIn("host", wf.check_url("https:///path"))


class PublicAddresses(unittest.TestCase):
    def test_returns_public_addresses(self):
        self.assertEqual(wf.public_addresses("docs.gitea.com", resolver("104.16.1.1")), ["104.16.1.1"])

    def test_rejects_hosts_that_resolve_to_internal_addresses(self):
        internal = ("127.0.0.1", "10.43.0.10", "172.20.0.1", "192.168.1.5", "100.70.1.1", "169.254.169.254",
                    "0.0.0.0", "::1", "fe80::1", "fd00::1", "::ffff:127.0.0.1", "::ffff:10.0.0.1", "64:ff9b::a00:1")
        for addr in internal:
            with self.assertRaises(ValueError, msg=addr) as cm:
                wf.public_addresses("docs.gitea.com", resolver(addr))
            self.assertIn("non-public", str(cm.exception), addr)

    def test_one_internal_address_among_public_ones_is_enough_to_refuse(self):
        with self.assertRaises(ValueError):
            wf.public_addresses("x.example", resolver("104.16.1.1", "10.0.0.1"))

    def test_unresolvable_host(self):
        def fail(*a, **k):
            raise socket.gaierror("no such host")

        with self.assertRaises(ValueError):
            wf.public_addresses("nope.example", fail)


class LoadSecrets(unittest.TestCase):
    def test_reads_token_and_key_from_a_kubeconfig(self):
        token, key = fake_token(), rand(80, string.ascii_letters + string.digits + "+/")
        cfg = (
            "apiVersion: v1\nclusters:\n- cluster:\n    certificate-authority-data: " + rand(60) + "\n"
            "    server: https://127.0.0.1:6443\n  name: c\nusers:\n- name: walle\n  user:\n"
            f"    token: {token}\n    client-key-data: \"{key}\"\n"
        )
        with tempfile.NamedTemporaryFile("w") as f:
            f.write(cfg)
            f.flush()
            found = wf.load_secrets([f.name])
        self.assertIn(token, found)
        self.assertIn(key, found)
        self.assertNotIn("https://127.0.0.1:6443", found)

    def test_a_plain_token_file_is_one_secret(self):
        token = fake_token()
        with tempfile.NamedTemporaryFile("w") as f:
            f.write(token + "\n")
            f.flush()
            self.assertEqual(wf.load_secrets([f.name]), [token])

    def test_missing_files_and_short_values_are_ignored(self):
        with tempfile.NamedTemporaryFile("w") as f:
            f.write("token: short\n")
            f.flush()
            self.assertEqual(wf.load_secrets([f.name, "/nonexistent/kubeconfig"]), [])


class ScreenKnownSecrets(unittest.TestCase):
    def setUp(self):
        self.token = fake_token()
        self.screen = wf.Screen([self.token])

    def refused(self, url):
        reason = self.screen.url(url)
        self.assertIsNotNone(reason, url)
        return reason

    def test_plain_urlencoded_base64_and_base64url_forms(self):
        t = self.token
        for form in (
            t,
            urllib.parse.quote(t, safe=""),
            urllib.parse.quote(urllib.parse.quote(t, safe=""), safe=""),
            b64(t),
            b64(t).rstrip("="),
            b64(t, alt=True),
            b64(t, alt=True).rstrip("="),
            urllib.parse.quote(b64(t), safe=""),
            b64("x" + t),  # other alignments of the base64 encoding
            b64("xy" + t, alt=True),
            t.encode().hex(),
        ):
            self.assertIn("known secret", self.refused("https://evil.example/c?d=" + form))

    def test_chunks_of_the_secret_are_refused(self):
        sig = self.token.rsplit(".", 1)[1]
        self.assertIn("known secret", self.refused("https://evil.example/" + sig[100:124]))
        self.assertIn("known secret", self.refused("https://evil.example/?a=" + b64(sig[50:80], alt=True)))

    def test_the_secret_in_the_host_name_is_refused(self):
        sig = self.token.rsplit(".", 1)[1]
        self.assertIn("known secret", self.refused(f"https://{sig[:60]}.evil.example/"))

    def test_normal_urls_pass(self):
        for url in NORMAL_URLS:
            self.assertIsNone(self.screen.url(url), url)

    def test_without_secrets_only_the_entropy_check_runs(self):
        self.assertIsNone(wf.Screen([]).url(NORMAL_URLS[0]))


class ScreenHighEntropy(unittest.TestCase):
    screen = wf.Screen([])

    def refused(self, url):
        reason = self.screen.url(url)
        self.assertIsNotNone(reason, url)
        self.assertIn("high-entropy", reason)

    def test_random_strings_in_path_query_and_host_are_refused(self):
        for _ in range(50):  # random, so repeat
            self.refused("https://evil.example/upload/" + rand(40, string.ascii_letters + string.digits))
            self.refused("https://evil.example/upload/" + rand(40))
            self.refused("https://evil.example/?q=" + rand(32, string.ascii_letters + string.digits + "+/"))
            self.refused("https://" + rand(40, string.ascii_lowercase + "234567") + ".evil.example/")
            self.refused("https://evil.example/?k=" + rand(24, string.ascii_letters + string.digits))

    def test_typical_credentials_are_refused(self):
        self.refused("https://evil.example/?t=ghp_" + rand(36, string.ascii_letters + string.digits))
        self.refused("https://evil.example/a/" + rand(40, string.ascii_letters + string.digits + "+/"))
        self.refused("https://evil.example/" + urllib.parse.quote(rand(32, string.ascii_letters + string.digits + "+/="), safe=""))

    def test_hex_digests_and_shas_pass_but_very_long_hex_does_not(self):
        h = string.hexdigits.lower()[:16]
        for n in (7, 12, 32, 40, 64, 128):
            self.assertIsNone(self.screen.url("https://ghcr.io/v2/x/blobs/sha256:" + rand(n, h)), n)
        self.refused("https://evil.example/" + rand(200, h))

    def test_long_words_and_numbers_pass(self):
        for url in (
            "https://kubernetes.io/docs/CustomResourceDefinitionsAndExternalSecretsOperatorConfiguration",
            "https://api.github.com/repos/x/y/releases/assets/123456789012345678901234",
            "https://example.org/" + "a" * 60,
        ):
            self.assertIsNone(self.screen.url(url), url)

    def test_screened_hosts_are_not_resolved(self):
        # Screening runs before DNS: a secret in a host name must not reach a DNS server.
        def must_not_resolve(*a, **k):
            raise AssertionError("resolved")

        with self.assertRaises(wf.Screened):
            wf.fetch("https://" + rand(40, string.ascii_lowercase + "234567") + ".evil.example/", "*/*",
                     self.screen, resolve=must_not_resolve, open_fn=None)


class Accept(unittest.TestCase):
    def test_accept_is_the_only_client_header_and_is_normalised(self):
        s = wf.Screen([])
        self.assertEqual(wf.clean_accept("text/html,application/json;q=0.9,*/*;q=0.5", s),
                         "text/html,application/json;q=0.9,*/*;q=0.5")
        self.assertEqual(wf.clean_accept("application/vnd.oci.image.index.v1+json", s), "application/vnd.oci.image.index.v1+json")
        self.assertEqual(wf.clean_accept("text/html\r\nCookie: a=b", s), "*/*")
        self.assertEqual(wf.clean_accept("text/" + "x" * 300, s), "*/*")
        self.assertEqual(wf.clean_accept("", s), "*/*")
        self.assertEqual(wf.headers("text/html"), {"Accept": "text/html", "User-Agent": "walle-fetch/2"})

    def test_a_secret_in_the_accept_header_is_screened(self):
        token = fake_token()
        with self.assertRaises(wf.Screened):
            wf.clean_accept("text/" + token.split(".")[2][:60], wf.Screen([token]))
        with self.assertRaises(wf.Screened):
            wf.clean_accept("text/x" + rand(40, string.ascii_letters + string.digits), wf.Screen([]))


class Response:
    def __init__(self, status=200, body=b"ok", ctype="text/plain"):
        self.status, self.headers, self._body = status, {"Content-Type": ctype}, io.BytesIO(body)

    def read(self, n=-1):
        return self._body.read(n)


def redirect(url, location):
    return urllib.error.HTTPError(url, 302, "Found", {"Location": location}, io.BytesIO(b""))


class Fetch(unittest.TestCase):
    def setUp(self):
        self.token = fake_token()
        self.screen = wf.Screen([self.token])
        self.calls = []

    def open_fn(self, responses):
        def _open(url, addr, accept):
            self.calls.append((url, addr, accept))
            r = responses.pop(0)
            if isinstance(r, Exception):
                raise r
            return r

        return _open

    def test_connects_to_the_checked_address_only(self):
        status, ctype, body, final = wf.fetch("https://docs.gitea.com/x", "text/html", self.screen,
                                              resolve=resolver("104.16.1.1"), open_fn=self.open_fn([Response()]))
        self.assertEqual((status, body, final), (200, b"ok", "https://docs.gitea.com/x"))
        self.assertEqual(self.calls, [("https://docs.gitea.com/x", "104.16.1.1", "text/html")])

    def test_body_is_limited(self):
        _, _, body, _ = wf.fetch("https://a.example/", "*/*", self.screen, resolve=resolver("104.16.1.1"),
                                 open_fn=self.open_fn([Response(body=b"x" * (wf.MAX_BYTES + 10))]))
        self.assertEqual(len(body), wf.MAX_BYTES)

    def test_redirects_are_followed_and_checked(self):
        ok = self.open_fn([redirect("https://a.example/", "/b"), Response()])
        self.assertEqual(wf.fetch("https://a.example/", "*/*", self.screen, resolve=resolver("104.16.1.1"), open_fn=ok)[3],
                         "https://a.example/b")
        to_lan = self.open_fn([redirect("https://a.example/", "https://lan.example/")])
        resolve = lambda h, p, proto=None: resolver("192.168.1.5" if h == "lan.example" else "104.16.1.1")(h, p)
        with self.assertRaises(ValueError) as cm:
            wf.fetch("https://a.example/", "*/*", self.screen, resolve=resolve, open_fn=to_lan)
        self.assertIn("non-public", str(cm.exception))
        to_http = self.open_fn([redirect("https://a.example/", "http://a.example/")])
        with self.assertRaises(ValueError):
            wf.fetch("https://a.example/", "*/*", self.screen, resolve=resolver("104.16.1.1"), open_fn=to_http)

    def test_a_redirect_carrying_a_known_secret_is_screened(self):
        leak = self.open_fn([redirect("https://a.example/", "https://b.example/?t=" + self.token)])
        with self.assertRaises(wf.Screened):
            wf.fetch("https://a.example/", "*/*", self.screen, resolve=resolver("104.16.1.1"), open_fn=leak)

    def test_signed_download_redirects_pass(self):
        # Servers choose redirect targets (signed blob URLs); only known secrets are screened there.
        signed = "https://release-assets.githubusercontent.com/x?sig=" + rand(44) + "&jwt=" + rand(300)
        r = self.open_fn([redirect("https://github.com/a/b/releases/download/v1/f", signed), Response()])
        self.assertEqual(wf.fetch("https://github.com/a/b/releases/download/v1/f", "*/*", self.screen,
                                  resolve=resolver("104.16.1.1"), open_fn=r)[3], signed)

    def test_too_many_redirects(self):
        loop = self.open_fn([redirect("https://a.example/", "/again") for _ in range(wf.MAX_REDIRECTS + 1)])
        with self.assertRaises(ValueError):
            wf.fetch("https://a.example/", "*/*", self.screen, resolve=resolver("104.16.1.1"), open_fn=loop)


class LogLine(unittest.TestCase):
    def test_screened_refusals_have_a_marker_and_no_secret(self):
        token = fake_token()
        url = "https://evil.example/c?d=" + token
        line = wf.screened_log_line(url, "known secret", wf.Screen([token]))
        self.assertTrue(line.startswith("fetch SCREENED "), line)
        self.assertNotIn(token, line)
        self.assertNotIn(token[-40:], line)
        self.assertIn("evil.example", line)

    def test_a_screened_host_is_not_logged_either(self):
        host = rand(40, string.ascii_lowercase + "234567")
        line = wf.screened_log_line(f"https://{host}.evil.example/", "high-entropy", wf.Screen([]))
        self.assertNotIn(host, line)


# --- Digest lookup (GET /digest?image=...) ------------------------------------------

DIGEST = "sha256:" + "4b7ce07a4f2ab4f4a6d3a5e6c4f6b4b1e3c2d1a0f9e8d7c6b5a4f3e2d1c0b9a8"
INDEX = "application/vnd.oci.image.index.v1+json"


class Head:
    """A manifest HEAD response."""

    def __init__(self, digest=DIGEST, ctype=INDEX, status=200):
        self.status, self.headers = status, {"Docker-Content-Digest": digest, "Content-Type": ctype}

    def read(self, n=-1):
        return b""


def http_error(url, code):
    return urllib.error.HTTPError(url, code, "error", {}, io.BytesIO(b""))


class ParseImage(unittest.TestCase):
    def test_ghcr_and_docker_hub_images(self):
        self.assertEqual(wf.parse_image("ghcr.io/zitadel/zitadel:v4.20.3"), ("ghcr.io", "zitadel/zitadel", "v4.20.3"))
        self.assertEqual(wf.parse_image("docker.io/library/nginx:latest"), ("docker.io", "library/nginx", "latest"))
        self.assertEqual(wf.parse_image("docker.io/gitea/gitea:1.24.5-rootless"), ("docker.io", "gitea/gitea", "1.24.5-rootless"))
        self.assertEqual(wf.parse_image("ghcr.io/cloudnative-pg/postgresql:17.6_system-trixie"),
                         ("ghcr.io", "cloudnative-pg/postgresql", "17.6_system-trixie"))

    def test_official_docker_hub_images_get_the_library_prefix(self):
        self.assertEqual(wf.parse_image("docker.io/nginx:1.27-alpine"), ("docker.io", "library/nginx", "1.27-alpine"))

    def test_invalid_or_other_images_are_refused(self):
        for image in [
            "", "nginx:latest", "nginx", "ghcr.io/zitadel/zitadel", "ghcr.io/zitadel/zitadel:",
            "quay.io/prometheus/node-exporter:v1.9.1", "evil.example/a/b:latest", "localhost:5000/a:b",
            "registry-1.docker.io/library/nginx:latest", "ghcr.io:443/zitadel/zitadel:v1",
            "user@ghcr.io/zitadel/zitadel:v1", "https://ghcr.io/zitadel/zitadel:v1",
            "ghcr.io/Zitadel/zitadel:v1", "ghcr.io/zitadel//zitadel:v1", "ghcr.io/zitadel/../x:v1",
            "ghcr.io/zitadel/zitadel:v1?x=1", "ghcr.io/zitadel/zitadel:v1#x", "ghcr.io/zitadel/zitadel:v 1",
            "ghcr.io/zitadel/zitadel:v1\n", "ghcr.io/zitadel/zitadel%2fx:v1", "ghcr.io/zitadel/zitadel:.v1",
            "ghcr.io/zitadel/zitadel@" + DIGEST, "ghcr.io/zitadel/zitadel:v1@" + DIGEST,
            "ghcr.io/" + "a" * 200 + ":v1", "ghcr.io/zitadel/zitadel:" + "1" * 129,
            "ghcr.io/a/b/c/d/e/f/g:v1",
        ]:
            with self.assertRaises(ValueError, msg=image):
                wf.parse_image(image)


class LookupDigest(unittest.TestCase):
    def setUp(self):
        self.calls = []
        self.token = rand(40)

    def open_fn(self, responses):
        def _open(url, addr, method, hdrs):
            self.calls.append((url, addr, method, hdrs))
            r = responses.pop(0)
            if isinstance(r, Exception):
                raise r
            return r

        return _open

    def token_response(self, key="token"):
        return Response(body=('{"%s": "%s"}' % (key, self.token)).encode(), ctype="application/json")

    def test_ghcr_fetches_an_anonymous_token_then_heads_the_manifest(self):
        r = wf.lookup_digest("ghcr.io/zitadel/zitadel:v4.20.3", wf.Screen([]), resolve=resolver("140.82.1.1"),
                             open_fn=self.open_fn([self.token_response(), Head()]))
        self.assertEqual(r, {"image": "ghcr.io/zitadel/zitadel:v4.20.3", "digest": DIGEST, "mediaType": INDEX,
                             "pinned": "ghcr.io/zitadel/zitadel:v4.20.3@" + DIGEST})
        (turl, taddr, tmethod, thdrs), (murl, maddr, mmethod, mhdrs) = self.calls
        self.assertEqual((turl, taddr, tmethod), ("https://ghcr.io/token?scope=repository:zitadel/zitadel:pull", "140.82.1.1", "GET"))
        self.assertNotIn("Authorization", thdrs)
        self.assertEqual((murl, mmethod), ("https://ghcr.io/v2/zitadel/zitadel/manifests/v4.20.3", "HEAD"))
        self.assertEqual(mhdrs["Authorization"], "Bearer " + self.token)
        for media in ("application/vnd.oci.image.index.v1+json", "application/vnd.docker.distribution.manifest.list.v2+json",
                      "application/vnd.docker.distribution.manifest.v2+json", "application/vnd.oci.image.manifest.v1+json"):
            self.assertIn(media, mhdrs["Accept"])
        self.assertNotIn(self.token, str(r))

    def test_docker_hub_uses_its_auth_service_and_registry_host(self):
        r = wf.lookup_digest("docker.io/nginx:latest", wf.Screen([]), resolve=resolver("104.16.1.1"),
                             open_fn=self.open_fn([self.token_response("access_token"), Head()]))
        self.assertEqual(r["pinned"], "docker.io/library/nginx:latest@" + DIGEST)
        self.assertEqual(self.calls[0][0], "https://auth.docker.io/token?service=registry.docker.io&scope=repository:library/nginx:pull")
        self.assertEqual(self.calls[1][0], "https://registry-1.docker.io/v2/library/nginx/manifests/latest")

    def test_registry_hosts_must_resolve_to_public_addresses(self):
        with self.assertRaises(ValueError) as cm:
            wf.lookup_digest("ghcr.io/zitadel/zitadel:v1", wf.Screen([]), resolve=resolver("10.0.0.5"),
                             open_fn=self.open_fn([]))
        self.assertIn("non-public", str(cm.exception))
        self.assertEqual(self.calls, [])

    def test_a_screened_image_is_not_requested(self):
        secret = fake_token()
        for image, screen in ((f"ghcr.io/{rand(40, string.ascii_lowercase + string.digits)}/x:v1", wf.Screen([])),
                              ("ghcr.io/x/" + secret[40:70].lower().replace("_", "a").replace("-", "b") + ":v1", wf.Screen([secret]))):
            with self.assertRaises(wf.Screened, msg=image):
                wf.lookup_digest(image, screen, resolve=resolver("140.82.1.1"), open_fn=self.open_fn([]))
        self.assertEqual(self.calls, [])

    def test_registry_errors_are_reported_without_the_token(self):
        for err in (http_error("https://ghcr.io/v2/x/y/manifests/v1", 404), http_error("https://ghcr.io/v2/x/y/manifests/v1", 401)):
            with self.assertRaises(ValueError) as cm:
                wf.lookup_digest("ghcr.io/x/y:v1", wf.Screen([]), resolve=resolver("140.82.1.1"),
                                 open_fn=self.open_fn([self.token_response(), err]))
            self.assertIn(str(err.code), str(cm.exception))
            self.assertNotIn(self.token, str(cm.exception))

    def test_a_missing_token_or_a_malformed_digest_is_refused(self):
        bad = [
            [Response(body=b"not json")],
            [Response(body=b'{"token": "a b\\r\\nX-Evil: 1"}')],
            [self.token_response(), Head(digest="sha256:short")],
            [self.token_response(), Head(digest="sha256:" + "A" * 64)],
            [self.token_response(), Head(digest=DIGEST, ctype="text/html; <script>")],
        ]
        for responses in bad:
            with self.assertRaises(ValueError, msg=responses):
                wf.lookup_digest("ghcr.io/x/y:v1", wf.Screen([]), resolve=resolver("140.82.1.1"), open_fn=self.open_fn(responses))


class DigestEndpoint(unittest.TestCase):
    def test_success_is_json_and_logged_without_the_token(self):
        status, body, log = wf.digest_endpoint("ghcr.io/x/y:v1", wf.Screen([]),
                                               lookup=lambda image, screen: {"image": image, "digest": DIGEST})
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body)["digest"], DIGEST)
        self.assertTrue(log.startswith("digest ghcr.io/x/y:v1 -> " + DIGEST), log)

    def test_refusals(self):
        status, body, log = wf.digest_endpoint("quay.io/x/y:v1", wf.Screen([]))
        self.assertEqual(status, 403)
        self.assertIn("ghcr.io", body.decode())
        self.assertTrue(log.startswith("digest DENIED"), log)

    def test_screened_images_are_not_logged(self):
        secret = rand(40, string.ascii_lowercase + string.digits)
        status, _, log = wf.digest_endpoint(f"ghcr.io/{secret}/x:v1", wf.Screen([]))
        self.assertEqual(status, 403)
        self.assertTrue(log.startswith("digest SCREENED"), log)
        self.assertNotIn(secret, log)

    def test_upstream_failures_are_502(self):
        def fail(image, screen):
            raise OSError("timed out")

        self.assertEqual(wf.digest_endpoint("ghcr.io/x/y:v1", wf.Screen([]), lookup=fail)[0], 502)


if __name__ == "__main__":
    unittest.main()
