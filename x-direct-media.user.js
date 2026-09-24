// ==UserScript==
// @name         X → Discord: Direct Media & GIF Maker
// @namespace    https://github.com/tbatesend/ilove_sending_gifs
// @version      6.1.0
// @description  Right-click media on X (or use the Share menu) to copy direct links, download MP4s, or turn videos/GIFs into real .gif files that Discord animates.
// @match        https://x.com/*
// @match        https://twitter.com/*
// @run-at       document-idle
// @noframes
//
// @grant        GM_setClipboard
// @grant        GM_xmlhttpRequest
// @connect      api.fxtwitter.com
// @connect      video.twimg.com
// @connect      pbs.twimg.com
// @connect      gif.fxtwitter.com
// @connect      catbox.moe
// ==/UserScript==

(function () {
    'use strict';

    // ============================================================
    // Settings
    // ============================================================

    const CONFIG = {
        /*
         * Right-clicking a photo/video/GIF inside a tweet opens
         * this script's menu. Shift + right-click still gives the
         * browser's normal menu.
         */
        rightClickMenu: true,

        /*
         * X's own "Copy link" in the Share menu copies a
         * fixupx.com link instead of x.com.
         */
        rewriteNativeCopyLink: true,

        fixupHost: 'fixupx.com',

        gif: {
            // Longest side of the GIF in pixels (first attempt).
            maxSide: 480,
            fps: 15,
            // Longer clips are trimmed to this many seconds.
            maxSeconds: 15,
            /*
             * Discord's upload limit for accounts without Nitro
             * is 10 MB. If a GIF comes out bigger, it is re-made
             * smaller (lower fps / size) automatically.
             */
            maxBytes: 10 * 1024 * 1024 - 64 * 1024
        },

        // Anonymous, public, permanent file host used by "upload".
        uploadEndpoint: 'https://catbox.moe/user/api.php'
    };

    // X's "Copy link" label in a few UI languages.
    const COPY_LINK_LABELS = [
        /^copy link/i,
        /bağlantıyı kopyala/i,
        /linki kopyala/i
    ];

    // ============================================================
    // Toast notification
    // ============================================================

    function toast(message, duration = 2500) {
        let el = document.getElementById('fx-direct-toast');

        if (!el) {
            el = document.createElement('div');
            el.id = 'fx-direct-toast';

            Object.assign(el.style, {
                position: 'fixed',
                bottom: '30px',
                left: '50%',
                transform: 'translateX(-50%)',
                zIndex: '2147483647',
                background: 'rgba(0,0,0,.88)',
                color: '#fff',
                padding: '10px 16px',
                borderRadius: '8px',
                fontFamily: 'Arial, sans-serif',
                fontSize: '14px',
                pointerEvents: 'none',
                boxShadow: '0 2px 12px rgba(0,0,0,.4)',
                maxWidth: '90vw',
                textAlign: 'center'
            });

            document.body.appendChild(el);
        }

        el.textContent = message;
        el.style.display = 'block';

        clearTimeout(el._timer);

        if (duration > 0) {
            el._timer = setTimeout(() => {
                el.style.display = 'none';
            }, duration);
        }
    }

    function formatSize(bytes) {
        return bytes < 1024 * 1024
            ? `${Math.max(1, Math.round(bytes / 1024))} KB`
            : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
    }

    // ============================================================
    // Clipboard / files
    // ============================================================

    function writeClipboard(text) {
        GM_setClipboard(text, 'text');
    }

    function saveBlob(blob, filename) {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');

        a.href = url;
        a.download = filename;
        a.style.display = 'none';

        document.body.appendChild(a);
        a.click();
        a.remove();

        setTimeout(() => URL.revokeObjectURL(url), 60000);
    }

    // ============================================================
    // HTTP
    // ============================================================

    function gmRequest(options) {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: 'GET',
                timeout: 30000,
                ...options,

                onload(response) {
                    if (response.status < 200 || response.status >= 300) {
                        reject(new Error(`HTTP ${response.status} — ${options.url}`));
                        return;
                    }

                    resolve(response);
                },

                onerror() {
                    reject(new Error(`Request failed — ${options.url}`));
                },

                ontimeout() {
                    reject(new Error(`Request timed out — ${options.url}`));
                }
            });
        });
    }

    async function fetchBlob(url, label) {
        const response = await gmRequest({
            url,
            responseType: 'blob',
            timeout: 120000,

            onprogress(event) {
                if (event.lengthComputable && event.total) {
                    const pct = Math.round((event.loaded / event.total) * 100);
                    toast(`${label}: ${pct}%`, 0);
                }
            }
        });

        return response.response;
    }

    async function uploadFile(blob, filename) {
        const form = new FormData();

        form.append('reqtype', 'fileupload');
        form.append('fileToUpload', blob, filename);

        const response = await gmRequest({
            method: 'POST',
            url: CONFIG.uploadEndpoint,
            data: form,
            timeout: 180000
        });

        const text = (response.responseText || '').trim();

        if (!/^https:\/\/\S+$/.test(text)) {
            throw new Error(`Upload failed: ${text.slice(0, 200)}`);
        }

        return text;
    }

    // ============================================================
    // Tweet URL helpers
    // ============================================================

    function parseStatusUrl(input) {
        try {
            const url = new URL(input, location.origin);

            const match = url.pathname.match(
                /^\/([^/]+)\/status\/(\d+)(?:\/(photo|video)\/(\d+))?/
            );

            if (!match) {
                return null;
            }

            return {
                user: match[1],
                id: match[2],
                mediaKind: match[3] || null,
                mediaIndex: match[4] ? Math.max(Number(match[4]) - 1, 0) : null
            };
        } catch {
            return null;
        }
    }

    function fixupUrl(tweet) {
        return `https://${CONFIG.fixupHost}/${tweet.user}/status/${tweet.id}`;
    }

    /*
     * FxTwitter link variants (from its README):
     *   d.fixupx.com/... → the media itself, no tweet embed
     *   g.fixupx.com/... → media + author only, no tweet text
     * /photo/N or /video/N picks one item of a multi-media tweet.
     */
    function fixupMediaUrl(entry, subdomain) {
        const user = entry.status.author?.screen_name || 'i';
        let url = `https://${subdomain}.${CONFIG.fixupHost}/${user}/status/${entry.status.id}`;

        if (entry.total > 1) {
            const kind = entry.media.type === 'photo' ? 'photo' : 'video';
            url += `/${kind}/${entry.number}`;
        }

        return url;
    }

    function tweetFromArticle(article) {
        /*
         * The timestamp permalink belongs to this exact tweet.
         * The main tweet's timestamp comes before a quoted
         * tweet's in DOM order.
         */
        for (const time of article.querySelectorAll('time')) {
            const link = time.closest('a[href*="/status/"]');
            const parsed = link && parseStatusUrl(link.getAttribute('href'));

            if (parsed) {
                return parsed;
            }
        }

        for (const link of article.querySelectorAll('a[href*="/status/"]')) {
            const parsed = parseStatusUrl(link.getAttribute('href'));

            if (parsed) {
                return parsed;
            }
        }

        return null;
    }

    // ============================================================
    // FxTwitter API
    // ============================================================

    const statusCache = new Map();

    function getStatus(id) {
        if (!statusCache.has(id)) {
            const promise = fetchStatus(id).catch(error => {
                statusCache.delete(id);
                throw error;
            });

            statusCache.set(id, promise);
        }

        return statusCache.get(id);
    }

    async function fetchStatus(id) {
        const endpoints = [
            `https://api.fxtwitter.com/2/status/${id}`,
            `https://api.fxtwitter.com/status/${id}`
        ];

        let lastError = null;

        for (const url of endpoints) {
            try {
                const response = await gmRequest({
                    url,
                    headers: { Accept: 'application/json' },
                    timeout: 15000
                });

                const data = JSON.parse(response.responseText);
                const status = data.status || data.tweet;

                if (status) {
                    return status;
                }

                lastError = new Error('FxTwitter returned no tweet');
            } catch (error) {
                lastError = error;
            }
        }

        throw lastError;
    }

    // ============================================================
    // Media helpers
    // ============================================================

    function mediaList(status) {
        const media = status?.media;

        if (!media) {
            return [];
        }

        const list =
            Array.isArray(media.all) && media.all.length
                ? media.all
                : [
                    ...(Array.isArray(media.photos) ? media.photos : []),
                    ...(Array.isArray(media.videos) ? media.videos : [])
                ];

        return list.filter(
            item => item && ['photo', 'video', 'gif'].includes(item.type)
        );
    }

    /*
     * Path segments that identify one media file. X's thumbnail
     * URLs and FxTwitter's media URLs share the media id or key:
     *
     *   pbs.twimg.com/ext_tw_video_thumb/<ID>/pu/img/<hash>.jpg
     *   video.twimg.com/ext_tw_video/<ID>/pu/vid/.../<hash>.mp4
     *   pbs.twimg.com/tweet_video_thumb/<KEY>.jpg
     *   video.twimg.com/tweet_video/<KEY>.mp4
     */
    const GENERIC_SEGMENTS = new Set([
        'ext_tw_video_thumb',
        'amplify_video_thumb',
        'tweet_video_thumb',
        'ext_tw_video',
        'amplify_video',
        'tweet_video',
        'card_img'
    ]);

    function urlTokens(input) {
        if (!input || input.startsWith('blob:') || input.startsWith('data:')) {
            return [];
        }

        try {
            const url = new URL(input, location.origin);

            return url.pathname
                .split('/')
                .map(segment => segment.replace(/\.[a-z0-9]+$/i, ''))
                .filter(segment =>
                    segment.length >= 6 &&
                    !GENERIC_SEGMENTS.has(segment) &&
                    !/^\d+x\d+$/.test(segment)
                );
        } catch {
            return [];
        }
    }

    function mediaTokens(media) {
        return new Set([
            ...urlTokens(media.url),
            ...urlTokens(media.thumbnail_url)
        ]);
    }

    function photoUrl(media) {
        try {
            const url = new URL(media.url);

            // Ask the image CDN for original quality.
            if (url.hostname === 'pbs.twimg.com') {
                url.searchParams.set('name', 'orig');
            }

            return url.toString();
        } catch {
            return media.url;
        }
    }

    function photoExtension(media) {
        const match = (media.url || '').match(/\.(jpe?g|png|webp|gif)(?:\?|$)/i);
        return match ? match[1].toLowerCase() : 'jpg';
    }

    function mp4Variants(media) {
        const raw = [
            ...(Array.isArray(media.formats) ? media.formats : []),
            ...(Array.isArray(media.variants) ? media.variants : [])
        ];

        const list = raw
            .filter(format =>
                format?.url && (
                    format.container === 'mp4' ||
                    format.content_type === 'video/mp4' ||
                    /\.mp4(?:\?|$)/i.test(format.url)
                )
            )
            .map(format => {
                const dims = format.url.match(/\/(\d+)x(\d+)\//);

                return {
                    url: format.url,
                    bitrate: Number(format.bitrate) || 0,
                    width: Number(format.width) || (dims ? Number(dims[1]) : 0),
                    height: Number(format.height) || (dims ? Number(dims[2]) : 0)
                };
            });

        if (!list.length && /\.mp4(?:\?|$)/i.test(media.url || '')) {
            list.push({
                url: media.url,
                bitrate: 0,
                width: Number(media.width) || 0,
                height: Number(media.height) || 0
            });
        }

        // Best first: highest bitrate, then highest resolution.
        return list.sort((a, b) =>
            (b.bitrate - a.bitrate) ||
            (b.width * b.height - a.width * a.height)
        );
    }

    function bestMp4(media) {
        return mp4Variants(media)[0]?.url || null;
    }

    /*
     * For GIF conversion there's no point downloading a 1080p
     * file: take the smallest MP4 that is still at least as
     * big as the GIF we want to make.
     */
    function mp4ForGif(media) {
        const variants = mp4Variants(media);

        const bigEnough = variants
            .filter(v => Math.max(v.width, v.height) >= CONFIG.gif.maxSide)
            .sort((a, b) => a.width * a.height - b.width * b.height);

        return (bigEnough[0] || variants[0])?.url || null;
    }

    // ============================================================
    // Which media did the user click on?
    // ============================================================

    const MEDIA_CONTAINER =
        '[data-testid="tweetPhoto"], ' +
        '[data-testid="videoPlayer"], ' +
        '[data-testid="videoComponent"]';

    function findClickedMedia(target) {
        if (!(target instanceof Element)) {
            return null;
        }

        const container = target.closest(MEDIA_CONTAINER);

        const isMediaImage =
            target instanceof HTMLImageElement &&
            /pbs\.twimg\.com\/(media|ext_tw_video_thumb|amplify_video_thumb|tweet_video_thumb)\//.test(target.src);

        if (!container && !isMediaImage && !(target instanceof HTMLVideoElement)) {
            return null;
        }

        const root = container || target.parentElement || target;
        const tokens = new Set();

        const addTokens = url => urlTokens(url).forEach(t => tokens.add(t));

        for (const el of [target, ...root.querySelectorAll('img, video, source')]) {
            if (el instanceof HTMLImageElement) addTokens(el.src);
            if (el instanceof HTMLVideoElement) {
                addTokens(el.poster);
                addTokens(el.src);
            }
            if (el instanceof HTMLSourceElement) addTokens(el.src);
        }

        const isVideo = !!root.querySelector('video') ||
            target instanceof HTMLVideoElement ||
            root.matches('[data-testid="videoPlayer"], [data-testid="videoComponent"]');

        /*
         * Photo links point at the exact tweet (also for quoted
         * tweets) and carry the photo number.
         */
        const link = target.closest('a[href*="/status/"]');
        const fromLink = link && parseStatusUrl(link.getAttribute('href'));

        const article = target.closest('article');
        const fromArticle = article && tweetFromArticle(article);
        const fromPage = parseStatusUrl(location.href);

        const tweet = fromLink || fromArticle || fromPage;

        if (!tweet) {
            return null;
        }

        // Position among video players, used only as a fallback.
        let videoIndex = 0;

        if (isVideo && article) {
            const players = [...article.querySelectorAll('[data-testid="videoPlayer"]')];
            const player = target.closest('[data-testid="videoPlayer"]');
            videoIndex = Math.max(players.indexOf(player), 0);
        }

        return {
            tweet,
            tokens,
            kind: isVideo ? 'video' : 'photo',
            index: fromLink?.mediaIndex ?? (isVideo ? videoIndex : 0)
        };
    }

    /*
     * Returns [{ status, media, number }] for the clicked item,
     * or every media item of the tweet when nothing specific
     * was clicked.
     */
    function resolveMedia(status, clicked) {
        const sources = [status, status.quote].filter(Boolean);

        const entries = sources.flatMap(source =>
            mediaList(source).map((media, i, list) => ({
                status: source,
                media,
                number: i + 1,
                total: list.length
            }))
        );

        if (!clicked) {
            const own = entries.filter(e => e.status === status);
            return own.length ? own : entries;
        }

        // 1. Match by media id / key in the URLs.
        if (clicked.tokens.size) {
            const match = entries.find(entry =>
                [...mediaTokens(entry.media)].some(t => clicked.tokens.has(t))
            );

            if (match) {
                return [match];
            }
        }

        // 2. Fall back to position.
        const own = entries.filter(e => e.status === status);
        const pool = own.length ? own : entries;

        const sameKind = pool.filter(entry =>
            clicked.kind === 'photo'
                ? entry.media.type === 'photo'
                : entry.media.type !== 'photo'
        );

        const pick = sameKind[clicked.index] || sameKind[0] || pool[0];

        return pick ? [pick] : [];
    }

    // ============================================================
    // Actions
    // ============================================================

    let gifBusy = false;

    function baseName(entry) {
        const user = entry.status.author?.screen_name || 'x';
        return `${user}_${entry.status.id}_${entry.number}`;
    }

    function copyAndTell(text, message) {
        writeClipboard(text);
        toast(message);
        console.log('[Direct Media]', text);
    }

    async function downloadRemote(url, filename, label) {
        const blob = await fetchBlob(url, label);
        saveBlob(blob, filename);
        toast(`İndirildi: ${filename}`);
    }

    async function makeGif(entry, mode) {
        if (gifBusy) {
            toast('Zaten bir GIF hazırlanıyor, bekle…');
            return;
        }

        gifBusy = true;

        try {
            const source = mp4ForGif(entry.media);

            if (!source) {
                throw new Error('No MP4 found for this media');
            }

            const videoBlob = await fetchBlob(source, 'Video indiriliyor');

            const result = await videoToGif(videoBlob, source, message => toast(message, 0));
            const filename = `${baseName(entry)}.gif`;

            const notes = [formatSize(result.blob.size), `${result.width}×${result.height}`, `${result.fps} fps`];

            if (result.trimmed) {
                notes.push(`ilk ${CONFIG.gif.maxSeconds} sn`);
            }

            if (result.tooBig) {
                notes.push('10 MB üstü — Nitro gerekebilir');
            }

            if (mode === 'upload') {
                toast(`Yükleniyor (${formatSize(result.blob.size)})…`, 0);

                const link = await uploadFile(result.blob, filename);

                copyAndTell(link, `GIF linki kopyalandı ✓ (${notes.join(', ')})`);
            } else {
                saveBlob(result.blob, filename);
                toast(`GIF indirildi ✓ (${notes.join(', ')})`, 5000);
            }
        } finally {
            gifBusy = false;
        }
    }

    function actionsFor(entry, tweet) {
        const { media } = entry;

        const items = [
            {
                label: 'Sadece medya linki (d.fixupx)',
                hint: 'Tweet yazısı olmadan, sadece medya',
                run: () => copyAndTell(fixupMediaUrl(entry, 'd'), 'Medya linki kopyalandı ✓')
            },
            {
                label: 'Galeri linki (g.fixupx)',
                hint: 'Medya + kullanıcı adı, tweet yazısı yok',
                run: () => copyAndTell(fixupMediaUrl(entry, 'g'), 'Galeri linki kopyalandı ✓')
            }
        ];

        if (media.type === 'photo') {
            items.push({
                label: 'Resim linkini kopyala',
                run: () => copyAndTell(photoUrl(media), 'Resim linki kopyalandı ✓')
            });

            items.push({
                label: 'Resmi indir',
                run: () => downloadRemote(photoUrl(media), `${baseName(entry)}.${photoExtension(media)}`, 'Resim indiriliyor')
            });
        }

        if (media.type === 'gif' || media.type === 'video') {
            items.push({
                label: 'GIF yap → indir (.gif)',
                hint: 'Dosyayı Discord\'a sürükle',
                run: () => makeGif(entry, 'download')
            });
        }

        if (media.type === 'gif' && media.transcode_url) {
            items.push({
                label: 'FxTwitter GIF linkini kopyala',
                hint: 'Anında; animasyonlu WebP',
                run: () => copyAndTell(media.transcode_url, 'FxTwitter GIF linki kopyalandı ✓')
            });
        }

        if (media.type === 'gif' || media.type === 'video') {
            const mp4 = bestMp4(media);

            if (mp4) {
                items.push({
                    label: 'MP4 linkini kopyala',
                    hint: 'Discord video oynatıcı olarak gösterir',
                    run: () => copyAndTell(mp4, 'MP4 linki kopyalandı ✓')
                });

                items.push({
                    label: 'MP4 indir',
                    run: () => downloadRemote(mp4, `${baseName(entry)}.mp4`, 'Video indiriliyor')
                });
            }

            /*
             * The file itself is fine, but in testing Discord's image
             * proxy answered "Invalid resource" for a catbox link, so
             * the link did not embed.
             */
            items.push({
                label: 'GIF yap → catbox\'a yükle & linki kopyala',
                hint: 'Discord\'da açılmayabilir; herkese açık, silinemez',
                run: () => makeGif(entry, 'upload')
            });
        }

        return items;
    }

    // ============================================================
    // Menu UI
    // ============================================================

    const MENU_ID = 'fx-direct-menu';

    function closeMenu() {
        document.getElementById(MENU_ID)?.remove();
    }

    function menuStyle(el, styles) {
        Object.assign(el.style, styles);
        return el;
    }

    function addHeader(menu, text) {
        const el = document.createElement('div');
        el.textContent = text;

        menuStyle(el, {
            padding: '8px 14px 4px',
            fontSize: '12px',
            color: '#8b98a5',
            fontWeight: 'bold'
        });

        menu.appendChild(el);
    }

    function addItem(menu, item) {
        const el = document.createElement('button');
        el.type = 'button';

        menuStyle(el, {
            display: 'block',
            width: '100%',
            textAlign: 'left',
            padding: '9px 14px',
            border: '0',
            background: 'transparent',
            color: '#e7e9ea',
            font: 'inherit',
            cursor: 'pointer'
        });

        const label = document.createElement('div');
        label.textContent = item.label;
        el.appendChild(label);

        if (item.hint) {
            const hint = document.createElement('div');
            hint.textContent = item.hint;
            menuStyle(hint, { fontSize: '12px', color: '#8b98a5', marginTop: '2px' });
            el.appendChild(hint);
        }

        el.addEventListener('mouseenter', () => { el.style.background = 'rgba(255,255,255,.08)'; });
        el.addEventListener('mouseleave', () => { el.style.background = 'transparent'; });

        el.addEventListener('click', async event => {
            event.preventDefault();
            event.stopPropagation();
            closeMenu();

            try {
                await item.run();
            } catch (error) {
                console.error('[Direct Media]', error);
                toast(`Hata: ${error.message}`, 6000);
            }
        });

        menu.appendChild(el);
    }

    function placeMenu(menu, x, y) {
        const rect = menu.getBoundingClientRect();
        const left = Math.min(x, window.innerWidth - rect.width - 8);
        const top = Math.min(y, window.innerHeight - rect.height - 8);

        menu.style.left = `${Math.max(8, left)}px`;
        menu.style.top = `${Math.max(8, top)}px`;
    }

    async function openMenu(x, y, tweet, clicked) {
        closeMenu();

        const menu = document.createElement('div');
        menu.id = MENU_ID;

        menuStyle(menu, {
            position: 'fixed',
            zIndex: '2147483646',
            minWidth: '240px',
            maxWidth: '340px',
            maxHeight: '80vh',
            overflowY: 'auto',
            background: '#15202b',
            border: '1px solid #38444d',
            borderRadius: '12px',
            boxShadow: '0 4px 20px rgba(0,0,0,.5)',
            padding: '4px 0',
            fontFamily: 'TwitterChirp, -apple-system, "Segoe UI", Roboto, Arial, sans-serif',
            fontSize: '14px'
        });

        addHeader(menu, 'Yükleniyor…');
        document.body.appendChild(menu);
        placeMenu(menu, x, y);

        const fixupItem = {
            label: 'FixupX linkini kopyala',
            run: () => copyAndTell(fixupUrl(tweet), 'FixupX linki kopyalandı ✓')
        };

        let entries = [];

        try {
            const status = await getStatus(tweet.id);
            entries = resolveMedia(status, clicked);
        } catch (error) {
            console.error('[Direct Media]', error);

            if (!document.body.contains(menu)) return;
            menu.textContent = '';
            addHeader(menu, `FxTwitter hatası: ${error.message}`);
            addItem(menu, fixupItem);
            placeMenu(menu, x, y);
            return;
        }

        // Closed while loading.
        if (!document.body.contains(menu)) {
            return;
        }

        menu.textContent = '';

        if (!entries.length) {
            addHeader(menu, 'Bu gönderide medya yok');
        }

        const typeNames = { photo: 'Resim', video: 'Video', gif: 'GIF' };

        for (const entry of entries) {
            const quoted = entry.status.id !== tweet.id ? ' (alıntı)' : '';
            addHeader(menu, `${typeNames[entry.media.type]} ${entry.number}${quoted}`);
            actionsFor(entry, tweet).forEach(item => addItem(menu, item));
        }

        addHeader(menu, 'Gönderi');
        addItem(menu, fixupItem);

        placeMenu(menu, x, y);
    }

    document.addEventListener('pointerdown', event => {
        const menu = document.getElementById(MENU_ID);

        if (menu && !menu.contains(event.target)) {
            closeMenu();
        }
    }, true);

    document.addEventListener('keydown', event => {
        if (event.key === 'Escape') closeMenu();
    }, true);

    window.addEventListener('resize', closeMenu);
    window.addEventListener('blur', closeMenu);

    // ============================================================
    // Right-click on media
    // ============================================================

    window.addEventListener('contextmenu', event => {
        if (!CONFIG.rightClickMenu || event.shiftKey) {
            return;
        }

        if (document.getElementById(MENU_ID)?.contains(event.target)) {
            event.preventDefault();
            return;
        }

        const clicked = findClickedMedia(event.target);

        if (!clicked) {
            return;
        }

        event.preventDefault();
        event.stopPropagation();

        openMenu(event.clientX, event.clientY, clicked.tweet, clicked);
    }, true);

    // ============================================================
    // Share menu: "Copy link" → FixupX, plus our own entry
    // ============================================================

    let sharedTweet = null;
    let shareArmedUntil = 0;

    function rememberSharedTweet(event) {
        const target = event.target;

        if (!(target instanceof Element)) {
            return;
        }

        const shareButton = target.closest(
            '[data-testid="share"], ' +
            '[aria-label="Share post"], ' +
            '[aria-label="Share"]'
        );

        if (!shareButton) {
            return;
        }

        const article = shareButton.closest('article');
        const tweet = (article && tweetFromArticle(article)) || parseStatusUrl(location.href);

        if (tweet) {
            sharedTweet = tweet;
            shareArmedUntil = Date.now() + 5000;
        }
    }

    document.addEventListener('pointerdown', rememberSharedTweet, true);
    document.addEventListener('click', rememberSharedTweet, true);

    function closeShareMenu() {
        const options = {
            key: 'Escape',
            code: 'Escape',
            keyCode: 27,
            which: 27,
            bubbles: true,
            cancelable: true
        };

        for (const target of [document.activeElement, document, document.body]) {
            try {
                target?.dispatchEvent(new KeyboardEvent('keydown', options));
            } catch {
                // ignore
            }
        }
    }

    function replaceFirstText(root, newText) {
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);

        while (walker.nextNode()) {
            const node = walker.currentNode;

            if (node.nodeValue?.trim()) {
                node.nodeValue = newText;
                return;
            }
        }
    }

    function enhanceShareMenu(menu) {
        if (menu.dataset.fxDirectEnhanced === 'true') {
            return;
        }

        const items = [...menu.querySelectorAll('[role="menuitem"]')];

        if (!items.length) {
            return;
        }

        menu.dataset.fxDirectEnhanced = 'true';

        const tweet = sharedTweet;

        if (CONFIG.rewriteNativeCopyLink) {
            const copyItem = items.find(item => {
                const text = item.innerText?.trim() || '';
                return COPY_LINK_LABELS.some(re => re.test(text));
            });

            /*
             * Let X copy its own link, then overwrite it with
             * the FixupX version. No clipboard reading needed.
             */
            copyItem?.addEventListener('click', () => {
                setTimeout(() => copyAndTell(fixupUrl(tweet), 'FixupX linki kopyalandı ✓'), 150);
            });
        }

        /*
         * Clone an existing entry so styling matches. Cloned
         * nodes carry no React handlers, so it does nothing
         * except what we attach.
         */
        const ours = items[items.length - 1].cloneNode(true);

        ours.dataset.fxDirectMedia = 'true';
        replaceFirstText(ours, 'Direkt medya / GIF yap…');

        ours.addEventListener('click', event => {
            event.preventDefault();
            event.stopPropagation();

            const rect = menu.getBoundingClientRect();

            closeShareMenu();

            const selected = parseStatusUrl(location.href);

            // In the media viewer (/status/ID/photo/2), use that item.
            const clicked = selected?.id === tweet.id && selected.mediaKind
                ? {
                    tokens: new Set(),
                    kind: selected.mediaKind,
                    index: selected.mediaIndex
                }
                : null;

            setTimeout(() => openMenu(rect.left, rect.top, tweet, clicked), 30);
        });

        items[items.length - 1].after(ours);
    }

    function scanForShareMenu() {
        if (!sharedTweet || Date.now() > shareArmedUntil) {
            return;
        }

        document
            .querySelectorAll('[role="menu"]')
            .forEach(enhanceShareMenu);
    }

    new MutationObserver(scanForShareMenu).observe(document.body, {
        childList: true,
        subtree: true
    });

    // ============================================================
    // Video → GIF (runs entirely in the browser)
    // ============================================================

    function waitForEvent(target, name, timeoutMs) {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                cleanup();
                reject(new Error(`Timed out waiting for video "${name}"`));
            }, timeoutMs);

            const onEvent = () => {
                cleanup();
                resolve();
            };

            const onError = () => {
                cleanup();
                reject(new Error('The browser could not decode this video'));
            };

            function cleanup() {
                clearTimeout(timer);
                target.removeEventListener(name, onEvent);
                target.removeEventListener('error', onError);
            }

            target.addEventListener(name, onEvent);
            target.addEventListener('error', onError);
        });
    }

    async function loadVideo(src, crossOrigin) {
        const video = document.createElement('video');

        video.muted = true;
        video.playsInline = true;
        video.preload = 'auto';

        if (crossOrigin) {
            video.crossOrigin = 'anonymous';
        }

        const ready = waitForEvent(video, 'loadeddata', 30000);
        video.src = src;
        await ready;

        return video;
    }

    async function seekTo(video, time) {
        if (Math.abs(video.currentTime - time) < 1e-4 && video.readyState >= 2) {
            return;
        }

        const done = waitForEvent(video, 'seeked', 10000);
        video.currentTime = time;
        await done;
    }

    async function captureFrames(video, width, height, fps, clipSeconds, onProgress) {
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;

        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        const frameCount = Math.max(1, Math.round(clipSeconds * fps));
        const histogram = new Uint32Array(32768);
        const frames = [];
        const delays = [];

        for (let i = 0; i < frameCount; i++) {
            // Sample the middle of each frame's time slot.
            const time = Math.min((i + 0.5) / fps, video.duration - 0.001);

            await seekTo(video, Math.max(0, time));

            ctx.drawImage(video, 0, 0, width, height);

            const rgba = ctx.getImageData(0, 0, width, height).data;
            const frame = new Uint16Array(width * height);

            for (let p = 0, j = 0; p < frame.length; p++, j += 4) {
                const color =
                    ((rgba[j] >> 3) << 10) |
                    ((rgba[j + 1] >> 3) << 5) |
                    (rgba[j + 2] >> 3);

                frame[p] = color;
                histogram[color]++;
            }

            frames.push(frame);

            // Centiseconds, spread so the total length stays exact.
            delays.push(Math.round(((i + 1) * 100) / fps) - Math.round((i * 100) / fps));

            if (i % 5 === 0) {
                onProgress(`GIF: kareler alınıyor ${i + 1}/${frameCount}`);
            }
        }

        return { frames, histogram, delays };
    }

    async function videoToGif(videoBlob, remoteUrl, onProgress) {
        const blobUrl = URL.createObjectURL(videoBlob);
        let video;

        try {
            try {
                video = await loadVideo(blobUrl, false);
            } catch (error) {
                // Some pages block blob: media; try the CDN directly.
                console.warn('[Direct Media] blob video failed, trying direct URL', error);
                video = await loadVideo(remoteUrl, true);
            }

            /*
             * Some files report an unknown (Infinity) duration until
             * the browser has seen their end.
             */
            if (video.duration === Infinity) {
                await seekTo(video, 1e9);
                await seekTo(video, 0);
            }

            const duration = video.duration;

            if (!Number.isFinite(duration) || duration <= 0) {
                throw new Error('Video has no usable duration');
            }

            const clipSeconds = Math.min(duration, CONFIG.gif.maxSeconds);
            const longest = Math.max(video.videoWidth, video.videoHeight);

            let maxSide = Math.min(CONFIG.gif.maxSide, longest);
            let fps = CONFIG.gif.fps;
            let result = null;

            for (let attempt = 0; attempt < 5; attempt++) {
                const scale = maxSide / longest;
                const width = Math.max(2, Math.round(video.videoWidth * scale));
                const height = Math.max(2, Math.round(video.videoHeight * scale));

                const { frames, histogram, delays } =
                    await captureFrames(video, width, height, fps, clipSeconds, onProgress);

                onProgress(`GIF: kodlanıyor (${width}×${height}, ${fps} fps)…`);

                // Let the toast paint before the heavy work.
                await new Promise(resolve => setTimeout(resolve, 30));

                const bytes = encodeGif(frames, histogram, width, height, delays);
                const blob = new Blob([bytes], { type: 'image/gif' });

                result = {
                    blob,
                    width,
                    height,
                    fps,
                    trimmed: duration > clipSeconds + 0.05,
                    tooBig: blob.size > CONFIG.gif.maxBytes
                };

                if (!result.tooBig) {
                    return result;
                }

                /*
                 * Too big: spend the needed reduction on fps first
                 * (not below 10), then on resolution.
                 */
                const ratio = (CONFIG.gif.maxBytes / blob.size) * 0.9;
                const newFps = Math.max(10, Math.min(fps, Math.floor(fps * ratio)));
                const areaRatio = Math.min((ratio * fps) / newFps, 0.95);

                fps = newFps;
                maxSide = Math.floor(maxSide * Math.sqrt(areaRatio));

                if (maxSide < 120) {
                    break;
                }

                onProgress(`GIF ${formatSize(blob.size)} çıktı, küçültülüyor…`);
            }

            return result;
        } finally {
            if (video) {
                video.removeAttribute('src');
                video.load();
            }

            URL.revokeObjectURL(blobUrl);
        }
    }

    // @@GIF_ENCODER_START
    // ============================================================
    // GIF encoder
    //
    // Input frames are 15-bit colors (5 bits per channel).
    // One global palette of up to 255 colors is built with
    // median cut; index 255 is transparent and marks pixels that
    // did not change since the previous frame, so each frame only
    // stores what moved.
    // ============================================================

    function buildPalette(histogram, maxColors) {
        const ids = [];

        for (let color = 0; color < histogram.length; color++) {
            if (histogram[color]) ids.push(color);
        }

        const colors = Uint16Array.from(ids);
        const channel = (color, c) => (color >> (10 - c * 5)) & 31;

        function describe(lo, hi) {
            const min = [31, 31, 31];
            const max = [0, 0, 0];
            let count = 0;

            for (let i = lo; i < hi; i++) {
                const color = colors[i];
                count += histogram[color];

                for (let c = 0; c < 3; c++) {
                    const v = channel(color, c);
                    if (v < min[c]) min[c] = v;
                    if (v > max[c]) max[c] = v;
                }
            }

            let axis = 0;

            for (let c = 1; c < 3; c++) {
                if (max[c] - min[c] > max[axis] - min[axis]) axis = c;
            }

            const range = max[axis] - min[axis];

            return { lo, hi, count, axis, score: range > 0 ? count * range : -1 };
        }

        const boxes = [describe(0, colors.length)];

        while (boxes.length < maxColors) {
            let best = -1;

            for (let b = 0; b < boxes.length; b++) {
                if (boxes[b].score > 0 && (best < 0 || boxes[b].score > boxes[best].score)) {
                    best = b;
                }
            }

            if (best < 0) break;

            const box = boxes[best];
            const axis = box.axis;

            colors
                .subarray(box.lo, box.hi)
                .sort((a, b) => channel(a, axis) - channel(b, axis));

            // Split at the weighted median, keeping both halves non-empty.
            let split = box.lo + 1;
            let running = histogram[colors[box.lo]];

            while (split < box.hi - 1 && running * 2 < box.count) {
                running += histogram[colors[split]];
                split++;
            }

            boxes.splice(best, 1, describe(box.lo, split), describe(split, box.hi));
        }

        const palette = [];

        for (const box of boxes) {
            const sum = [0, 0, 0];

            for (let i = box.lo; i < box.hi; i++) {
                const color = colors[i];
                const weight = histogram[color];

                for (let c = 0; c < 3; c++) {
                    const v = channel(color, c);
                    sum[c] += ((v << 3) | (v >> 2)) * weight;
                }
            }

            palette.push(sum.map(s => Math.round(s / Math.max(box.count, 1))));
        }

        if (!palette.length) palette.push([0, 0, 0]);

        return palette;
    }

    function buildLookup(histogram, palette) {
        const lookup = new Uint8Array(32768);

        for (let color = 0; color < 32768; color++) {
            if (!histogram[color]) continue;

            const r = ((color >> 10) & 31) << 3 | ((color >> 10) & 31) >> 2;
            const g = ((color >> 5) & 31) << 3 | ((color >> 5) & 31) >> 2;
            const b = (color & 31) << 3 | (color & 31) >> 2;

            let best = 0;
            let bestDistance = Infinity;

            for (let i = 0; i < palette.length; i++) {
                const p = palette[i];
                const dr = r - p[0];
                const dg = g - p[1];
                const db = b - p[2];
                const distance = 2 * dr * dr + 4 * dg * dg + 3 * db * db;

                if (distance < bestDistance) {
                    bestDistance = distance;
                    best = i;
                }
            }

            lookup[color] = best;
        }

        return lookup;
    }

    class ByteWriter {
        constructor(size = 1 << 20) {
            this.buffer = new Uint8Array(size);
            this.length = 0;
        }

        ensure(extra) {
            if (this.length + extra <= this.buffer.length) return;

            let size = this.buffer.length * 2;
            while (size < this.length + extra) size *= 2;

            const next = new Uint8Array(size);
            next.set(this.buffer.subarray(0, this.length));
            this.buffer = next;
        }

        byte(value) {
            this.ensure(1);
            this.buffer[this.length++] = value;
        }

        u16(value) {
            this.byte(value & 255);
            this.byte((value >> 8) & 255);
        }

        bytes(values) {
            this.ensure(values.length);
            this.buffer.set(values, this.length);
            this.length += values.length;
        }

        ascii(text) {
            for (let i = 0; i < text.length; i++) this.byte(text.charCodeAt(i));
        }

        result() {
            return this.buffer.slice(0, this.length);
        }
    }

    // Dictionary for LZW: key = prefixCode * 256 + nextIndex.
    const lzwCodes = new Int16Array(4096 * 256);
    const lzwStamp = new Int32Array(4096 * 256);
    let lzwGeneration = 0;

    function writeLzw(out, pixels, minCodeSize) {
        const clearCode = 1 << minCodeSize;
        const endCode = clearCode + 1;

        let codeSize = minCodeSize + 1;
        let nextCode = endCode + 1;

        const block = new Uint8Array(255);
        let blockLength = 0;
        let bitBuffer = 0;
        let bitCount = 0;

        const flushBlock = () => {
            if (!blockLength) return;
            out.byte(blockLength);
            out.bytes(block.subarray(0, blockLength));
            blockLength = 0;
        };

        const emit = code => {
            bitBuffer |= code << bitCount;
            bitCount += codeSize;

            while (bitCount >= 8) {
                block[blockLength++] = bitBuffer & 255;
                if (blockLength === 255) flushBlock();
                bitBuffer >>>= 8;
                bitCount -= 8;
            }
        };

        out.byte(minCodeSize);

        lzwGeneration++;
        emit(clearCode);

        let prefix = pixels[0];

        for (let i = 1; i < pixels.length; i++) {
            const k = pixels[i];
            const key = prefix * 256 + k;

            if (lzwStamp[key] === lzwGeneration) {
                prefix = lzwCodes[key];
                continue;
            }

            emit(prefix);

            if (nextCode === 4096) {
                // Table full: start over.
                emit(clearCode);
                lzwGeneration++;
                codeSize = minCodeSize + 1;
                nextCode = endCode + 1;
            } else {
                /*
                 * Grow the code size when the entry about to be
                 * added no longer fits (the decoder lags one entry
                 * behind, which this timing accounts for).
                 */
                if (nextCode >= (1 << codeSize)) codeSize++;

                lzwCodes[key] = nextCode++;
                lzwStamp[key] = lzwGeneration;
            }

            prefix = k;
        }

        emit(prefix);
        emit(endCode);

        if (bitCount > 0) {
            block[blockLength++] = bitBuffer & 255;
            if (blockLength === 255) flushBlock();
        }

        flushBlock();
        out.byte(0);
    }

    function encodeGif(frames, histogram, width, height, delays) {
        const TRANSPARENT = 255;

        const palette = buildPalette(histogram, 255);
        const lookup = buildLookup(histogram, palette);
        const out = new ByteWriter();

        // Header + logical screen with a 256-entry global palette.
        out.ascii('GIF89a');
        out.u16(width);
        out.u16(height);
        out.byte(0xf7);
        out.byte(0);
        out.byte(0);

        for (let i = 0; i < 256; i++) {
            const color = palette[i] || [0, 0, 0];
            out.byte(color[0]);
            out.byte(color[1]);
            out.byte(color[2]);
        }

        // Loop forever.
        out.byte(0x21);
        out.byte(0xff);
        out.byte(11);
        out.ascii('NETSCAPE2.0');
        out.bytes([3, 1, 0, 0, 0]);

        const shown = new Uint8Array(width * height);
        const indices = new Uint8Array(width * height);
        let pending = null;

        const writeFrame = frame => {
            // Graphic control: keep previous frame, optional transparency.
            out.byte(0x21);
            out.byte(0xf9);
            out.byte(4);
            out.byte((1 << 2) | (frame.transparent ? 1 : 0));
            out.u16(Math.min(frame.delay, 65535));
            out.byte(TRANSPARENT);
            out.byte(0);

            out.byte(0x2c);
            out.u16(frame.x);
            out.u16(frame.y);
            out.u16(frame.w);
            out.u16(frame.h);
            out.byte(0);

            writeLzw(out, frame.pixels, 8);
        };

        for (let f = 0; f < frames.length; f++) {
            const source = frames[f];

            for (let p = 0; p < indices.length; p++) {
                indices[p] = lookup[source[p]];
            }

            if (f === 0) {
                shown.set(indices);

                pending = {
                    x: 0,
                    y: 0,
                    w: width,
                    h: height,
                    pixels: indices.slice(),
                    delay: delays[f],
                    transparent: false
                };

                continue;
            }

            // Bounding box of pixels that changed.
            let minX = width;
            let minY = height;
            let maxX = -1;
            let maxY = -1;

            for (let y = 0, p = 0; y < height; y++) {
                for (let x = 0; x < width; x++, p++) {
                    if (indices[p] !== shown[p]) {
                        if (x < minX) minX = x;
                        if (x > maxX) maxX = x;
                        if (y < minY) minY = y;
                        if (y > maxY) maxY = y;
                    }
                }
            }

            if (maxX < 0) {
                // Identical frame: just show the previous one longer.
                pending.delay += delays[f];
                continue;
            }

            const w = maxX - minX + 1;
            const h = maxY - minY + 1;
            const pixels = new Uint8Array(w * h);

            for (let y = 0; y < h; y++) {
                let p = (minY + y) * width + minX;

                for (let x = 0; x < w; x++, p++) {
                    if (indices[p] === shown[p]) {
                        pixels[y * w + x] = TRANSPARENT;
                    } else {
                        pixels[y * w + x] = indices[p];
                        shown[p] = indices[p];
                    }
                }
            }

            writeFrame(pending);

            pending = {
                x: minX,
                y: minY,
                w,
                h,
                pixels,
                delay: delays[f],
                transparent: true
            };
        }

        if (pending) writeFrame(pending);

        out.byte(0x3b);

        return out.result();
    }
    // @@GIF_ENCODER_END

})();
