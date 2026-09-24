// Loads the userscript into Chromium on a fake X-like page with stubbed GM_*
// APIs and a fake FxTwitter response, then exercises the right-click menu,
// link copying, and the full video -> GIF path.
//
// Run: node test/browser.test.js   (writes test/out/browser.gif)
const fs = require('fs');
const path = require('path');
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright');

const scriptSource = fs.readFileSync(path.join(__dirname, '..', 'x-direct-media.user.js'), 'utf8');

const PAGE = `<!doctype html><html><body>
<article>
  <a href="/alice/status/111"><time>1h</time></a>
  <div data-testid="tweetPhoto"><img id="photo" src="https://pbs.twimg.com/media/PHOTOKEY1.jpg?name=small"></div>
  <div data-testid="videoPlayer"><div id="overlay">
    <video id="video" poster="https://pbs.twimg.com/ext_tw_video_thumb/999000111/pu/img/THUMBHASH.jpg"></video>
  </div></div>
  <div role="link">
    <div data-testid="videoPlayer"><video id="quoted" poster="https://pbs.twimg.com/tweet_video_thumb/GIFKEY42.jpg"></video></div>
  </div>
  <button data-testid="share">share</button>
</article>
</body></html>`;

const STATUS = {
    id: '111',
    author: { screen_name: 'alice' },
    media: {
        all: [
            { type: 'photo', url: 'https://pbs.twimg.com/media/PHOTOKEY1.jpg' },
            {
                type: 'video',
                url: 'https://video.twimg.com/ext_tw_video/999000111/pu/vid/avc1/1280x720/best.mp4',
                thumbnail_url: 'https://pbs.twimg.com/ext_tw_video_thumb/999000111/pu/img/THUMBHASH.jpg',
                formats: [
                    { container: 'mp4', bitrate: 256000, url: 'https://video.twimg.com/ext_tw_video/999000111/pu/vid/avc1/480x270/small.mp4' },
                    { container: 'mp4', bitrate: 2176000, url: 'https://video.twimg.com/ext_tw_video/999000111/pu/vid/avc1/1280x720/best.mp4' },
                    { container: 'm3u8', url: 'https://video.twimg.com/ext_tw_video/999000111/pu/pl/x.m3u8' }
                ]
            }
        ]
    },
    quote: {
        id: '222',
        author: { screen_name: 'bob' },
        media: {
            all: [{
                type: 'gif',
                url: 'https://video.twimg.com/tweet_video/GIFKEY42.mp4',
                thumbnail_url: 'https://pbs.twimg.com/tweet_video_thumb/GIFKEY42.jpg',
                transcode_url: 'https://gif.fxtwitter.com/tweet_video/GIFKEY42.webp'
            }]
        }
    }
};

function assert(condition, message) {
    if (!condition) throw new Error(`FAIL: ${message}`);
    console.log(`ok - ${message}`);
}

(async () => {
    const browser = await chromium.launch();
    const page = await browser.newPage({ acceptDownloads: true });

    await page.route('https://x.com/**', route =>
        route.fulfill({ contentType: 'text/html', body: PAGE }));
    await page.goto('https://x.com/home');

    // Stubs + a test video made with MediaRecorder (2 s, moving square).
    await page.evaluate(async status => {
        window.clipboard = [];
        window.requests = [];
        window.GM_setClipboard = text => window.clipboard.push(text);

        const canvas = document.createElement('canvas');
        canvas.width = 320;
        canvas.height = 180;
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
                ctx.fillRect(0, 0, 320, 180);
                ctx.fillStyle = '#ffd400';
                ctx.fillRect(20 + t * 120, 60, 50, 50);
                if (t < 2) requestAnimationFrame(draw); else resolve();
            })();
        });
        recorder.stop();
        await stopped;
        window.testVideo = new Blob(chunks, { type: 'video/webm' });

        window.GM_xmlhttpRequest = opts => {
            window.requests.push(opts.method || 'GET ' + opts.url);
            window.requests.push(opts.url);
            setTimeout(() => {
                if (opts.url.startsWith('https://api.fxtwitter.com/2/status/111')) {
                    opts.onload({ status: 200, responseText: JSON.stringify({ code: 200, status }) });
                } else if (opts.url.includes('video.twimg.com')) {
                    opts.onload({ status: 200, response: window.testVideo });
                } else if (opts.url.includes('catbox.moe')) {
                    window.uploaded = opts.data.get('fileToUpload');
                    opts.onload({ status: 200, responseText: 'https://files.catbox.moe/abc123.gif' });
                } else {
                    opts.onload({ status: 404, responseText: '' });
                }
            }, 5);
        };
    }, STATUS);

    await page.addScriptTag({ content: scriptSource });

    const menuTexts = () => page.$$eval('#fx-direct-menu > *', els => els.map(e => e.innerText.split('\n')[0]));
    const clickItem = async label => {
        const items = await page.$$('#fx-direct-menu button');
        for (const item of items) {
            if ((await item.innerText()).startsWith(label)) return item.click();
        }
        throw new Error(`menu item not found: ${label}`);
    };

    // 1. Right-click the main tweet's video (on an overlay, like on X).
    await page.click('#overlay', { button: 'right', force: true });
    await page.waitForFunction(() => document.querySelector('#fx-direct-menu')?.innerText.includes('MP4'));
    let texts = await menuTexts();
    console.log('   video menu:', texts);
    assert(texts[0] === 'Video 2', 'video right-click resolves to media #2 by thumbnail id');
    assert(!texts.some(t => t.startsWith('Resim')), 'only the clicked media is listed');

    assert(texts[1] === 'Sadece medya linki (d.fixupx)', 'direct media link is the first option');
    await clickItem('Sadece medya linki');
    assert(await page.evaluate(() => window.clipboard.at(-1)) ===
        'https://d.fixupx.com/alice/status/111/video/2', 'd.fixupx link picks the clicked item of a multi-media tweet');

    await page.click('#overlay', { button: 'right', force: true });
    await page.waitForFunction(() => document.querySelector('#fx-direct-menu')?.innerText.includes('MP4'));
    await clickItem('MP4 linkini kopyala');
    assert(await page.evaluate(() => window.clipboard.at(-1)) ===
        'https://video.twimg.com/ext_tw_video/999000111/pu/vid/avc1/1280x720/best.mp4',
        'MP4 link is the highest-bitrate variant');

    // 2. Right-click the photo.
    await page.click('#photo', { button: 'right' });
    await page.waitForFunction(() => document.querySelector('#fx-direct-menu')?.innerText.includes('Resim linkini'));
    texts = await menuTexts();
    assert(texts[0] === 'Resim 1', 'photo right-click resolves to media #1');
    await clickItem('Resim linkini kopyala');
    assert(await page.evaluate(() => window.clipboard.at(-1)) ===
        'https://pbs.twimg.com/media/PHOTOKEY1.jpg?name=orig', 'photo link asks for original size');

    // 3. Right-click the quoted tweet's GIF.
    await page.click('#quoted', { button: 'right' });
    await page.waitForFunction(() => document.querySelector('#fx-direct-menu')?.innerText.includes('GIF 1'));
    texts = await menuTexts();
    console.log('   quoted gif menu:', texts);
    assert(texts[0] === 'GIF 1 (alıntı)', 'quoted GIF is matched through status.quote');
    await clickItem('Galeri linki');
    assert(await page.evaluate(() => window.clipboard.at(-1)) ===
        'https://g.fixupx.com/bob/status/222', 'g.fixupx link uses the quoted tweet, no suffix for a single item');

    await page.click('#quoted', { button: 'right' });
    await page.waitForFunction(() => document.querySelector('#fx-direct-menu')?.innerText.includes('GIF 1'));
    await clickItem('FxTwitter GIF linkini kopyala');
    assert(await page.evaluate(() => window.clipboard.at(-1)) ===
        'https://gif.fxtwitter.com/tweet_video/GIFKEY42.webp', 'FxTwitter GIF link copied');

    // 4. FixupX link.
    await page.click('#photo', { button: 'right' });
    await page.waitForFunction(() => document.querySelector('#fx-direct-menu')?.innerText.includes('FixupX'));
    await clickItem('FixupX linkini kopyala');
    assert(await page.evaluate(() => window.clipboard.at(-1)) === 'https://fixupx.com/alice/status/111', 'FixupX link');

    // 5. Video -> GIF -> download.
    await page.click('#overlay', { button: 'right', force: true });
    await page.waitForFunction(() => document.querySelector('#fx-direct-menu')?.innerText.includes('indir (.gif)'));
    const downloadPromise = page.waitForEvent('download', { timeout: 60000 });
    await clickItem('GIF yap → indir');
    const download = await downloadPromise;
    const gifPath = path.join(__dirname, 'out', 'browser.gif');
    fs.mkdirSync(path.dirname(gifPath), { recursive: true });
    await download.saveAs(gifPath);
    assert(download.suggestedFilename() === 'alice_111_2.gif', `download named ${download.suggestedFilename()}`);
    const requested = await page.evaluate(() => window.requests);
    assert(requested.includes('https://video.twimg.com/ext_tw_video/999000111/pu/vid/avc1/480x270/small.mp4'),
        'GIF conversion downloads the smallest MP4 that is big enough');
    const toastText = await page.$eval('#fx-direct-toast', el => el.textContent);
    console.log('   toast:', toastText);

    // 6. Video -> GIF -> upload -> link copied.
    await page.click('#overlay', { button: 'right', force: true });
    await page.waitForFunction(() => document.querySelector('#fx-direct-menu')?.innerText.includes('catbox'));
    await clickItem('GIF yap → catbox');
    await page.waitForFunction(() => window.clipboard.at(-1) === 'https://files.catbox.moe/abc123.gif', null, { timeout: 60000 });
    const uploaded = await page.evaluate(async () => ({
        name: window.uploaded.name,
        type: window.uploaded.type,
        magic: new TextDecoder().decode(new Uint8Array(await window.uploaded.slice(0, 6).arrayBuffer()))
    }));
    assert(uploaded.name === 'alice_111_2.gif' && uploaded.magic === 'GIF89a', 'uploaded file is a GIF and link is copied');

    // 7. Shift + right-click keeps the browser menu (our handler does nothing).
    await page.evaluate(() => document.getElementById('fx-direct-menu')?.remove());
    await page.click('#photo', { button: 'right', modifiers: ['Shift'] });
    await page.waitForTimeout(100);
    assert(!(await page.$('#fx-direct-menu')), 'shift + right-click is left alone');

    await browser.close();
})().catch(error => {
    console.error(error);
    process.exit(1);
});
