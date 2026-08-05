function switchTab(tabName) {
    ['dashboard', 'proxmox', 'gameservers', 'settings'].forEach(t => {
        const el = document.getElementById(`tab-${t}`);
        if (el) el.classList.add('hidden');
        const btn = document.getElementById(`nav-${t}`);
        if (btn) {
            btn.classList.remove('bg-gradient-to-r', 'from-blue-600', 'to-purple-600', 'text-white', 'shadow-lg');
            btn.classList.add('hover:bg-gray-800', 'text-gray-400');
        }
    });

    document.getElementById(`tab-${tabName}`).classList.remove('hidden');
    const activeBtn = document.getElementById(`nav-${tabName}`);
    if (activeBtn) {
        activeBtn.classList.add('bg-gradient-to-r', 'from-blue-600', 'to-purple-600', 'text-white', 'shadow-lg');
        activeBtn.classList.remove('hover:bg-gray-800', 'text-gray-400');
    }

    if (tabName === 'dashboard') loadDashboardIPStatus();
    if (tabName === 'proxmox') loadProxmoxResources();
    if (tabName === 'gameservers') loadGameTemplates();
}

function handleTypeChange() {
    const type = document.getElementById('create-type').value;
    const boxTemplate = document.getElementById('box-template');
    const boxIso = document.getElementById('box-iso');

    if (type === 'lxc') {
        boxTemplate.classList.remove('hidden');
        boxIso.classList.add('hidden');
    } else {
        boxTemplate.classList.add('hidden');
        boxIso.classList.remove('hidden');
    }
}

function toggleModal(modalId, show) {
    const modal = document.getElementById(modalId);
    if (show) {
        modal.classList.remove('hidden');
        if (modalId === 'create-vm-modal') {
            loadFreeIPs();
            loadStorageTemplatesAndISOs();
            handleTypeChange();
        }
    } else {
        modal.classList.add('hidden');
    }
}

// Hilfsfunktion: Bereinigt Dateinamen (Entfernt -amd64, -DVD-1, .iso etc.)
function formatCleanName(raw) {
    if (!raw) return '';
    let name = raw.split('/').pop();
    // Endungen entfernen
    name = name.replace(/\.(iso|tar\.zst|tar\.gz|img|tgz)$/i, '');
    // Technische Zusätze entfernen
    name = name.replace(/-amd64|-x86_64|-DVD-\d+|-standard_[\d\.\-]+/gi, '');
    // Bindestriche durch Leerzeichen ersetzen
    name = name.replace(/-/g, ' ');
    // Ersten Buchstaben großschreiben
    return name.replace(/\b\w/g, l => l.toUpperCase());
}

// Proxmox Storage: ISOs und Container Templates sauber geladen anzeigen
async function loadStorageTemplatesAndISOs() {
    const selectTemplate = document.getElementById('create-template-select');
    const selectIso = document.getElementById('create-iso-select');

    if (selectTemplate) {
        selectTemplate.innerHTML = `<option value="">Lade LXC Templates...</option>`;
        try {
            const res = await fetch('/api/proxmox/storage/templates');
            const data = await res.json();
            if (data.success && data.templates.length > 0) {
                selectTemplate.innerHTML = data.templates.map(t => {
                    const cleanName = formatCleanName(t.volid);
                    const sizeMB = (t.size / 1024 / 1024).toFixed(0);
                    return `<option value="${t.volid}">${cleanName} (${sizeMB} MB)</option>`;
                }).join('');
            } else {
                selectTemplate.innerHTML = `<option value="">Keine LXC-Templates auf Proxmox gefunden</option>`;
            }
        } catch (e) {
            selectTemplate.innerHTML = `<option value="">Fehler beim Laden der Templates</option>`;
        }
    }

    if (selectIso) {
        selectIso.innerHTML = `<option value="">Lade ISO Images...</option>`;
        try {
            const res = await fetch('/api/proxmox/storage/isos');
            const data = await res.json();
            if (data.success && data.isos.length > 0) {
                selectIso.innerHTML = `<option value="">-- Keines (Leere VM) --</option>` + data.isos.map(i => {
                    const cleanName = formatCleanName(i.volid);
                    const sizeGB = (i.size / 1024 / 1024 / 1024).toFixed(1);
                    return `<option value="${i.volid}">${cleanName} (${sizeGB} GB)</option>`;
                }).join('');
            } else {
                selectIso.innerHTML = `<option value="">Keine ISOs auf Proxmox gefunden</option>`;
            }
        } catch (e) {
            selectIso.innerHTML = `<option value="">Fehler beim Laden der ISOs</option>`;
        }
    }
}

// Config laden & Formular
async function loadConfig() {
    try {
        const res = await fetch('/api/config/proxmox');
        const config = await res.json();
        document.getElementById('cfg-host').value = config.proxmoxHost || '';
        document.getElementById('cfg-node').value = config.proxmoxNode || '';
        document.getElementById('cfg-token-id').value = config.tokenId || '';
        document.getElementById('cfg-token-secret').value = config.tokenSecret || '';
    } catch (err) {}
}

document.getElementById('proxmox-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const alertBox = document.getElementById('cfg-alert');
    const data = {
        proxmoxHost: document.getElementById('cfg-host').value,
        proxmoxNode: document.getElementById('cfg-node').value,
        tokenId: document.getElementById('cfg-token-id').value,
        tokenSecret: document.getElementById('cfg-token-secret').value
    };
    const res = await fetch('/api/config/proxmox', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
    const result = await res.json();
    alertBox.classList.remove('hidden');
    alertBox.className = `p-4 rounded-xl text-sm ${result.success ? 'bg-green-500/10 border border-green-500/30 text-green-400' : 'bg-red-500/10 border border-red-500/30 text-red-400'}`;
    alertBox.innerText = result.message;
    updatePveStatus(result.success);
});

function updatePveStatus(connected) {
    const dot = document.getElementById('pve-status-dot');
    const text = document.getElementById('pve-status-text');
    if (connected) {
        dot.className = 'w-3 h-3 rounded-full bg-green-500 shadow-lg shadow-green-500/50';
        text.className = 'text-xs text-green-400 font-bold';
        text.innerText = 'Online (PVE)';
    } else {
        dot.className = 'w-3 h-3 rounded-full bg-red-500';
        text.className = 'text-xs text-red-400';
        text.innerText = 'Offline';
    }
}

// IP-Status direkt auf dem Dashboard anzeigen
async function loadDashboardIPStatus() {
    const container = document.getElementById('dash-ip-list');
    if (!container) return;

    try {
        const res = await fetch('/api/network/free-ips');
        const data = await res.json();

        if (data.success && data.ipList) {
            container.innerHTML = data.ipList.map(item => `
                <div class="p-3 bg-bgDark rounded-xl border ${item.free ? 'border-green-500/30 bg-green-500/5' : 'border-red-500/30 bg-red-500/5'} flex flex-col items-center justify-center space-y-1">
                    <span class="font-mono text-xs font-bold text-white">${item.ip}</span>
                    <span class="text-[10px] font-semibold ${item.free ? 'text-green-400' : 'text-red-400'}">
                        ${item.free ? '🟢 FREI' : '🔴 BELEGT'}
                    </span>
                </div>
            `).join('');
        } else {
            container.innerHTML = `<div class="col-span-5 text-center text-xs text-red-400">Fehler beim Laden des IP-Status</div>`;
        }
    } catch (err) {
        container.innerHTML = `<div class="col-span-5 text-center text-xs text-red-400">Verbindungsfehler</div>`;
    }
}

// Proxmox Instanzen (Tabelle) laden & Steuerung
async function loadProxmoxResources() {
    const tbody = document.getElementById('proxmox-table-body');
    
    if (!tbody.innerHTML.trim() || tbody.innerHTML.includes('Lade Proxmox')) {
        tbody.innerHTML = `<tr><td colspan="6" class="p-6 text-center text-gray-400"><i class="fa-solid fa-spinner animate-spin mr-2"></i> Lade Proxmox Ressourcen...</td></tr>`;
    }

    try {
        const res = await fetch('/api/proxmox/resources');
        const data = await res.json();
        if (!data.success) {
            tbody.innerHTML = `<tr><td colspan="6" class="p-6 text-center text-red-400">${data.error}</td></tr>`;
            updatePveStatus(false);
            return;
        }

        updatePveStatus(true);
        document.getElementById('dash-vms-count').innerText = data.resources.length;

        tbody.innerHTML = data.resources.map(item => {
            const isOnline = item.status && item.status.toLowerCase() === 'running';
            const name = item.name || item.hostname || `VM ${item.vmid}`;
            const cores = item.maxcpu || item.cpus || item.cores || '-';
            const rawMem = item.maxmem || item.mem || 0;
            const ramGB = rawMem > 0 ? (rawMem / 1073741824).toFixed(1) : '0';

            return `
                <tr class="border-b border-gray-800/50 hover:bg-gray-800/20 transition">
                    <td class="p-4 font-mono font-bold text-primary">${item.vmid}</td>
                    <td class="p-4 font-medium text-white">${name}</td>
                    <td class="p-4 uppercase text-xs text-gray-400">${item.type}</td>
                    <td class="p-4">
                        ${isOnline 
                            ? `<span class="bg-green-500/10 text-green-400 border border-green-500/20 px-2.5 py-1 rounded-full text-xs font-semibold">🟢 Läuft</span>` 
                            : `<span class="bg-gray-800 text-gray-400 border border-gray-700 px-2.5 py-1 rounded-full text-xs font-semibold">🔴 Gestoppt</span>`}
                    </td>
                    <td class="p-4 text-xs text-gray-400">${cores} Cores | ${ramGB} GB RAM</td>
                    <td class="p-4 text-right space-x-2">
                        ${isOnline 
                            ? `<button onclick="vmAction(${item.vmid}, '${item.type}', 'stop')" class="bg-red-500/20 text-red-400 hover:bg-red-500/30 px-3 py-1 rounded-lg text-xs font-bold">Stopp</button>
                               <button onclick="vmAction(${item.vmid}, '${item.type}', 'reboot')" class="bg-yellow-500/20 text-yellow-400 hover:bg-yellow-500/30 px-3 py-1 rounded-lg text-xs font-bold">Neustart</button>`
                            : `<button onclick="vmAction(${item.vmid}, '${item.type}', 'start')" class="bg-green-500/20 text-green-400 hover:bg-green-500/30 px-3 py-1 rounded-lg text-xs font-bold">Starten</button>`
                        }
                        <button onclick="confirmDeleteVM(${item.vmid}, '${item.type}')" class="bg-rose-600/20 text-rose-400 hover:bg-rose-600/30 border border-rose-500/30 px-3 py-1 rounded-lg text-xs font-bold">Löschen</button>
                    </td>
                </tr>
            `;
        }).join('');
    } catch (err) {
        tbody.innerHTML = `<tr><td colspan="6" class="p-6 text-center text-red-400">Fehler beim Verbinden.</td></tr>`;
        updatePveStatus(false);
    }
}

// VM / Container Aktion ausführen (Start / Stop / Reboot / Delete)
async function vmAction(vmid, type, action) {
    const res = await fetch('/api/proxmox/action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ vmid, type, action })
    });
    const result = await res.json();
    if (result.success) {
        setTimeout(loadProxmoxResources, 1000);
        setTimeout(loadDashboardIPStatus, 1500);
    } else {
        alert('Fehler: ' + JSON.stringify(result.error));
    }
}

// Löschen-Sicherheitsabfrage
function confirmDeleteVM(vmid, type) {
    if (confirm(`Möchtest du ${type.toUpperCase()} mit ID ${vmid} wirklich unwiderruflich löschen?`)) {
        vmAction(vmid, type, 'delete');
    }
}

// IP-Status für Modal laden
async function loadFreeIPs() {
    const selectEl = document.getElementById('create-ip-select');
    if (!selectEl) return;
    selectEl.innerHTML = `<option value="">Scanne IP-Status...</option>`;

    try {
        const res = await fetch('/api/network/free-ips');
        const data = await res.json();

        if (data.success && data.ipList) {
            selectEl.innerHTML = `<option value="">-- IP-Adresse wählen --</option>` + 
                data.ipList.map(item => {
                    if (item.free) {
                        return `<option value="${item.ip}">🟢 ${item.ip} (Frei)</option>`;
                    } else {
                        return `<option value="${item.ip}" disabled class="text-gray-500">🔴 ${item.ip} (Belegt)</option>`;
                    }
                }).join('');
        } else {
            selectEl.innerHTML = `<option value="">Keine IPs gefunden</option>`;
        }
    } catch (err) {
        selectEl.innerHTML = `<option value="">Fehler beim Laden der IPs</option>`;
    }
}

// Neue VM oder LXC mit allen Einstellungen & Auto-Netzwerk anlegen
document.getElementById('create-vm-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const type = document.getElementById('create-type').value;

    const data = {
        type: type,
        vmid: document.getElementById('create-vmid').value,
        name: document.getElementById('create-name').value,
        memory: document.getElementById('create-ram').value,
        cores: document.getElementById('create-cores').value,
        diskSize: document.getElementById('create-disk').value,
        password: document.getElementById('create-password').value,
        ip: document.getElementById('create-ip-select') ? document.getElementById('create-ip-select').value : '',
        template: document.getElementById('create-template-select').value,
        iso: document.getElementById('create-iso-select').value
    };

    const res = await fetch('/api/proxmox/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
    });
    const result = await res.json();
    if (result.success) {
        toggleModal('create-vm-modal', false);
        setTimeout(loadProxmoxResources, 1000);
        setTimeout(loadDashboardIPStatus, 1500);
    } else {
        alert('Erstellen fehlgeschlagen: ' + JSON.stringify(result.error));
    }
});

// Game Server Templates anzeigen
async function loadGameTemplates() {
    const grid = document.getElementById('games-grid');
    const res = await fetch('/api/gameservers/templates');
    const games = await res.json();

    grid.innerHTML = games.map(g => `
        <div class="bg-panelDark border border-gray-800 rounded-2xl p-6 space-y-4">
            <div class="flex items-center space-x-3">
                <i class="fa-solid ${g.icon} ${g.color} text-3xl"></i>
                <div>
                    <h3 class="font-bold text-lg">${g.name}</h3>
                    <p class="text-xs text-gray-400">Standard Port: ${g.defaultPort} | Min. RAM: ${g.minRam / 1024} GB</p>
                </div>
            </div>
            <div>
                <label class="block text-xs font-bold text-gray-400 uppercase mb-2">Version / Modpack wählen</label>
                <select id="ver-${g.id}" class="w-full bg-bgDark border border-gray-700 rounded-xl px-3 py-2 text-sm text-white">
                    ${g.versions.map(v => `<option value="${v}">${v}</option>`).join('')}
                </select>
            </div>
            <button onclick="deployGameServer('${g.id}')" class="w-full bg-gray-800 border border-gray-700 hover:bg-gray-700 font-bold py-2 rounded-xl text-sm transition">
                <i class="fa-solid fa-rocket mr-2 text-primary"></i> Server Erstellen
            </button>
        </div>
    `).join('');
}

function deployGameServer(gameId) {
    const selectedVersion = document.getElementById(`ver-${gameId}`).value;
    alert(`Server-Deployment für ${gameId.toUpperCase()} (${selectedVersion}) gestartet!\nWird als Docker/LXC Instanz vorbereitet.`);
}

// System Statistiken
async function loadSystemStats() {
    try {
        const res = await fetch('/api/system');
        const data = await res.json();
        document.getElementById('dash-cpu').innerText = `${data.cpuUsage}%`;
        document.getElementById('dash-ram').innerText = `${data.ramUsage}%`;
        document.getElementById('dash-ram-details').innerText = `${data.ramUsedGB} GB / ${data.ramTotalGB} GB`;
        if (data.ips && data.ips.length > 0) document.getElementById('system-ip-badge').innerText = `IP: ${data.ips[0].ip}`;
    } catch (err) {}
}

loadConfig();
loadSystemStats();
loadDashboardIPStatus();
loadProxmoxResources();

// Auto-Refresh Intervalle
setInterval(loadSystemStats, 4000);
setInterval(loadDashboardIPStatus, 10000);
setInterval(loadProxmoxResources, 5000);