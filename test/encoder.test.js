// Encodes synthetic frames with the userscript's GIF encoder and writes
// test/out/*.gif plus the expected RGB frames, for check_gif.py to verify.
const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(path.join(__dirname, '..', 'x-direct-media.user.js'), 'utf8');
const body = source.split('// @@GIF_ENCODER_START')[1].split('// @@GIF_ENCODER_END')[0];
const { encodeGif } = new Function(`${body}; return { encodeGif };`)();

const outDir = path.join(__dirname, 'out');
fs.mkdirSync(outDir, { recursive: true });

function pack(r, g, b) {
    return ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
}

function makeCase(name, width, height, count, pixelAt) {
    const histogram = new Uint32Array(32768);
    const frames = [];
    const expected = [];
    const delays = [];

    for (let f = 0; f < count; f++) {
        const frame = new Uint16Array(width * height);
        const rgb = Buffer.alloc(width * height * 3);

        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const [r, g, b] = pixelAt(x, y, f);
                const p = y * width + x;
                frame[p] = pack(r, g, b);
                histogram[frame[p]]++;
                rgb[p * 3] = r; rgb[p * 3 + 1] = g; rgb[p * 3 + 2] = b;
            }
        }

        frames.push(frame);
        expected.push(rgb);
        delays.push(Math.round(((f + 1) * 100) / 15) - Math.round((f * 100) / 15));
    }

    const t = Date.now();
    const gif = encodeGif(frames, histogram, width, height, delays);
    const ms = Date.now() - t;

    fs.writeFileSync(path.join(outDir, `${name}.gif`), gif);
    fs.writeFileSync(path.join(outDir, `${name}.rgb`), Buffer.concat(expected));
    fs.writeFileSync(path.join(outDir, `${name}.json`), JSON.stringify({ width, height, count, delays }));
    console.log(`${name}: ${width}x${height}x${count} -> ${gif.length} bytes in ${ms} ms`);
}

// Few colors: palette must be exact, so decoding must be lossless.
makeCase('boxes', 97, 61, 12, (x, y, f) => {
    const inBox = x >= f * 5 && x < f * 5 + 20 && y >= 10 && y < 40;
    if (inBox) return [255, 0, 0];
    return (x + y) % 16 < 8 ? [0, 0, 255] : [255, 255, 255];
});

// Includes identical frames (must merge delays) and a static first frame.
makeCase('static', 40, 30, 6, (x, y, f) => (f < 3 ? [10, 200, 10] : [x * 6, y * 8, 100]));

// Many colors: gradient + moving noise, exercises median cut and LZW resets.
let seed = 1;
const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
makeCase('gradient', 480, 270, 30, (x, y, f) => {
    const n = rand() * 40;
    return [
        Math.min(255, (x + f * 8) % 256),
        Math.min(255, (y * 255) / 269),
        Math.min(255, 128 + n)
    ].map(Math.round);
});
