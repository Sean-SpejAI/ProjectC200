# imageright-proxy

Minimal HTTPS proxy that lives on the Azure VPN VM. Forwards authenticated requests from Supabase Edge Functions through the StrongSwan VPN tunnel to the on-premises ImageRight REST API.

## Why this exists

Supabase Edge Functions run in Supabase's managed cloud and cannot route through the Azure VPN. This proxy is the bridge:

```
Edge Function  --HTTPS + Bearer token-->  Azure VM Proxy  --HTTP via VPN-->  ImageRight API
```

Because the ImageRight API has no auth (it relies on network isolation), this proxy enforces a shared bearer token so the public HTTPS endpoint isn't an unauthenticated gateway to ImageRight.

## Endpoints

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| GET | `/health` | none | Liveness probe |
| GET | `/imageright/files/:fileId` | Bearer | File/folder metadata |
| GET | `/imageright/files/:fileId/pages/:pageId/content` | Bearer | Stream PDF bytes |

The path structure mirrors the ImageRight REST API. Adjust `server.js` to match the exact paths once the client's API docs are confirmed.

## Deployment (Azure VM, Ubuntu 22.04)

### 1. Install prerequisites

```bash
sudo apt update
sudo apt install -y nodejs npm caddy
node --version   # should be >= 20
```

If the distro's Node is too old:
```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo bash -
sudo apt install -y nodejs
```

### 2. Create service user

```bash
sudo useradd --system --no-create-home --shell /usr/sbin/nologin imageright
sudo mkdir -p /opt/imageright-proxy /etc/imageright-proxy /var/log/imageright-proxy
sudo chown imageright:imageright /var/log/imageright-proxy
```

### 3. Deploy the code

```bash
sudo rsync -av --delete ./ /opt/imageright-proxy/
cd /opt/imageright-proxy
sudo -u imageright npm ci --omit=dev
```

### 4. Configure environment

Generate a shared secret:

```bash
openssl rand -hex 32
```

Save it — you'll need the same value in Supabase as `IMAGERIGHT_PROXY_TOKEN`.

Create `/etc/imageright-proxy/.env` (root-owned, 600 perms):

```bash
sudo tee /etc/imageright-proxy/.env <<'EOF'
IMAGERIGHT_BASE_URL=http://10.0.0.0/ImageRightWebAPI
PROXY_SHARED_SECRET=<paste-output-of-openssl-rand>
PORT=8080
EOF
sudo chmod 600 /etc/imageright-proxy/.env
```

Replace `IMAGERIGHT_BASE_URL` with the internal URL reachable through the VPN.

### 5. Install systemd unit

```bash
sudo cp imageright-proxy.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now imageright-proxy
sudo systemctl status imageright-proxy
```

Check logs:
```bash
sudo journalctl -u imageright-proxy -f
```

**Updating an existing host** (e.g. after a code or unit change lands in this repo):

```bash
# scp the files you want to update into /tmp/proxy-deploy/, then:
ssh nodak-prod 'sudo install -o imageright -g imageright -m 644 /tmp/proxy-deploy/server.js     /opt/imageright-proxy/server.js && \
  sudo install -o imageright -g imageright -m 644 /tmp/proxy-deploy/soap.js                     /opt/imageright-proxy/soap.js && \
  sudo install -o imageright -g imageright -m 644 /tmp/proxy-deploy/package.json                /opt/imageright-proxy/package.json && \
  sudo install -o imageright -g imageright -m 644 /tmp/proxy-deploy/package-lock.json           /opt/imageright-proxy/package-lock.json && \
  sudo install -o root      -g root      -m 644 /tmp/proxy-deploy/imageright-proxy.service     /etc/systemd/system/imageright-proxy.service && \
  sudo -u imageright HOME=/tmp/imageright-home npm --prefix /opt/imageright-proxy --cache=/tmp/imageright-home/.npm ci --omit=dev && \
  sudo systemctl daemon-reload && \
  sudo systemctl restart imageright-proxy && \
  ps -o cmd -p "$(systemctl show -p MainPID --value imageright-proxy)"'
```

Note the `HOME=/tmp/imageright-home` + `--cache=/tmp/imageright-home/.npm` —
the `imageright` user is a system user created with `--no-create-home`, so
without these flags `npm ci` aborts with "Log files were not written due to
an error writing to the directory: /home/imageright/.npm/_logs".

The final `ps` line should show `node server.js` (no `--max-old-space-size`).
The PDF-fetch path streams base64 → decode → response chunk-by-chunk via
`streamPdfForPages` in [soap.js](soap.js), so the default Node heap (~2 GB)
is plenty regardless of PDF size. If you find a `--max-old-space-size` flag
on a live host, the streaming path probably regressed — investigate before
bumping. (Pre-streaming, we OOM-crashlooped on a 50 MB PDF during the
2026-06-01 prod ingestion and hot-patched the unit with `--max-old-space-size=6144`
as a stopgap.)

### 6. Configure Caddy (TLS termination)

Replace `<FQDN>` in `Caddyfile` with the Azure VM's public DNS name (e.g. `imageright-proxy.westus.cloudapp.azure.com`), then:

```bash
sudo cp Caddyfile /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

Caddy will auto-provision a Let's Encrypt certificate on first request. Ensure ports 80 and 443 are open on the Azure NSG and UFW:

```bash
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
```

### 7. Verify

**Local (from the VM):**
```bash
curl http://localhost:8080/health
# {"status":"ok","timestamp":"..."}
```

**Public (from anywhere):**
```bash
curl https://<FQDN>/health
```

**Auth enforcement (should return 401):**
```bash
curl -i https://<FQDN>/imageright/files/123
```

**With valid token (should proxy to ImageRight):**
```bash
curl -H "Authorization: Bearer <PROXY_SHARED_SECRET>" https://<FQDN>/imageright/files/<known-test-file-id>
```

**VPN path (from VM only):**
```bash
curl $(grep IMAGERIGHT_BASE_URL /etc/imageright-proxy/.env | cut -d= -f2)/api/...
```

## Secret rotation

1. Generate a new secret: `openssl rand -hex 32`
2. Update `IMAGERIGHT_PROXY_TOKEN` in Supabase secrets for all environments
3. Update `/etc/imageright-proxy/.env` with the new `PROXY_SHARED_SECRET`
4. `sudo systemctl restart imageright-proxy`

Do step 2 **before** step 3 — updates propagate to Edge Functions first, then flip the proxy.

## Troubleshooting

- **502 from proxy:** Check VPN is up (`sudo ipsec status`). Check `IMAGERIGHT_BASE_URL` is reachable from the VM (`curl` it directly).
- **401 from proxy:** Token mismatch. Verify both sides match exactly.
- **Caddy can't get a cert:** DNS may not be pointing at the VM yet, or port 80 is blocked. Check `sudo journalctl -u caddy -f`.
