# web-mcp

Local web search for LM Studio / Bionic as an MCP server.

- **`web_search(query)`**: searches through your own SearXNG. Returns up to 8 results with title, URL and snippet.
- **`fetch_page(url)`** (optional, off by default): reads the text of a page that `web_search` returned.

Zero npm dependencies. Node 22, built-ins only.

## Security model

| Layer | What it does |
|---|---|
| Container | Read-only filesystem, all Linux capabilities dropped, non-root, memory/CPU/process limits. Nothing from your Mac is mounted. |
| Internal network | `websearch-internal` has **no route out**. The server can only reach `searxng` (and `egress` in fetch mode). No internet, LAN, Tailscale or Mac. |
| Query | The server fixes host and path. The query only goes into `?q=`. Max 200 chars, control characters stripped. |
| Results | Each block is wrapped in `UNTRUSTED WEB CONTENT [id=<random>]` … `END UNTRUSTED WEB CONTENT [id=<same>]`. The id is new for every response, so a page cannot fake the end line. Marker-like text inside results is removed. |
| fetch_page | Accepts **only URLs that web_search returned in this session** (exact match). A model cannot build `evil.com/?d=<your data>`. Only http/https on ports 80/443, no credentials, max 3 redirects (each fully re-checked), 2 MB (raw and decompressed), 10 s total, text/html and text/plain only, max 5 pages / 20 attempts per session. |
| In-process guard | Blocks private, loopback, link-local, CGNAT/Tailscale (100.64/10), multicast, reserved and documentation ranges. Also covers IPv6, including embedded-IPv4 forms. Blocks local names (`localhost`, `*.local`, `*.internal`, `*.home.arpa`, `*.ts.net`, single-label names …). |
| Egress proxy | In fetch mode all traffic goes through a squid container that **resolves DNS itself** and refuses the same destinations. This is a second, independent implementation. It also refuses anything that isn't CONNECT to 80/443, and any client outside `websearch-internal`. |

**What this cannot prevent:** the model putting private text into a *search query*. The container never holds your data, but the model does. So:

> **Session rule:** use web search only in chats where the **memory server is off** and no private files or work documents are in the conversation. Keep shell access ("Allow coding") off in web sessions.

## Files

```
index.js            entry point
lib/server.js       MCP protocol (newline-delimited JSON-RPC over stdio)
lib/search.js       web_search
lib/fetch.js        fetch_page
lib/http.js         HTTP client: total deadline, size caps, direct / CONNECT-proxy
lib/netguard.js     IP / hostname / URL rules
lib/text.js         markers, neutralising, HTML-to-text (linear time)
egress/squid.conf   egress proxy config
egress/verify.sh    proves sandbox + proxy behave (run on the Mac)
tools/mcp-smoke.mjs protocol conformance check for any stdio MCP server
test/               node --test suites (49 tests, local mock servers only)
Dockerfile          node:22-alpine, runs as user "node"
```

---

## Setup (Mac with colima)

**You need:**
- colima + docker running (`colima status`)
- the `searxng` container from before, with `json` enabled under `search.formats`
- Node 22+ for the tests (`node -v`)

### 0. Put the folder in place

```bash
unzip ~/Downloads/web-mcp.zip -d ~/.lmstudio/
cd ~/.lmstudio/web-mcp
```

### 1. Run the tests

```bash
node --test          # expect: 49 pass, 0 fail
```

### 2. Create the internal network (fixed subnet: the proxy trusts only this one)

```bash
# if you created websearch-internal earlier without a subnet, remove it first:
docker network disconnect websearch-internal searxng 2>/dev/null; docker network rm websearch-internal 2>/dev/null

docker network create --internal --subnet 172.30.99.0/24 websearch-internal
docker network connect websearch-internal searxng
```

If `172.30.99.0/24` collides with something on your side, pick another private /24. Change it in `egress/squid.conf` (`acl clients src …`) to match.

### 3. Build the image and pin the base image

```bash
docker pull node:22-alpine
docker inspect --format '{{index .RepoDigests 0}}' node:22-alpine
# -> node@sha256:abc123...   put that into the Dockerfile:
#    FROM node:22-alpine@sha256:abc123...
docker build -t web-mcp:local .
```

### 4. Check the sandbox

```bash
docker run --rm --network websearch-internal node:22-alpine sh -c '
  wget -q -T 5 -O /dev/null https://example.com && echo "BAD: internet reachable" || echo "good: no internet";
  wget -q -T 5 -O - "http://searxng:8080/search?q=test&format=json" | head -c 120; echo'
```

You want `good: no internet` followed by the start of a JSON answer.

### 5. Smoke test, exactly as LM Studio will start it

```bash
node tools/mcp-smoke.mjs --call web_search '{"query":"yamllint"}' -- \
  docker run -i --rm --read-only --cap-drop ALL --security-opt no-new-privileges \
  --pids-limit 64 --memory 256m --cpus 0.5 --network websearch-internal \
  -e SEARXNG_URL=http://searxng:8080 web-mcp:local
```

Expect `ALL CHECKS PASSED` and real search results in the output.

### 6. Register it in LM Studio (search only)

Add this next to your existing `memory` entry in `~/.lmstudio/mcp.json`:

```json
"web": {
  "command": "/opt/homebrew/bin/docker",
  "args": ["run", "-i", "--rm",
           "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
           "--pids-limit", "64", "--memory", "256m", "--cpus", "0.5",
           "--network", "websearch-internal",
           "-e", "SEARXNG_URL=http://searxng:8080",
           "web-mcp:local"]
}
```

Then:
1. Restart LM Studio.
2. In a **new chat without the memory server**, enable only `web`.
3. Ask something current.

If LM Studio can't reach Docker, add `"env": {"DOCKER_HOST": "unix:///Users/YOUR_USER/.colima/default/docker.sock"}` to the entry.

**Stop here if search is all you want.**

---

### 7. Optional: enable fetch_page with the egress proxy

**Start the proxy.** It runs as the unprivileged `proxy` user (uid 13), read-only, logging to a tmpfs:

```bash
docker pull ubuntu/squid:latest
docker run -d --name egress --restart unless-stopped \
  --network bridge \
  --read-only --tmpfs /var/log/squid:uid=13,gid=13,mode=0750 --tmpfs /tmp:uid=13,gid=13 \
  --user 13:13 --cap-drop ALL --security-opt no-new-privileges \
  --memory 128m --pids-limit 64 \
  -v "$HOME/.lmstudio/web-mcp/egress/squid.conf:/etc/squid/squid.conf:ro" \
  --entrypoint /usr/sbin/squid \
  ubuntu/squid:latest -N -f /etc/squid/squid.conf
docker network connect websearch-internal egress

docker exec egress cat /var/log/squid/cache.log | tail -5   # should end with "Accepting HTTP Socket connections"
```

**Prove it:**

```bash
sh egress/verify.sh      # expect: ALL CHECKS PASSED
```

**Switch LM Studio to fetch mode.** Replace the `args` of the `web` entry with:

```json
["run", "-i", "--rm",
 "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
 "--pids-limit", "64", "--memory", "256m", "--cpus", "0.5",
 "--network", "websearch-internal",
 "-e", "SEARXNG_URL=http://searxng:8080",
 "-e", "WEB_ALLOW_FETCH=1",
 "-e", "EGRESS_PROXY=http://egress:3128",
 "web-mcp:local"]
```

Restart LM Studio. `fetch_page` now shows up next to `web_search`.

---

## Logs

| What | Where |
|---|---|
| Queries and fetched URLs | The server's stderr, one line each. LM Studio shows it in its MCP/developer log. |
| Proxy decisions | `docker exec egress cat /var/log/squid/access.log`. `TCP_DENIED/403` means refused, `TCP_TUNNEL/200` means allowed. |

## Troubleshooting

- **"cannot reach SearXNG"**:
  - `docker ps`: is `searxng` running?
  - Is it connected to `websearch-internal`?
  - After a reboot, run `colima start` (or `brew services start colima` to start it automatically).
- **"SearXNG did not return JSON"**: add `json` under `search.formats` in `~/searxng/config/settings.yml`, then run `docker restart searxng`.
- **egress container exits immediately**: `docker logs egress`. If it complains about permissions, first try without `--read-only`, then send the log for review. Don't just drop all the hardening.
- **Every fetch returns "blocked by egress proxy … 503"**: squid can't resolve names. Check with `docker exec egress cat /var/log/squid/cache.log`. Adding `--dns 9.9.9.9` (or another resolver you trust) to the egress `docker run` fixes it.
- **A page returns almost nothing**: it's JavaScript-rendered, or behind a bot check such as "Client Challenge". fetch_page reads plain HTML only; there is no browser.
- **IPv6**: if squid's `cache.log` says `IPv6 has not been enabled`, squid ignores its IPv6 rules. It then also cannot make IPv6 connections, so that is safe.

## Check any MCP server

`tools/mcp-smoke.mjs` works for any stdio MCP server, not just this one. Run it before trusting a server in LM Studio:

```bash
node tools/mcp-smoke.mjs -- node ~/.lmstudio/memory/mcp-server/index.js
```
