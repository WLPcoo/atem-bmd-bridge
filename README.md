# ATEM to Blackmagic Camera REST API Bridge (`atem-bmd-bridge`)

A lightweight Node.js bridge that listens for **ATEM Camera Control (`CCdP`)** commands over the network and translates them in real time to the **Blackmagic Camera Control REST API (`/control/api/v1`)** on **Blackmagic Micro Studio Camera 4K G2** (and other REST-enabled Blackmagic Studio/URSA cameras).

This lets you shade and control IP-connected Blackmagic cameras directly from **ATEM Software Control** (or an ATEM hardware CCU panel) without needing SDI return feeds.

---

## Features

- **Direct `CCdP` Packet Interception:** Listens to raw `CameraControlUpdateCommand` (`CCdP`) packets via `atem-connection`.
- **Supported Controls:**
  - **Lens (`Category 0`):** Focus (`0.0`), Instantaneous Auto Focus (`0.1`), Iris / Aperture f-stop (`0.2`), Normalised Iris (`0.3`), Ordinal Iris (`0.4`), Auto Iris (`0.5`), Zoom (`0.7`)
  - **Video / Exposure (`Category 1`):** Sensor Gain in dB (`1.13` & legacy `1.1`), ISO (`1.14`), Manual White Balance & Tint (`1.2`), Auto White Balance (`1.3`), Shutter Speed & Shutter Angle (`1.5`, `1.11`, `1.12`)
  - **DaVinci Primary Color Corrector (`Category 8`):** Lift (`8.0`), Gamma (`8.1`), Gain (`8.2`), Offset/Pedestal (`8.3`), Contrast & Pivot (`8.4`), Luma Mix (`8.5`), Hue & Saturation (`8.6`), Color Reset (`8.7`)
- **Non-Overlapping Per-Camera Queue:** Debounces rapid slider adjustments (30ms window), prevents overlapping HTTP requests, filters out idle periodic ATEM refreshes, and reuses TCP connections via HTTP Keep-Alive.

---

## Prerequisites

1. **Node.js** (v18+ recommended)
2. **Camera Setup:** Enable network control on each Micro Studio Camera 4K G2 via **Blackmagic Camera Setup** (enable Web Media Manager / REST API access over Ethernet).

---

## Configuration

Edit the IP addresses and input mapping at the top of `bridge.js`:

```js
const ATEM_IP = process.env.ATEM_IP || '10.0.80.240';

const CAMERAS = {
  5: { name: 'Roamer A', ip: '10.157.152.231' },
  6: { name: 'Roamer B', ip: '10.0.80.54' }
};
```
*(The numeric keys `5`, `6`, etc. correspond to the **Camera / Input ID** assigned in ATEM Software Control).*

---

## Installation & Usage

```bash
npm install
npm start
```

### Debug Mode
To log incoming `CCdP` commands and outgoing `PUT` requests in real time:

```powershell
# PowerShell
$env:DEBUG_CCDP="1"; npm start
```

```bash
# Bash / macOS / Linux
DEBUG_CCDP=1 npm start
```
