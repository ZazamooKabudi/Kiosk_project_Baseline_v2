// Kiosk Display Logic
const kioskId = new URLSearchParams(window.location.search).get('id');
const iframe = document.getElementById('kiosk-iframe');
const kioskImg = document.getElementById('kiosk-img');
const noContent = document.getElementById('no-content');
const msgOverlay = document.getElementById('msg-overlay');
const msgText = document.getElementById('msg-text');
const msgTimer = document.getElementById('msg-timer');
const progressFill = document.getElementById('progress-fill');

let links = [];
let currentIdx = -1;
let linkTimer = null;
let msgTimerInterval = null;
let isMsg = false;
let progressAnim = null;

if (!kioskId) {
  noContent.classList.add('show');
  noContent.querySelector('.no-content-text').textContent = 'שגיאה: לא צוין מזהה קיוסק (ID)';
} else {
  tryFullscreen();
  initKiosk();
}

async function tryFullscreen() {
  try {
    const el = document.documentElement;
    if (el.requestFullscreen) await el.requestFullscreen();
    else if (el.webkitRequestFullScreen) await el.webkitRequestFullScreen();
  } catch {}
}

async function fetchState() {
  try {
    const res = await fetch(`/api/kiosk-client/${kioskId}`);
    const data = await res.json();

    const newStr = JSON.stringify(data.links);
    if (newStr !== JSON.stringify(links)) {
      links = data.links;
      if (!isMsg) playNext();
    }

    if (data.message && !isMsg) showMessage(data.message);
  } catch (e) {
    console.warn('Fetch error:', e);
  }
}

function showMessage(msg) {
  isMsg = true;
  clearTimeout(linkTimer);
  linkTimer = null;
  stopProgress();

  msgText.textContent = msg.message;
  msgOverlay.classList.add('show');

  let remaining = msg.duration_seconds;
  msgTimer.textContent = `נסגר בעוד ${remaining} שניות`;
  msgTimerInterval = setInterval(() => {
    remaining--;
    msgTimer.textContent = remaining > 0 ? `נסגר בעוד ${remaining} שניות` : '';
  }, 1000);

  setTimeout(() => {
    clearInterval(msgTimerInterval);
    msgOverlay.classList.remove('show');
    isMsg = false;
    playNext();
  }, msg.duration_seconds * 1000);
}

function playNext() {
  clearTimeout(linkTimer);
  linkTimer = null;
  stopProgress();

  if (!links.length) {
    iframe.style.display = 'none';
    kioskImg.style.display = 'none';
    noContent.classList.add('show');
    return;
  }

  noContent.classList.remove('show');

  currentIdx = (currentIdx + 1) % links.length;
  const link = links[currentIdx];

  if (link.type === 'image') {
    iframe.style.display = 'none';
    kioskImg.style.display = 'block';
    kioskImg.src = link.url;
  } else {
    kioskImg.style.display = 'none';
    iframe.style.display = 'block';
    iframe.src = link.url;
  }

  startProgress(link.duration_seconds);

  linkTimer = setTimeout(() => {
    if (!isMsg) playNext();
  }, link.duration_seconds * 1000);
}

function startProgress(seconds) {
  progressFill.style.transition = 'none';
  progressFill.style.width = '100%';
  requestAnimationFrame(() => {
    progressFill.style.transition = `width ${seconds}s linear`;
    progressFill.style.width = '0%';
  });
}

function stopProgress() {
  progressFill.style.transition = 'none';
  progressFill.style.width = '100%';
}

function initKiosk() {
  fetchState();
  setInterval(fetchState, 5000);
}
