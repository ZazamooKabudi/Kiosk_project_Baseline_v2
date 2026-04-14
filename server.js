const express = require('express');
const ping = require('ping');
const fs = require('fs');
const path = require('path');
const cors = require('cors');

const app = express();
const port = process.env.PORT || 5190;
let db = {
    areas: [],
    kiosks: [],
    kiosk_links: [],
    messages: [],
    users: [],
    user_areas: [],
    config: { offline_days: 14 },
    currentIds: { areas: 1, kiosks: 1, kiosk_links: 1, messages: 1, users: 1 }
};

// Use current directory for portable DB
const dbPath = path.join(process.cwd(), 'kiosk_db.json');

function loadDb() {
    try {
        if (fs.existsSync(dbPath)) {
            const data = fs.readFileSync(dbPath, 'utf8');
            db = Object.assign(db, JSON.parse(data));
        }

        if (!db.users) db.users = [];
        if (!db.user_areas) db.user_areas = [];
        if (!db.currentIds.users) db.currentIds.users = 1;
        if (!db.config) db.config = { offline_days: 14 };

        let hasAdmin = db.users.find(u => u.username === 'nivm');
        if (!hasAdmin) {
            db.users.push({
                id: getNextId('users'),
                username: 'nivm',
                password: 'qw12!@',
                role: 'admin'
            });
            saveDb();
        }
    } catch (e) {
        console.error("Failed to load DB:", e);
    }
}

function saveDb() {
    try {
        fs.writeFileSync(dbPath, JSON.stringify(db, null, 2), 'utf8');
    } catch (e) {
        console.error("Failed to save DB:", e);
    }
}

function getNextId(table) {
    if (!db.currentIds[table]) db.currentIds[table] = 1;
    const id = db.currentIds[table]++;
    saveDb();
    return id;
}

app.use(express.json());
app.use(cors()); // Allow connecting from Electron clients

// Serve public files correctly (kiosk display)
app.use(express.static(path.join(__dirname, 'public')));

loadDb();

async function runPingSweep() {
    let needsSave = false;
    await Promise.all(db.kiosks.map(async (kiosk) => {
        if (kiosk.is_active === 1 && kiosk.ip) {
            let isAlive = { alive: false };
            try {
                isAlive = await ping.promise.probe(kiosk.ip, {
                    timeout: 2,
                    extra: ['-n', '1']
                });
            } catch (e) {
                console.error("Ping error on", kiosk.ip, e);
            }
            let status = isAlive.alive ? 'Online' : 'Offline';
            let time = new Date().toISOString();

            if (isAlive.alive) {
                kiosk.last_success_time = time;
            }

            if (kiosk.last_ping_status !== status || kiosk.last_ping_time !== time) {
                kiosk.last_ping_status = status;
                kiosk.last_ping_time = time;
                needsSave = true;
            }
        }
    }));
    if (needsSave) saveDb();
}

setInterval(runPingSweep, 10 * 60 * 1000);

// CONFIG ROUTES
app.get('/api/config', (req, res) => {
    res.json(db.config);
});

app.post('/api/config', (req, res) => {
    db.config = { ...db.config, ...req.body };
    saveDb();
    res.json({ success: true });
});

app.post('/api/ping-all', async (req, res) => {
    await runPingSweep();
    res.json({ success: true });
});

app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    const user = db.users.find(u => u.username === username && u.password === password);
    if (user) {
        res.json({ id: user.id, username: user.username, role: user.role });
    } else {
        res.status(401).json({ error: "Invalid credentials" });
    }
});

app.get('/api/users', (req, res) => {
    const users = db.users.map(u => ({ id: u.id, username: u.username, role: u.role }));
    res.json({ users, user_areas: db.user_areas });
});

app.post('/api/users', (req, res) => {
    const { username, password, role, areas } = req.body;
    if (db.users.find(u => u.username === username)) {
        return res.status(400).json({ error: "Username exists" });
    }
    const id = getNextId('users');
    db.users.push({ id, username, password, role });

    if (areas && Array.isArray(areas)) {
        areas.forEach(area_id => {
            db.user_areas.push({ user_id: id, area_id: parseInt(area_id) });
        });
    }
    saveDb();
    res.json({ id });
});

app.put('/api/users/:id', (req, res) => {
    const id = parseInt(req.params.id);
    const { password, areas } = req.body;
    const user = db.users.find(u => u.id === id);
    if (user) {
        if (password) user.password = password;
        if (areas !== undefined) {
            db.user_areas = db.user_areas.filter(ua => ua.user_id !== id);
            areas.forEach(area_id => {
                db.user_areas.push({ user_id: id, area_id: parseInt(area_id) });
            });
        }
        saveDb();
        res.json({ success: true });
    } else {
        res.status(404).json({ error: "Not found" });
    }
});

app.delete('/api/users/:id', (req, res) => {
    const id = parseInt(req.params.id);
    db.users = db.users.filter(u => u.id !== id);
    db.user_areas = db.user_areas.filter(ua => ua.user_id !== id);
    saveDb();
    res.json({ success: true });
});

app.get('/api/areas', (req, res) => {
    const user_id = req.query.user_id ? parseInt(req.query.user_id) : null;
    if (!user_id) return res.json(db.areas);

    const user = db.users.find(u => u.id === user_id);
    if (!user) return res.status(401).json({ error: "User not found" });

    if (user.role === 'admin') {
        res.json(db.areas);
    } else {
        const allowedAreas = db.user_areas.filter(ua => ua.user_id === user_id).map(ua => ua.area_id);
        res.json(db.areas.filter(a => allowedAreas.includes(a.id)));
    }
});

app.post('/api/areas', (req, res) => {
    const { name } = req.body;
    const id = getNextId('areas');
    db.areas.push({ id, name });
    saveDb();
    res.json({ id, name });
});

app.delete('/api/areas/:id', (req, res) => {
    const id = parseInt(req.params.id);
    db.areas = db.areas.filter(a => a.id !== id);
    db.kiosks = db.kiosks.filter(k => k.area_id !== id);
    db.user_areas = db.user_areas.filter(ua => ua.area_id !== id);
    saveDb();
    res.json({ success: true });
});

app.get('/api/kiosks', (req, res) => {
    const area_id = req.query.area_id ? parseInt(req.query.area_id) : null;
    let kiosks = db.kiosks;
    if (area_id) kiosks = kiosks.filter(k => k.area_id === area_id);
    res.json(kiosks);
});

app.post('/api/kiosks', (req, res) => {
    const { area_id, ip, computer_name, description, station_manager, manager_email, notes, is_active, alert_offline } = req.body;
    const active = is_active !== undefined ? is_active : 1;
    const alertOff = alert_offline !== undefined ? alert_offline : 0;
    const id = getNextId('kiosks');

    db.kiosks.push({
        id, area_id: parseInt(area_id), ip, computer_name, description,
        station_manager, manager_email, notes, is_active: active, alert_offline: alertOff,
        last_ping_status: null, last_ping_time: null, last_success_time: null
    });
    saveDb();
    res.json({ id });
});

app.put('/api/kiosks/:id', (req, res) => {
    const id = parseInt(req.params.id);
    const { area_id, ip, computer_name, description, station_manager, manager_email, notes, is_active, alert_offline } = req.body;
    const idx = db.kiosks.findIndex(k => k.id === id);

    if (idx !== -1) {
        db.kiosks[idx] = { ...db.kiosks[idx], area_id: parseInt(area_id), ip, computer_name, description, station_manager, manager_email, notes, is_active, alert_offline };
        saveDb();
        res.json({ success: true });
    } else {
        res.status(404).json({ error: "Kiosk not found" });
    }
});

app.delete('/api/kiosks/:id', (req, res) => {
    const id = parseInt(req.params.id);
    db.kiosks = db.kiosks.filter(k => k.id !== id);
    db.kiosk_links = db.kiosk_links.filter(l => l.kiosk_id !== id);
    saveDb();
    res.json({ success: true });
});

app.get('/api/kiosks/:id/links', (req, res) => {
    const id = parseInt(req.params.id);
    res.json(db.kiosk_links.filter(l => l.kiosk_id === id));
});

app.post('/api/kiosks/:id/links', (req, res) => {
    const kiosk_id = parseInt(req.params.id);
    const { url, duration_seconds } = req.body;
    const id = getNextId('kiosk_links');

    db.kiosk_links.push({ id, kiosk_id, url, duration_seconds: parseInt(duration_seconds) });
    saveDb();
    res.json({ id });
});

app.delete('/api/links/:id', (req, res) => {
    const id = parseInt(req.params.id);
    db.kiosk_links = db.kiosk_links.filter(l => l.id !== id);
    saveDb();
    res.json({ success: true });
});

app.post('/api/messages', (req, res) => {
    const { kiosk_id, message, duration_seconds } = req.body;
    const id = getNextId('messages');

    db.messages.push({
        id, kiosk_id: parseInt(kiosk_id), message, duration_seconds: parseInt(duration_seconds),
        created_at: new Date().toISOString(), is_displayed: 0
    });
    saveDb();
    res.json({ id });
});

app.get('/api/kiosk-client/:id', (req, res) => {
    const kioskId = parseInt(req.params.id);
    const links = db.kiosk_links.filter(l => l.kiosk_id === kioskId);

    // Auto-mark kiosk as Online when it polls
    const kiosk = db.kiosks.find(k => k.id === kioskId);
    if (kiosk) {
        const now = new Date().toISOString();
        kiosk.last_seen_time = now;
        kiosk.last_success_time = now;
        kiosk.last_ping_status = 'Online';
        kiosk.last_ping_time = now;
    }

    const message = db.messages.find(m => m.kiosk_id === kioskId && m.is_displayed === 0);
    if (message) message.is_displayed = 1;

    if (kiosk || message) saveDb();
    res.json({ links, message: message || null });
});

app.get('/api/info', (req, res) => {
    const { networkInterfaces } = require('os');
    const nets = networkInterfaces();
    let localIp = '127.0.0.1';
    for (const name of Object.keys(nets)) {
        for (const net of nets[name]) {
            if (net.family === 'IPv4' && !net.internal) {
                localIp = net.address;
            }
        }
    }
    res.json({ ip: localIp, port });
});

// ─────────────────────────────────────────────
// OFFLINE ALERTS (Mailer & Cron)
// ─────────────────────────────────────────────

function sendOfflineAlerts() {
    const offlineThreshold = db.config.offline_days || 14;
    const now = new Date();
    const todayStr = now.toISOString().split('T')[0]; // "YYYY-MM-DD"

    // Filter kiosks that: are active, have alert enabled, have email,
    // are offline long enough, AND have NOT already been alerted today.
    const kiosksToAlert = db.kiosks.filter(k => {
        if (!k.is_active || !k.alert_offline || !k.manager_email) return false;

        // Skip if already sent alert today for this kiosk
        if (k.last_alert_date === todayStr) return false;

        const lastSuccess = k.last_success_time || k.last_ping_time;
        if (!lastSuccess) return true; // Never been online → alert
        const diffDays = Math.floor((now - new Date(lastSuccess)) / (1000 * 60 * 60 * 24));
        return diffDays >= offlineThreshold;
    });

    if (kiosksToAlert.length === 0) return;

    if (!db.config.smtp_host || !db.config.smtp_user) {
        console.warn("Emails not sent: SMTP is not configured in settings.");
        return;
    }

    let nodemailer;
    try {
        nodemailer = require('nodemailer');
    } catch (e) {
        console.error("Nodemailer is not installed. Please run 'npm install nodemailer'.");
        return;
    }

    const transporter = nodemailer.createTransport({
        host: db.config.smtp_host,
        port: db.config.smtp_port || 587,
        secure: db.config.smtp_secure || false,
        auth: {
            user: db.config.smtp_user,
            pass: db.config.smtp_pass
        }
    });

    kiosksToAlert.forEach(k => {
        const lastSuccess = k.last_success_time || k.last_ping_time;
        const offlineSince = lastSuccess
            ? `מאז ${new Date(lastSuccess).toLocaleDateString('he-IL')}`
            : 'מעולם לא היה מחובר';

        const mailOptions = {
            from: db.config.smtp_user,
            to: k.manager_email,
            subject: `התראה: קיוסק מנותק — ${k.computer_name}`,
            text: `שלום ${k.station_manager || 'אחראי'},\n\nהקיוסק "${k.computer_name}" (IP: ${k.ip}) מנותק כבר יותר מ-${offlineThreshold} ימים.\nסטטוס: ${offlineSince}.\n\nנא לבדוק את התחנה.\n\n— מערכת Kiosk Manager`
        };

        transporter.sendMail(mailOptions, (error) => {
            if (error) {
                console.error(`[Alert] שגיאה בשליחה אל ${k.manager_email}:`, error.message);
            } else {
                // Mark this kiosk as alerted today — prevents duplicate sends
                k.last_alert_date = todayStr;
                saveDb();
                console.log(`[Alert] נשלחה התראה אל ${k.manager_email} עבור קיוסק ${k.computer_name}`);
            }
        });
    });
}

// Run check every minute — triggers daily at 08:00 AM.
let lastAlertRun = null;
setInterval(() => {
    const d = new Date();
    if (d.getHours() === 8 && d.getMinutes() === 0) {
        const dateStr = d.toISOString().split('T')[0];
        if (lastAlertRun !== dateStr) {
            lastAlertRun = dateStr;
            sendOfflineAlerts();
        }
    }
}, 60 * 1000);

app.listen(port, '0.0.0.0', () => {
    console.log(`Kiosk Server is running on port ${port}...`);
});
