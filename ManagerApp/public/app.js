document.addEventListener("DOMContentLoaded", () => {
    const connStatus = document.getElementById("conn-status");
    let currentUser = null;
    let allGlobalAreas = []; // for admin users management
    let serverInfo = { ip: '127.0.0.1', port: 3000 };

    // GUI Elements
    const loginOverlay = document.getElementById("login-overlay");
    const appContainer = document.getElementById("app-container");
    const loginForm = document.getElementById("login-form");
    const loginUser = document.getElementById("login-user");
    const loginPass = document.getElementById("login-pass");
    const loginError = document.getElementById("login-error");

    // User Management
    const usersNavHeader = document.getElementById("users-nav-header");
    const usersContainer = document.getElementById("users-container");
    const kioskContainer = document.getElementById("kiosk-container");
    const welcomeMessage = document.getElementById("welcome-message");
    const currentUserDisplay = document.getElementById("current-user-display");

    // Login Form Submit
    loginForm.addEventListener("submit", async (e) => {
        e.preventDefault();
        try {
            const res = await fetch("/api/login", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ username: loginUser.value, password: loginPass.value })
            });

            if (res.ok) {
                currentUser = await res.json();
                loginOverlay.style.display = "none";
                appContainer.style.display = "flex";
                currentUserDisplay.innerText = `Logged in as: ${currentUser.username}`;

                apiFetch("/api/info").then(res => res.json()).then(data => { serverInfo = data; }).catch(e => e);
                checkConnectionAndLoad();

                if (currentUser.role === 'admin') {
                    usersNavHeader.style.display = "block";
                } else {
                    usersNavHeader.style.display = "none";
                }
            } else {
                loginError.style.display = "block";
            }
        } catch (err) {
            loginError.innerText = "Connection error";
            loginError.style.display = "block";
        }
    });

    document.getElementById("logout-btn").addEventListener("click", () => {
        currentUser = null;
        appContainer.style.display = "none";
        loginOverlay.style.display = "flex";
        loginForm.reset();
        loginError.style.display = "none";
        document.getElementById("area-list").innerHTML = "";
    });

    // Wrapper for all fetch requests
    async function apiFetch(endpoint, options = {}) {
        try {
            const res = await fetch(endpoint, options);
            if (connStatus) {
                connStatus.className = "status online";
                connStatus.innerText = "Online";
            }
            return res;
        } catch (err) {
            if (connStatus) {
                connStatus.className = "status offline";
                connStatus.innerText = "Offline";
            }
            throw err;
        }
    }

    async function checkConnectionAndLoad() {
        try {
            document.getElementById("welcome-message").innerText = "Pinging kiosks... Please wait.";
            await apiFetch('/api/ping-all', { method: 'POST' });
            document.getElementById("welcome-message").innerText = "Select an area from the sidebar to manage kiosks.";
            await loadAreas();
        } catch (e) {
            console.error("Failed to connect to local server", e);
        }
    }

    // Theme toggling
    const themeToggle = document.getElementById("theme-toggle");
    themeToggle.addEventListener("click", () => {
        document.body.classList.toggle("dark-theme");
        const isDark = document.body.classList.contains("dark-theme");
        localStorage.setItem("theme", isDark ? "dark" : "light");
    });

    if (localStorage.getItem("theme") === "light") {
        document.body.classList.remove("dark-theme");
    }

    let currentAreaId = null;

    // Load Areas
    async function loadAreas() {
        if (!currentUser) return;
        const res = await apiFetch(`/api/areas?user_id=${currentUser.id}`);
        if (!res) return;
        const areas = await res.json();
        const list = document.getElementById("area-list");
        list.innerHTML = "";
        areas.forEach(area => {
            const li = document.createElement("li");
            // Only admin can delete areas
            const deleteBtn = currentUser.role === 'admin' ? `<span class="delete-area" data-id="${area.id}">✕</span>` : '';
            li.innerHTML = `<span>${area.name}</span> ${deleteBtn}`;
            li.onclick = (e) => {
                if (e.target.classList.contains("delete-area")) return;
                document.querySelectorAll(".area-list li").forEach(el => el.classList.remove("active"));
                li.classList.add("active");
                selectArea(area.id, area.name);
            };
            list.appendChild(li);
        });

        if (currentUser.role === 'admin') {
            document.querySelectorAll(".delete-area").forEach(btn => {
                btn.onclick = async (e) => {
                    e.stopPropagation();
                    if (confirm("Delete this area and all its kiosks?")) {
                        await apiFetch(`/api/areas/${e.target.dataset.id}`, { method: "DELETE" });
                        if (currentAreaId == e.target.dataset.id) {
                            kioskContainer.style.display = "none";
                            welcomeMessage.style.display = "block";
                            document.getElementById("current-area-title").innerText = "Select an Area";
                            currentAreaId = null;
                        }
                        loadAreas();
                    }
                };
            });
            document.getElementById("add-area-btn").style.display = "block";
        } else {
            document.getElementById("add-area-btn").style.display = "none";
        }
    }

    function selectArea(id, name) {
        currentAreaId = id;
        document.getElementById("current-area-title").innerText = `Area: ${name}`;
        kioskContainer.style.display = "block";
        usersContainer.style.display = "none";
        welcomeMessage.style.display = "none";
        loadKiosks();
    }

    // Load Kiosks
    async function loadKiosks() {
        if (!currentAreaId) return;
        const res = await apiFetch(`/api/kiosks?area_id=${currentAreaId}`);
        if (!res) return;
        const kiosks = await res.json();
        const tbody = document.getElementById("kiosk-table-body");
        tbody.innerHTML = "";

        kiosks.forEach(k => {
            let statusClass = "inactive";
            let statusText = "Inactive";
            if (k.is_active) {
                if (k.last_ping_status === 'Online') { statusClass = 'online'; statusText = 'Online'; }
                else if (k.last_ping_status === 'Offline') { statusClass = 'offline'; statusText = 'Offline'; }
                else { statusText = 'Unknown'; }

                if (k.last_ping_time) {
                    const lastPing = new Date(k.last_ping_time);
                    const now = new Date();
                    const diffDays = Math.floor((now - lastPing) / (1000 * 60 * 60 * 24));
                    if (diffDays >= 14) {
                        statusClass = 'offline';
                    }
                }
            }

            const tr = document.createElement("tr");
            tr.innerHTML = `
                <td><b>${k.id}</b></td>
                <td><span class="status ${statusClass}">${statusText}</span></td>
                <td>
                    <a href="/kiosk.html?id=${k.id}" class="open-kiosk" data-id="${k.id}" title="Open Kiosk">${k.computer_name}</a><br>
                    <button class="btn btn-outline copy-kiosk-link" data-id="${k.id}" style="font-size:10px; padding:2px 5px; margin-top:5px;" title="Copy Full URL">📋 Copy Link</button>
                </td>
                <td>${k.ip}</td>
                <td>${k.description}</td>
                <td><small>${k.notes || ''}</small></td>
                <td>${k.last_ping_time ? new Date(k.last_ping_time).toLocaleString() : 'Never'}</td>
                <td>
                    <button class="icon-btn manage-links" data-id="${k.id}" data-name="${k.computer_name}" title="Manage Links">🔗</button>
                    <button class="icon-btn send-msg" data-id="${k.id}" data-name="${k.computer_name}" title="Send Message">✉</button>
                </td>
                <td>
                    <button class="icon-btn edit-kiosk" data-kiosk='${JSON.stringify(k)}' title="Edit">✎</button>
                    ${currentUser.role === 'admin' ? `<button class="icon-btn warn delete-kiosk" data-id="${k.id}" title="Delete">🗑</button>` : ''}
                </td>
            `;
            tbody.appendChild(tr);
        });

        attachKioskEvents();
    }

    function attachKioskEvents() {
        document.querySelectorAll(".delete-kiosk").forEach(btn => {
            btn.onclick = async (e) => {
                if (confirm("Delete this kiosk?")) {
                    await apiFetch(`/api/kiosks/${e.target.dataset.id}`, { method: "DELETE" });
                    loadKiosks();
                }
            };
        });

        document.querySelectorAll(".edit-kiosk").forEach(btn => {
            btn.onclick = (e) => {
                const k = JSON.parse(e.target.dataset.kiosk);
                document.getElementById("fkiosk-id").value = k.id;
                document.getElementById("fkiosk-name").value = k.computer_name;
                document.getElementById("fkiosk-ip").value = k.ip;
                document.getElementById("fkiosk-desc").value = k.description;
                document.getElementById("fkiosk-manager").value = k.station_manager || "";
                document.getElementById("fkiosk-notes").value = k.notes || "";
                document.getElementById("fkiosk-active").checked = k.is_active === 1;
                document.getElementById("kiosk-modal-title").innerText = "Edit Kiosk";
                openModal("kiosk-modal");
            };
        });

        document.querySelectorAll(".manage-links").forEach(btn => {
            btn.onclick = (e) => {
                const id = e.target.dataset.id;
                document.getElementById("link-kiosk-name").innerText = e.target.dataset.name;
                document.getElementById("flink-url").dataset.kioskId = id;
                loadLinks(id);
                openModal("links-modal");
            };
        });

        document.querySelectorAll(".send-msg").forEach(btn => {
            btn.onclick = (e) => {
                const id = e.target.dataset.id;
                document.getElementById("msg-kiosk-name").innerText = e.target.dataset.name;
                document.getElementById("fmsg-text").dataset.kioskId = id;
                openModal("msg-modal");
            };
        });

        document.querySelectorAll(".open-kiosk").forEach(btn => {
            btn.onclick = (e) => {
                e.preventDefault();
                const id = e.target.dataset.id;
                try {
                    require('electron').shell.openExternal(`http://localhost:${serverInfo.port}/kiosk.html?id=${id}`);
                } catch (err) {
                    window.open(`http://${serverInfo.ip}:${serverInfo.port}/kiosk.html?id=${id}`, '_blank');
                }
            };
        });

        document.querySelectorAll(".copy-kiosk-link").forEach(btn => {
            btn.onclick = (e) => {
                const id = e.target.dataset.id;
                const link = `http://${serverInfo.ip}:${serverInfo.port}/kiosk.html?id=${id}`;
                navigator.clipboard.writeText(link).then(() => {
                    const originalText = e.target.innerText;
                    e.target.innerText = "✅ Copied!";
                    setTimeout(() => e.target.innerText = originalText, 2000);
                });
            };
        });
    }

    // Refresh Kiosks
    document.getElementById("refresh-btn").addEventListener("click", async () => {
        const btn = document.getElementById("refresh-btn");
        const origText = btn.innerText;
        btn.innerText = "Pinging...";
        await apiFetch('/api/ping-all', { method: 'POST' });
        await loadKiosks();
        btn.innerText = origText;
    });

    // Modals Handling
    function openModal(id) {
        document.getElementById(id).style.display = "flex";
    }

    document.querySelectorAll(".close-btn").forEach(btn => {
        btn.onclick = () => {
            document.getElementById(btn.dataset.modal).style.display = "none";
        };
    });

    document.getElementById("add-area-btn").addEventListener("click", () => openModal("area-modal"));

    document.getElementById("area-form").addEventListener("submit", async (e) => {
        e.preventDefault();
        const name = document.getElementById("area-name").value;
        await apiFetch("/api/areas", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name })
        });
        document.getElementById("area-form").reset();
        document.getElementById("area-modal").style.display = "none";
        loadAreas();
    });

    document.getElementById("add-kiosk-btn").addEventListener("click", () => {
        document.getElementById("kiosk-form").reset();
        document.getElementById("fkiosk-id").value = "";
        document.getElementById("kiosk-modal-title").innerText = "Add Kiosk";
        openModal("kiosk-modal");
    });

    document.getElementById("kiosk-form").addEventListener("submit", async (e) => {
        e.preventDefault();
        const id = document.getElementById("fkiosk-id").value;
        const data = {
            area_id: currentAreaId,
            computer_name: document.getElementById("fkiosk-name").value,
            ip: document.getElementById("fkiosk-ip").value,
            description: document.getElementById("fkiosk-desc").value,
            station_manager: document.getElementById("fkiosk-manager").value,
            notes: document.getElementById("fkiosk-notes").value,
            is_active: document.getElementById("fkiosk-active").checked ? 1 : 0
        };

        const method = id ? "PUT" : "POST";
        const url = id ? `/api/kiosks/${id}` : "/api/kiosks";

        await apiFetch(url, {
            method: method,
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(data)
        });

        document.getElementById("kiosk-modal").style.display = "none";
        loadKiosks();
    });

    // Links Handling
    async function loadLinks(kioskId) {
        const res = await apiFetch(`/api/kiosks/${kioskId}/links`);
        if (!res) return;
        const links = await res.json();
        const list = document.getElementById("kiosk-links-list");
        list.innerHTML = "";
        links.forEach(link => {
            const li = document.createElement("li");
            li.innerHTML = `
                <span>${link.url} (${link.duration_seconds}s)</span>
                <button class="icon-btn warn" onclick="deleteLink(${link.id}, ${kioskId})">🗑</button>
            `;
            list.appendChild(li);
        });
    }

    window.deleteLink = async (linkId, kioskId) => {
        if (confirm("Delete this link?")) {
            await apiFetch(`/api/links/${linkId}`, { method: "DELETE" });
            loadLinks(kioskId);
        }
    };

    document.getElementById("add-link-form").addEventListener("submit", async (e) => {
        e.preventDefault();
        const url = document.getElementById("flink-url").value;
        const duration_seconds = document.getElementById("flink-duration").value;
        const kioskId = document.getElementById("flink-url").dataset.kioskId;

        await apiFetch(`/api/kiosks/${kioskId}/links`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ url, duration_seconds })
        });

        document.getElementById("flink-url").value = "";
        document.getElementById("flink-duration").value = "10";
        loadLinks(kioskId);
    });

    document.getElementById("send-msg-form").addEventListener("submit", async (e) => {
        e.preventDefault();
        const message = document.getElementById("fmsg-text").value;
        const duration_seconds = document.getElementById("fmsg-duration").value;
        const kioskId = document.getElementById("fmsg-text").dataset.kioskId;

        await apiFetch(`/api/messages`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ kiosk_id: kioskId, message, duration_seconds })
        });

        document.getElementById("send-msg-form").reset();
        document.getElementById("msg-modal").style.display = "none";
        alert("Message sent to Kiosk.");
    });


    // --- USERS MANAGEMENT ---

    usersNavHeader.addEventListener("click", () => {
        document.getElementById("current-area-title").innerText = "Manage Users & Permissions";
        document.querySelectorAll(".area-list li").forEach(el => el.classList.remove("active"));
        kioskContainer.style.display = "none";
        welcomeMessage.style.display = "none";
        usersContainer.style.display = "block";
        currentAreaId = null;
        loadUsers();
    });

    async function fetchAllGlobalAreas() {
        // Need to get all areas as admin
        const res = await apiFetch(`/api/areas`);
        if (res) {
            allGlobalAreas = await res.json();
        }
    }

    async function loadUsers() {
        const res = await apiFetch(`/api/users`);
        if (!res) return;
        const data = await res.json();
        await fetchAllGlobalAreas(); // Fetch fresh areas for assignment

        const tbody = document.getElementById("users-table-body");
        tbody.innerHTML = "";

        data.users.forEach(u => {
            const userAreas = data.user_areas.filter(ua => ua.user_id === u.id).map(ua => ua.area_id);
            const assignedAreaNames = allGlobalAreas.filter(a => userAreas.includes(a.id)).map(a => a.name).join(", ");

            const tr = document.createElement("tr");
            tr.innerHTML = `
                <td>${u.id}</td>
                <td>${u.username}</td>
                <td>${u.role}</td>
                <td>${u.role === 'admin' ? 'All Areas (Admin)' : (assignedAreaNames || 'None')}</td>
                <td>
                    <button class="icon-btn edit-user" data-user='${JSON.stringify({ ...u, assignedAreas: userAreas })}' title="Edit">✎</button>
                    ${u.username !== 'nivm' ? `<button class="icon-btn warn delete-user" data-id="${u.id}" title="Delete">🗑</button>` : ''}
                </td>
            `;
            tbody.appendChild(tr);
        });

        document.querySelectorAll(".delete-user").forEach(btn => {
            btn.onclick = async (e) => {
                if (confirm("Delete this user?")) {
                    await apiFetch(`/api/users/${e.target.dataset.id}`, { method: "DELETE" });
                    loadUsers();
                }
            }
        });

        document.querySelectorAll(".edit-user").forEach(btn => {
            btn.onclick = (e) => {
                const u = JSON.parse(e.target.dataset.user);
                document.getElementById("fuser-id").value = u.id;
                document.getElementById("fuser-name").value = u.username;
                document.getElementById("fuser-name").disabled = (u.username === 'nivm'); // Protect default admin
                document.getElementById("fuser-pass").value = "";
                document.getElementById("fuser-pass").required = false;
                document.getElementById("fuser-role").value = u.role;
                document.getElementById("user-modal-title").innerText = "Edit User";

                populateUserAreas(u.assignedAreas);
                openModal("user-modal");
            };
        });
    }

    document.getElementById("add-user-btn").addEventListener("click", async () => {
        document.getElementById("user-form").reset();
        document.getElementById("fuser-id").value = "";
        document.getElementById("fuser-name").disabled = false;
        document.getElementById("fuser-pass").required = true;
        document.getElementById("user-modal-title").innerText = "Add User";

        await fetchAllGlobalAreas();
        populateUserAreas([]);
        openModal("user-modal");
    });

    function populateUserAreas(selectedIds) {
        const container = document.getElementById("fuser-areas");
        container.innerHTML = "";
        allGlobalAreas.forEach(a => {
            const checked = selectedIds.includes(a.id) ? "checked" : "";
            container.innerHTML += `
                <div style="margin-bottom: 5px;">
                    <input type="checkbox" class="u-area-cb" value="${a.id}" ${checked}> ${a.name}
                </div>
            `;
        });
    }

    document.getElementById("user-form").addEventListener("submit", async (e) => {
        e.preventDefault();
        const id = document.getElementById("fuser-id").value;
        const role = document.getElementById("fuser-role").value;

        // Collect areas
        const areas = [];
        document.querySelectorAll(".u-area-cb:checked").forEach(cb => {
            areas.push(parseInt(cb.value));
        });

        const data = {
            username: document.getElementById("fuser-name").value,
            role,
            areas
        };

        const pass = document.getElementById("fuser-pass").value;
        if (pass) data.password = pass;

        if (id) {
            await apiFetch(`/api/users/${id}`, {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(data)
            });
        } else {
            await apiFetch(`/api/users`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(data)
            });
        }

        document.getElementById("user-modal").style.display = "none";
        loadUsers();
    });

});
