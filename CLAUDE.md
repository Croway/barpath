# CLAUDE.md

Guidance for Claude Code in this repository.

## Project

Bar Path: weightlifting bar-path analysis from one side-on phone video, as an installable PWA. Single target
device: Galaxy S23, Chrome on Android. Plain ES modules, no build step, no runtime dependencies besides the
bundled MediaPipe in `vendor/` (fetched by `tools/fetch-vendor.sh`, gitignored). Everything runs on the device;
nothing is uploaded. Published at https://croway.github.io/barpath/ by `.github/workflows/pages.yml` on every
push to `main` (public repo); that address is also the `canonical` link Share app hands out from a dev server.

## Commands

```bash
npm run vendor && npm run serve            # dev server on :8765
npm test                                   # snatch on ideal data + squat/deadlift/bench/press on a synthetic lifter + QR read-back (must pass)
node test/synth.mjs /tmp/s.mp4 && node test/track.test.mjs /tmp/s.mp4 && node test/analysis.test.mjs /tmp/s.mp4
node test/e2e.mjs . /tmp/s.mp4 /tmp/s.truth.json /tmp/out --at 0.4 --end 4   # headless Chrome at S23 size: drags the handles, reads the share QR
tools/phone.sh <adb device>                # serve to the phone as http://localhost:8765 and open it
npm run icons                              # re-render PNG icons from icons/*.svg
```

## Architecture

`trim.js` (timeline under the video) chooses the part to analyse: `S.start`..`S.end` (null = video end) →
`video.js` hands frames over in order with true media timestamps (`requestVideoFrameCallback`; playback slows
itself when processing falls behind) → `plate.js` crops a region around the predicted plate, scaled so the plate
is 36 px in radius, and finds it → `pose.js` adds 33 landmarks per frame → `analysis.js` turns samples into the
lift → `app.js` renders. `analyse()` is pure and re-runs instantly when settings change (plate size, slow-motion
factor, facing, lift, load kg); only a new plate mark or pose model needs tracking again.

Gallery: every fresh analysis is saved (`store.js`, IndexedDB stores lifts / data / videos, so the list never
reads videos); a saved lift keeps its samples and settings and reopens by re-running `analyse()`. Settings changed
on the results update it; Mark again → Analyse replaces it. `compare.js` lines lifts up at `t0i` (τ = s from
lift-off), syncs their videos on a wall clock and nudges any that drift. Gallery and compare get history entries,
so the phone's Back works.

`analyse()` = `prepare()` (grid, smoothing, per-frame scale, pose access) → `recognise()` → `olympic()` (snatch,
clean, jerk: one pull) or `reps()` (squat, bench go down first; deadlift, press go up first). Both return the same
shape for the UI: `title, tiles, marks, span, t0i, axis, stages, metrics, checks, notes` (+ `reps`, `repOf` for
rep lifts). Olympic lifts use slots 1–6 in order (first pull, transition, second pull, turnover, catch,
recovery: the palette's first six, validated as adjacent pairs in that order); rep lifts use slots 1–3 only
(validated against each other in any order). Elite figures and thresholds cite their studies in comments.

Recognition: lying = flat torso AND bar above the shoulders (a deadlift set-up is flat too); a pull is told by
where the bar FINISHES on the body (hips = deadlift, shoulders/overhead = clean/snatch), not by speed; squat vs
press by the bar's biggest trip from rest, not its first move (unracking lifts the bar before a squat).

### Decisions that matter (each was a real failure)
- **Tap detection** picks the circle with the best `coverage × tightness`, not the strongest votes (the hub and
  printing win those when the rim is half hidden by dark clothes/floor) and not the largest (circles through gym
  clutter look complete).
- **Tracking** fits the centre with the radius held within a ±6% band, then lets the radius move inside the band.
  A free radius slides onto the plate's raised lip and drags the centre; a frozen radius loses the plate when its
  size on screen changes (camera close or tilted). Coasting on the last velocity is capped at 0.1 s.
- **Scale is per frame** (`R.rs`): each frame's movement is converted at that frame's plate size.
- **Start position is where the bar sat just before lift-off**, not the first frame (lifters roll the bar in).
- **Hips first / chest drop**: the MOST the torso tips forward in the first third of the lift, not its lean at
  the one-third point (while the hips shoot up the bar barely moves, and the torso has recovered by then).
- **Catch**: if the bar drops after its peak, the catch is its lowest point within 1 s; if it never drops (met on
  the way up), it's where the bar was slowest. Standing = the bar stops rising for good. These windows keep a bar
  dropped after the lift out of the results.
- Coordinates at the `plate.js` boundary are canvas coordinates (pixel i spans i..i+1).
- **Power** = d/dt of the bar's energy (m·g·h + ½m·v²) smoothed at 6 Hz; force = m(g + a) with acceleration
  smoothed at 6 Hz on top of the 10 Hz positions. Less smoothing doesn't recover a sharp force peak (the position
  filter limits it) and inflates power under tracking noise. Multiplying the 6 Hz acceleration by the sharper 10 Hz
  speed instead read peak power 3–5% high.
- **Mean lifting speed** (rep lifts) runs while the bar rises faster than 0.02 m/s, its ends interpolated between
  frames: the mean concentric velocity of linear transducers and published load-velocity data (Renner 2024).
  Bounding the legs by distance from the rest position dropped the slow start and lockout and read 7–15% high. The
  test reference is the exact path processed like a transducer (1 kHz, 10 Hz zero-lag filter, 0.02 m/s).
- **Per-frame scale beats a pinhole back-projection** about the image centre: with the phone tilted up to 20°, the
  plate's radius shrinks with the same vertical foreshortening as the movement, so heights and speeds stay right
  (back-projection read 9% low); it was only ~1 cm better sideways.
- **First pull without the body**: a speed dip if there is one, else the bar's furthest-back point (Nagao 2019).
  Most good lifters' bars never slow in the transition, so a dip-only rule left one undivided "Pull".
- **Record opens the camera app** (`<input capture>`), not the in-app camera: on a Galaxy S23 browsers get the
  camera at 30 fps at most (getUserMedia refuses 60 at any size, Chrome and Samsung Internet alike), while the
  camera app opened from the page records FHD 60. The in-app camera (spirit level) is the secondary 30 fps option.
  Chrome ignores `capture="environment"` (a bare ACTION_VIDEO_CAPTURE intent), and the S23 camera starts on the
  front camera in that mode: the hint says to flip; the back camera remembers FHD 60.
- **The plate mark belongs to the start frame** (tracking only runs forward). The circle is drawn only on that
  frame; letting go of the end handle shows the start frame again; a tap on the plate near the end is refused;
  moving the start re-finds the plate near the old mark (kept as is, with a warning, if the rim isn't found).

## Conventions
- Colours only via the CSS tokens in `css/app.css` (validated categorical stage colours, sequential speed ramp,
  status colours with icon + label). Dark mode has its own steps; QR codes stay dark on light in both.
- Text into the DOM via `textContent`, never `innerHTML` with data.
- New app files must be added to `SHELL_FILES` in `sw.js`; bump `SHELL` when caching behaviour changes.
- Every analysis change keeps `npm test` and the synthetic tracked test passing; check a real clip end to end.
