# Nodak Prod VM — FortiGate Peer Whitelist Handoff

**Date:** 2026-05-28
**Status:** New prod VM is fully provisioned in the Nodak IT Azure subscription. HTTPS endpoint live with a valid Let's Encrypt cert. Only remaining step before the prod claims-analyzer can talk to ImageRight is whitelisting the new VM's public IP on the Nodak FortiGate.

## What was built

VM in resource group `ClaimsAnalyzerTool`, region `centralus`:

| Property | Value |
|---|---|
| VM name | `nodak-prod` |
| **Public IP** | **`20.9.44.53`** ← needs FortiGate whitelist |
| FQDN | `nodak-prod-imageright.centralus.cloudapp.azure.com` |
| Private IP | `10.1.0.4` |
| VNet / subnet | `nodak-prod-vnet` (`10.1.0.0/16`) / `default` (`10.1.0.0/24`) |
| Size | Standard_D2s_v3 |
| OS | Ubuntu 24.04 LTS (Pro) |

Software installed and running (mirrors the Dev VM exactly):

- **StrongSwan 5.9.13** — IPSec IKEv2, currently in CONNECTING state, retrying every 4s. Tunnel config matches Dev: `right=209.243.15.170`, `rightsubnet=192.168.11.0/24`, `ike=aes256-sha256-modp2048`, `esp=aes256-sha256-modp2048`. PSK provisionally set to the Dev value (see PSK question below).
- **Caddy 2.6.2** — HTTPS reverse-proxy with a Let's Encrypt cert auto-issued for the FQDN above. Listening on 80 + 443.
- **Node 20.20.2** + the SOAP proxy at `/opt/imageright-proxy/` — running as the `imageright` system user, listening on `localhost:8080`. Confirmed reachable end-to-end via HTTPS; the HMAC auth gate is active (`HTTP 401` without a valid signature).

## What we need from Nodak's network team

1. **Add `20.9.44.53` as an accepted IPSec peer on the FortiGate at `209.243.15.170`**, identical to how the Dev VM IP (`64.236.21.203`) was added previously. Same tunnel parameters; only the source IP changes.
2. **PSK question** — confirm whether the Nodak side wants a brand-new pre-shared key issued for this prod tunnel, or whether re-using the existing Dev PSK is acceptable. Either works; we just need to know which value to put in `/etc/ipsec.secrets` on the prod VM.

## Verification after the FortiGate update

We'll run:

```bash
ssh nodak-prod 'sudo ipsec status'
```

Expected: a line beginning `fortigate-tunnel[N]: ESTABLISHED ...` instead of `CONNECTING`.

Then a SOAP reachability check:

```bash
ssh nodak-prod 'curl -sk --max-time 10 http://192.168.11.179/imageright.webservice/IRWebService40.asmx?wsdl | head -2'
```

Expected: `<?xml version="1.0" encoding="utf-8"?>` (the WSDL).

Once both succeed, we wire the prod Supabase Edge functions to the new proxy URL and the prod environment is live end-to-end.
