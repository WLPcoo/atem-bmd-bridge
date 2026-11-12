const http = require('http');
const { Atem, Commands } = require('atem-connection');
const axios = require('axios');

// --- Switcher Configuration ---
const ATEM_IP = process.env.ATEM_IP || '10.0.80.240';
const DEBUG_CCDP = process.env.DEBUG_CCDP === '1';

// --- Camera Mapping (ATEM Input/Camera ID -> Micro Studio Camera 4K G2 IP) ---
const CAMERAS = {
  5: { name: 'Roamer A', ip: '10.157.152.231' },
  6: { name: 'Roamer B', ip: '10.0.80.54' }
};

// Persistent HTTP Keep-Alive client so rapid CCU adjustments reuse TCP sockets
const httpClient = axios.create({
  httpAgent: new http.Agent({ keepAlive: true, maxSockets: 4 }),
  timeout: 500,
  headers: { 'Content-Type': 'application/json' }
});

// Standard Blackmagic shutter speed denominators (1/x sec) for microsecond conversion
const BMD_SHUTTER_SPEEDS = [
  24, 25, 30, 50, 60, 75, 90, 100, 120, 150, 180, 250, 360, 500, 725, 1000, 1450, 2000
];

function clamp(val, min, max) {
  return Math.min(max, Math.max(min, val));
}

function roundTo(val, decimals = 4) {
  const factor = Math.pow(10, decimals);
  return Math.round(val * factor) / factor;
}

function microsecondsToShutterSpeed(us) {
  if (!us || us <= 0) return 60;
  const rawDenominator = 1000000 / us;
  let closest = BMD_SHUTTER_SPEEDS[0];
  let minDiff = Math.abs(rawDenominator - closest);
  for (const speed of BMD_SHUTTER_SPEEDS) {
    const diff = Math.abs(rawDenominator - speed);
    if (diff < minDiff) {
      minDiff = diff;
      closest = speed;
    }
  }
  return closest;
}

// Per-camera state & non-overlapping request queue
const cameraQueues = {};
Object.keys(CAMERAS).forEach(id => {
  cameraQueues[id] = {
    pending: {},
    lastSent: {},
    timer: null,
    inFlight: false
  };
});

async function flushCameraQueue(camId) {
  const q = cameraQueues[camId];
  if (!q || q.inFlight) return;

  q.timer = null;
  q.inFlight = true;
  const cam = CAMERAS[camId];
  const baseUrl = `http://${cam.ip}/control/api/v1`;

  try {
    while (Object.keys(q.pending).length > 0) {
      const batch = q.pending;
      q.pending = {};

      for (const [endpoint, payload] of Object.entries(batch)) {
        try {
          if (payload === null) {
            await httpClient.put(`${baseUrl}${endpoint}`);
          } else {
            await httpClient.put(`${baseUrl}${endpoint}`, payload);
          }
          if (DEBUG_CCDP) {
            console.log(`[${cam.name}] PUT ${endpoint}`, payload ?? '');
          }
        } catch (err) {
          const status = err.response ? ` (HTTP ${err.response.status})` : '';
          console.error(`[${cam.name}] Error updating ${endpoint}${status}:`, err.message);
        }
      }
    }
  } finally {
    q.inFlight = false;
    // If new updates arrived right as we finished, schedule another flush
    if (Object.keys(q.pending).length > 0 && !q.timer) {
      q.timer = setTimeout(() => flushCameraQueue(camId), 30);
    }
  }
}

function queueUpdate(camId, endpoint, payload, isPeriodicFlush = false) {
  const q = cameraQueues[camId];
  if (!q) return;

  const serialized = JSON.stringify(payload);

  // Ignore redundant periodic refreshes from the ATEM if value hasn't changed
  if (isPeriodicFlush && q.lastSent[endpoint] === serialized) {
    return;
  }

  // Record initial state while ATEM is still completing its initial connection dump
  if (!isAtemConnected) {
    q.lastSent[endpoint] = serialized;
    return;
  }

  q.lastSent[endpoint] = serialized;
  q.pending[endpoint] = payload;

  if (!q.timer && !q.inFlight) {
    q.timer = setTimeout(() => flushCameraQueue(camId), 30); // 30ms debounce window
  }
}

/**
 * Translates an ATEM CCdP (CameraControlUpdateCommand) packet into
 * Blackmagic Micro Studio Camera 4K G2 REST API (/control/api/v1) calls.
 */
function handleCameraControlCommand(cmd) {
  const camId = cmd.source;
  if (!CAMERAS[camId]) return;

  const { category, parameter, properties } = cmd;
  const nums = properties.numberData || [];
  const isPeriodic = Boolean(properties.periodicFlushEnabled);

  if (DEBUG_CCDP && !isPeriodic) {
    console.log(
      `[CCdP] Cam ${camId} (${CAMERAS[camId].name}) Cat=${category} Param=${parameter} Type=${properties.type} Data=${JSON.stringify(nums)}`
    );
  }

  switch (category) {
    // --- Category 0: Lens ---
    case 0: {
      switch (parameter) {
        case 0: // Focus (0.0 = near, 1.0 = far)
          if (nums.length >= 1) {
            queueUpdate(camId, '/lens/focus', { focus: roundTo(clamp(nums[0], 0, 1)) }, isPeriodic);
          }
          break;

        case 1: // Instantaneous Autofocus trigger
          if (!isPeriodic) {
            queueUpdate(camId, '/lens/focus/doAutoFocus', null, false);
          }
          break;

        case 2: // Aperture (f-stop AV where f = 2^(AV/2))
          if (nums.length >= 1) {
            const fStop = roundTo(Math.pow(2, nums[0] / 2), 2);
            queueUpdate(camId, '/lens/iris', { apertureStop: fStop }, isPeriodic);
          }
          break;

        case 3: // Aperture (normalised 0.0 .. 1.0)
          if (nums.length >= 1) {
            queueUpdate(camId, '/lens/iris', { normalised: roundTo(clamp(nums[0], 0, 1)) }, isPeriodic);
          }
          break;

        case 4: // Aperture (ordinal index)
          if (nums.length >= 1) {
            queueUpdate(camId, '/lens/iris', { apertureNumber: Math.round(nums[0]) }, isPeriodic);
          }
          break;

        case 5: // Instantaneous Auto Aperture trigger
          if (!isPeriodic) {
            queueUpdate(camId, '/lens/iris/doAutoIris', null, false);
          }
          break;

        case 7: // Zoom (normalised 0.0 .. 1.0)
          if (nums.length >= 1) {
            queueUpdate(camId, '/lens/zoom', { normalised: roundTo(clamp(nums[0], 0, 1)) }, isPeriodic);
          }
          break;
      }
      break;
    }

    // --- Category 1: Video / Exposure / White Balance ---
    case 1: {
      switch (parameter) {
        case 1: // Legacy Sensor Gain (1, 2, 4, 8, 16 -> convert to dB for Micro Studio 4K G2)
          if (nums.length >= 1 && nums[0] > 0) {
            const dbGain = Math.round(20 * Math.log10(nums[0] / 4));
            queueUpdate(camId, '/video/gain', { gain: dbGain }, isPeriodic);
          }
          break;

        case 2: // Manual White Balance [kelvin, tint]
          if (nums.length >= 1) {
            queueUpdate(camId, '/video/whiteBalance', { whiteBalance: Math.round(nums[0]) }, isPeriodic);
          }
          if (nums.length >= 2) {
            queueUpdate(camId, '/video/whiteBalanceTint', { whiteBalanceTint: Math.round(nums[1]) }, isPeriodic);
          }
          break;

        case 3: // Set Auto White Balance trigger
          if (!isPeriodic) {
            queueUpdate(camId, '/video/whiteBalance/doAuto', null, false);
          }
          break;

        case 5: // Exposure (microseconds -> convert to 1/x shutterSpeed denominator)
          if (nums.length >= 1 && nums[0] > 0) {
            const shutterSpeed = microsecondsToShutterSpeed(nums[0]);
            queueUpdate(camId, '/video/shutter', { shutterSpeed }, isPeriodic);
          }
          break;

        case 11: // Shutter Angle (1/100ths of a degree, e.g. 18000 = 180 deg)
          if (nums.length >= 1 && nums[0] > 0) {
            queueUpdate(camId, '/video/shutter', { shutterAngle: Math.round(nums[0] / 100) }, isPeriodic);
          }
          break;

        case 12: // Shutter Speed (denominator 1/x sec, e.g. 60 = 1/60s)
          if (nums.length >= 1 && nums[0] > 0) {
            queueUpdate(camId, '/video/shutter', { shutterSpeed: Math.round(nums[0]) }, isPeriodic);
          }
          break;

        case 13: // Sensor Gain in dB (Micro Studio 4K G2 native gain)
          if (nums.length >= 1) {
            queueUpdate(camId, '/video/gain', { gain: Math.round(nums[0]) }, isPeriodic);
          }
          break;

        case 14: // ISO
          if (nums.length >= 1 && nums[0] > 0) {
            queueUpdate(camId, '/video/iso', { iso: Math.round(nums[0]) }, isPeriodic);
          }
          break;
      }
      break;
    }

    // --- Category 8: Color Correction (DaVinci Resolve Primary Grading) ---
    case 8: {
      switch (parameter) {
        case 0: // Lift [red, green, blue, luma] (-2.0 .. 2.0)
          if (nums.length >= 4) {
            queueUpdate(
              camId,
              '/colorCorrection/lift',
              {
                red: roundTo(clamp(nums[0], -2, 2)),
                green: roundTo(clamp(nums[1], -2, 2)),
                blue: roundTo(clamp(nums[2], -2, 2)),
                luma: roundTo(clamp(nums[3], -2, 2))
              },
              isPeriodic
            );
          }
          break;

        case 1: // Gamma [red, green, blue, luma] (-4.0 .. 4.0)
          if (nums.length >= 4) {
            queueUpdate(
              camId,
              '/colorCorrection/gamma',
              {
                red: roundTo(clamp(nums[0], -4, 4)),
                green: roundTo(clamp(nums[1], -4, 4)),
                blue: roundTo(clamp(nums[2], -4, 4)),
                luma: roundTo(clamp(nums[3], -4, 4))
              },
              isPeriodic
            );
          }
          break;

        case 2: // Gain [red, green, blue, luma] (0.0 .. 16.0)
          if (nums.length >= 4) {
            queueUpdate(
              camId,
              '/colorCorrection/gain',
              {
                red: roundTo(clamp(nums[0], 0, 16)),
                green: roundTo(clamp(nums[1], 0, 16)),
                blue: roundTo(clamp(nums[2], 0, 16)),
                luma: roundTo(clamp(nums[3], 0, 16))
              },
              isPeriodic
            );
          }
          break;

        case 3: // Offset / Pedestal [red, green, blue, luma] (-8.0 .. 8.0)
          if (nums.length >= 4) {
            queueUpdate(
              camId,
              '/colorCorrection/offset',
              {
                red: roundTo(clamp(nums[0], -8, 8)),
                green: roundTo(clamp(nums[1], -8, 8)),
                blue: roundTo(clamp(nums[2], -8, 8)),
                luma: roundTo(clamp(nums[3], -8, 8))
              },
              isPeriodic
            );
          }
          break;

        case 4: // Contrast [pivot, adjust] (pivot: 0..1, adjust: 0..2)
          if (nums.length >= 2) {
            queueUpdate(
              camId,
              '/colorCorrection/contrast',
              {
                pivot: roundTo(clamp(nums[0], 0, 1)),
                adjust: roundTo(clamp(nums[1], 0, 2))
              },
              isPeriodic
            );
          }
          break;

        case 5: // Luma Mix / Contribution (0.0 .. 1.0)
          if (nums.length >= 1) {
            queueUpdate(
              camId,
              '/colorCorrection/lumaContribution',
              { lumaContribution: roundTo(clamp(nums[0], 0, 1)) },
              isPeriodic
            );
          }
          break;

        case 6: // Color Adjust [hue, saturation] (hue: -1..1, saturation: 0..2)
          if (nums.length >= 2) {
            queueUpdate(
              camId,
              '/colorCorrection/color',
              {
                hue: roundTo(clamp(nums[0], -1, 1)),
                saturation: roundTo(clamp(nums[1], 0, 2))
              },
              isPeriodic
            );
          }
          break;

        case 7: // Reset Color Correction to defaults
          if (!isPeriodic) {
            queueUpdate(camId, '/colorCorrection/lift', { red: 0, green: 0, blue: 0, luma: 0 }, false);
            queueUpdate(camId, '/colorCorrection/gamma', { red: 0, green: 0, blue: 0, luma: 0 }, false);
            queueUpdate(camId, '/colorCorrection/gain', { red: 1, green: 1, blue: 1, luma: 1 }, false);
            queueUpdate(camId, '/colorCorrection/offset', { red: 0, green: 0, blue: 0, luma: 0 }, false);
            queueUpdate(camId, '/colorCorrection/contrast', { pivot: 0.5, adjust: 1 }, false);
            queueUpdate(camId, '/colorCorrection/lumaContribution', { lumaContribution: 1 }, false);
            queueUpdate(camId, '/colorCorrection/color', { hue: 0, saturation: 1 }, false);
          }
          break;
      }
      break;
    }
  }
}

let isAtemConnected = false;
const atem = new Atem();

atem.on('error', err => {
  console.error('[ATEM] Error:', err);
});

atem.on('connected', () => {
  isAtemConnected = true;
  console.log(`[ATEM] Connected to switcher at ${ATEM_IP}`);
  console.log(
    `[BRIDGE] Monitoring CCdP camera control for inputs: ${Object.entries(CAMERAS)
      .map(([id, c]) => `${id} (${c.name} @ ${c.ip})`)
      .join(', ')}`
  );
});

atem.on('disconnected', () => {
  isAtemConnected = false;
  console.log('[ATEM] Disconnected from switcher');
});

// Intercept deserialized CCdP (CameraControlUpdateCommand) packets directly
atem.on('receivedCommands', commands => {
  for (const cmd of commands) {
    if (
      cmd instanceof Commands.CameraControlUpdateCommand ||
      (cmd && cmd.constructor && cmd.constructor.rawName === 'CCdP')
    ) {
      handleCameraControlCommand(cmd);
    }
  }
});

console.log(`Connecting to ATEM at ${ATEM_IP}...`);
atem.connect(ATEM_IP);
