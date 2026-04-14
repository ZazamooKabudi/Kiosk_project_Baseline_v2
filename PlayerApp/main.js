const { app, BrowserWindow, Menu, ipcMain } = require('electron');
const path = require('path');
const fs   = require('fs');

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
function createSetupWindow() {
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
    win.loadFile('index.html');
    return win;
}

// ── Player Window ────────────────────────────────────────────────
function createPlayerWindow(url) {
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

    // Load local player.html wrapper with the URL as query param
    const playerUrl = `file://${path.join(__dirname, 'player.html')}?url=${encodeURIComponent(url)}`;
    win.loadURL(playerUrl);

    // ESC → exit fullscreen
    win.webContents.on('before-input-event', (_e, input) => {
        if (input.key === 'Escape' && input.type === 'keyDown') {
            win.setFullScreen(false);
        }
        // F12 → reset config and return to setup
        if (input.key === 'F12' && input.type === 'keyDown') {
            saveConfig({});
            win.close();
            createSetupWindow();
        }
    });
    return win;
}

// ── App Ready ────────────────────────────────────────────────────
app.whenReady().then(() => {
    const config = loadConfig();
    const reset  = process.argv.includes('--reset');

    if (reset || !config || !config.url) {
        createSetupWindow();
    } else {
        createPlayerWindow(config.url);
    }

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            const cfg = loadConfig();
            cfg && cfg.url ? createPlayerWindow(cfg.url) : createSetupWindow();
        }
    });
});

// ── IPC: save URL from setup form ────────────────────────────────
ipcMain.on('save-url', (_e, url) => {
    saveConfig({ url });
    BrowserWindow.getAllWindows().forEach(w => w.close());
    createPlayerWindow(url);
});

// ── IPC: update URL from player overlay ──────────────────────────
ipcMain.on('update-url', (_e, url) => {
    saveConfig({ url });
    BrowserWindow.getAllWindows().forEach(w => w.close());
    createPlayerWindow(url);
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});
