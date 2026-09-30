#!/bin/sh
# Proves the sandbox and the egress proxy behave as intended.
# Run on the Mac after starting the egress container (README, step 7).
# Uses the official curl image (curlimages/curl) inside websearch-internal.

NET=websearch-internal
PROXY=http://egress:3128
IMG=curlimages/curl:latest
fails=0

if ! docker network inspect "$NET" >/dev/null 2>&1; then
  echo "ERROR: Docker network $NET does not exist (README, step 1)."; exit 1
fi
if [ "$(docker inspect -f '{{.State.Running}}' egress 2>/dev/null)" != "true" ]; then
  echo "ERROR: egress container is not running (README, step 7)."; exit 1
fi
docker pull -q "$IMG" >/dev/null || { echo "ERROR: could not pull $IMG"; exit 1; }

# CONNECT response code through the proxy (-p forces a tunnel, like web-mcp does).
via_proxy() {
  docker run --rm --network "$NET" "$IMG" -g -s -o /dev/null -m 10 -p -x "$PROXY" -w '%{http_connect}' "$1" 2>/dev/null
}

expect() {  # expect <wanted-code> <url> <label>
  got=$(via_proxy "$2")
  if [ "$got" = "$1" ]; then echo "  PASS  $3 ($2 -> $got)"; else echo "  FAIL  $3 ($2 -> got '$got', wanted $1)"; fails=$((fails+1)); fi
}

echo "1. No direct internet from inside $NET:"
docker run --rm --network "$NET" "$IMG" -s -o /dev/null -m 8 https://example.com 2>/dev/null
rc=$?
if [ "$rc" -eq 0 ]; then
  echo "  FAIL  direct internet reachable"; fails=$((fails+1))
elif [ "$rc" -ge 125 ]; then
  echo "  FAIL  docker itself failed (exit $rc), test inconclusive"; fails=$((fails+1))
else
  echo "  PASS  direct internet blocked (curl exit $rc)"
fi

echo "2. Allowed through the proxy:"
expect 200 https://example.com/ "public HTTPS site"
expect 200 http://example.com/ "public HTTP site"

echo "3. Refused by the proxy:"
expect 403 https://127.0.0.1/ "loopback"
expect 403 http://0.0.0.0/ "this-host address"
expect 403 https://10.0.0.1/ "private 10/8"
expect 403 https://192.168.1.1/ "home LAN"
expect 403 https://172.17.0.1/ "Docker host bridge"
expect 403 http://169.254.169.254/ "cloud metadata"
expect 403 https://100.100.100.100/ "Tailscale range"
# IPv6 loopback: 403 if the container has IPv6 (rules active); 503 if it has
# no IPv6 at all (squid then drops the IPv6 rules but also cannot connect).
got=$(via_proxy "https://[::1]/")
case "$got" in 403|503) echo "  PASS  IPv6 loopback (https://[::1]/ -> $got)";; *) echo "  FAIL  IPv6 loopback -> '$got'"; fails=$((fails+1));; esac
expect 403 "https://[::ffff:127.0.0.1]/" "IPv4-mapped loopback"
# DNS rebinding: a temporary proxy where rebind.test is forced to 127.0.0.1
# (public test names like localtest.me are often blocked by the local resolver).
CONF="$(cd "$(dirname "$0")" && pwd)/squid.conf"
docker run -d --name egress-rebind-test --network bridge --add-host rebind.test:127.0.0.1 \
  --read-only --tmpfs /var/log/squid:uid=13,gid=13,mode=0750 --tmpfs /tmp:uid=13,gid=13 \
  --user 13:13 --cap-drop ALL --security-opt no-new-privileges --memory 128m --pids-limit 64 \
  -v "$CONF:/etc/squid/squid.conf:ro" \
  --entrypoint /usr/sbin/squid ubuntu/squid:latest -N -f /etc/squid/squid.conf >/dev/null
docker network connect "$NET" egress-rebind-test; sleep 3
got=$(docker run --rm --network "$NET" "$IMG" -g -s -o /dev/null -m 10 -p -x http://egress-rebind-test:3128 -w '%{http_connect}' https://rebind.test/ 2>/dev/null)
docker rm -f egress-rebind-test >/dev/null
if [ "$got" = "403" ]; then echo "  PASS  name forced to 127.0.0.1 (rebind.test -> 403)"; else echo "  FAIL  name forced to 127.0.0.1 -> '$got'"; fails=$((fails+1)); fi
expect 403 https://example.com:8080/ "non-web port"
expect 403 https://printer.local/ "local name"
expect 403 https://searxng/ "internal container by name (port 443, so the name/IP rule is what refuses it)"

echo "4. Plain (non-CONNECT) proxy requests refused:"
code=$(docker run --rm --network "$NET" "$IMG" -s -o /dev/null -m 10 -x "$PROXY" -w '%{http_code}' http://example.com/ 2>/dev/null)
if [ "$code" = "403" ]; then echo "  PASS  GET via proxy -> 403"; else echo "  FAIL  GET via proxy -> $code"; fails=$((fails+1)); fi

echo "5. Proxy refuses clients outside $NET (from the default bridge):"
code=$(docker run --rm --network bridge "$IMG" -s -o /dev/null -m 10 -p -x "http://$(docker inspect -f '{{with index .NetworkSettings.Networks "bridge"}}{{.IPAddress}}{{end}}' egress):3128" -w '%{http_connect}' https://example.com/ 2>/dev/null)
if [ "$code" = "403" ]; then echo "  PASS  bridge client -> 403"; else echo "  FAIL  bridge client -> '$code'"; fails=$((fails+1)); fi

echo
if [ "$fails" -eq 0 ]; then echo "ALL CHECKS PASSED"; else echo "$fails CHECK(S) FAILED"; exit 1; fi
