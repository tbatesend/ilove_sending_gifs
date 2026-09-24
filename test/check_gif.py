"""Decode the GIFs written by encoder.test.js with Pillow and compare them
against the source frames."""
import json
import sys
from pathlib import Path

from PIL import Image, ImageSequence

out = Path(__file__).parent / "out"
failed = False

for meta_path in sorted(out.glob("*.json")):
    name = meta_path.stem
    meta = json.loads(meta_path.read_text())
    w, h, count = meta["width"], meta["height"], meta["count"]
    raw = (out / f"{name}.rgb").read_bytes()
    frame_size = w * h * 3
    expected = [raw[i * frame_size:(i + 1) * frame_size] for i in range(count)]

    img = Image.open(out / f"{name}.gif")
    assert img.size == (w, h), (name, img.size)
    decoded = []
    durations = []
    for frame in ImageSequence.Iterator(img):
        decoded.append(frame.convert("RGB").tobytes())
        durations.append(frame.info.get("duration", 0))

    # Identical consecutive source frames are merged, so expand by duration.
    total_ms = sum(meta["delays"]) * 10
    assert sum(durations) == total_ms, (name, sum(durations), total_ms)

    # Map each source frame to the decoded frame showing at that moment.
    starts, t = [], 0
    for d in durations:
        starts.append(t)
        t += d
    max_err, mean_err = 0, 0.0
    t = 0
    for i, exp in enumerate(expected):
        k = max(j for j, s in enumerate(starts) if s <= t)
        got = decoded[k]
        diffs = [abs(a - b) for a, b in zip(exp, got)]
        max_err = max(max_err, max(diffs))
        mean_err += sum(diffs) / len(diffs)
        t += meta["delays"][i] * 10
    mean_err /= count
    print(f"{name}: {len(decoded)} gif frames for {count} source frames, "
          f"max err {max_err}, mean err {mean_err:.2f}, loop={img.info.get('loop')}")

    # "boxes" has few colors and must round-trip exactly; the others
    # have more than 255 colors, so some quantization error is expected.
    limit = {"boxes": 0}.get(name, 40)
    if max_err > limit or img.info.get("loop") != 0:
        failed = True
        print(f"  FAIL {name}")


# test/out/browser.gif comes from browser.test.js (a yellow square moving
# right); make sure the frames really animate.
browser_gif = out / "browser.gif"
if browser_gif.exists():
    positions = []
    img = Image.open(browser_gif)
    for frame in ImageSequence.Iterator(img):
        rgb = frame.convert("RGB")
        row = [rgb.getpixel((x, 85)) for x in range(rgb.width)]
        xs = [x for x, (r, g, b) in enumerate(row) if r > 200 and b < 100]
        positions.append(xs[0] if xs else None)
    moving = all(a is not None and b is not None and b >= a for a, b in zip(positions, positions[1:]))
    print(f"browser: {len(positions)} frames, square x {positions[0]} -> {positions[-1]}")
    if not moving or positions[-1] - positions[0] < 150:
        failed = True
        print("  FAIL browser.gif does not animate as expected")

sys.exit(1 if failed else 0)
