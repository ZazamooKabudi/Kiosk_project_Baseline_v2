// ================================================================
// KIOSK MANAGER — Frontend Application
// ================================================================

// ── API CLIENT ──────────────────────────────────────────────────
const api = {
  async req(url, opts = {}) {
    const cfg = {
      headers: { 'Content-Type': 'application/json' },
      method: opts.method || 'GET'
    };
    if (opts.body !== undefined) cfg.body = JSON.stringify(opts.body);
    const res = await fetch(url, cfg);
    if (!res.ok) {
      let msg = res.statusText;
      try { const d = await res.json(); msg = d.error || msg; } catch {}
      throw new Error(msg);
    }
    return res.json();
  },
  get:  url        => api.req(url),
  post: (url, body) => api.req(url, { method: 'POST',   body }),
  put:  (url, body) => api.req(url, { method: 'PUT',    body }),
  del:  url        => api.req(url, { method: 'DELETE' })
};

// ── STATE ────────────────────────────────────────────────────────
const S = {
  user: null, areas: [], kiosks: [], users: [], userAreas: [],
  config: {}, serverInfo: {}, selectedKiosk: null, currentSection: 'dashboard'
};

// ── UTILS ────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const h = s => String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');

function timeAgo(iso) {
  if (!iso) return '—';
  try {
    const m = Math.floor((Date.now() - new Date(iso)) / 60000);
    if (m < 1)    return 'לפני רגע';
    if (m < 60)   return `לפני ${m} דק'`;
    if (m < 1440) return `לפני ${Math.floor(m/60)} שע'`;
    return `לפני ${Math.floor(m/1440)} ימים`;
  } catch { return iso; }
}

// ── TOAST ────────────────────────────────────────────────────────
function toast(msg, type = 'success') {
  const icons = { success: '✓', error: '✕', info: 'ℹ' };
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.innerHTML = `<span class="toast-icon">${icons[type]||'●'}</span><span>${h(msg)}</span>`;
  $('toastContainer').appendChild(el);
  setTimeout(() => {
    el.style.opacity = '0'; el.style.transform = 'translateX(-10px)';
    el.style.transition = 'all 0.3s ease';
    setTimeout(() => el.remove(), 300);
  }, 3200);
}

// ── CONFIRM ──────────────────────────────────────────────────────
let _cb = null;
function confirm2(text, cb) {
  $('confirmText').textContent = text;
  _cb = cb;
  openModal('confirmModal');
}

// ── MODALS ───────────────────────────────────────────────────────
function openModal(id)  { $(id).style.display = 'flex'; }
function closeModal(id) { $(id).style.display = 'none'; }

// ── INIT ─────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {

  // Confirm ok
  $('confirmOkBtn').onclick = () => { closeModal('confirmModal'); _cb && _cb(); _cb = null; };

  // Close modals on backdrop click
  document.querySelectorAll('.modal-overlay').forEach(o =>
    o.addEventListener('click', e => { if (e.target === o) o.style.display = 'none'; })
  );

  // Close modals on ESC
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape')
      document.querySelectorAll('.modal-overlay').forEach(o => o.style.display = 'none');
  });

  // ── AUTH ─────────────────────────────────────────────────────
  $('loginForm').addEventListener('submit', async e => {
    e.preventDefault();
    const btn = $('loginBtn'), err = $('loginError');
    err.style.display = 'none';
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span>';
    try {
      const user = await api.post('/api/login', {
        username: $('loginUsername').value.trim(),
        password: $('loginPassword').value
      });
      S.user = user;
      $('loginScreen').style.display = 'none';
      $('app').style.display = 'flex';
      $('userAvatar').textContent = user.username[0].toUpperCase();
      $('sidebarUserName').textContent = user.username;
      $('sidebarUserRole').textContent = user.role === 'admin' ? 'מנהל' : 'משתמש';
      document.querySelectorAll('.admin-only').forEach(el =>
        el.style.display = user.role === 'admin' ? '' : 'none'
      );
      await loadAll();
      goto('dashboard');
    } catch {
      err.textContent = 'שם משתמש או סיסמה שגויים';
      err.style.display = 'block';
    } finally {
      btn.disabled = false;
      btn.innerHTML = 'כניסה למערכת';
    }
  });

  $('logoutBtn').onclick = () => {
    S.user = null; S.selectedKiosk = null;
    $('app').style.display = 'none';
    $('loginScreen').style.display = 'flex';
    $('loginUsername').value = '';
    $('loginPassword').value = '';
  };

  // ── NAV ───────────────────────────────────────────────────────
  document.querySelectorAll('.nav-item').forEach(el =>
    el.addEventListener('click', e => { e.preventDefault(); goto(el.dataset.section); })
  );

  // ── KIOSK FILTER/SEARCH ───────────────────────────────────────
  $('kioskAreaFilter').addEventListener('change', renderKiosks);
  $('kioskSearch').addEventListener('input', renderKiosks);

  // ── PING ─────────────────────────────────────────────────────
  $('pingAllBtn').onclick = pingAll;
  $('pingAllSettings').onclick = pingAll;

  // ── AREA ─────────────────────────────────────────────────────
  $('saveAreaBtn').onclick = saveArea;
  $('areaName').addEventListener('keydown', e => { if (e.key === 'Enter') saveArea(); });

  // ── KIOSK ────────────────────────────────────────────────────
  $('saveKioskBtn').onclick = saveKiosk;

  // ── CONTENT ──────────────────────────────────────────────────
  $('addLinkBtn').onclick = addLink;
  $('newLinkUrl').addEventListener('keydown', e => { if (e.key === 'Enter') addLink(); });

  // ── MESSAGE ──────────────────────────────────────────────────
  $('sendMsgBtn').onclick = sendMessage;

  // ── USER ─────────────────────────────────────────────────────
  $('saveUserBtn').onclick = saveUser;

  // ── SETTINGS ─────────────────────────────────────────────────
  $('saveSmtpBtn').onclick = saveSmtp;
  $('saveAlertsBtn').onclick = saveAlerts;

  // ── AUTO REFRESH ─────────────────────────────────────────────
  setInterval(async () => {
    if (!S.user) return;
    await loadKiosks();
    if (S.currentSection === 'dashboard') renderDashboard();
    if (S.currentSection === 'kiosks') renderKiosks();
  }, 60000);
});

// ── DATA ─────────────────────────────────────────────────────────
async function loadAll() {
  await Promise.all([loadAreas(), loadKiosks()]);
  if (S.user.role === 'admin') {
    await Promise.all([loadUsers(), loadConfig(), loadServerInfo()]);
  }
}

async function loadAreas() {
  S.areas = await api.get(`/api/areas?user_id=${S.user.id}`);
  ['kioskAreaFilter','kioskAreaId'].forEach(id => {
    const el = $(id);
    const first = el.firstElementChild ? el.firstElementChild.cloneNode(true) : null;
    el.innerHTML = '';
    if (first) el.appendChild(first);
    S.areas.forEach(a => {
      const o = document.createElement('option');
      o.value = a.id; o.textContent = a.name;
      el.appendChild(o);
    });
  });
}

async function loadKiosks() {
  S.kiosks = await api.get('/api/kiosks');
}

async function loadUsers() {
  const d = await api.get('/api/users');
  S.users = d.users; S.userAreas = d.user_areas;
}

async function loadConfig() {
  S.config = await api.get('/api/config') || {};
}

async function loadServerInfo() {
  try { S.serverInfo = await api.get('/api/info'); } catch {}
}

// ── NAVIGATION ───────────────────────────────────────────────────
const TITLES = {
  dashboard: 'לוח בקרה', kiosks: 'ניהול קיוסקים', areas: 'ניהול אזורים',
  content: 'ניהול תוכן', messages: 'הודעות', users: 'ניהול משתמשים', settings: 'הגדרות'
};

function goto(section) {
  S.currentSection = section;
  document.querySelectorAll('.nav-item').forEach(el =>
    el.classList.toggle('active', el.dataset.section === section)
  );
  document.querySelectorAll('.section').forEach(el => el.classList.remove('active'));
  const sec = document.getElementById('section-' + section);
  if (sec) sec.classList.add('active');
  $('topbarTitle').textContent = TITLES[section] || '';

  const acts = $('topbarActions');
  acts.innerHTML = '';
  if (section === 'kiosks')  acts.innerHTML = '<button class="btn btn-primary btn-sm" onclick="openAddKiosk()">+ הוסף קיוסק</button>';
  if (section === 'areas')   acts.innerHTML = '<button class="btn btn-primary btn-sm" onclick="openAddArea()">+ הוסף אזור</button>';
  if (section === 'users')   acts.innerHTML = '<button class="btn btn-primary btn-sm" onclick="openAddUser()">+ הוסף משתמש</button>';

  switch (section) {
    case 'dashboard': renderDashboard(); break;
    case 'kiosks':    renderKiosks();    break;
    case 'areas':     renderAreas();     break;
    case 'content':   renderContent();   break;
    case 'messages':  renderMessages();  break;
    case 'users':     renderUsers();     break;
    case 'settings':  renderSettings();  break;
  }
}

// ── DASHBOARD ────────────────────────────────────────────────────
function renderDashboard() {
  const online  = S.kiosks.filter(k => k.last_ping_status === 'Online').length;
  const offline = S.kiosks.filter(k => k.last_ping_status === 'Offline').length;
  $('stat-total').textContent   = S.kiosks.length;
  $('stat-online').textContent  = online;
  $('stat-offline').textContent = offline;
  $('stat-areas').textContent   = S.areas.length;

  const grid = $('kioskStatusGrid');
  if (!S.kiosks.length) {
    grid.innerHTML = '<div class="loading-placeholder">אין קיוסקים רשומים — הוסף קיוסק ראשון</div>';
    return;
  }
  grid.innerHTML = S.kiosks.map(k => {
    const st = k.last_ping_status;
    const cls    = st === 'Online' ? 'online' : st === 'Offline' ? 'offline' : '';
    const dotCls = st === 'Online' ? 'dot-green' : st === 'Offline' ? 'dot-red' : 'dot-gray';
    const stTxt  = st === 'Online' ? 'מחובר' : st === 'Offline' ? 'מנותק' : 'לא ידוע';
    const area   = S.areas.find(a => a.id === k.area_id);
    const kioskUrl = S.serverInfo.ip
      ? `http://${S.serverInfo.ip}:${S.serverInfo.port||3000}/kiosk.html?id=${k.id}`
      : '';
    return `<div class="ks-card ${cls}">
      <div class="ks-name">${h(k.computer_name || k.description || 'קיוסק')}</div>
      <div class="ks-ip">${h(k.ip || '')}</div>
      <div class="ks-status"><span class="dot ${dotCls}"></span>${stTxt}</div>
      ${area ? `<div style="font-size:10px;color:var(--tm);margin-top:4px">${h(area.name)}</div>` : ''}
      ${kioskUrl ? `<button class="ks-copy" onclick="copyText('${kioskUrl}')">📋 העתק קישור לקיוסק</button>` : ''}
    </div>`;
  }).join('');
}

async function pingAll() {
  const btns = [$('pingAllBtn'), $('pingAllSettings')].filter(Boolean);
  const originals = btns.map(b => b.innerHTML);
  btns.forEach(b => { b.disabled = true; b.innerHTML = '<span class="spinner"></span>'; });
  try {
    await api.post('/api/ping-all', {});
    toast('בדיקת קישוריות הושלמה');
    await loadKiosks();
    if (S.currentSection === 'dashboard') renderDashboard();
    if (S.currentSection === 'kiosks')    renderKiosks();
  } catch { toast('שגיאה בבדיקת קישוריות', 'error'); }
  finally  { btns.forEach((b, i) => { b.disabled = false; b.innerHTML = originals[i]; }); }
}

// ── KIOSKS ───────────────────────────────────────────────────────
function renderKiosks() {
  const areaId = $('kioskAreaFilter').value;
  const q = ($('kioskSearch').value || '').toLowerCase();
  let rows = S.kiosks;
  if (areaId) rows = rows.filter(k => k.area_id === parseInt(areaId));
  if (q) rows = rows.filter(k =>
    [k.computer_name, k.description, k.ip, k.station_manager].some(v => (v||'').toLowerCase().includes(q))
  );

  const tbody = $('kioskTableBody');
  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="8" class="empty-td">לא נמצאו קיוסקים</td></tr>';
    return;
  }
  tbody.innerHTML = rows.map(k => {
    const st     = k.last_ping_status;
    const bCls   = st === 'Online' ? 'badge-green' : st === 'Offline' ? 'badge-red' : 'badge-gray';
    const dotCls = st === 'Online' ? 'dot-green'   : st === 'Offline' ? 'dot-red'   : 'dot-gray';
    const stTxt  = st === 'Online' ? 'מחובר'       : st === 'Offline' ? 'מנותק'     : 'לא ידוע';
    const area   = S.areas.find(a => a.id === k.area_id);
    return `<tr>
      <td><span class="badge ${bCls}"><span class="dot ${dotCls}" style="width:6px;height:6px"></span>${stTxt}</span></td>
      <td style="font-weight:600;color:var(--t)">${h(k.computer_name||'—')}</td>
      <td>${h(k.description||'—')}</td>
      <td dir="ltr" style="text-align:right;font-family:monospace;font-size:12px;color:var(--tm)">${h(k.ip||'—')}</td>
      <td>${area ? h(area.name) : '—'}</td>
      <td>${h(k.station_manager||'—')}</td>
      <td style="font-size:11px;color:var(--tm)">${timeAgo(k.last_ping_time)}</td>
      <td><div class="act-cell">
        <button class="icon-btn" title="ניהול תוכן" onclick="gotoContent(${k.id})">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" width="13" height="13"><rect x="1" y="2" width="14" height="12" rx="1.5"/><path d="M4 6h8M4 8.5h5M4 11h6"/></svg>
        </button>
        <button class="icon-btn" title="ערוך" onclick="openEditKiosk(${k.id})">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" width="13" height="13"><path d="M11 2l3 3-8 8H3v-3l8-8z"/></svg>
        </button>
        <button class="icon-btn del" title="מחק" onclick="deleteKiosk(${k.id})">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" width="13" height="13"><path d="M2 4h12M5 4V2h6v2M6 7v5M10 7v5M3 4l1 10h8l1-10"/></svg>
        </button>
      </div></td>
    </tr>`;
  }).join('');
}

function openAddKiosk() {
  $('kioskModalTitle').textContent = 'הוסף קיוסק';
  $('kioskId').value = '';
  ['kioskComputerName','kioskIp','kioskDescription','kioskManager','kioskNotes'].forEach(id => $(id).value = '');
  $('kioskAreaId').value = '';
  $('kioskActive').checked = true;
  openModal('kioskModal');
  setTimeout(() => $('kioskComputerName').focus(), 100);
}

function openEditKiosk(id) {
  const k = S.kiosks.find(k => k.id === id); if (!k) return;
  $('kioskModalTitle').textContent = 'ערוך קיוסק';
  $('kioskId').value             = k.id;
  $('kioskComputerName').value   = k.computer_name     || '';
  $('kioskIp').value             = k.ip                || '';
  $('kioskDescription').value    = k.description       || '';
  $('kioskAreaId').value         = k.area_id           || '';
  $('kioskManager').value        = k.station_manager   || '';
  $('kioskNotes').value          = k.notes             || '';
  $('kioskActive').checked       = k.is_active === 1 || k.is_active === true;
  openModal('kioskModal');
}

async function saveKiosk() {
  const id   = $('kioskId').value;
  const data = {
    computer_name:    $('kioskComputerName').value.trim(),
    ip:               $('kioskIp').value.trim(),
    description:      $('kioskDescription').value.trim(),
    area_id:          $('kioskAreaId').value,
    station_manager:  $('kioskManager').value.trim(),
    notes:            $('kioskNotes').value.trim(),
    is_active:        $('kioskActive').checked ? 1 : 0
  };
  if (!data.computer_name || !data.ip || !data.area_id) {
    toast('נא למלא שם מחשב, IP ואזור', 'error'); return;
  }
  const btn = $('saveKioskBtn'); btn.disabled = true;
  try {
    if (id) { await api.put(`/api/kiosks/${id}`, data); toast('הקיוסק עודכן'); }
    else     { await api.post('/api/kiosks', data);     toast('הקיוסק נוסף'); }
    closeModal('kioskModal');
    await loadKiosks(); await loadAreas();
    renderKiosks();
    if (S.currentSection === 'dashboard') renderDashboard();
  } catch (e) { toast(e.message || 'שגיאה בשמירה', 'error'); }
  finally     { btn.disabled = false; }
}

function deleteKiosk(id) {
  const k = S.kiosks.find(k => k.id === id); if (!k) return;
  confirm2(`למחוק את הקיוסק "${k.computer_name || k.description}"?`, async () => {
    try {
      await api.del(`/api/kiosks/${id}`);
      toast('הקיוסק נמחק');
      await loadKiosks();
      renderKiosks();
      if (S.currentSection === 'dashboard') renderDashboard();
    } catch { toast('שגיאה במחיקה', 'error'); }
  });
}

// ── AREAS ────────────────────────────────────────────────────────
function renderAreas() {
  const cards = S.areas.map(a => {
    const cnt = S.kiosks.filter(k => k.area_id === a.id).length;
    return `<div class="area-card">
      <div class="area-card-top">
        <div class="area-icon-wrap">
          <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" width="18" height="18"><path d="M10 2l8 4v8l-8 4-8-4V6l8-4z"/></svg>
        </div>
        <button class="icon-btn del" onclick="deleteArea(${a.id})" title="מחק">✕</button>
      </div>
      <div class="area-name">${h(a.name)}</div>
      <div class="area-count">${cnt} קיוסקים</div>
    </div>`;
  }).join('');
  $('areasGrid').innerHTML = cards + `<div class="area-add" onclick="openAddArea()"><div class="area-add-icon">+</div><span>הוסף אזור</span></div>`;
}

function openAddArea() {
  $('areaName').value = '';
  openModal('areaModal');
  setTimeout(() => $('areaName').focus(), 100);
}

async function saveArea() {
  const name = $('areaName').value.trim();
  if (!name) { toast('נא להכניס שם אזור', 'error'); return; }
  const btn = $('saveAreaBtn'); btn.disabled = true;
  try {
    await api.post('/api/areas', { name });
    toast('האזור נוסף');
    closeModal('areaModal');
    await loadAreas();
    renderAreas();
  } catch { toast('שגיאה', 'error'); }
  finally   { btn.disabled = false; }
}

function deleteArea(id) {
  const a = S.areas.find(a => a.id === id); if (!a) return;
  confirm2(`למחוק את האזור "${a.name}"?\nכל הקיוסקים באזור יימחקו!`, async () => {
    try {
      await api.del(`/api/areas/${id}`);
      toast('האזור נמחק');
      await Promise.all([loadAreas(), loadKiosks()]);
      renderAreas();
      if (S.currentSection === 'dashboard') renderDashboard();
    } catch { toast('שגיאה במחיקה', 'error'); }
  });
}

// ── CONTENT ──────────────────────────────────────────────────────
function renderContent() {
  const list = $('contentKioskList');
  if (!S.kiosks.length) {
    list.innerHTML = '<div class="loading-placeholder">אין קיוסקים</div>';
    return;
  }
  list.innerHTML = S.kiosks.map(k => {
    const st     = k.last_ping_status;
    const dotCls = st === 'Online' ? 'dot-green' : st === 'Offline' ? 'dot-red' : 'dot-gray';
    const sel    = S.selectedKiosk === k.id ? 'sel' : '';
    return `<div class="kiosk-pick-item ${sel}" onclick="selectKiosk(${k.id})">
      <span class="dot ${dotCls}"></span>
      <span>${h(k.computer_name || k.description || 'קיוסק')}</span>
    </div>`;
  }).join('');
}

async function selectKiosk(id) {
  S.selectedKiosk = id;
  const k = S.kiosks.find(k => k.id === id); if (!k) return;
  renderContent();
  $('contentEmpty').style.display = 'none';
  const lp = $('linksPanel');
  lp.style.display = 'flex';
  lp.style.flexDirection = 'column';
  $('linksPanelTitle').textContent = `קישורים — ${k.computer_name || k.description}`;
  await renderLinks(id);
}

function gotoContent(id) {
  goto('content');
  setTimeout(() => selectKiosk(id), 80);
}

async function renderLinks(kioskId) {
  const list = $('linksList');
  list.innerHTML = '<div class="loading-placeholder">טוען...</div>';
  try {
    const links = await api.get(`/api/kiosks/${kioskId}/links`);
    if (!links.length) {
      list.innerHTML = '<div class="loading-placeholder">אין קישורים — הוסף קישור ראשון</div>';
      return;
    }
    list.innerHTML = links.map(l => `<div class="link-row">
      <div style="min-width:0">
        <div class="link-url" title="${h(l.url)}">${h(l.url)}</div>
        <div class="link-dur">${l.duration_seconds} שניות הצגה</div>
      </div>
      <button class="icon-btn del" onclick="deleteLink(${l.id},${kioskId})" title="מחק">
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" width="12" height="12"><path d="M2 4h12M5 4V2h6v2M6 7v5M10 7v5M3 4l1 10h8l1-10"/></svg>
      </button>
    </div>`).join('');
  } catch { list.innerHTML = '<div class="loading-placeholder">שגיאה בטעינה</div>'; }
}

async function addLink() {
  const url = $('newLinkUrl').value.trim();
  const dur = parseInt($('newLinkDuration').value) || 30;
  if (!url || !S.selectedKiosk) { toast('נא להכניס URL', 'error'); return; }
  const btn = $('addLinkBtn'); btn.disabled = true;
  try {
    await api.post(`/api/kiosks/${S.selectedKiosk}/links`, { url, duration_seconds: dur });
    $('newLinkUrl').value = '';
    toast('הקישור נוסף');
    await renderLinks(S.selectedKiosk);
  } catch { toast('שגיאה', 'error'); }
  finally   { btn.disabled = false; }
}

async function deleteLink(linkId, kioskId) {
  try {
    await api.del(`/api/links/${linkId}`);
    toast('הקישור נמחק');
    await renderLinks(kioskId);
  } catch { toast('שגיאה', 'error'); }
}

// ── MESSAGES ─────────────────────────────────────────────────────
function renderMessages() {
  const sel = $('msgKioskSelect');
  sel.innerHTML = '<option value="">בחר קיוסק...</option>';
  S.kiosks.forEach(k => {
    const o = document.createElement('option');
    o.value = k.id;
    o.textContent = k.computer_name || k.description || `קיוסק ${k.id}`;
    sel.appendChild(o);
  });
}

async function sendMessage() {
  const kioskId = $('msgKioskSelect').value;
  const message = $('msgText').value.trim();
  const dur     = parseInt($('msgDuration').value) || 30;
  if (!kioskId || !message) { toast('נא לבחור קיוסק ולהכניס הודעה', 'error'); return; }
  const btn = $('sendMsgBtn');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> שולח...';
  try {
    await api.post('/api/messages', { kiosk_id: kioskId, message, duration_seconds: dur });
    $('msgText').value = '';
    toast('ההודעה נשלחה בהצלחה');
  } catch { toast('שגיאה בשליחה', 'error'); }
  finally   { btn.disabled = false; btn.innerHTML = 'שלח הודעה'; }
}

// ── USERS ────────────────────────────────────────────────────────
function renderUsers() {
  const tbody = $('usersTableBody');
  if (!S.users.length) {
    tbody.innerHTML = '<tr><td colspan="4" class="empty-td">אין משתמשים</td></tr>';
    return;
  }
  tbody.innerHTML = S.users.map(u => {
    const uaIds    = S.userAreas.filter(x => x.user_id === u.id).map(x => x.area_id);
    const areaNms  = S.areas.filter(a => uaIds.includes(a.id)).map(a => a.name);
    const isMe     = u.id === S.user.id;
    return `<tr>
      <td style="font-weight:600;color:var(--t)">${h(u.username)}</td>
      <td><span class="badge ${u.role==='admin'?'badge-purple':'badge-gray'}">${u.role==='admin'?'מנהל':'משתמש'}</span></td>
      <td style="font-size:12px">
        ${u.role==='admin'
          ? '<span style="color:var(--tm)">כל האזורים</span>'
          : (areaNms.length
              ? areaNms.map(n=>`<span class="badge badge-blue" style="margin-inline-end:4px">${h(n)}</span>`).join('')
              : '—')}
      </td>
      <td><div class="act-cell">
        <button class="icon-btn" onclick="openEditUser(${u.id})" title="ערוך">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" width="12" height="12"><path d="M11 2l3 3-8 8H3v-3l8-8z"/></svg>
        </button>
        ${!isMe ? `<button class="icon-btn del" onclick="deleteUser(${u.id})" title="מחק">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" width="12" height="12"><path d="M2 4h12M5 4V2h6v2M6 7v5M10 7v5M3 4l1 10h8l1-10"/></svg>
        </button>` : ''}
      </div></td>
    </tr>`;
  }).join('');
}

function openAddUser() {
  $('userModalTitle').textContent = 'הוסף משתמש';
  $('userId').value = ''; $('userNameInput').value = '';
  $('userPasswordInput').value = ''; $('userRoleInput').value = 'user';
  $('userNameInput').disabled = false;
  buildAreaChecks([]); openModal('userModal');
  setTimeout(() => $('userNameInput').focus(), 100);
}

function openEditUser(id) {
  const u = S.users.find(u => u.id === id); if (!u) return;
  $('userModalTitle').textContent = 'ערוך משתמש';
  $('userId').value = u.id; $('userNameInput').value = u.username;
  $('userPasswordInput').value = ''; $('userRoleInput').value = u.role;
  $('userNameInput').disabled = true;
  buildAreaChecks(S.userAreas.filter(x => x.user_id === id).map(x => x.area_id));
  openModal('userModal');
}

function buildAreaChecks(sel) {
  const c = $('userAreasChecks');
  if (!S.areas.length) {
    c.innerHTML = '<span style="font-size:12px;color:var(--tm)">אין אזורים</span>';
    return;
  }
  c.innerHTML = S.areas.map(a =>
    `<label class="check-label"><input type="checkbox" name="ua" value="${a.id}" ${sel.includes(a.id)?'checked':''}><span>${h(a.name)}</span></label>`
  ).join('');
}

async function saveUser() {
  const id       = $('userId').value;
  const username = $('userNameInput').value.trim();
  const password = $('userPasswordInput').value;
  const role     = $('userRoleInput').value;
  const areas    = [...document.querySelectorAll('input[name="ua"]:checked')].map(el => el.value);
  if (!id && (!username || !password)) { toast('נא למלא שם משתמש וסיסמה', 'error'); return; }
  const btn = $('saveUserBtn'); btn.disabled = true;
  try {
    if (id) { await api.put(`/api/users/${id}`, { password: password||undefined, areas }); toast('המשתמש עודכן'); }
    else    { await api.post('/api/users', { username, password, role, areas });            toast('המשתמש נוסף'); }
    closeModal('userModal');
    await loadUsers();
    renderUsers();
  } catch (e) { toast(e.message || 'שגיאה', 'error'); }
  finally     { btn.disabled = false; }
}

function deleteUser(id) {
  const u = S.users.find(u => u.id === id); if (!u) return;
  confirm2(`למחוק את המשתמש "${u.username}"?`, async () => {
    try {
      await api.del(`/api/users/${id}`);
      toast('המשתמש נמחק');
      await loadUsers(); renderUsers();
    } catch { toast('שגיאה', 'error'); }
  });
}

// ── SETTINGS ────────────────────────────────────────────────────
function renderSettings() {
  const c = S.config || {};
  $('smtpHost').value     = c.smtp_host  || '';
  $('smtpPort').value     = c.smtp_port  || 587;
  $('smtpSecure').checked = !!c.smtp_secure;
  $('smtpUser').value     = c.smtp_user  || '';
  $('smtpPass').value     = c.smtp_pass  || '';
  $('offlineDays').value  = c.offline_days || 14;

  if (S.serverInfo.ip) {
    $('serverIp').textContent = `${S.serverInfo.ip}:${S.serverInfo.port||3000}`;
    $('kioskUrlTemplate').value = `http://${S.serverInfo.ip}:${S.serverInfo.port||3000}/kiosk.html?id=<ID>`;
  }
}

async function saveSmtp() {
  const btn = $('saveSmtpBtn'); btn.disabled = true;
  try {
    await api.post('/api/config', {
      smtp_host: $('smtpHost').value, smtp_port: +$('smtpPort').value,
      smtp_secure: $('smtpSecure').checked,
      smtp_user: $('smtpUser').value, smtp_pass: $('smtpPass').value
    });
    toast('הגדרות SMTP נשמרו');
    await loadConfig();
  } catch { toast('שגיאה', 'error'); }
  finally   { btn.disabled = false; }
}

async function saveAlerts() {
  const btn = $('saveAlertsBtn'); btn.disabled = true;
  try {
    await api.post('/api/config', { offline_days: +$('offlineDays').value });
    toast('הגדרות נשמרו');
    await loadConfig();
  } catch { toast('שגיאה', 'error'); }
  finally   { btn.disabled = false; }
}

// ── HELPERS ──────────────────────────────────────────────────────
function copyText(text) {
  navigator.clipboard.writeText(text).then(
    () => toast('הועתק ללוח'),
    () => { prompt('העתק את הקישור:', text); }
  );
}

function copyKioskUrl() {
  const val = $('kioskUrlTemplate').value;
  if (val) copyText(val);
}
