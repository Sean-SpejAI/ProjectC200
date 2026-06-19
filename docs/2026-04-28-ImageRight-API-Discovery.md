# ImageRight API Discovery (2026-04-28)

## TL;DR

The customer's ImageRight environment exposes a **SOAP/ASMX web service**, not the REST API documented in the public Vertafore PDF. End-to-end SOAP connectivity over the StrongSwan VPN is verified working. Authentication is required via a `UserLogin` operation; we need test-environment credentials before we can do anything beyond a smoke test.

## What we confirmed

| Layer | Status |
|---|---|
| StrongSwan IPsec tunnel | Up and stable (16 hours at time of test) |
| L3 reachability to `192.168.11.179` | ICMP ping ~12ms RTT |
| HTTP reachable on the IIS server (port 80) | Yes |
| WSDL retrievable | Yes — 291 KB, 342 operations |
| SOAP 1.1 envelope round-trip | Yes — `AvailableConnections` returned `["Test"]` |
| Authentication required | Yes — every operation other than `AvailableConnections` returns `Not logged in.` |

## Key API details

- **Endpoint:** `http://192.168.11.179/imageright.webservice/IRWebService40.asmx`
- **WSDL:** add `?wsdl` to the endpoint. Local copy committed at [IRWebService40.wsdl](IRWebService40.wsdl).
- **Namespace:** `http://imageright.com/imageright.webservice`
- **Available connection:** `"Test"` (returned by `AvailableConnections`)
- **Auth flow:** `UserLogin(username, password, connName)` → returns string token → pass in `securityToken` param of every other call

## Important operations (sample)

The WSDL exposes 342 operations. The ones likely relevant to the claims integration:

| Operation | Purpose |
|---|---|
| `AvailableConnections` | List connection names (no auth) |
| `UserLogin` | Authenticate, returns security token |
| `CurrentUser` | Get current logged-in user |
| `GetDrawers` / `GetDrawerByRef` | Top-level container listings |
| `FindFiles` / `FindFilesEx` | Search for files (claims) |
| `FindDocuments` / `FindDocumentsEx` | Search for documents inside a file |
| `GetDocumentByRef` | Get document metadata |
| `GetContent` | Download document content (PDF bytes) |
| `CreateFile` / `CreateDocument` | Write back into ImageRight |

## What changed vs. our original plan

The original plan assumed the REST API. We built:
- `imageright-proxy/` — Express HTTP proxy that forwards REST GETs
- `supabase/functions/fetch-imageright-document/` — edge function calling REST endpoints

Both will need rework to handle SOAP. Two options:

1. **Make the proxy SOAP-aware.** The proxy on the Azure VM constructs SOAP envelopes and exposes a clean REST surface to the edge function. Recommended — it isolates the SOAP complexity to one place.
2. **Make the edge function SOAP-aware.** More duplication if other edge functions later need ImageRight access.

Option 1 keeps the contract between the edge function and the proxy unchanged from the original design.

## Reproducing the smoke test

From the nodak VM (`ssh nodak`):

```bash
cat > /tmp/availableconnections.xml <<EOF
<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <AvailableConnections xmlns="http://imageright.com/imageright.webservice" />
  </soap:Body>
</soap:Envelope>
EOF

curl -s \
  -H "Content-Type: text/xml; charset=utf-8" \
  -H 'SOAPAction: "http://imageright.com/imageright.webservice/AvailableConnections"' \
  --data @/tmp/availableconnections.xml \
  "http://192.168.11.179/imageright.webservice/IRWebService40.asmx"
```

Expect: `<AvailableConnectionsResult><string>Test</string></AvailableConnectionsResult>`

## Outstanding asks (for Chris)

1. **Test-environment credentials** — username, password, and confirm `connName="Test"` is correct.
2. **A known test File ID** so we can exercise `FindFiles` → `GetDocumentByRef` → `GetContent` end-to-end.
3. Confirm the document content from `GetContent` is returned as bytes inline in the SOAP response (large PDFs may be a problem for that pattern; some ASMX services use MTOM/DIME for binary).

## Out of scope until creds arrive

- Building the SOAP wrapper in `imageright-proxy`
- Wiring `fetch-imageright-document` to call it
- Streaming PDFs into Supabase Storage
