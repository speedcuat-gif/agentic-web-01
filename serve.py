#!/usr/bin/env python3
"""Serve the Corner Shelf (and, on a second port, the Northside peer) with
CORS headers, so any other agent site can fetch our public agent files.

Usage:
  python3 serve.py            # main site on :8001, peer on :8002
  python3 serve.py 9001 9002  # pick your own ports
"""
import functools
import http.server
import os
import sys

ROOT = os.path.dirname(os.path.abspath(__file__))


class CORSHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        # Public agent artifacts are meant to be fetched cross-origin.
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Accept, Content-Type")
        super().end_headers()

    def log_message(self, fmt, *args):  # keep the terminal quiet
        pass


def serve(directory, port):
    handler = functools.partial(CORSHandler, directory=directory)
    httpd = http.server.ThreadingHTTPServer(("127.0.0.1", port), handler)
    print(f"serving {directory} on http://127.0.0.1:{port}/")
    httpd.serve_forever()


if __name__ == "__main__":
    main_port = int(sys.argv[1]) if len(sys.argv) > 1 else 8001
    peer_port = int(sys.argv[2]) if len(sys.argv) > 2 else 8002
    import threading

    threading.Thread(target=serve, args=(os.path.join(ROOT, "peer"), peer_port), daemon=True).start()
    serve(ROOT, main_port)
