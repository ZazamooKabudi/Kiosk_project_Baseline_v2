const express = require('express');
const ping = require('ping');
const path = require('path');
const fs = require('fs');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const multer = require('multer');
const bcrypt = require('bcryptjs');
const SALT_ROUNDS = 12;

const app = express();
const PORT = 5190;

let uploadsDir;

const logsDir = path.join(__dirname, 'logs');
if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir);

// ── Daily rotating logger — keeps last 7 files per prefix ────────
function writeLog(prefix, line) {
    const today = new Date().toISOString().slice(0, 10);
    const file  = path.join(logsDir, `${prefix}-${today}.log`);
    try {
        fs.appendFileSync(file, line, 'utf8');
        // Prune: keep only the 7 most recent dated files for this prefix
        const re = new RegExp(`^${prefix}-\\d{4}-\\d{2}-\\d{2}\\.log$`);
        const old = fs.readdirSync(logsDir).filter(f => re.test(f)).sort();
        if (old.length > 7) old.slice(0, old.length - 7).forEach(f => {
            try { fs.unlinkSync(path.join(logsDir, f)); } catch {}
        });
    } catch {}
}

function logError(e, req) {
    const ctx  = req ? `${req.method} ${req.originalUrl}` : 'server';
    const line = `[${new Date().toISOString()}] ${ctx} — ${e.stack || e.message}\n`;
    writeLog('errors', line);
}

function logEvent(prefix, msg) {
    writeLog(prefix, `[${new Date().toISOString()}] ${msg}\n`);
}

const upload = multer({
    storage: multer.diskStorage({
        destination: (req, file, cb) => cb(null, uploadsDir),
        filename: (req, file, cb) => {
            const ext = path.extname(file.originalname).toLowerCase();
            cb(null, `${Date.now()}-${req.params.id}${ext}`);
        }
    }),
    limits: { fileSize: 20 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        const allowed = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.svg'];
        cb(null, allowed.includes(path.extname(file.originalname).toLowerCase()));
    }
});

const DEFAULT_DB_DIR = 'C:\\SQL_DB\\Kiosk_project_Baseline_v2';
const settingsPath = path.join(__dirname, 'settings.json');

function loadSettings() {
    try { return JSON.parse(fs.readFileSync(settingsPath, 'utf8')); } catch { return {}; }
}

function ensureSettings() {
    if (!fs.existsSync(settingsPath)) {
        fs.writeFileSync(settingsPath, JSON.stringify({ db_path: DEFAULT_DB_DIR }, null, 2), 'utf8');
    }
}

ensureSettings();
const settings = loadSettings();
const dbDir = process.env.DB_PATH || settings.db_path || DEFAULT_DB_DIR;
if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });

uploadsDir = process.env.UPLOADS_PATH || settings.uploads_path || path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

const dbPath = path.join(dbDir, 'kiosk.db');
const db = new sqlite3.Database(dbPath);

// Promise helpers
function run(sql, params = []) {
    return new Promise((res, rej) => db.run(sql, params, function (err) { err ? rej(err) : res(this); }));
}
function get(sql, params = []) {
    return new Promise((res, rej) => db.get(sql, params, (err, row) => err ? rej(err) : res(row)));
}
function all(sql, params = []) {
    return new Promise((res, rej) => db.all(sql, params, (err, rows) => err ? rej(err) : res(rows || [])));
}

async function initDb() {
    await new Promise((res, rej) => db.exec(`
        PRAGMA journal_mode = WAL;
        PRAGMA foreign_keys = ON;

        CREATE TABLE IF NOT EXISTS areas (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE NOT NULL,
            password TEXT NOT NULL,
            role TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS user_areas (
            user_id INTEGER NOT NULL,
            area_id INTEGER NOT NULL,
            PRIMARY KEY (user_id, area_id)
        );

        CREATE TABLE IF NOT EXISTS kiosks (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            area_id INTEGER NOT NULL,
            ip TEXT,
            computer_name TEXT,
            description TEXT,
            station_manager TEXT,
            manager_email TEXT,
            notes TEXT,
            is_active INTEGER DEFAULT 1,
            alert_offline INTEGER DEFAULT 0,
            last_ping_status TEXT,
            last_ping_time TEXT,
            last_success_time TEXT,
            last_seen_time TEXT,
            last_snapshot_url TEXT,
            last_snapshot_time TEXT,
            last_alert_date TEXT
        );

        CREATE TABLE IF NOT EXISTS kiosk_links (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            kiosk_id INTEGER NOT NULL,
            url TEXT NOT NULL,
            duration_seconds INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            kiosk_id INTEGER NOT NULL,
            message TEXT NOT NULL,
            duration_seconds INTEGER NOT NULL,
            created_at TEXT NOT NULL,
            is_displayed INTEGER DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS config (
            key TEXT PRIMARY KEY,
            value TEXT
        );
    `, err => err ? rej(err) : res()));

    await run("INSERT OR IGNORE INTO config (key, value) VALUES ('offline_days', '14')");
    await run("INSERT OR IGNORE INTO config (key, value) VALUES ('snapshot_interval_seconds', '10')");
    const admin = await get("SELECT id FROM users WHERE username = 'kioskadmin'");
    if (!admin) {
        const hashed = await bcrypt.hash('qw12!@', SALT_ROUNDS);
        await run("INSERT INTO users (username, password, role) VALUES (?, ?, ?)", ['kioskadmin', hashed, 'admin']);
    }
}

async function getConfig() {
    const rows = await all('SELECT key, value FROM config');
    const cfg = {};
    for (const row of rows) {
        const num = Number(row.value);
        cfg[row.key] = row.value !== '' && !isNaN(num) ? num : row.value;
    }
    return cfg;
}

async function getAllowedAreaIds(user_id) {
    const user = await get('SELECT role FROM users WHERE id = ?', [user_id]);
    if (!user) return [];
    if (user.role === 'admin') return null;
    const rows = await all('SELECT area_id FROM user_areas WHERE user_id = ?', [user_id]);
    return rows.map(r => r.area_id);
}

async function canAccessKiosk(user_id, kiosk_id) {
    const areaIds = await getAllowedAreaIds(user_id);
    if (areaIds === null) return true;
    const kiosk = await get('SELECT area_id FROM kiosks WHERE id = ?', [kiosk_id]);
    if (!kiosk) return false;
    return areaIds.includes(kiosk.area_id);
}

async function runPingSweep() {
    const kiosks = await all("SELECT * FROM kiosks WHERE is_active = 1 AND ip IS NOT NULL AND ip != ''");
    await Promise.all(kiosks.map(async (kiosk) => {
        let isAlive = { alive: false };
        try {
            isAlive = await ping.promise.probe(kiosk.ip, { timeout: 2, extra: ['-n', '1'] });
        } catch (e) {
            logEvent('errors', `ping ${kiosk.ip} — ${e.message}`);
        }
        const status = isAlive.alive ? 'Online' : 'Offline';
        const time = new Date().toISOString();
        if (isAlive.alive) {
            await run('UPDATE kiosks SET last_ping_status = ?, last_ping_time = ?, last_success_time = ? WHERE id = ?',
                [status, time, time, kiosk.id]);
        } else {
            await run('UPDATE kiosks SET last_ping_status = ?, last_ping_time = ? WHERE id = ?',
                [status, time, kiosk.id]);
        }
    }));
}

setInterval(runPingSweep, 10 * 60 * 1000);

app.use(express.json({ limit: '10mb' }));
app.use(cors());
app.use('/uploads', express.static(uploadsDir));
app.use(express.static(path.join(__dirname, 'public')));

// SETTINGS (settings.json)
app.get('/api/settings', (req, res) => {
    res.json({ ...loadSettings(), current_db_path: dbPath, current_uploads_path: uploadsDir });
});

app.post('/api/settings', (req, res) => {
    try {
        const current = loadSettings();
        const updated = { ...current };
        if (req.body.db_path !== undefined) {
            updated.db_path = req.body.db_path;
            try { fs.mkdirSync(req.body.db_path, { recursive: true }); } catch {}
        }
        if (req.body.uploads_path !== undefined) {
            updated.uploads_path = req.body.uploads_path;
            try { fs.mkdirSync(req.body.uploads_path, { recursive: true }); } catch {}
        }
        fs.writeFileSync(settingsPath, JSON.stringify(updated, null, 2), 'utf8');
        res.json({ success: true });
    } catch (e) { logError(e, req); res.status(500).json({ error: e.message }); }
});

// CONFIG
app.get('/api/config', async (req, res) => {
    try { res.json(await getConfig()); } catch (e) { logError(e, req); res.status(500).json({ error: e.message }); }
});

app.post('/api/config', async (req, res) => {
    try {
        for (const [key, value] of Object.entries(req.body))
            await run('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)', [key, String(value)]);
        res.json({ success: true });
    } catch (e) { logError(e, req); res.status(500).json({ error: e.message }); }
});

// PING
app.post('/api/ping-all', async (req, res) => {
    try { await runPingSweep(); res.json({ success: true }); }
    catch (e) { logError(e, req); res.status(500).json({ error: e.message }); }
});

// LOGIN
app.post('/api/login', async (req, res) => {
    try {
        const { username, password } = req.body;
        const user = await get('SELECT * FROM users WHERE username = ?', [username]);
        if (user && await bcrypt.compare(password, user.password))
            res.json({ id: user.id, username: user.username, role: user.role });
        else res.status(401).json({ error: "Invalid credentials" });
    } catch (e) { logError(e, req); res.status(500).json({ error: e.message }); }
});

// USERS
app.get('/api/users', async (req, res) => {
    try {
        const users = await all('SELECT id, username, role FROM users');
        const user_areas = await all('SELECT * FROM user_areas');
        res.json({ users, user_areas });
    } catch (e) { logError(e, req); res.status(500).json({ error: e.message }); }
});

app.post('/api/users', async (req, res) => {
    try {
        const { username, password, role, areas } = req.body;
        if (await get('SELECT id FROM users WHERE username = ?', [username]))
            return res.status(400).json({ error: "Username exists" });
        const hashed = await bcrypt.hash(password, SALT_ROUNDS);
        const result = await run('INSERT INTO users (username, password, role) VALUES (?, ?, ?)', [username, hashed, role]);
        const id = result.lastID;
        if (areas && Array.isArray(areas))
            for (const area_id of areas)
                await run('INSERT OR IGNORE INTO user_areas (user_id, area_id) VALUES (?, ?)', [id, parseInt(area_id)]);
        res.json({ id });
    } catch (e) { logError(e, req); res.status(500).json({ error: e.message }); }
});

app.put('/api/users/:id', async (req, res) => {
    try {
        const id = parseInt(req.params.id);
        const { password, areas } = req.body;
        if (!await get('SELECT id FROM users WHERE id = ?', [id]))
            return res.status(404).json({ error: "Not found" });
        if (password) {
            const hashed = await bcrypt.hash(password, SALT_ROUNDS);
            await run('UPDATE users SET password = ? WHERE id = ?', [hashed, id]);
        }
        if (areas !== undefined) {
            await run('DELETE FROM user_areas WHERE user_id = ?', [id]);
            for (const area_id of areas)
                await run('INSERT OR IGNORE INTO user_areas (user_id, area_id) VALUES (?, ?)', [id, parseInt(area_id)]);
        }
        res.json({ success: true });
    } catch (e) { logError(e, req); res.status(500).json({ error: e.message }); }
});

app.delete('/api/users/:id', async (req, res) => {
    try {
        const id = parseInt(req.params.id);
        await run('DELETE FROM users WHERE id = ?', [id]);
        await run('DELETE FROM user_areas WHERE user_id = ?', [id]);
        res.json({ success: true });
    } catch (e) { logError(e, req); res.status(500).json({ error: e.message }); }
});

// AREAS
app.get('/api/areas', async (req, res) => {
    try {
        const user_id = req.query.user_id ? parseInt(req.query.user_id) : null;
        if (!user_id) return res.json(await all('SELECT * FROM areas'));

        const user = await get('SELECT role FROM users WHERE id = ?', [user_id]);
        if (!user) return res.status(401).json({ error: "User not found" });

        if (user.role === 'admin') {
            res.json(await all('SELECT * FROM areas'));
        } else {
            const allowed = (await all('SELECT area_id FROM user_areas WHERE user_id = ?', [user_id])).map(r => r.area_id);
            if (allowed.length === 0) return res.json([]);
            const placeholders = allowed.map(() => '?').join(',');
            res.json(await all(`SELECT * FROM areas WHERE id IN (${placeholders})`, allowed));
        }
    } catch (e) { logError(e, req); res.status(500).json({ error: e.message }); }
});

app.post('/api/areas', async (req, res) => {
    try {
        const { name } = req.body;
        const result = await run('INSERT INTO areas (name) VALUES (?)', [name]);
        res.json({ id: result.lastID, name });
    } catch (e) { logError(e, req); res.status(500).json({ error: e.message }); }
});

app.delete('/api/areas/:id', async (req, res) => {
    try {
        const id = parseInt(req.params.id);
        await run('DELETE FROM areas WHERE id = ?', [id]);
        await run('DELETE FROM kiosks WHERE area_id = ?', [id]);
        await run('DELETE FROM user_areas WHERE area_id = ?', [id]);
        res.json({ success: true });
    } catch (e) { logError(e, req); res.status(500).json({ error: e.message }); }
});

// KIOSKS
app.get('/api/kiosks', async (req, res) => {
    try {
        const area_id = req.query.area_id ? parseInt(req.query.area_id) : null;
        const user_id = req.query.user_id ? parseInt(req.query.user_id) : null;

        let query = 'SELECT * FROM kiosks';
        const params = [];
        const conditions = [];

        if (area_id) { conditions.push('area_id = ?'); params.push(area_id); }

        if (user_id) {
            const allowed = await getAllowedAreaIds(user_id);
            if (allowed !== null) {
                if (allowed.length === 0) return res.json([]);
                conditions.push(`area_id IN (${allowed.map(() => '?').join(',')})`);
                params.push(...allowed);
            }
        }

        if (conditions.length) query += ' WHERE ' + conditions.join(' AND ');
        const kiosks = await all(query, params);
        if (!kiosks.length) return res.json([]);
        const ids = kiosks.map(k => k.id);
        const links = await all(
            `SELECT * FROM kiosk_links WHERE kiosk_id IN (${ids.map(() => '?').join(',')}) ORDER BY id`,
            ids
        );
        const linksMap = {};
        links.forEach(l => {
            if (!linksMap[l.kiosk_id]) linksMap[l.kiosk_id] = [];
            linksMap[l.kiosk_id].push(l);
        });
        res.json(kiosks.map(k => ({ ...k, links: linksMap[k.id] || [] })));
    } catch (e) { logError(e, req); res.status(500).json({ error: e.message }); }
});

app.post('/api/kiosks', async (req, res) => {
    try {
        const { area_id, ip, computer_name, description, station_manager, manager_email, notes, is_active, alert_offline, user_id } = req.body;
        if (user_id) {
            const allowed = await getAllowedAreaIds(parseInt(user_id));
            if (allowed !== null && !allowed.includes(parseInt(area_id)))
                return res.status(403).json({ error: "Access denied" });
        }
        const active = is_active !== undefined ? is_active : 1;
        const alertOff = alert_offline !== undefined ? alert_offline : 0;
        const result = await run(
            `INSERT INTO kiosks (area_id, ip, computer_name, description, station_manager, manager_email, notes, is_active, alert_offline)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [parseInt(area_id), ip, computer_name, description, station_manager, manager_email, notes, active, alertOff]
        );
        res.json({ id: result.lastID });
    } catch (e) { logError(e, req); res.status(500).json({ error: e.message }); }
});

app.put('/api/kiosks/:id', async (req, res) => {
    try {
        const id = parseInt(req.params.id);
        const { area_id, ip, computer_name, description, station_manager, manager_email, notes, is_active, alert_offline, user_id } = req.body;
        if (user_id && !await canAccessKiosk(parseInt(user_id), id))
            return res.status(403).json({ error: "Access denied" });
        if (!await get('SELECT id FROM kiosks WHERE id = ?', [id]))
            return res.status(404).json({ error: "Kiosk not found" });
        await run(
            `UPDATE kiosks SET area_id = ?, ip = ?, computer_name = ?, description = ?,
             station_manager = ?, manager_email = ?, notes = ?, is_active = ?, alert_offline = ?
             WHERE id = ?`,
            [parseInt(area_id), ip, computer_name, description, station_manager, manager_email, notes, is_active, alert_offline, id]
        );
        res.json({ success: true });
    } catch (e) { logError(e, req); res.status(500).json({ error: e.message }); }
});

app.delete('/api/kiosks/:id', async (req, res) => {
    try {
        const id = parseInt(req.params.id);
        const user_id = req.query.user_id ? parseInt(req.query.user_id) : null;
        if (user_id && !await canAccessKiosk(user_id, id))
            return res.status(403).json({ error: "Access denied" });
        await run('DELETE FROM kiosks WHERE id = ?', [id]);
        await run('DELETE FROM kiosk_links WHERE kiosk_id = ?', [id]);
        res.json({ success: true });
    } catch (e) { logError(e, req); res.status(500).json({ error: e.message }); }
});

// KIOSK LINKS
app.get('/api/kiosks/:id/links', async (req, res) => {
    try {
        const id = parseInt(req.params.id);
        const user_id = req.query.user_id ? parseInt(req.query.user_id) : null;
        if (user_id && !await canAccessKiosk(user_id, id))
            return res.status(403).json({ error: "Access denied" });
        res.json(await all('SELECT * FROM kiosk_links WHERE kiosk_id = ?', [id]));
    } catch (e) { logError(e, req); res.status(500).json({ error: e.message }); }
});

app.post('/api/kiosks/:id/links', async (req, res) => {
    try {
        const kiosk_id = parseInt(req.params.id);
        const { url, duration_seconds, user_id } = req.body;
        if (user_id && !await canAccessKiosk(parseInt(user_id), kiosk_id))
            return res.status(403).json({ error: "Access denied" });
        const result = await run(
            'INSERT INTO kiosk_links (kiosk_id, url, duration_seconds) VALUES (?, ?, ?)',
            [kiosk_id, url, parseInt(duration_seconds)]
        );
        res.json({ id: result.lastID });
    } catch (e) { logError(e, req); res.status(500).json({ error: e.message }); }
});

app.put('/api/links/:id', async (req, res) => {
    try {
        const id = parseInt(req.params.id);
        const { url, duration_seconds, user_id } = req.body;
        const link = await get('SELECT * FROM kiosk_links WHERE id = ?', [id]);
        if (!link) return res.status(404).json({ error: 'Not found' });
        if (user_id && !await canAccessKiosk(parseInt(user_id), link.kiosk_id))
            return res.status(403).json({ error: 'Access denied' });
        const newUrl = link.type === 'image' ? link.url : (url || link.url);
        await run(
            'UPDATE kiosk_links SET url = ?, duration_seconds = ? WHERE id = ?',
            [newUrl, parseInt(duration_seconds) || link.duration_seconds, id]
        );
        res.json({ success: true });
    } catch (e) { logError(e, req); res.status(500).json({ error: e.message }); }
});

app.post('/api/kiosks/:id/links/image', upload.single('image'), async (req, res) => {
    try {
        const kiosk_id = parseInt(req.params.id);
        const { duration_seconds, user_id } = req.body;
        if (!req.file) return res.status(400).json({ error: 'No image uploaded' });
        if (user_id && !await canAccessKiosk(parseInt(user_id), kiosk_id))
            return res.status(403).json({ error: "Access denied" });
        const url = `/uploads/${req.file.filename}`;
        const result = await run(
            "INSERT INTO kiosk_links (kiosk_id, url, duration_seconds, type) VALUES (?, ?, ?, 'image')",
            [kiosk_id, url, parseInt(duration_seconds) || 30]
        );
        res.json({ id: result.lastID });
    } catch (e) { logError(e, req); res.status(500).json({ error: e.message }); }
});

app.post('/api/kiosks/:id/snapshot', upload.single('snapshot'), async (req, res) => {
    try {
        const kiosk_id = parseInt(req.params.id);
        const user_id = req.body.user_id ? parseInt(req.body.user_id) : null;
        if (!req.file) return res.status(400).json({ error: 'No snapshot uploaded' });
        if (user_id && !await canAccessKiosk(user_id, kiosk_id))
            return res.status(403).json({ error: "Access denied" });

        const kiosk = await get('SELECT last_snapshot_url FROM kiosks WHERE id = ?', [kiosk_id]);
        if (kiosk && kiosk.last_snapshot_url) {
            try { fs.unlinkSync(path.join(uploadsDir, path.basename(kiosk.last_snapshot_url))); } catch {}
        }

        const url = `/uploads/${req.file.filename}`;
        const time = new Date().toISOString();
        await run('UPDATE kiosks SET last_snapshot_url = ?, last_snapshot_time = ? WHERE id = ?', [url, time, kiosk_id]);
        res.json({ success: true, url, time });
    } catch (e) { logError(e, req); res.status(500).json({ error: e.message }); }
});

app.post('/api/kiosks/:id/snapshot-json', async (req, res) => {
    try {
        const kiosk_id = parseInt(req.params.id);
        const user_id = req.body.user_id ? parseInt(req.body.user_id) : null;
        const imageBase64 = req.body.image;
        if (!imageBase64) return res.status(400).json({ error: 'No snapshot image provided' });
        if (isNaN(kiosk_id)) return res.status(400).json({ error: 'Invalid kiosk ID' });
        if (user_id && !await canAccessKiosk(user_id, kiosk_id))
            return res.status(403).json({ error: "Access denied" });

        // Verify kiosk exists — without this the UPDATE silently affects 0 rows
        const kiosk = await get('SELECT id, last_snapshot_url FROM kiosks WHERE id = ?', [kiosk_id]);
        if (!kiosk) {
            logEvent('errors', `snapshot: kiosk_id=${kiosk_id} not found`);
            return res.status(404).json({ error: `Kiosk ${kiosk_id} not found` });
        }

        // Per-kiosk subfolder — fixed filename, overwrites previous
        const kioskDir = path.join(uploadsDir, `kiosk_${kiosk_id}`);
        if (!fs.existsSync(kioskDir)) fs.mkdirSync(kioskDir, { recursive: true });

        const destPath = path.join(kioskDir, 'snapshot.jpg');
        const imgBuf = Buffer.from(imageBase64, 'base64');
        fs.writeFileSync(destPath, imgBuf);

        const url = `/uploads/kiosk_${kiosk_id}/snapshot.jpg`;
        const time = new Date().toISOString();
        await run('UPDATE kiosks SET last_snapshot_url = ?, last_snapshot_time = ? WHERE id = ?', [url, time, kiosk_id]);

        logEvent('snapshots', `kiosk_id=${kiosk_id} size=${imgBuf.length}B`);

        res.json({ success: true, url, time });
    } catch (e) { logError(e, req); res.status(500).json({ error: e.message }); }
});

app.delete('/api/links/:id', async (req, res) => {
    try {
        const id = parseInt(req.params.id);
        const user_id = req.query.user_id ? parseInt(req.query.user_id) : null;
        const link = await get('SELECT * FROM kiosk_links WHERE id = ?', [id]);
        if (user_id && link && !await canAccessKiosk(user_id, link.kiosk_id))
            return res.status(403).json({ error: "Access denied" });
        if (link && link.type === 'image' && link.url) {
            try { fs.unlinkSync(path.join(__dirname, link.url)); } catch {}
        }
        await run('DELETE FROM kiosk_links WHERE id = ?', [id]);
        res.json({ success: true });
    } catch (e) { logError(e, req); res.status(500).json({ error: e.message }); }
});

// MESSAGES
app.post('/api/messages', async (req, res) => {
    try {
        const { kiosk_id, message, duration_seconds, user_id } = req.body;
        if (user_id && !await canAccessKiosk(parseInt(user_id), parseInt(kiosk_id)))
            return res.status(403).json({ error: "Access denied" });
        const result = await run(
            `INSERT INTO messages (kiosk_id, message, duration_seconds, created_at, is_displayed) VALUES (?, ?, ?, ?, 0)`,
            [parseInt(kiosk_id), message, parseInt(duration_seconds), new Date().toISOString()]
        );
        res.json({ id: result.lastID });
    } catch (e) { logError(e, req); res.status(500).json({ error: e.message }); }
});

// KIOSK CLIENT POLL
app.get('/api/kiosk-client/:id', async (req, res) => {
    try {
        const kioskId = parseInt(req.params.id);
        const now = new Date().toISOString();
        await run(
            `UPDATE kiosks SET last_seen_time = ?, last_success_time = ?, last_ping_status = 'Online', last_ping_time = ? WHERE id = ?`,
            [now, now, now, kioskId]
        );
        const links = await all('SELECT * FROM kiosk_links WHERE kiosk_id = ?', [kioskId]);
        const message = await get('SELECT * FROM messages WHERE kiosk_id = ? AND is_displayed = 0 LIMIT 1', [kioskId]);
        if (message) await run('UPDATE messages SET is_displayed = 1 WHERE id = ?', [message.id]);
        res.json({ links, message: message || null });
    } catch (e) { logError(e, req); res.status(500).json({ error: e.message }); }
});

// GET KIOSK BY COMPUTER NAME
app.get('/api/kiosk-by-computer-name', async (req, res) => {
    try {
        const computer_name = req.query.computer_name;
        if (!computer_name) return res.status(400).json({ error: "computer_name required" });
        const kiosk = await get('SELECT * FROM kiosks WHERE computer_name = ?', [computer_name]);
        if (!kiosk) return res.status(404).json({ error: "Kiosk not found" });
        res.json(kiosk);
    } catch (e) { logError(e, req); res.status(500).json({ error: e.message }); }
});

// SERVER INFO
app.get('/api/info', (req, res) => {
    const { networkInterfaces } = require('os');
    const nets = networkInterfaces();
    let localIp = '127.0.0.1';
    for (const name of Object.keys(nets))
        for (const net of nets[name])
            if (net.family === 'IPv4' && !net.internal) localIp = net.address;
    res.json({ ip: localIp, port: PORT });
});

// OFFLINE ALERTS
async function sendOfflineAlerts() {
    const cfg = await getConfig();
    const offlineThreshold = cfg.offline_days || 14;
    const now = new Date();
    const todayStr = now.toISOString().split('T')[0];

    const kiosks = await all(`
        SELECT * FROM kiosks
        WHERE is_active = 1 AND alert_offline = 1
        AND manager_email IS NOT NULL AND manager_email != ''
        AND (last_alert_date IS NULL OR last_alert_date != ?)
    `, [todayStr]);

    const kiosksToAlert = kiosks.filter(k => {
        const lastSuccess = k.last_success_time || k.last_ping_time;
        if (!lastSuccess) return true;
        return Math.floor((now - new Date(lastSuccess)) / (1000 * 60 * 60 * 24)) >= offlineThreshold;
    });

    if (kiosksToAlert.length === 0) return;
    if (!cfg.smtp_host || !cfg.smtp_user) {
        logEvent('alerts', 'emails not sent: SMTP not configured');
        return;
    }

    let nodemailer;
    try { nodemailer = require('nodemailer'); } catch (e) {
        logEvent('errors', 'nodemailer not installed — run: npm install nodemailer');
        return;
    }

    const transporter = nodemailer.createTransport({
        host: cfg.smtp_host,
        port: cfg.smtp_port || 587,
        secure: cfg.smtp_secure || false,
        auth: { user: cfg.smtp_user, pass: cfg.smtp_pass }
    });

    for (const k of kiosksToAlert) {
        const lastSuccess = k.last_success_time || k.last_ping_time;
        const offlineSince = lastSuccess
            ? `מאז ${new Date(lastSuccess).toLocaleDateString('he-IL')}`
            : 'מעולם לא היה מחובר';

        transporter.sendMail({
            from: cfg.smtp_user,
            to: k.manager_email,
            subject: `התראה: קיוסק מנותק — ${k.computer_name}`,
            text: `שלום ${k.station_manager || 'אחראי'},\n\nהקיוסק "${k.computer_name}" (IP: ${k.ip}) מנותק כבר יותר מ-${offlineThreshold} ימים.\nסטטוס: ${offlineSince}.\n\nנא לבדוק את התחנה.\n\n— מערכת Kiosk Manager`
        }, async (error) => {
            if (error) {
                logEvent('alerts', `send failed → ${k.manager_email}: ${error.message}`);
            } else {
                await run('UPDATE kiosks SET last_alert_date = ? WHERE id = ?', [todayStr, k.id]);
                logEvent('alerts', `sent → ${k.manager_email} kiosk=${k.computer_name}`);
            }
        });
    }
}

let lastAlertRun = null;
setInterval(() => {
    const d = new Date();
    if (d.getHours() === 8 && d.getMinutes() === 0) {
        const dateStr = d.toISOString().split('T')[0];
        if (lastAlertRun !== dateStr) {
            lastAlertRun = dateStr;
            sendOfflineAlerts().catch(e => logEvent('errors', `sendOfflineAlerts: ${e.message}`));
        }
    }
}, 60 * 1000);

async function migratePasswords() {
    const users = await all('SELECT id, password FROM users');
    for (const u of users) {
        if (!u.password.startsWith('$2')) {
            const hashed = await bcrypt.hash(u.password, SALT_ROUNDS);
            await run('UPDATE users SET password = ? WHERE id = ?', [hashed, u.id]);
        }
    }
}

initDb().then(async () => {
    try { await run("ALTER TABLE kiosk_links ADD COLUMN type TEXT DEFAULT 'url'"); } catch {}
    try { await run("ALTER TABLE kiosks ADD COLUMN last_snapshot_url TEXT"); } catch {}
    try { await run("ALTER TABLE kiosks ADD COLUMN last_snapshot_time TEXT"); } catch {}
    await migratePasswords();
    const server = app.listen(PORT, '0.0.0.0', () => {
        console.log(`Kiosk Server is running on port ${PORT}...`);
    });
    server.on('error', err => {
        if (err.code === 'EADDRINUSE') {
            console.error(`\n==========================================`);
            console.error(`שגיאה: פורט ${PORT} כבר בשימוש.`);
            console.error(`השרת כנראה כבר רץ בחלון אחר.`);
            console.error(`\nכדי לסגור את התהליך ב-Windows:`);
            console.error(`  netstat -ano | findstr :${PORT}`);
            console.error(`  taskkill /PID <PID> /F`);
            console.error(`==========================================\n`);
        } else {
            console.error('Server error:', err.message);
        }
        process.exit(1);
    });
}).catch(err => {
    console.error("Failed to initialize database:", err);
    process.exit(1);
});
