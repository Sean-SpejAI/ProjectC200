# ImageRight REST Smoke Test — RESOLVED (2026-05-13)

## TL;DR

End-to-end REST API smoke test **passes**. We can authenticate and call protected endpoints through the StrongSwan VPN. The previous failure ([2026-05-06-ImageRight-REST-Smoke-Test.md](2026-05-06-ImageRight-REST-Smoke-Test.md)) was because we were probing the wrong port — the API runs on **HTTPS port 8093** at the FQDN, not HTTP on any port we tried.

## The unblocking info from Chris (Nodak)

After working with Tom at Vertafore, Chris confirmed:

1. The REST API is on **HTTPS port 8093**, not HTTP.
2. Use the **FQDN** `irtest-appsvr.nodakmutual.com`, not the IP. Their cert has no SAN entries, so TLS only validates against the FQDN. (Cert fix scheduled for next Wednesday.)
3. Credentials we already have via the gitignored `.env` (`IR_USERNAME`, `IR_PASSWORD`) work.

## What works

| Step | Verified |
|---|---|
| TCP connect to `192.168.11.179:8093` from the nodak VM | ✅ |
| `POST /api/authenticate` returns 200 + plain-text token (~384 chars) | ✅ |
| `GET /api/attributes/definitions` with `Authorization: AccessToken <token>` returns 200 + 85 KB JSON array of 181 attribute definitions | ✅ |
| TLS cert: invalid without `-k` (no SAN, possibly self-signed) — must skip validation for now | ⚠️ until Wed fix |

## Reproducible recipe

Run from anywhere — `ssh nodak` takes the request to the VM that has the VPN tunnel.

```bash
# Load creds from the gitignored project-root .env
set -a; source /c/Users/sean/repo/ncp/supabase-claim-companion/.env; set +a

# Stage the JSON payload on the VM
JSON=$(printf '{"UserName":"%s","Password":"%s"}' "$IR_USERNAME" "$IR_PASSWORD")
echo "$JSON" | ssh nodak 'cat > /tmp/ir_auth.json && chmod 600 /tmp/ir_auth.json'

# Auth + protected read in one shell
ssh nodak '
  TOKEN=$(curl -sk -m 15 \
    --resolve irtest-appsvr.nodakmutual.com:8093:192.168.11.179 \
    -H "Content-Type: application/json" -H "Accept: application/json" \
    --data @/tmp/ir_auth.json \
    "https://irtest-appsvr.nodakmutual.com:8093/api/authenticate")

  echo "Got token, ${#TOKEN} chars"

  curl -sk -m 30 \
    --resolve irtest-appsvr.nodakmutual.com:8093:192.168.11.179 \
    -H "Authorization: AccessToken ${TOKEN}" \
    -H "Accept: application/json" \
    -w "\nHTTP %{http_code}  type=%{content_type}  size=%{size_download}\n" \
    "https://irtest-appsvr.nodakmutual.com:8093/api/attributes/definitions" | tail -c 500

  rm -f /tmp/ir_auth.json
'
```

Expected: token printed, then `HTTP 200`, JSON body with 181 attribute definitions.

## Two important flags

- **`--resolve irtest-appsvr.nodakmutual.com:8093:192.168.11.179`** — spoofs DNS just for this curl. The internal name doesn't resolve from our VM but the cert requires it as the hostname. `curl --resolve` is cleaner than touching `/etc/hosts`.
- **`-k`** — skip cert validation. Required until the customer regenerates the cert with proper SAN entries (Wednesday). Once fixed, drop `-k` and verify cleanly.

## Sample response shape (`/api/attributes/definitions`)

```json
[
  {"id":396,"name":"ACTION","type":2,"description":"ACTION","displayName":"ACTION","validationRule":null},
  {"id":397,"name":"ACTION2","type":2,"description":"ACTION2","displayName":"ACTION2","validationRule":null},
  {"id":398,"name":"ADJUSTER CODE","type":2,"description":"ADJUSTER CODE","displayName":"ADJUSTER CODE","validationRule":null}
  // ... 181 total
]
```

## What this unblocks

- The existing `imageright-proxy` (Express on the Azure VM) and `fetch-imageright-document` edge function can now be wired against a real API. The protocol matches what they were originally designed for — they just need:
  1. The real base URL (`https://irtest-appsvr.nodakmutual.com:8093/api`) plumbed through env
  2. `/etc/hosts` entry on the Azure VM mapping that FQDN to `192.168.11.179` (cleaner than `--resolve` once it's a long-lived service)
  3. The auth flow: call `POST /api/authenticate` once, cache the token, attach `Authorization: AccessToken <token>` to subsequent calls, refresh on 401
  4. `rejectUnauthorized: false` on the HTTPS agent until the cert is fixed — then remove
- Chris said next: he'll provide test File IDs / document IDs for the doc types we need to fetch. With those + the working auth, we can do a real `GetContent`-equivalent and pull a PDF.

## What changed in the repo as part of this resolution

- [CLAUDE.md](../CLAUDE.md) — ImageRight section rewritten: REST marked WORKING with the full URL, header format, cert caveat, and connection pattern.
- This document (new).
- [2026-05-06-ImageRight-REST-Smoke-Test.md](2026-05-06-ImageRight-REST-Smoke-Test.md) — banner added at the top pointing here.
