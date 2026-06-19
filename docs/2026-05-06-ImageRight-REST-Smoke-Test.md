# ImageRight REST API Smoke Test (2026-05-06)

> **⚠️ HISTORICAL — RESOLVED 2026-05-13.** See [2026-05-13-ImageRight-REST-Smoke-Test-Resolution.md](2026-05-13-ImageRight-REST-Smoke-Test-Resolution.md) for the working configuration. The REST API was on `https://irtest-appsvr.nodakmutual.com:8093/api` all along — we were probing the wrong port (8093 vs 21740) and the wrong scheme (HTTPS, not HTTP). This document is kept as a record of the failure path so the same dead ends aren't re-walked.

## TL;DR

We have credentials, we have docs, but the public REST WebAPI documented in `ImageRight API - Getting Started Guide.rtf` is **not reachable on the customer's test app server** (`192.168.11.179`). Every documented endpoint returns a Web API 2 routing 404. The previously-discovered SOAP/ASMX service on port 80 is still the only working integration path.

## What we set out to do

Per the user-approved plan ([deep-wibbling-hopcroft.md](../../.claude/plans/deep-wibbling-hopcroft.md)):
1. Find the working base URL via `POST /api/authenticate`
2. Capture the returned access token
3. Verify with `GET /api/attributes/definitions`
4. One additional sanity-check endpoint

## What we actually did

### Setup

- Credentials sourced from gitignored `.env` (project root) — vars `IR_USERNAME` and `IR_PASSWORD`
- All probes run from the nodak Azure VM via `ssh nodak '...'` so they go through the StrongSwan tunnel to the customer network

### Phase 1 — base URL discovery

POST `{"UserName":"...","Password":"..."}` to each candidate:

| URL | Status | Notes |
|---|---|---|
| `http://192.168.11.179:21740/api/authenticate` | 404 | JSON body: `"No HTTP resource was found..."` (Web API 2 routing 404) |
| `http://192.168.11.179/api/authenticate` | 404 | IIS default-site HTML 404 |
| `http://192.168.11.179/imageright/api/authenticate` | 404 | IIS default-site HTML 404 |
| `http://192.168.11.179/imageright.webapi/api/authenticate` | 404 | IIS default-site HTML 404 |
| `http://192.168.11.179/IRWebApi/api/authenticate` | 404 | IIS default-site HTML 404 |
| `http://192.168.11.179/imageright.webservice/api/authenticate` | 404 | IIS default-site HTML 404 |

### Extended probes on port 21740

Tried Authentication path variants:

| Path | Result |
|---|---|
| `/authenticate` | 404 (no body, no content-type — outside `/api` prefix) |
| `/api/Authenticate` (capitalized) | 404 with Web API 2 JSON body — case-insensitive routing confirmed |
| `/api/v1/authenticate` | 404 (no body) |
| `/v1/api/authenticate` | 404 (no body) |
| `/0/api/authenticate`, `/1/api/authenticate` | 404 (no body) |
| `/api/login`, `/api/auth`, `/api/account/login`, `/oauth/token`, `/token`, `/rest/api/authenticate` | All 404 |

Tried Host header variants targeting `irtest-appsvr.nodakmutual.com` on both port 80 and port 21740 — same 404s.

Tried identification endpoints on port 21740 to see what *is* running there: `/version`, `/api/version`, `/health`, `/api/health`, `/healthcheck`, `/status`, `/swagger.json`, `/api-docs` — all 404.

### Subnet sweep

Scanned 192.168.11.0/24 for HTTP responders on ports 80 and 21740:
```
OPEN 192.168.11.179:80
OPEN 192.168.11.179:21740
```
No other servers in the subnet — the REST API is not on a different machine.

## Diagnosis

**Port 21740** is a .NET Web API 2 self-host (`Server: Microsoft-HTTPAPI/2.0`, route prefix `/api`, returns `application/json` 404 with the standard Web API 2 dispatcher message format). The framework is running but **no controllers are registered** — every documented endpoint maps to nothing. Likely candidates for what this service actually is: ImageRight Notification Service, File Storage Service, or another internal microservice. It is *not* the public WebAPI.

**Port 80** runs IIS 10 with the default welcome page and the working SOAP service at `/imageright.webservice/IRWebService40.asmx`. No virtual application hosts the REST WebAPI under any of the conventional path names.

## Conclusion

The public REST WebAPI documented in the customer-supplied PDFs is not running on the test app server, or it's bound to a port/IP we haven't discovered. Comprehensive port and path probing has not located it.

## Asks for Chris

Please confirm with the ImageRight admin / Vertafore:

1. **Is the REST WebAPI service actually installed and running on `IRTest-AppSvr` (`192.168.11.179`)?** It would be a Windows service typically named something like "ImageRight Web API" or "ImageRight.WebApi.Host".

2. **What is the exact base URL?** Specifically:
   - Port number (we tested 80 and 21740 — neither serves the REST API at any documented path)
   - Path prefix (the cloud URL pattern is `/<customerId>/api/...` — does the on-prem install use a customer ID prefix? If so, what's Nodak's?)

3. **Is there a different server hosting the REST API?** We swept the entire 192.168.11.0/24 subnet and only `192.168.11.179` responds on common HTTP ports.

4. **Could they share a known-working `curl` command** they use internally? Even just the auth call — that would tell us the exact URL.

Until any of those resolve, **the working integration path is the SOAP/ASMX service on port 80**, which we already verified end-to-end on 2026-04-28 ([2026-04-28-ImageRight-API-Discovery.md](2026-04-28-ImageRight-API-Discovery.md)).

## Reference: docs we received

- `docs/ImageRight API - Getting Started Guide.rtf` — 5.4 MB official docs (RTF, requires conversion to read)
- `docs/ImageRight API - Sample REST Code.txt` — official C# sample showing:
  ```csharp
  private const string BASE_URL = @"https://wsol-8000001app.worksmartonline.vertafore.com/8000001/api/";
  private const string AUTHENTICATE_URL = @"/authenticate";
  // POST {UserName, Password} → returns plain string token
  // Authorization: AccessToken <token>
  // GET /attributes/definitions to verify token
  ```

## Reproducing this test

```bash
# From the user's machine (not the VM):
set -a; source /c/Users/sean/repo/ncp/supabase-claim-companion/.env; set +a
JSON=$(printf '{"UserName":"%s","Password":"%s"}' "$IR_USERNAME" "$IR_PASSWORD")
echo "$JSON" | ssh nodak 'cat > /tmp/auth.json'

ssh nodak 'curl -i -m 10 \
  -H "Content-Type: application/json" -H "Accept: application/json" \
  --data @/tmp/auth.json \
  http://192.168.11.179:21740/api/authenticate'
```

Expected today: HTTP/1.1 404 Not Found with body `{"Message":"No HTTP resource was found..."}`. If that ever changes to 200 or 401, the WebAPI has been brought online.
