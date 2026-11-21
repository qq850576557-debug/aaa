"""Append an exact HTTPS virtual host to the reviewed, running Nginx configuration."""

import importlib.util
from pathlib import Path
import re
import sys

HOST = "owner-test.chmsj.cn"
MARKER = "# Managed Chunmo owner-test HTTPS"
spec = importlib.util.spec_from_file_location("nginx_syntax", Path(__file__).resolve().parents[1] / "apk-download/publish.py")
syntax = importlib.util.module_from_spec(spec)
spec.loader.exec_module(syntax)


def configure(original, release, tls):
    for path in (release, tls):
        if re.fullmatch(r"/[a-zA-Z0-9/._-]+", path) is None:
            raise ValueError("Unexpected test deployment path")
    if MARKER in original or HOST in original:
        raise ValueError("An owner-test hostname or managed route already exists")
    parsed = syntax.statements(original)
    http = [node for node in parsed["children"] if node["words"] == ["http"]]
    if len(http) != 1:
        raise ValueError("Expected exactly one http block")
    existing = [
        node for node in http[0]["children"] if node["words"] == ["server"]
        and any(words[0] == "server_name" and "chmsj.cn" in words[1:] for words, _, _ in node["directives"])
        and any(words[0] == "listen" and "ssl" in words and words[1] in ("443", "0.0.0.0:443")
                for words, _, _ in node["directives"])
    ]
    if len(existing) != 1:
        raise ValueError("Expected the known chmsj.cn HTTPS listener")
    route = r"""
  {marker}
  server {{
    listen 0.0.0.0:443 ssl;
    server_name {host};
    if ($host != "{host}") {{ return 421; }}
    ssl_certificate {tls}/fullchain.pem;
    ssl_certificate_key {tls}/server.key;
    ssl_protocols TLSv1.2 TLSv1.3;
    root {release}/dist;
    access_log off;
    add_header X-Content-Type-Options nosniff always;
    add_header X-Frame-Options DENY always;
    add_header Referrer-Policy no-referrer always;
    add_header X-Robots-Tag "noindex, nofollow" always;
    location /api/ {{
      client_max_body_size 16m;
      proxy_pass http://127.0.0.1:4410;
      proxy_http_version 1.1;
      proxy_set_header Host {host};
      proxy_set_header X-Forwarded-Proto https;
      proxy_set_header X-Forwarded-For $remote_addr;
      proxy_set_header Connection "";
      proxy_buffering off;
      proxy_cache off;
      proxy_read_timeout 90s;
    }}
    location = /chunmo-owner-test.zip {{
      alias {release}/chunmo-owner-test.zip;
      default_type application/zip;
      add_header Content-Disposition 'attachment; filename="chunmo-owner-test.zip"';
      add_header Cache-Control no-store;
    }}
    location ~ /\. {{ return 404; }}
    location / {{ try_files $uri $uri/ /index.html; }}
  }}
""".format(marker=MARKER, host=HOST, tls=tls, release=release)
    position = http[0]["end"] - 1
    return original[:position] + route + original[position:]


if __name__ == "__main__":
    print(configure(Path(sys.argv[1]).read_text(), sys.argv[2], sys.argv[3]), end="")
