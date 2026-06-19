# ImageRight SOAP Integration — Call Sequence & What We Retrieve (2026-06-17)

Shareable reference for the Nodak / Vertafore (ImageRight) team to validate that our integration is calling `IRWebService40.asmx` correctly. It documents (a) the exact ordered SOAP operations we invoke, (b) how we handle page formats, (c) the effective identity our calls run as, and (d) **exactly what our integration can and cannot see** for the claims in question.

## Connection & authentication

| Property | Value |
|---|---|
| Endpoint | `http://192.168.11.179/imageright.webservice/IRWebService40.asmx` (over the site-to-site VPN) |
| `Host` header | `irtest-appsvr.nodakmutual.com` |
| **HTTP auth (IIS)** | **NTLM / Windows Authentication — REQUIRED** (Anonymous is off). Every request carries NTLM creds; `curl --ntlm -u "<user>:<pass>"`. Basic/Negotiate are rejected. |
| **NTLM credential** | Windows account **`spejai@nodakmutual.com`** + password |
| `UserLogin` (SOAP body) username | `spejai@nodakmutual.com` (or `spejai` — both work once NTLM passes) |
| `connName` | `Test` |
| Drawer | CLMS, id `1383` |
| Available connections | `AvailableConnections` → **`["Test"]`** (only one backend exposed) |

**Three auth layers** (all required end-to-end):
1. **HTTP NTLM (Windows Auth)** — gates *who can reach* the endpoint. As of 2026-06-17 IIS Windows Authentication is on and Anonymous is off, so every HTTP request must present NTLM credentials before the SOAP service runs.
2. **SOAP `UserLogin`** — returns a `securityToken` (GUID). `connName` must be `Test`. The token **rotates on every response** — thread the latest into the next call.
3. **App-pool identity** — `CurrentUser` reports the IIS app-pool service account **`irservices` (id 6, "IR Services")**, *not* the NTLM caller. This identity governs **document-class permissions** (BI/PIP/medical visibility). It is correctly provisioned with full access. (It was previously misconfigured to `webagent` (id 211), which lacked BI/PIP access and made these claims appear empty — now resolved.)

- `CurrentUser` SOAPAction `"http://imageright.com/imageright.webservice/CurrentUser"`; request `<CurrentUser><securityToken>{token}</securityToken></CurrentUser>`; response `SecurityAccount.Name=irservices`, `Id.Id=6`.

**Health check:** `GET …asmx?WSDL` returns **200 only with `--ntlm`**; **401** = Windows-auth layer rejecting (no/wrong NTLM creds); **500** = app pool down / misconfigured identity.

## Document-pull call sequence

| # | Operation | Key request parameters | What we read |
|---|---|---|---|
| 1 | `UserLogin` | `username=spejai`, `password=…`, `connName=Test` | `securityToken` |
| 2 | `FindFilesEx` | `searchConditions` = DrawerCondition `drsaDrawerId=1383` **AND** FileCondition `fsaFileNumber=<claim#>`; `getContent=false`, `includeDeleted=false` | `File.Id.RefId` (fileId), `FileNumber1`, `Description` |
| 3 | `GetFileByRef` | `fileRef.RefId=<fileId>`, `getContent=true`, `includeDeleted=false` | File attributes + **top-level** folders/documents (`Content.TypedObjectData`, `@xsi:type` = `Folder`/`Document`) |
| 4 | `GetContent` (recursive, one per folder) | `objectId=<folderId>`, `includeDeleted=false` | Child folders/documents; recurse into each child `Folder`. `GetFileByRef`'s content is one level deep, so we walk folders with `GetContent`. |
| 5 | `GetPages` | `documentRef.RefId=<docId>`, `includeDeleted=false` | `Page.Id.RefId` + `Page.Format` per page |
| 6 | `GetMultiPageImageFileUsingPages` | `pageRefs=[…]`, `outputType=PDF` (or `Native` for office docs) | base64 of a single merged PDF (streamed) |

Exact request envelopes (namespace `xmlns="http://imageright.com/imageright.webservice"`, inside the standard `soap:Envelope`/`Body`):

```xml
<!-- 2. FindFilesEx -->
<FindFilesEx>
  <securityToken>{token}</securityToken>
  <searchConditions>
    <DrawerConditions><DrawerCondition>
      <AType>atInt</AType><ATarget>catSelf</ATarget><CompOp>coEqual</CompOp>
      <Id>0</Id><Value xsi:type="xsd:long">1383</Value>
      <ConditionName>drsaDrawerId</ConditionName>
    </DrawerCondition></DrawerConditions>
    <FileConditions><FileCondition>
      <AType>atString</AType><ATarget>catSelf</ATarget><CompOp>coEqual</CompOp>
      <Id>0</Id><Value xsi:type="xsd:string">0000325507</Value>
      <ConditionName>fsaFileNumber</ConditionName>
    </FileCondition></FileConditions>
    <Operation>And</Operation>
  </searchConditions>
  <getContent>false</getContent><includeDeleted>false</includeDeleted>
</FindFilesEx>

<!-- 3. GetFileByRef -->
<GetFileByRef>
  <securityToken>{token}</securityToken>
  <fileRef><RefId>{fileId}</RefId></fileRef>
  <getContent>true</getContent><includeDeleted>false</includeDeleted>
</GetFileByRef>

<!-- 4. GetContent (per folder) -->
<GetContent>
  <securityToken>{token}</securityToken>
  <objectId>{folderId}</objectId>
  <includeDeleted>false</includeDeleted>
</GetContent>

<!-- 5. GetPages -->
<GetPages>
  <securityToken>{token}</securityToken>
  <documentRef><RefId>{docId}</RefId></documentRef>
  <includeDeleted>false</includeDeleted>
</GetPages>

<!-- 6. GetMultiPageImageFileUsingPages -->
<GetMultiPageImageFileUsingPages>
  <securityToken>{token}</securityToken>
  <pageRefs><PageRef><RefId>{pageId}</RefId></PageRef> ...</pageRefs>
  <outputType>PDF</outputType>
</GetMultiPageImageFileUsingPages>
```

## Page-format handling (we do NOT filter to "PDF only")

A document is a set of `Page` objects, each with a `Format`. We render **all** pages to a single PDF via `GetMultiPageImageFileUsingPages(outputType=PDF)` — scanned **image** pages (TIFF/JPG/etc.), PDF pages, and unknown/blank formats are **all kept** (fail-open). The only exclusions:
- **Audio/video** formats (MP3/MP4/WAV/AVI/…) are skipped (no PDF-renderable content).
- **Office/email** formats (DOC/DOCX/MSG/EML/XLS/…) are fetched as `Native` and converted to PDF separately.
- Known gap: in a **mixed** image+office document, the office pages are currently omitted from the merged PDF (tracked separately).

So an all-image 288-page medical record (e.g. a `BIDO – MAYO CLINIC` document) would be retrieved **in full** — *if our account can see it* (see below).

## Diagnostic operations (read-only)

Used by our presence-probe to verify what's actually retrievable, independent of the folder walk:
- `CurrentUser` — effective account (above).
- `AvailableConnections` — backend connections (`["Test"]`).
- `FindDocumentsEx` — server-side document search by `drsaDrawerId=1383` + `fsaFileNumber`, `includeDeleted=true` (does NOT use the folder walk).
- `GetFolderByRef` / `GetContent(includeDeleted=true)` — folder contents incl. deleted/cut.

## Diagnostic snapshot — what `webagent` saw BEFORE the fix (historical)

> **Note:** this section captured the *broken* state (app pool running as `webagent`). It is superseded by the ✅ RESOLUTION section below — full access is now confirmed. Kept as the diagnostic record.

Run live 2026-06-17 (pre-fix). "Engineer (admin)" = what a Nodak staff member sees in the ImageRight Desktop client.

| Claim | Our integration (`webagent`) retrieves | Engineer (admin) sees |
|---|---|---|
| **0000325507** EVANSON (fileId 89462305) | **6 docs**: 1 `SG11` (Declarations, 2p) + 5 cut `CORR` (0p). Folder `Claimant - 01 "Michael Evanson - IVD, PIP, UIM, atty"` → **EMPTY**; + 26 empty `New Mail` folders. | 6,042 pages incl. BI/PIP medical |
| **0000360689** VALADEZ (fileId 104999104) | **3 docs**: `SG11` (2p), `STAT` (1p), `MAIL` (0p). Folder `Claimant - 02 "Shelley (Michelle) Knippling - CVD, BI"` → **EMPTY**. | 507 pages incl. BI |
| **0000312624** DYE | `FindFilesEx` → **0 files** (not visible to `webagent`). | 1,538 pages |
| **0000264463** HUST (fileId 60576567) | **9 docs**: `SG11`/`CORR`/`STAT` skeleton. **No `Claimant - 01` folder, no `BIDO – MAYO CLINIC` document.** | `BIDO – MAYO CLINIC` (288p) + more |

### Document-by-document (every object our session returns)

Folder → documents, with ImageRight document-type code, page count, and delete state. "EMPTY" = the folder returns zero child documents to our session.

**0000325507 EVANSON** (fileId 89462305):
- `Claim Information`: `SG11` (Declarations, 2p); `CORR` (0p, Cut) ×5
- `Claimant - 01` — "Michael Evanson - IVD, PIP, UIM, atty": **EMPTY**
- `Claimant - 19`: **EMPTY**
- `New Mail` ×26: all **EMPTY**

**0000360689 VALADEZ** (fileId 104999104):
- `Claim Information`: `SG11` (2p)
- `Claimant - 01`: `STAT` (Statement, 1p)
- `Claimant - 02` — "Shelley (Michelle) Knippling - CVD, BI": **EMPTY**
- `New Mail`: `MAIL` (0p); + 4 more `New Mail` folders, all **EMPTY**

**0000312624 DYE:** file not visible to our session at all (`FindFilesEx` → 0 files).

**0000264463 HUST** (fileId 60576567):
- `Claim Information`: `SG11` (2p); `SG11` (0p, Cut) ×2; `CORR` (0p, Cut); `CORR` (1p); `CORR` (0p, Cut) ×2  — 7 docs
- `Claimant - 02` — "BRYAN HUST-002": `STAT` (1p)
- `Claimant - 03` — "AMENA CHAUDHRY (clmt driver, BI, atty)": `STAT` (1p)
- `New Mail` ×11: all **EMPTY**
- **Not returned to us:** the `Claimant - 01` folder and its `BIDO – MAYO CLINIC` (288p) document the engineer sees on screen.

Document-type codes seen: `SG11` (Declarations), `CORR` (Correspondence), `STAT` (Statement), `MAIL` (New Mail). **None** of the BI/PIP/medical classes (`BIDO`, `PIPR`, `PIPB`, `PIPC`, `MATD`, `IME`, bills) appear for any of these claims.

Drawer-wide, in the freshest 2-week window (CLMS documents created 2026-05-01…14), `webagent` sees **65 documents — all `CORR` + `MAIL`; zero `BIDO`/`PIPR`/`PIPB`/medical/bills**.

## ✅ RESOLUTION (2026-06-17, later same day)

The "empty folders" above were a **misconfigured IIS app-pool identity** — the WebService was running as account **`webagent` (id 211)**, which lacked BI/PIP document-class permissions. Nodak corrected the app pool to run as **`irservices` (id 6)**, which has full access. Then Nodak switched the WebService to **Windows Authentication (NTLM)** (Anonymous off), and our proxy was updated to send NTLM (`curl --ntlm`).

**After both changes, full access is confirmed.** Re-running the exact same calls now returns the complete BI/PIP record:

| Claim | Before (`webagent`) | **After (`irservices` + NTLM)** |
|---|---|---|
| 0000325507 EVANSON | 6 docs | **18 live docs = 6,041 pages** — BIDO 3143p, BIDO 1081p, PIPR 630p/595p, PIPC 313p, PIPB 94p, MATD 29p (all under "Michael Evanson - IVD, PIP, UIM, atty") |
| 0000360689 VALADEZ | 3 docs | Claimant-02 "…CVD, BI" full: BIDO 169p/139p/44p, MATD 103p |
| 0000312624 DYE | not found | **found** (fileId 84623991): POLDEM 668p ×2, ATTLIEN ×13, Litigation |
| 0000264463 HUST | 9 docs | Claimant-03 "AMENA CHAUDHRY (BI, atty)" full: BIDO 75p + more |

Streaming PDF fetch over NTLM returns valid `%PDF` (200). The `webagent`/empty-folder snapshot above is retained as the diagnostic record; it no longer reflects current behavior.
