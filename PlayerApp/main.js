const { app, BrowserWindow, Menu, ipcMain } = require('electron');
const path = require('path');
const fs   = require('fs');

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
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false
        }
    });
    Menu.setApplicationMenu(null);

    const computerName = process.env.COMPUTERNAME || 'unknown';
    let kioskId = null;
    const serverBase = (() => {
        try { return new URL(url).origin; } catch { return null; }
    })();
    if (serverBase) {
        try {
            const response = await fetch(`${serverBase}/api/kiosk-by-computer-name?computer_name=${encodeURIComponent(computerName)}`);
            if (response.ok) {
                const kiosk = await response.json();
                kioskId = kiosk.id;
            }
        } catch (e) {
            console.warn('Failed to get kiosk by computer name:', e);
        }
    }

    const separator = url.includes('?') ? '&' : '?';
    const fullUrl = kioskId ? `${url}${separator}id=${kioskId}` : url;

    // Load the kiosk URL directly — no iframe wrapper so capturePage() works
    win.loadURL(fullUrl);

    // Inject the settings gear overlay after every page load
    win.webContents.on('did-finish-load', () => {
        win.webContents.executeJavaScript(buildOverlayScript(fullUrl)).catch(() => {});
    });

    // Start periodic snapshot upload
    if (kioskId && serverBase) {
        startSnapshotLoop(win, kioskId, serverBase);
    }

    win.webContents.on('before-input-event', (_e, input) => {
        if (input.key === 'Escape' && input.type === 'keyDown') {
            win.setFullScreen(false);
        }
        if (input.key === 'F12' && input.type === 'keyDown') {
            saveConfig({});
            win.close();
            createSetupWindow();
        }
    });
    return win;
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

// ── Snapshot ─────────────────────────────────────────────────────
async function getSnapshotInterval(serverBase) {
    try {
        const response = await fetch(`${serverBase}/api/config`);
        if (!response.ok) return 10;
        const config = await response.json();
        const interval = parseInt(config.snapshot_interval_seconds, 10);
        return interval >= 3 ? interval : 10;
    } catch {
        return 10;
    }
}

function resizeSnapshot(image) {
    const { width, height } = image.getSize();
    const maxWidth = 640;
    if (width <= maxWidth) return image;
    return image.resize({ width: maxWidth, height: Math.round(height * (maxWidth / width)) });
}

async function sendSnapshot(kioskId, serverBase, jpegBuffer) {
    try {
        const response = await fetch(`${serverBase}/api/kiosks/${kioskId}/snapshot-json`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ image: jpegBuffer.toString('base64') })
        });
        if (!response.ok) {
            const text = await response.text();
            console.warn('Snapshot upload failed:', text);
        }
    } catch (err) {
        console.warn('Snapshot upload exception:', err);
    }
}

function startSnapshotLoop(win, kioskId, serverBase) {
    let timeoutId = null;

    async function captureOnce() {
        if (win.isDestroyed()) return;
        const interval = await getSnapshotInterval(serverBase);
        try {
            const image = await win.webContents.capturePage();
            const small = resizeSnapshot(image);
            const jpeg  = small.toJPEG(50);
            await sendSnapshot(kioskId, serverBase, jpeg);
        } catch (err) {
            console.warn('Snapshot capture failed:', err);
        }
        if (!win.isDestroyed()) {
            timeoutId = setTimeout(captureOnce, interval * 1000);
        }
    }

    win.on('closed', () => { if (timeoutId) clearTimeout(timeoutId); });
    setTimeout(captureOnce, 5000);
}

// ── App Ready ────────────────────────────────────────────────────
app.whenReady().then(async () => {
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
