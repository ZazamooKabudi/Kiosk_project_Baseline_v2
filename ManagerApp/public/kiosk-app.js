// Extract kiosk ID from URL
const urlParams = new URLSearchParams(window.location.search);
const kioskId = urlParams.get('id');

async function attemptFullscreen() {
    try {
        const docElm = document.documentElement;
        if (docElm.requestFullscreen) {
            await docElm.requestFullscreen();
        } else if (docElm.mozRequestFullScreen) {
            await docElm.mozRequestFullScreen();
        } else if (docElm.webkitRequestFullScreen) {
            await docElm.webkitRequestFullScreen();
        } else if (docElm.msRequestFullscreen) {
            await docElm.msRequestFullscreen();
        }
    } catch (e) {
        console.warn("Fullscreen auto-start prevented by browser policy", e);
    }
}

// Check ID
if (!kioskId) {
    document.getElementById("no-links-msg").style.display = "flex";
    document.getElementById("no-links-msg").innerText = "Error: No Kiosk ID specified in URL.";
} else {
    attemptFullscreen();
    initKiosk();
}


let links = [];
let currentLinkIndex = -1;
let linkTimer = null;
let messageTimer = null;
let isMessageActive = false;

// Poll backend every 5 seconds for updates (links & messages)
async function fetchState() {
    try {
        const res = await fetch(`/api/kiosk-client/${kioskId}`);
        const data = await res.json();

        // Update links
        const newLinksString = JSON.stringify(data.links);
        const oldLinksString = JSON.stringify(links);

        if (newLinksString !== oldLinksString) {
            links = data.links;
            // If links changed and no active message, restart display cycle
            if (!isMessageActive) {
                playNextLink();
            }
        }

        // Display Message if any
        if (data.message && !isMessageActive) {
            displayMessage(data.message);
        }

    } catch (e) {
        console.error("Error fetching state:", e);
    }
}

function displayMessage(msg) {
    isMessageActive = true;

    // Pause link rotation
    if (linkTimer) {
        clearTimeout(linkTimer);
        linkTimer = null;
    }

    const overlay = document.getElementById("message-overlay");
    const content = document.getElementById("message-content");

    content.innerText = msg.message;
    overlay.style.display = "flex";

    // Stop after duration
    messageTimer = setTimeout(() => {
        overlay.style.display = "none";
        isMessageActive = false;
        // Resume link rotation
        playNextLink();
    }, msg.duration_seconds * 1000);
}

function playNextLink() {
    // Clear existing timer to prevent duplicates
    if (linkTimer) {
        clearTimeout(linkTimer);
        linkTimer = null;
    }

    // Check if lengths is zero
    if (links.length === 0) {
        document.getElementById("kiosk-iframe").style.display = "none";
        document.getElementById("no-links-msg").style.display = "flex";
        document.getElementById("no-links-msg").innerText = "No content assigned to this kiosk.";
        return;
    }

    document.getElementById("kiosk-iframe").style.display = "block";
    document.getElementById("no-links-msg").style.display = "none";

    // Advance Index
    currentLinkIndex++;
    if (currentLinkIndex >= links.length) {
        currentLinkIndex = 0;
    }

    const link = links[currentLinkIndex];
    document.getElementById("kiosk-iframe").src = link.url;

    // Schedule next
    linkTimer = setTimeout(() => {
        if (!isMessageActive) {
            playNextLink();
        }
    }, link.duration_seconds * 1000);
}

function initKiosk() {
    fetchState(); // Initial fetch
    setInterval(fetchState, 5000); // Poll every 5 seconds
}
