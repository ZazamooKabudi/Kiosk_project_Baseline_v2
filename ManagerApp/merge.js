const fs = require("fs");

// 1. Merge index.html
let serverIndex = fs.readFileSync("../ServerApp/public/index.html", "utf8");

const setupOverlay = `
    <!-- SETUP OVERLAY -->
    <div id="setup-overlay" class="modal" style="display: none; background: var(--bg-color); z-index: 10001;">
        <div class="modal-content" style="max-width: 350px;">
            <h2 style="text-align: center; margin-bottom: 20px;">Manager Setup</h2>
            <form id="setup-form">
                <div class="form-group">
                    <label>Server URL</label>
                    <input type="text" id="server-url-input" placeholder="http://127.0.0.1:5190" required>
                </div>
                <button type="submit" class="btn btn-primary" style="width: 100%;">Connect</button>
                <div id="setup-error" style="color: var(--danger); margin-top: 10px; display: none; text-align: center;">Connection failed</div>
            </form>
        </div>
    </div>
`;

// Insert the setup overlay right above the login overlay
serverIndex = serverIndex.replace("<!-- Login Overlay -->", setupOverlay + "\n    <!-- Login Overlay -->");

// Insert config button in the top bar of the sidebar
serverIndex = serverIndex.replace(
    '<button class="btn btn-settings" id="settings-btn"',
    '<button class="icon-btn" id="config-btn" title="Server Settings" style="flex:0.5; font-size:12px; padding: 5px; background:transparent; border:1px solid #ccc; color:inherit;">⚙ Config</button>\n                    <button class="btn btn-settings" id="settings-btn"'
);

fs.writeFileSync("index.html", serverIndex);

// 2. Merge app.js
let serverApp = fs.readFileSync("../ServerApp/public/app.js", "utf8");

const setupLogic = `
    let serverUrl = localStorage.getItem("serverUrl");
    const setupOverlay = document.getElementById("setup-overlay");
    const serverUrlInput = document.getElementById("server-url-input");

    if (!serverUrl) {
        if (setupOverlay) setupOverlay.style.display = "flex";
        if (document.getElementById("login-overlay")) document.getElementById("login-overlay").style.display = "none";
    }

    if (document.getElementById("setup-form")) {
        document.getElementById("setup-form").addEventListener("submit", async (e) => {
            e.preventDefault();
            let inputUrl = serverUrlInput.value.trim();
            if (inputUrl.endsWith("/")) inputUrl = inputUrl.slice(0, -1);
            try {
                // simple endpoint to check if valid server
                const res = await fetch(\`\${inputUrl}/api/info\`);
                if (res.ok) {
                    serverUrl = inputUrl;
                    localStorage.setItem("serverUrl", serverUrl);
                    setupOverlay.style.display = "none";
                    document.getElementById("setup-error").style.display = "none";
                    document.getElementById("login-overlay").style.display = "flex";
                } else { throw new Error("Invalid response"); }
            } catch (err) {
                document.getElementById("setup-error").style.display = "block";
                document.getElementById("setup-error").innerText = "Failed to connect.";
            }
        });
    }

    if (document.getElementById("config-btn")) {
        document.getElementById("config-btn").addEventListener("click", () => {
            serverUrlInput.value = serverUrl || "";
            document.getElementById("app-container").style.display = "none";
            document.getElementById("login-overlay").style.display = "none";
            setupOverlay.style.display = "flex";
        });
    }
`;

// Add setup logic inside DOMContentLoaded
serverApp = serverApp.replace('document.addEventListener("DOMContentLoaded", () => {', 'document.addEventListener("DOMContentLoaded", () => {\n' + setupLogic);

// Transform API calls to use serverUrl
serverApp = serverApp.replace('const res = await fetch(endpoint, options);', 'const res = await fetch(`${serverUrl}${endpoint}`, options);');
serverApp = serverApp.replace('const res = await fetch("/api/login"', 'const res = await fetch(`${serverUrl}/api/login`');

fs.writeFileSync("app.js", serverApp);
fs.copyFileSync("../ServerApp/public/style.css", "style.css");
console.log("Merge complete");
