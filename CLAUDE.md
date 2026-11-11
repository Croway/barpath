# CLAUDE.md

Guidance for Claude Code in this repository.

## Project

Bar Path: weightlifting bar-path analysis from one side-on phone video, as an installable PWA. Single target
device: Galaxy S23, Chrome on Android. Plain ES modules, no build step, no runtime dependencies besides the
bundled MediaPipe in `vendor/` (fetched by `tools/fetch-vendor.sh`, gitignored). Everything runs on the device;
nothing is uploaded.

## Commands

```bash
npm run vendor && npm run serve            # dev server on :8765
npm test                                   # analysis on ideal data (must pass)
node test/synth.mjs /tmp/s.mp4 && node test/track.test.mjs /tmp/s.mp4 && node test/analysis.test.mjs /tmp/s.mp4
node test/e2e.mjs . /tmp/s.mp4 /tmp/s.truth.json /tmp/out           # headless Chrome at S23 size
tools/phone.sh <adb device>                # serve to the phone as http://localhost:8765 and open it
npm run icons                              # re-render PNG icons from icons/*.svg
```

## Architecture

`video.js` hands frames over in order with true media timestamps (`requestVideoFrameCallback`; playback slows
itself when processing falls behind) → `plate.js` crops a region around the predicted plate, scaled so the plate
is 36 px in radius, and finds it → `pose.js` adds 33 landmarks per frame → `analysis.js` turns samples into the
lift → `app.js` renders. `analyse()` is pure and re-runs instantly when settings change (plate size, slow-motion
factor, facing, lift type); only a new plate mark or pose model needs tracking again.

### Decisions that matter (each was a real failure)
- **Tap detection** picks the circle with the best `coverage × tightness`, not the strongest votes (the hub and
  printing win those when the rim is half hidden by dark clothes/floor) and not the largest (circles through gym
  clutter look complete).
- **Tracking** fits the centre with the radius held within a ±6% band, then lets the radius move inside the band.
  A free radius slides onto the plate's raised lip and drags the centre; a frozen radius loses the plate when its
  size on screen changes (camera close or tilted). Coasting on the last velocity is capped at 0.1 s.
- **Scale is per frame** (`R.rs`): each frame's movement is converted at that frame's plate size.
- **Start position is where the bar sat just before lift-off**, not the first frame (lifters roll the bar in).
- **Catch**: if the bar drops after its peak, the catch is its lowest point within 1 s; if it never drops (met on
  the way up), it's where the bar was slowest. Standing = the bar stops rising for good. These windows keep a bar
  dropped after the lift out of the results.
- Coordinates at the `plate.js` boundary are canvas coordinates (pixel i spans i..i+1).

## Conventions
- Colours only via the CSS tokens in `css/app.css` (validated categorical stage colours, sequential speed ramp,
  status colours with icon + label). Dark mode has its own steps.
- Text into the DOM via `textContent`, never `innerHTML` with data.
- New app files must be added to `SHELL_FILES` in `sw.js`; bump `SHELL` when caching behaviour changes.
- Every analysis change keeps `npm test` and the synthetic tracked test passing; check a real clip end to end.
