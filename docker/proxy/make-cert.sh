#!/bin/sh
# Creates the self-signed certificate once (it lives in a volume, so browsers are asked to trust it only once).
# AGORA_HOSTS: comma-separated names and IPs the certificate must cover, e.g. "192.168.2.155,meu-pc.local".
# Changing it makes a new certificate.
set -e
DIR=/etc/nginx/certs
HOSTS="localhost,127.0.0.1,${AGORA_HOSTS:-}"
if [ -f "$DIR/cert.pem" ] && [ "$(cat "$DIR/hosts" 2>/dev/null)" = "$HOSTS" ]; then exit 0; fi
mkdir -p "$DIR"
SAN=""
for host in $(echo "$HOSTS" | tr ',' ' '); do
    case "$host" in
        *[!0-9.]*) SAN="$SAN,DNS:$host" ;;
        *) SAN="$SAN,IP:$host" ;;
    esac
done
openssl req -x509 -newkey rsa:2048 -nodes -days 825 -keyout "$DIR/key.pem" -out "$DIR/cert.pem" \
    -subj "/CN=ultima-agora (desenvolvimento)" -addext "subjectAltName=${SAN#,}" 2>/dev/null
echo "$HOSTS" > "$DIR/hosts"
echo "[proxy] certificate created for: $HOSTS"
