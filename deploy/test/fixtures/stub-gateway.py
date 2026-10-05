#!/usr/bin/env python3
"""A stand-in gateway for the doctor checks: /health, /ingest/check, /api/admin/setup,
/api/admin/settings and /.well-known/source, with the secrets and the schema it reports taken from the environment. With STUB_SPA
set it answers every path with the web app's HTML instead, like a misrouted reverse proxy.

    STUB_INGEST=… STUB_OPERATOR=… STUB_SCHEMA=0006_x.sql python3 stub-gateway.py PORT
"""
import json
import os
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def send(self, code, body):
        data = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        path = self.path.split("?")[0]
        if os.environ.get("STUB_SPA"):
            # a proxy that serves the web app for every path, gateway paths included
            data = b"<!doctype html><html></html>"
            self.send_response(200)
            self.send_header("content-type", "text/html")
            self.send_header("content-length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return
        if path == "/health":
            self.send(200, {"ok": True, "db": "up", "instance": "stub", "commit": "abc123", "schema": os.environ.get("STUB_SCHEMA")})
        elif path == "/ingest/check":
            ok = self.headers.get("x-ingest-secret") == os.environ["STUB_INGEST"]
            self.send(200 if ok else 401, {"ok": True} if ok else {"error": "invalid ingest credential"})
        elif path == "/api/admin/setup":
            if self.headers.get("x-operator-secret") != os.environ["STUB_OPERATOR"]:
                self.send(403, {"error": "forbidden"})
                return
            self.send(200, {
                "items": [
                    {"key": "config", "label": "Settings are well-formed", "level": "blocking", "status": "ok", "detail": "fine"},
                    {"key": "OPERATOR", "label": "Imprint", "level": "recommended", "status": "missing", "detail": "incomplete"},
                    {"key": "db:ingest", "label": "Ingest feeding", "level": "blocking", "status": "missing", "detail": "no packets"},
                ],
                "update": {
                    "current": "1.0.0", "latest": "v1.1.0", "url": "https://example.org/acs/releases/tag/v1.1.0",
                    "checkedAt": 1, "available": True, "desktop": False,
                },
            })
        elif path == "/api/admin/settings":
            if self.headers.get("x-operator-secret") != os.environ["STUB_OPERATOR"]:
                self.send(403, {"error": "forbidden"})
                return
            self.send(200, {
                "groups": [{"id": "game", "title": "Game rules"}],
                "settings": [
                    {"key": "HIDE_DAILY_LIMIT", "source": "site", "value": "3", "stored": {"value": "3", "at": 1, "by": "OE8APR"}},
                    {"key": "MIN_TRUST", "source": "default", "value": "B", "stored": None},
                    {"key": "UPDATE_CHECK", "source": "env", "value": "0", "stored": {"value": "1", "at": 1, "by": "OE8APR"}},
                ],
            })
        elif path == "/.well-known/source":
            self.send(200, {"protocol": "aprscaching-source/1", "repo": "https://example.org/acs", "commit": "abc123"})
        else:
            self.send(404, {"error": "not found"})


HTTPServer(("127.0.0.1", int(sys.argv[1])), Handler).serve_forever()
