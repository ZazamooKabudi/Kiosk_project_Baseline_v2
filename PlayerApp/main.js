const { app, BrowserWindow, Menu, ipcMain, session } = require('electron');
const path = require('path');
const fs   = require('fs');
const http  = require('http');
const https = require('https');

// Force all cross-origin iframes into the same renderer process so
// capturePage() captures their content correctly.
app.commandLine.appendSwitch('disable-site-isolation-trials');

const CONFIG_FILE = path.join(app.getPath('userData'), 'kiosk_config.json');

function loadConfig() {
    try {
        if (fs.existsSync(CONFIG_FILE)) {
            return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
        }
    } catch {}
    return null;
}

function saveConfig(data) {
    try { fs.writeFileSync(CONFIG_FILE, JSON.stringify(data), 'utf8'); } catch {}
}

// ── Setup Window ─────────────────────────────────────────────────
function createSetupWindow(prefillUrl = '') {
    const win = new BrowserWindow({
        width: 520,
        height: 560,
        title: 'Kiosk Player — הגדרה',
        resizable: false,
        center: true,
        autoHideMenuBar: true,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false
        }
    });
    Menu.setApplicationMenu(null);
    if (prefillUrl) {
        win.loadURL(`file://${path.join(__dirname, 'index.html')}?url=${encodeURIComponent(prefillUrl)}`);
    } else {
        win.loadFile('index.html');
    }
    return win;
}

// ── Player Window ────────────────────────────────────────────────
async function createPlayerWindow(url) {
    const win = new BrowserWindow({
        fullscreen: true,
        autoHideMenuBar: true,
        title: 'Kiosk',
        backgroundColor: '#000000',
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false
        }
    });
    Menu.setApplicationMenu(null);

    const serverBase = (() => {
        try { return new URL(url).origin; } catch { return null; }
    })();

    // Resolve kiosk ID from URL param
    let kioskId = null;
    try {
        const id = parseInt(new URL(url).searchParams.get('id'), 10);
        if (!isNaN(id) && id > 0) kioskId = id;
    } catch {}

    // Inject gear overlay on every navigation (content URLs, image pages, etc.)
    win.webContents.on('did-finish-load', () => {
        win.webContents.executeJavaScript(buildOverlayScript(url)).catch(() => {});
    });

    win.webContents.on('before-input-event', (_e, input) => {
        if (input.key === 'Escape' && input.type === 'keyDown') win.setFullScreen(false);
        if (input.key === 'F12' && input.type === 'keyDown') {
            saveConfig({});
            win.close();
            createSetupWindow();
        }
    });

    if (serverBase && kioskId) {
        startKioskDisplay(win, serverBase, kioskId);
    } else {
        win.loadURL('data:text/html;charset=utf-8;base64,' + Buffer.from(
            '<!DOCTYPE html><html><head><meta charset="utf-8"></head><body style="margin:0;background:#000;color:rgba(255,255,255,.5);' +
            'display:flex;align-items:center;justify-content:center;height:100vh;font-family:sans-serif;font-size:24px">' +
            'שגיאה: נא לוודא שה-URL מכיל מזהה קיוסק (?id=N)</body></html>', 'utf-8'
        ).toString('base64'));
    }

    if (serverBase) startSnapshotLoop(win, serverBase, kioskId);

    return win;
}

// ── Kiosk content display — drives rotation directly in main process ──
// Loads each content URL directly into the window (no iframe → no X-Frame-Options issues)
function startKioskDisplay(win, serverBase, kioskId) {
    let links         = [];
    let currentIdx    = -1;
    let rotationTimer = null;
    let fetchTimer    = null;
    let firstFetch    = true;

    function makeDataUrl(html) {
        // base64-encode so Hebrew/Unicode always renders correctly regardless of browser charset
        return 'data:text/html;charset=utf-8;base64,' + Buffer.from(html, 'utf-8').toString('base64');
    }

    const WAITING_HTML = makeDataUrl(
        '<!DOCTYPE html><html><head><meta charset="utf-8"><style>' +
        '*{margin:0;padding:0}html,body{width:100%;height:100%;' +
        'background:radial-gradient(ellipse at center,#0d0d2e 0%,#000 100%);' +
        'display:flex;flex-direction:column;align-items:center;justify-content:center;' +
        'font-family:-apple-system,BlinkMacSystemFont,sans-serif;gap:16px}' +
        '.logo{font-size:52px;font-weight:900;background:linear-gradient(135deg,#6366f1,#a78bfa);' +
        '-webkit-background-clip:text;-webkit-text-fill-color:transparent}' +
        '.msg{font-size:22px;color:rgba(255,255,255,.4);font-weight:300}' +
        '</style></head><body>' +
        '<div class="logo">K</div><div class="msg">ממתין לתוכן...</div>' +
        '</body></html>'
    );

    function loadWaiting() {
        if (!win.isDestroyed()) win.loadURL(WAITING_HTML);
    }

    function resolveUrl(url) {
        // turn server-relative paths (e.g. /uploads/x.jpg) into absolute URLs
        if (url && url.startsWith('/')) return serverBase + url;
        return url;
    }

    function loadLink(link) {
        if (win.isDestroyed()) return;
        if (link.type === 'image') {
            const src = resolveUrl(link.url);
            win.loadURL(makeDataUrl(
                '<!DOCTYPE html><html><head><meta charset="utf-8"><style>' +
                '*{margin:0;padding:0}html,body{width:100%;height:100%;background:#000;overflow:hidden}' +
                'img{width:100%;height:100%;object-fit:contain}' +
                '</style></head><body><img src="' + src.replace(/"/g, '&quot;') + '"></body></html>'
            ));
        } else {
            win.loadURL(resolveUrl(link.url));
        }
    }

    function advance() {
        if (rotationTimer) { clearTimeout(rotationTimer); rotationTimer = null; }
        if (!links.length) { loadWaiting(); return; }
        currentIdx = (currentIdx + 1) % links.length;
        const link = links[currentIdx];
        loadLink(link);
        const ms = Math.max((link.duration_seconds || 30), 3) * 1000;
        rotationTimer = setTimeout(() => { if (!win.isDestroyed()) advance(); }, ms);
    }

    async function fetchState() {
        try {
            const raw = await httpGet(`${serverBase}/api/kiosk-client/${kioskId}`);
            if (!raw) return;
            const data = JSON.parse(raw);
            const incoming = Array.isArray(data.links) ? data.links : [];
            const changed  = JSON.stringify(incoming) !== JSON.stringify(links);

            if (firstFetch || changed) {
                firstFetch = false;
                links = incoming;
                if (rotationTimer) { clearTimeout(rotationTimer); rotationTimer = null; }
                advance();
            }

            if (data.message) injectMessage(win, data.message);
        } catch {}
    }

    // Show waiting screen immediately, then start fetching
    loadWaiting();
    fetchState();
    fetchTimer = setInterval(fetchState, 5000);

    win.on('closed', () => {
        if (rotationTimer) clearTimeout(rotationTimer);
        if (fetchTimer) clearInterval(fetchTimer);
    });
}

// ── Inject a temporary message overlay into whatever page is visible ──
function injectMessage(win, msg) {
    if (win.isDestroyed()) return;
    const text = String(msg.message || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    const dur  = Math.max(parseInt(msg.duration_seconds) || 10, 1) * 1000;
    const js = `(function(){
var e=document.getElementById('__km');if(e)e.remove();
e=document.createElement('div');e.id='__km';
e.style.cssText='position:fixed;inset:0;background:rgba(0,0,0,.88);display:flex;align-items:center;justify-content:center;z-index:2147483647;font-family:sans-serif';
e.innerHTML='<div style="border:1.5px solid rgba(99,102,241,.5);border-radius:24px;padding:52px 60px;max-width:75%;text-align:center;background:rgba(99,102,241,.1)"><div style="font-size:5vw;font-weight:700;color:#fff">'+'${text}'+'</div></div>';
document.body.appendChild(e);setTimeout(function(){if(e.parentNode)e.remove();},${dur});
})();`;
    win.webContents.executeJavaScript(js).catch(() => {});
}

// ── Settings overlay injected into the kiosk page ────────────────
function buildOverlayScript(currentUrl) {
    const safe = currentUrl.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$/g, '\\$');
    return `
(function() {
    if (document.getElementById('__ko_root')) return;
    const root = document.createElement('div');
    root.id = '__ko_root';

    const style = document.createElement('style');
    style.textContent = \`
        #__ko_trigger{position:fixed;top:0;left:0;width:48px;height:48px;z-index:2147483644;cursor:pointer}
        #__ko_gear{position:fixed;top:10px;left:10px;z-index:2147483645;width:28px;height:28px;border-radius:50%;background:rgba(0,0,0,.55);border:1px solid rgba(255,255,255,.18);display:flex;align-items:center;justify-content:center;cursor:pointer;opacity:0;transition:opacity .25s ease;color:rgba(255,255,255,.75)}
        #__ko_trigger:hover~#__ko_gear,#__ko_gear:hover,#__ko_gear.vis{opacity:1}
        #__ko_panel{position:fixed;top:14px;left:14px;z-index:2147483646;width:320px;background:#13132a;border:1px solid rgba(255,255,255,.14);border-radius:14px;box-shadow:0 8px 40px rgba(0,0,0,.8);display:none;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif}
        #__ko_panel.open{display:block;animation:__ko_in .18s ease}
        @keyframes __ko_in{from{opacity:0;transform:scale(.94) translateY(-4px)}to{opacity:1;transform:none}}
        #__ko_panel .__kh{display:flex;align-items:center;justify-content:space-between;padding:14px 16px 10px;border-bottom:1px solid rgba(255,255,255,.07)}
        #__ko_panel .__kt{font-size:14px;font-weight:700;color:#f1f5f9}
        #__ko_panel .__kx{width:24px;height:24px;border-radius:5px;border:1px solid rgba(255,255,255,.1);background:transparent;color:#64748b;cursor:pointer;font-size:14px;display:flex;align-items:center;justify-content:center;transition:all .15s}
        #__ko_panel .__kx:hover{background:rgba(239,68,68,.15);color:#ef4444;border-color:rgba(239,68,68,.3)}
        #__ko_panel .__kb{padding:14px 16px}
        #__ko_panel .__kl{font-size:11px;font-weight:600;color:#64748b;margin-bottom:6px;display:block}
        #__ko_panel .__ki{width:100%;height:36px;background:#0b0b1a;border:1px solid rgba(255,255,255,.1);border-radius:7px;color:#f1f5f9;font-size:12px;padding:0 10px;outline:none;direction:ltr;font-family:monospace;box-sizing:border-box;transition:border-color .15s}
        #__ko_panel .__ki:focus{border-color:rgba(99,102,241,.55);box-shadow:0 0 0 3px rgba(99,102,241,.1)}
        #__ko_panel .__kf{display:flex;gap:8px;padding:10px 16px 14px;justify-content:flex-end}
        #__ko_panel .__bn{height:32px;padding:0 16px;border-radius:7px;border:none;font-size:12px;font-weight:600;cursor:pointer;transition:all .15s;font-family:inherit}
        #__ko_panel .__bc{background:rgba(255,255,255,.06);color:#94a3b8;border:1px solid rgba(255,255,255,.1)}
        #__ko_panel .__bc:hover{background:rgba(255,255,255,.1);color:#f1f5f9}
        #__ko_panel .__bs{background:#6366f1;color:#fff}
        #__ko_panel .__bs:hover{background:#818cf8}
        #__ko_panel .__bs:disabled{opacity:.45;cursor:not-allowed}
    \`;
    document.head.appendChild(style);

    root.innerHTML = \`
        <div id="__ko_trigger"></div>
        <div id="__ko_gear" title="שינוי קיוסק">
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" width="14" height="14">
                <circle cx="8" cy="8" r="2.5"/>
                <path d="M8 1v1.5M8 13.5V15M1 8h1.5M13.5 8H15M3.05 3.05l1.06 1.06M11.89 11.89l1.06 1.06M3.05 12.95l1.06-1.06M11.89 4.11l1.06-1.06"/>
            </svg>
        </div>
        <div id="__ko_panel">
            <div class="__kh"><span class="__kt">⚙ עדכון קיוסק</span><button class="__kx" id="__ko_close">✕</button></div>
            <div class="__kb">
                <label class="__kl">כתובת URL של הקיוסק</label>
                <input type="text" class="__ki" id="__ko_input" placeholder="http://192.168.1.10:5190/kiosk.html?id=1">
            </div>
            <div class="__kf">
                <button class="__bn __bc" id="__ko_cancel">ביטול</button>
                <button class="__bn __bs" id="__ko_save">עדכן וטען מחדש</button>
            </div>
        </div>
    \`;
    document.body.appendChild(root);

    const trigger = document.getElementById('__ko_trigger');
    const gear    = document.getElementById('__ko_gear');
    const panel   = document.getElementById('__ko_panel');
    const input   = document.getElementById('__ko_input');
    input.value   = \`${safe}\`;

    trigger.addEventListener('mouseenter', () => { if (!panel.classList.contains('open')) gear.classList.add('vis'); });
    trigger.addEventListener('mouseleave', () => gear.classList.remove('vis'));
    gear.addEventListener('click', () => { panel.classList.add('open'); gear.classList.remove('vis'); setTimeout(() => input.focus(), 80); });

    function close() { panel.classList.remove('open'); }
    document.getElementById('__ko_close').addEventListener('click', close);
    document.getElementById('__ko_cancel').addEventListener('click', close);
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && panel.classList.contains('open')) close(); });

    function doSave() {
        const u = input.value.trim();
        if (!u) return;
        const btn = document.getElementById('__ko_save');
        btn.disabled = true; btn.textContent = 'טוען...';
        if (window.kioskAPI) window.kioskAPI.updateUrl(u);
    }
    document.getElementById('__ko_save').addEventListener('click', doSave);
    input.addEventListener('keydown', e => { if (e.key === 'Enter') doSave(); });
})();
    `;
}

// ── Snapshot logging ──────────────────────────────────────────────
function snapshotLog(msg) {
    const line = `[${new Date().toISOString()}] ${msg}\n`;
    try { fs.appendFileSync(path.join(app.getPath('userData'), 'snapshot.log'), line, 'utf8'); } catch {}
    console.log('[Snapshot]', msg);
}

// ── Generic HTTP GET helper (no fetch dependency) ─────────────────
function httpGet(urlStr) {
    return new Promise((resolve) => {
        try {
            const parsed = new URL(urlStr);
            const transport = parsed.protocol === 'https:' ? https : http;
            const req = transport.request({
                hostname: parsed.hostname,
                port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
                path: parsed.pathname + parsed.search,
                method: 'GET'
            }, (res) => {
                let data = '';
                res.on('data', c => { data += c; });
                res.on('end', () => resolve(res.statusCode === 200 ? data : null));
            });
            req.on('error', () => resolve(null));
            req.setTimeout(5000, () => { req.destroy(); resolve(null); });
            req.end();
        } catch { resolve(null); }
    });
}

// ── Snapshot ─────────────────────────────────────────────────────
function resizeSnapshot(image) {
    const { width, height } = image.getSize();
    const maxWidth = 640;
    if (width <= maxWidth) return image;
    return image.resize({ width: maxWidth, height: Math.round(height * (maxWidth / width)) });
}

function sendSnapshot(kioskId, serverBase, jpegBuffer) {
    return new Promise((resolve) => {
        try {
            if (!jpegBuffer || jpegBuffer.length === 0) {
                snapshotLog('Empty image buffer, skipping send');
                return resolve();
            }
            const body = JSON.stringify({ image: jpegBuffer.toString('base64') });
            const parsed = new URL(`${serverBase}/api/kiosks/${kioskId}/snapshot-json`);
            const transport = parsed.protocol === 'https:' ? https : http;
            const req = transport.request({
                hostname: parsed.hostname,
                port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
                path: parsed.pathname,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(body)
                }
            }, (res) => {
                let data = '';
                res.on('data', chunk => { data += chunk; });
                res.on('end', () => {
                    if (res.statusCode === 200) {
                        snapshotLog(`Sent OK → kiosk ${kioskId} (${jpegBuffer.length} bytes)`);
                    } else {
                        snapshotLog(`Upload failed HTTP ${res.statusCode}: ${data}`);
                    }
                    resolve();
                });
            });
            req.on('error', (err) => { snapshotLog(`Upload error: ${err.message}`); resolve(); });
            req.setTimeout(10000, () => { req.destroy(); snapshotLog('Upload timed out'); resolve(); });
            req.write(body);
            req.end();
        } catch (err) {
            snapshotLog(`sendSnapshot exception: ${err.message}`);
            resolve();
        }
    });
}

function startSnapshotLoop(win, serverBase, initialKioskId) {
    let timeoutId = null;
    let kioskId   = initialKioskId || null;

    // Resolve kiosk ID lazily: first from the live page URL, then from the server API
    async function resolveKioskId() {
        if (kioskId) return kioskId;

        // Try from the currently loaded page URL
        try {
            if (!win.isDestroyed()) {
                const id = parseInt(new URL(win.webContents.getURL()).searchParams.get('id'), 10);
                if (id > 0) { kioskId = id; snapshotLog(`Kiosk ID resolved from page URL: ${id}`); return id; }
            }
        } catch {}

        // Try computer-name API (no fetch, uses http.request)
        try {
            const name = process.env.COMPUTERNAME || '';
            if (name) {
                const raw = await httpGet(`${serverBase}/api/kiosk-by-computer-name?computer_name=${encodeURIComponent(name)}`);
                if (raw) {
                    const k = JSON.parse(raw);
                    if (k && k.id) { kioskId = k.id; snapshotLog(`Kiosk ID resolved from computer name "${name}": ${k.id}`); return kioskId; }
                }
            }
        } catch {}

        return null;
    }

    async function getInterval() {
        try {
            const raw = await httpGet(`${serverBase}/api/config`);
            if (raw) {
                const cfg = JSON.parse(raw);
                const v = parseInt(cfg.snapshot_interval_seconds, 10);
                if (v >= 3) return v;
            }
        } catch {}
        return 10;
    }

    async function grabImage() {
        // 1st attempt: capturePage (fastest, captures renderer content)
        try {
            const img = await win.webContents.capturePage();
            if (img.getSize().width > 0) return img;
            snapshotLog('capturePage returned empty — trying desktopCapturer fallback');
        } catch (e) {
            snapshotLog(`capturePage error: ${e.message} — trying fallback`);
        }

        // 2nd attempt: desktopCapturer (captures actual GPU-composited screen)
        try {
            const { desktopCapturer, screen } = require('electron');
            const wb = win.getBounds();
            const display = screen.getDisplayNearestPoint({ x: wb.x + Math.floor(wb.width / 2), y: wb.y + Math.floor(wb.height / 2) });
            const { width: dw, height: dh } = display.size;
            const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: dw, height: dh } });
            if (sources && sources.length > 0) {
                const src = sources.find(s => s.display_id === String(display.id)) || sources[0];
                const img = src.thumbnail;
                if (img.getSize().width > 0) {
                    snapshotLog('desktopCapturer fallback OK');
                    return img;
                }
            }
        } catch (e) {
            snapshotLog(`desktopCapturer error: ${e.message}`);
        }

        return null;
    }

    async function captureOnce() {
        if (win.isDestroyed()) return;
        const interval = await getInterval();
        const id = await resolveKioskId();

        if (!id) {
            snapshotLog('Kiosk ID not yet resolved — skipping this cycle');
        } else {
            try {
                const image = await grabImage();
                if (!image) {
                    snapshotLog('Both capture methods returned no image');
                } else {
                    const small = resizeSnapshot(image);
                    const jpeg  = small.toJPEG(50);
                    await sendSnapshot(id, serverBase, jpeg);
                }
            } catch (err) {
                snapshotLog(`Capture/send error: ${err.message}`);
            }
        }

        if (!win.isDestroyed()) timeoutId = setTimeout(captureOnce, interval * 1000);
    }

    win.on('closed', () => { if (timeoutId) clearTimeout(timeoutId); });
    snapshotLog(`Loop started — serverBase=${serverBase} initialKioskId=${initialKioskId}`);
    setTimeout(captureOnce, 5000);
}

// ── App Ready ────────────────────────────────────────────────────
app.whenReady().then(async () => {
    // Strip X-Frame-Options and CSP frame-ancestors so any URL can load in the kiosk iframe
    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
        const headers = { ...details.responseHeaders };
        Object.keys(headers).forEach(k => {
            if (k.toLowerCase() === 'x-frame-options') delete headers[k];
            if (k.toLowerCase() === 'content-security-policy') {
                headers[k] = headers[k].map(v => v.replace(/frame-ancestors[^;]*(;|$)/gi, '').trim());
            }
        });
        callback({ responseHeaders: headers });
    });

    const config = loadConfig();
    const reset  = process.argv.includes('--reset');

    if (reset || !config || !config.url) {
        createSetupWindow();
    } else {
        await createPlayerWindow(config.url);
    }

    app.on('activate', async () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            const cfg = loadConfig();
            if (cfg && cfg.url) {
                await createPlayerWindow(cfg.url);
            } else {
                createSetupWindow();
            }
        }
    });
});

// ── IPC: save URL from setup form ────────────────────────────────
ipcMain.on('save-url', async (_e, url) => {
    saveConfig({ url });
    BrowserWindow.getAllWindows().forEach(w => w.close());
    await createPlayerWindow(url);
});

// ── IPC: update URL from player overlay ──────────────────────────
ipcMain.on('update-url', async (_e, url) => {
    saveConfig({ url });
    BrowserWindow.getAllWindows().forEach(w => w.close());
    await createPlayerWindow(url);
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});
