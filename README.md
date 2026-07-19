# waves · Sensor Dashboard

A multi-modal sensor-capture dashboard for a Raspberry Pi data-collection rig — **camera**
(`rpicam-still`), **microphone** (16 kHz mono via ALSA), and **motion** (MPU-6050 accelerometer +
gyro over I²C @ 40 Hz). You enter a label, hit **Collect**, and the app records an _N_-second sample
across all three sensors into a labelled dataset you can review and export for training.

This is a React implementation of the `Sensor Dashboard.dc.html` Claude Design component, built on the
**ProcurisUI** design system (shadcn `base-maia`, Tailwind CSS v4, OKLCH semantic tokens, Figtree).

## Stack

- **Vite** + **React 19** + **TypeScript**
- **Tailwind CSS v4** (`@tailwindcss/vite`) with the ProcurisUI OKLCH token system (light + dark)
- **class-variance-authority** for the reconstructed `Button` / `Input` / `Badge` / `Switch` primitives
- `@fontsource-variable/figtree` for the brand typeface
- `lucide-react` icons

## Getting started

```bash
npm install
npm run dev      # http://localhost:5173
npm run build    # tsc -b && vite build  →  dist/
npm run preview  # serve the production build
npm run lint     # oxlint
```

## How it works

The dashboard ships with a **built-in simulator** so the whole UI is live without any hardware. A
single `requestAnimationFrame` loop (`src/hooks/useSensorSimulation.ts`) synthesises audio, 6-axis
motion, and a procedural camera frame, renders them to `<canvas>`, and writes the numeric readouts
(dB meter, x/y/z, clock) straight to the DOM so 60 fps updates never re-render React.

- **Collect** snapshots the current camera frame and records audio + motion for the configured
  duration, then files a `Sample` into the dataset (newest first).
- **Click a dataset row** to freeze the visualisations on that stored sample (review mode); **Back to
  live** resumes.
- The **gear** popover sets the Pi host, capture duration (1–10 s), and toggles simulated activity.
  The **sun/moon** button flips the theme — every OKLCH token flips via the `.dark` class. Settings
  persist to `localStorage`.

### Wiring up a real Raspberry Pi

The simulator is isolated in `useSensorSimulation.ts` behind a small surface (`refs` + `startCapture`)
and a `Sample` shape (`src/lib/sensor.ts`). To drive the dashboard from real hardware, replace the
synthetic generators with a data source (e.g. a WebSocket from the Pi streaming mic/IMU frames, an
MJPEG/`rpicam` feed into the camera canvas) and have `startCapture` POST to a capture endpoint that
returns a `Sample`. The UI, dataset model, and review flow stay unchanged.

## Project layout

```
src/
  components/
    SensorDashboard.tsx   # the dashboard (header, capture bar, panels, dataset)
    SettingsPopover.tsx   # Pi host / duration / simulate settings
    ui/                   # ProcurisUI primitives: button, input, badge, switch
  hooks/
    useSensorSimulation.ts# the RAF simulation + capture/review engine
    useTheme.ts           # light/dark, persisted, toggles .dark on <html>
    useLocalStorage.ts
  lib/
    sensor.ts             # Sample type + sparkline/format/slug helpers
    utils.ts              # cn() class merge
  index.css               # Tailwind v4 + ProcurisUI OKLCH tokens + theme mapping
```
