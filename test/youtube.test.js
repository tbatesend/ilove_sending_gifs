// Loads the userscript on a fake YouTube watch page whose <video> plays a
// MediaRecorder WebM (yellow square moving right), then makes a GIF from the
// right-click menu with a mocked Discord webhook.
//
// Run: node test/youtube.test.js   (writes test/out/youtube.gif)
const fs = require('fs');
const path = require('path');
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright');

const scriptSource = fs.readFileSync(path.join(__dirname, '..', 'x-direct-media.user.js'), 'utf8');

const PAGE = `<!doctype html><html><body style="background:#000">
<div id="movie_player" class="html5-video-player"><div class="html5-video-container">
  <video id="video" style="width:640px;height:360px"></video>
</div><div id="overlay" style="position:absolute;inset:0"></div></div>
</body></html>`;

function assert(condition, message) {
    if (!condition) throw new Error(`FAIL: ${message}`);
    console.log(`ok - ${message}`);
}

(async () => {
    const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
    const page = await browser.newPage();

    await page.route('https://www.youtube.com/**', route =>
        route.fulfill({ contentType: 'text/html', body: PAGE }));
    await page.goto('https://www.youtube.com/watch?v=abcDEF12345&t=3');

    await page.evaluate(async () => {
        window.clipboard = [];
        window.store = { discordWebhookUrl: 'https://canary.discord.com/api/webhooks/1/tok' };
        window.GM_setClipboard = text => window.clipboard.push(text);
        window.GM_getValue = (key, fallback) => (key in window.store ? window.store[key] : fallback);
        window.GM_setValue = (key, value) => { window.store[key] = value; };
        window.GM_registerMenuCommand = () => {};
        window.GM_xmlhttpRequest = opts => setTimeout(() => {
            if (opts.url.startsWith('https://canary.discord.com/api/webhooks/1/tok?wait=true')) {
                window.uploaded = opts.data.get('files[0]');
                opts.onload({ status: 200, responseText: JSON.stringify({
                    attachments: [{ url: 'https://cdn.discordapp.com/attachments/1/2/yt.gif?ex=1' }]
                }) });
            } else {
                opts.onload({ status: 404, responseText: '' });
            }
        }, 5);

        // 4 s test clip.
        const canvas = document.createElement('canvas');
        canvas.width = 640;
        canvas.height = 360;
        const ctx = canvas.getContext('2d');
        const recorder = new MediaRecorder(canvas.captureStream(30), { mimeType: 'video/webm' });
        const chunks = [];
        recorder.ondataavailable = e => chunks.push(e.data);
        const stopped = new Promise(r => { recorder.onstop = r; });
        recorder.start();
        const t0 = performance.now();
        await new Promise(resolve => {
            (function draw() {
                const t = (performance.now() - t0) / 1000;
                ctx.fillStyle = '#1d9bf0';
                ctx.fillRect(0, 0, 640, 360);
                ctx.fillStyle = '#ffd400';
                ctx.fillRect(20 + t * 120, 150, 60, 60);
                if (t < 4) requestAnimationFrame(draw); else resolve();
            })();
        });
        recorder.stop();
        await stopped;

        const video = document.getElementById('video');
        video.src = URL.createObjectURL(new Blob(chunks, { type: 'video/webm' }));
        await new Promise(r => { video.onloadeddata = r; });
        video.currentTime = 0.5;
        await new Promise(r => { video.onseeked = r; });
    });

    await page.addScriptTag({ content: scriptSource });

    const clickItem = async label => {
        for (const item of await page.$$('#fx-direct-menu button')) {
            if ((await item.innerText()).startsWith(label)) return item.click();
        }
        throw new Error(`menu item not found: ${label}`);
    };

    // Menu.
    await page.click('#overlay', { button: 'right' });
    await page.waitForSelector('#fx-direct-menu');
    const texts = await page.$$eval('#fx-direct-menu > *', els => els.map(e => e.innerText.split('\n')[0]));
    console.log('   youtube menu:', texts);
    assert(texts[0] === "GIF yap (0:00'dan itibaren)" && texts.includes('Sonraki 3 saniye → GIF linki'),
        'right-click on the player opens the GIF menu');

    await clickItem('Linki');
    assert(await page.evaluate(() => window.clipboard.at(-1)) === 'https://youtu.be/abcDEF12345', 'YouTube link copied');

    // GIF from 0.5 s, 3 s long.
    await page.click('#overlay', { button: 'right' });
    await page.waitForSelector('#fx-direct-menu');
    await clickItem('Sonraki 3 saniye');
    await page.waitForFunction(() => window.clipboard.at(-1)?.startsWith('https://cdn.discordapp.com/'), null, { timeout: 60000 });
    assert(true, 'GIF uploaded through the webhook and CDN link copied');
    console.log('   toast:', await page.$eval('#fx-direct-toast', el => el.textContent));

    const state = await page.evaluate(() => {
        const v = document.getElementById('video');
        return { paused: v.paused, time: v.currentTime };
    });
    assert(state.paused && Math.abs(state.time - 0.5) < 0.05, `video paused back at start (${state.time.toFixed(2)} s)`);

    const bytes = await page.evaluate(async () => Array.from(new Uint8Array(await window.uploaded.arrayBuffer())));
    fs.mkdirSync(path.join(__dirname, 'out'), { recursive: true });
    fs.writeFileSync(path.join(__dirname, 'out', 'youtube.gif'), Buffer.from(bytes));
    assert(Buffer.from(bytes.slice(0, 6)).toString() === 'GIF89a', 'uploaded file is a GIF');

    // Shift + right-click leaves YouTube's own menu alone.
    await page.evaluate(() => document.getElementById('fx-direct-menu')?.remove());
    await page.click('#overlay', { button: 'right', modifiers: ['Shift'] });
    await page.waitForTimeout(100);
    assert(!(await page.$('#fx-direct-menu')), 'shift + right-click is left alone');

    await browser.close();
})().catch(error => {
    console.error(error);
    process.exit(1);
});
