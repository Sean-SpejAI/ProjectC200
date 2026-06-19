# VPN Gateway & Site-to-Site Tunnel Documentation

**Last Updated:** 2026-04-23
**Status:** ✅ Fully Operational (Phase 1 + Phase 2 established)

---

## 1. Overview

This document describes the infrastructure that allows the Nodak Claims Platform (NCP) to securely reach a client's internal system (`192.168.11.179`) located behind a FortiGate firewall. An Azure VM acts as a bridge — terminating an IPsec site-to-site VPN tunnel to the FortiGate and exposing an HTTPS proxy that the application uses to forward requests into the client's internal network.

```
[NCP App] --HTTPS--> [Azure VM Proxy : 64.236.21.203] ==IPsec Tunnel==> [FortiGate : 209.243.15.170] --LAN--> [192.168.11.179]
```

---

## 2. Azure VM (VPN Gateway / Proxy Host)

| Property              | Value                          |
| --------------------- | ------------------------------ |
| Size                  | Standard_B2s                   |
| OS                    | Ubuntu 24.04 LTS               |
| Public IP (static)    | `64.236.21.203`                |
| Private IP            | `10.0.0.4`                     |
| SSH User              | `nodakadmin`                   |
| Role                  | IPsec endpoint + HTTPS proxy   |

### Required Azure configuration
- **IP Forwarding enabled** on the NIC (Azure Portal → NIC → IP configurations → *Enable IP forwarding*)
- **Kernel IP forwarding** enabled: `net.ipv4.ip_forward = 1` (in `/etc/sysctl.conf`)
- **NSG inbound rules:**
  - TCP `22` — SSH
  - TCP `443` — HTTPS proxy
  - UDP `500` — IKE
  - UDP `4500` — IPsec NAT-T

### HTTPS Proxy
- Location: `/opt/vpn-proxy/server.js`
- Runtime: Node.js
- Port: `443`
- Purpose: Forwards application HTTPS requests across the IPsec tunnel to internal targets such as `192.168.11.179`.

---

## 3. IPsec Site-to-Site Tunnel

### Endpoints

| Side       | Public IP         | Internal Subnet/Host |
| ---------- | ----------------- | -------------------- |
| Azure VM   | `64.236.21.203`   | `10.0.0.4/32`        |
| FortiGate  | `209.243.15.170`  | `192.168.11.0/24`    |

### Phase 1 (IKE_SA)
- **IKE version:** IKEv2
- **Encryption / Integrity / DH:** `AES256 / SHA256 / DH14 (modp2048)`
- **Authentication:** Pre-shared key
- **Identifiers:** wildcard (`%any` ↔ `%any`) — configured this way after troubleshooting IKE identity mismatches with the FortiGate
- **PSK:** `TestKey12345` (stored in `/etc/ipsec.secrets`)
- **DPD:** Disabled
- **StrongSwan `dhcp` plugin:** Disabled

### Phase 2 (CHILD_SA)
- **Local traffic selector:**  `10.0.0.4/32` (Azure VM)
- **Remote traffic selector:** `192.168.11.0/24` (FortiGate LAN)
- **PFS:** Enabled
- **Status:** `INSTALLED`

### Key files on the Azure VM
| File                  | Purpose                                  |
| --------------------- | ---------------------------------------- |
| `/etc/ipsec.conf`     | Tunnel definition (`leftsubnet`, `rightsubnet`, proposals, etc.) |
| `/etc/ipsec.secrets`  | PSK (wildcard identifiers `%any %any`)   |
| `/var/log/syslog`     | StrongSwan / charon logs                 |

---

## 4. Common Operations

### Check tunnel status
```bash
sudo ipsec statusall
sudo ipsec statusall | grep -E "ESTABLISHED|INSTALLED|CHILD_SA"
```

### Bring the tunnel up / down
```bash
sudo ipsec up   fortigate-tunnel
sudo ipsec down fortigate-tunnel
sudo ipsec restart
```

### Inspect Phase 2 selectors
```bash
sudo grep -E "leftsubnet|rightsubnet" /etc/ipsec.conf
```

### Tail charon logs (debugging Phase 1 / Phase 2 issues)
```bash
sudo grep -i charon /var/log/syslog | tail -50
```

### Test connectivity through the tunnel (from the Azure VM)
```bash
ping -c 4 192.168.11.1
ping -c 4 192.168.11.179
```

---

## 5. Troubleshooting History

| Issue                                              | Resolution                                                        |
| -------------------------------------------------- | ----------------------------------------------------------------- |
| Phase 1 failed to authenticate                     | IKE identity mismatch — switched both sides to wildcard `%any`    |
| FortiGate `localid` rejected                       | Removed trailing whitespace in the FortiGate `localid` field      |
| Phase 2 not establishing                           | Mirrored traffic selectors on FortiGate (Local `192.168.11.0/24`, Remote `10.0.0.4/32`) |
| StrongSwan `dhcp` plugin causing noisy errors      | Disabled the plugin                                               |

---

## 6. FortiGate Side (Reference)

The FortiGate must mirror the Azure VM Phase 2 selectors:

| Setting          | Value                |
| ---------------- | -------------------- |
| Remote Gateway   | `64.236.21.203`      |
| IKE version      | v2                   |
| Phase 1 proposal | AES256 / SHA256 / DH14 |
| PSK              | `TestKey12345`       |
| Phase 2 Local    | `192.168.11.0/24`    |
| Phase 2 Remote   | `10.0.0.4/32`        |
| PFS              | Enabled              |

---

## 7. Related Documents

- `/mnt/documents/vpn-gateway-setup-plan.md` — full VM + tunnel build guide
