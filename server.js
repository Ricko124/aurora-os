const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const si = require('systeminformation');
const { exec } = require('child_process');
const session = require('express-session');
const bcrypt = require('bcrypt');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Session-Middleware für den Login-Status
app.use(session({
    secret: 'aurora-os-secret-key-change-this',
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false, maxAge: 24 * 60 * 60 * 1000 }
}));

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
const CONFIG_PATH = path.join(__dirname, 'config.json');
const USERS_FILE = path.join(__dirname, 'users.json');
const CREDENTIALS_FILE = path.join(__dirname, 'credentials.json');

function getUsers() {
    if (!fs.existsSync(USERS_FILE)) {
        const defaultUser = {
            username: 'admin',
            passwordHash: bcrypt.hashSync('admin123', 10),
            role: 'admin'
        };
        fs.writeFileSync(USERS_FILE, JSON.stringify([defaultUser], null, 2));
    }
    return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
}

function saveUsers(users) {
    fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
}

function getCredentials() {
    if (!fs.existsSync(CREDENTIALS_FILE)) fs.writeFileSync(CREDENTIALS_FILE, JSON.stringify([], null, 2));
    return JSON.parse(fs.readFileSync(CREDENTIALS_FILE, 'utf8'));
}

function saveCredentials(creds) {
    fs.writeFileSync(CREDENTIALS_FILE, JSON.stringify(creds, null, 2));
}

function requireAuth(req, res, next) {
    if (req.session && req.session.user) {
        return next();
    }
    res.status(401).json({ success: false, message: 'Nicht autorisiert.' });
}

function getConfig() {
    if (!fs.existsSync(CONFIG_PATH)) return {};
    try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch { return {}; }
}

function pveClient() {
    const config = getConfig();
    return axios.create({
        baseURL: `${config.proxmoxHost}/api2/json`,
        headers: { 'Authorization': `PVEAPIToken=${config.tokenId}=${config.tokenSecret}` },
        timeout: 10000
    });
}

// ------------------- AUTHENTICATION & USER MANAGEMENT APIs -------------------
app.get('/api/auth/me', (req, res) => {
    if (req.session && req.session.user) {
        res.json({ authenticated: true, username: req.session.user });
    } else {
        res.json({ authenticated: false });
    }
});

app.post('/api/auth/login', async (req, res) => {
    const { username, password } = req.body;
    const users = getUsers();
    const user = users.find(u => u.username === username);

    if (user && await bcrypt.compare(password, user.passwordHash)) {
        req.session.user = user.username;
        res.json({ success: true, message: 'Erfolgreich eingeloggt!' });
    } else {
        res.status(400).json({ success: false, message: 'Ungültiger Benutzername oder falsches Passwort.' });
    }
});

app.post('/api/auth/register', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) {
        return res.status(400).json({ success: false, message: 'Benutzername und Passwort erforderlich.' });
    }

    const users = getUsers();
    if (users.some(u => u.username === username)) {
        return res.status(400).json({ success: false, message: 'Benutzer existiert bereits.' });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    users.push({ username, passwordHash, role: 'admin' });
    saveUsers(users);

    req.session.user = username;
    res.json({ success: true, message: 'Account erstellt und eingeloggt!' });
});

app.post('/api/auth/logout', (req, res) => {
    req.session.destroy(() => {
        res.json({ success: true, message: 'Erfolgreich ausgeloggt.' });
    });
});

app.get('/api/users', requireAuth, (req, res) => {
    const users = getUsers().map(u => ({ username: u.username, role: u.role || 'viewer' }));
    res.json({ success: true, users });
});

app.post('/api/users', requireAuth, async (req, res) => {
    const { username, password, role } = req.body;
    if (!username || !password) {
        return res.status(400).json({ success: false, message: 'Benutzername und Passwort erforderlich.' });
    }

    const users = getUsers();
    if (users.some(u => u.username === username)) {
        return res.status(400).json({ success: false, message: 'Benutzer existiert bereits.' });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    users.push({ username, passwordHash, role: role || 'viewer' });
    saveUsers(users);

    res.json({ success: true, message: 'Benutzer erfolgreich angelegt!' });
});

app.put('/api/users/:username/role', requireAuth, (req, res) => {
    const targetUsername = req.params.username;
    const { role } = req.body;
    let users = getUsers();
    const user = users.find(u => u.username === targetUsername);
    if (!user) return res.status(404).json({ success: false, message: 'Benutzer nicht gefunden.' });
    
    user.role = role || 'viewer';
    saveUsers(users);
    res.json({ success: true, message: 'Rolle aktualisiert.' });
});

app.delete('/api/users/:username', requireAuth, (req, res) => {
    const targetUsername = req.params.username;
    if (targetUsername === 'admin') {
        return res.status(400).json({ success: false, message: 'Der Haupt-Admin kann nicht gelöscht werden.' });
    }
    let users = getUsers();
    users = users.filter(u => u.username !== targetUsername);
    saveUsers(users);
    res.json({ success: true, message: 'Benutzer gelöscht.' });
});

// ------------------- CREDENTIALS API (AUTOMATISCHER SYNC) -------------------
app.get('/api/credentials', requireAuth, async (req, res) => {
    try {
        const creds = getCredentials();
        const config = getConfig();
        if (config.proxmoxNode) {
            const client = pveClient();
            const [qemuRes, lxcRes] = await Promise.allSettled([
                client.get(`/nodes/${config.proxmoxNode}/qemu`),
                client.get(`/nodes/${config.proxmoxNode}/lxc`)
            ]);
            const allVMs = [
                ...(qemuRes.status === 'fulfilled' && qemuRes.value.data?.data ? qemuRes.value.data.data : []),
                ...(lxcRes.status === 'fulfilled' && lxcRes.value.data?.data ? lxcRes.value.data.data : [])
            ];
            
            for (const vm of allVMs) {
                const exists = creds.find(c => c.vmid === vm.vmid);
                if (!exists) {
                    creds.push({
                        vmid: vm.vmid,
                        name: vm.name || vm.hostname || `VM ${vm.vmid}`,
                        type: vm.maxcpu ? 'qemu' : 'lxc',
                        ip: 'DHCP / Automatisch',
                        username: 'ubuntu',
                        password: 'Aurora1234!'
                    });
                }
            }
            saveCredentials(creds);
        }
        res.json({ success: true, credentials: creds });
    } catch (err) {
        res.json({ success: true, credentials: getCredentials() });
    }
});

// ------------------- SYSTEM & CONFIG APIs -------------------
app.get('/api/config/proxmox', (req, res) => {
    const config = getConfig();
    res.json({ ...config, tokenSecret: config.tokenSecret ? '********' : '' });
});

app.post('/api/config/proxmox', async (req, res) => {
    const { proxmoxHost, proxmoxNode, tokenId, tokenSecret } = req.body;
    const currentConfig = getConfig();
    const newConfig = {
        proxmoxHost: proxmoxHost || currentConfig.proxmoxHost,
        proxmoxNode: proxmoxNode || currentConfig.proxmoxNode,
        tokenId: tokenId || currentConfig.tokenId,
        tokenSecret: (tokenSecret && tokenSecret !== '********') ? tokenSecret : currentConfig.tokenSecret
    };

    fs.writeFileSync(CONFIG_PATH, JSON.stringify(newConfig, null, 2));

    try {
        const client = axios.create({
            baseURL: `${newConfig.proxmoxHost}/api2/json`,
            headers: { 'Authorization': `PVEAPIToken=${newConfig.tokenId}=${newConfig.tokenSecret}` }
        });
        const response = await client.get(`/nodes/${newConfig.proxmoxNode}/status`);
        res.json({ success: true, message: 'Verbindung zu Proxmox erfolgreich hergestellt!', nodeStatus: response.data.data });
    } catch (error) {
        res.json({ success: false, message: 'Fehler bei Proxmox-Verbindung: ' + (error.response?.data?.errors || error.message) });
    }
});

app.get('/api/system', async (req, res) => {
    try {
        const currentLoad = await si.currentLoad();
        const mem = await si.mem();
        const netInterfaces = await si.networkInterfaces();
        const ipList = netInterfaces.filter(iface => !iface.internal && iface.ip4).map(iface => ({ iface: iface.iface, ip: iface.ip4 }));

        res.json({
            cpuUsage: Math.round(currentLoad.currentLoad),
            ramUsage: Math.round((mem.used / mem.total) * 100),
            ramUsedGB: (mem.used / 1073741824).toFixed(1),
            ramTotalGB: (mem.total / 1073741824).toFixed(1),
            ips: ipList
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ------------------- VNC CONSOLE TICKET API -------------------
app.post('/api/proxmox/vnc', async (req, res) => {
    const { vmid, type } = req.body;
    const config = getConfig();

    try {
        const response = await axios.post(`${config.proxmoxHost}/api2/json/nodes/${config.proxmoxNode}/${type}/${vmid}/vncproxy`, {
            websocket: 1
        }, {
            headers: {
                'Authorization': `PVEAPIToken=${config.tokenId}=${config.tokenSecret}`,
                'Content-Type': 'application/json'
            },
            timeout: 10000
        });
        const data = response.data;
        
        if (data.data) {
            const { port, ticket } = data.data;
            const novncUrl = `${config.proxmoxHost}/novnc/index.html?console=${type}&vmid=${vmid}&node=${config.proxmoxNode}&port=${port}&vncticket=${encodeURIComponent(ticket)}`;
            res.json({ success: true, url: novncUrl });
        } else {
            res.json({ success: false, error: 'Konnte kein VNC-Ticket generieren' });
        }
    } catch (err) {
        res.json({ success: false, error: err.response?.data?.errors || err.message });
    }
});

// ------------------- UPDATE SERVICE & APIs (GIT-BASIERT) -------------------
let updateStatus = {
    available: false,
    latestVersion: 'Neuer Commit',
    currentVersion: 'v2.1.0',
    downloadUrl: null
};

async function checkForUpdates() {
    return new Promise((resolve) => {
        exec('git fetch && git status -uno', { cwd: __dirname }, (err, stdout) => {
            if (err) {
                return resolve(updateStatus);
            }
            if (stdout.includes('Your branch is behind') || stdout.includes('Dein Branch ist hinter')) {
                updateStatus.available = true;
                updateStatus.latestVersion = 'Neuer Commit (GitHub)';
            } else {
                updateStatus.available = false;
            }
            resolve(updateStatus);
        });
    });
}

setInterval(() => { checkForUpdates(); }, 1000 * 60 * 60);

app.get('/api/update/status', async (req, res) => {
    const status = await checkForUpdates();
    res.json(status);
});

app.post('/api/update/install', async (req, res) => {
    if (!updateStatus.available) {
        return res.status(400).json({ success: false, message: 'Kein Update verfügbar.' });
    }
    try {
        res.json({ success: true, message: 'Update wird im Hintergrund installiert. Das System startet gleich neu.' });
        exec('git pull && npm install', { cwd: __dirname }, (err, stdout, stderr) => {
            if (err) return;
            setTimeout(() => { process.exit(0); }, 1500);
        });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// ------------------- NETWORK & IP STATUS SCANNER -------------------
app.get('/api/network/free-ips', async (req, res) => {
    try {
        const staticIpPool = ['94.249.254.2', '94.249.254.3', '94.249.254.4', '94.249.254.5', '94.249.254.6'];
        const isWin = process.platform === 'win32';

        const pingHost = (ip) => new Promise((resolve) => {
            const cmd = isWin ? `ping -n 1 -w 150 ${ip}` : `ping -c 1 -W 1 ${ip}`;
            exec(cmd, (err, stdout) => {
                const isAlive = !err && (stdout.includes('TTL=') || stdout.includes('bytes from'));
                resolve({ ip, free: !isAlive });
            });
        });

        const ipList = await Promise.all(staticIpPool.map(ip => pingHost(ip)));
        res.json({ success: true, ipList });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ------------------- PROXMOX STORAGE & OS TEMPLATES -------------------
app.get('/api/proxmox/storage/templates', async (req, res) => {
    try {
        const client = pveClient();
        const config = getConfig();
        const node = config.proxmoxNode;

        const storagesRes = await client.get(`/nodes/${node}/storage`);
        const storages = storagesRes.data.data;

        let templates = [];
        for (const store of storages) {
            if (store.content && store.content.includes('vztmpl')) {
                try {
                    const contentRes = await client.get(`/nodes/${node}/storage/${store.storage}/content?content=vztmpl`);
                    templates = templates.concat(contentRes.data.data || []);
                } catch (e) {}
            }
        }
        res.json({ success: true, templates });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/proxmox/storage/isos', async (req, res) => {
    try {
        const isos = [
            { volid: 'ubuntu-cloud', name: 'Ubuntu 24.04 LTS (Direkt-Download & Automatisches Setup)' },
            { volid: 'debian-cloud', name: 'Debian 12 Bookworm (Direkt-Download & Automatisches Setup)' },
            { volid: 'windows-10', name: 'Windows 10 Pro (Automatischer Download & Setup)' },
            { volid: 'windows-11', name: 'Windows 11 Pro (Automatischer Download & Setup)' }
        ];
        res.json({ success: true, isos });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ------------------- PROXMOX CONTROL APIs -------------------
app.get('/api/proxmox/resources', async (req, res) => {
    try {
        const client = pveClient();
        const config = getConfig();
        const node = config.proxmoxNode;

        if (!node) return res.status(400).json({ success: false, error: 'Kein Proxmox-Knoten konfiguriert.' });

        const [qemuRes, lxcRes] = await Promise.allSettled([
            client.get(`/nodes/${node}/qemu`),
            client.get(`/nodes/${node}/lxc`)
        ]);

        const qemus = (qemuRes.status === 'fulfilled' && qemuRes.value.data?.data)
            ? qemuRes.value.data.data.map(vm => ({ ...vm, type: 'qemu' }))
            : [];

        const lxcs = (lxcRes.status === 'fulfilled' && lxcRes.value.data?.data)
            ? lxcRes.value.data.data.map(ct => ({ ...ct, type: 'lxc' }))
            : [];

        const allResources = [...qemus, ...lxcs].map(item => ({
            vmid: item.vmid,
            name: item.name || item.hostname || `VM ${item.vmid}`,
            type: item.type,
            status: (item.status || 'stopped').toLowerCase(),
            maxcpu: item.maxcpu || item.cpus || item.cores || 0,
            maxmem: item.maxmem || item.mem || 0
        }));

        res.json({ success: true, resources: allResources });
    } catch (error) {
        res.status(500).json({ success: false, error: 'Proxmox Abfrage fehlgeschlagen: ' + (error.response?.data?.errors || error.message) });
    }
});

app.post('/api/proxmox/action', async (req, res) => {
    const { vmid, type, action } = req.body;
    const config = getConfig();
    try {
        const client = pveClient();
        if (action === 'delete') {
            await client.delete(`/nodes/${config.proxmoxNode}/${type}/${vmid}`);
            let creds = getCredentials();
            creds = creds.filter(c => c.vmid !== parseInt(vmid));
            saveCredentials(creds);
            res.json({ success: true, message: `${type.toUpperCase()} mit ID ${vmid} wurde gelöscht.` });
        } else {
            const endpoint = `/nodes/${config.proxmoxNode}/${type}/${vmid}/status/${action}`;
            await client.post(endpoint);
            res.json({ success: true, message: `Aktion ${action.toUpperCase()} für VM ${vmid} gesendet.` });
        }
    } catch (error) {
        res.status(500).json({ success: false, error: error.response?.data?.errors || error.message });
    }
});

// ------------------- HINTERGRUND-ERSTELLUNG (NON-BLOCKING) -------------------
app.post('/api/proxmox/create', async (req, res) => {
    const { type, vmid, name, memory, cores, storage, diskSize, ip, template, iso, password, username } = req.body;
    const config = getConfig();
    const client = pveClient();
    const node = config.proxmoxNode;
    const targetStorage = storage || 'local-lvm';
    const diskInGB = diskSize ? parseInt(diskSize) : (type === 'lxc' ? 10 : 40);
    const numericVmid = parseInt(vmid);
    const systemUser = username || 'ubuntu';

    // Zugangsdaten abspeichern
    const creds = getCredentials();
    const filteredCreds = creds.filter(c => c.vmid !== numericVmid);
    filteredCreds.push({
        vmid: numericVmid,
        name: name,
        type: type,
        ip: ip || 'DHCP / Automatisch',
        username: systemUser,
        password: password || 'Aurora1234!'
    });
    saveCredentials(filteredCreds);

    // Sofortige Antwort an den Client, damit die UI sofort frei ist
    res.json({ success: true, message: `System ${name} (ID: ${numericVmid}) wird im Hintergrund eingerichtet!` });

    // Asynchroner Task im Hintergrund
    (async () => {
        try {
            if (type === 'lxc') {
                const lxcData = {
                    vmid: numericVmid,
                    hostname: name,
                    memory: parseInt(memory),
                    cores: parseInt(cores),
                    storage: targetStorage,
                    ostemplate: template || 'local:vztmpl/debian-12-standard_12.2-1_amd64.tar.zst',
                    rootfs: `${targetStorage}:${diskInGB}`,
                    start: 1,
                    onboot: 1,
                    password: password || 'Aurora1234!',
                    cmode: 'shell',
                    unprivileged: 0
                };

                lxcData.net0 = ip ? `name=eth0,bridge=vmbr0,bootproto=static,ip=${ip}/24,gw=94.249.254.1` : 'name=eth0,bridge=vmbr0,bootproto=dhcp';

                await client.post(`/nodes/${node}/lxc`, lxcData);

                setTimeout(async () => {
                    try {
                        await client.post(`/nodes/${node}/lxc/${numericVmid}/exec`, {
                            command: ["bash", "-c", "sed -i 's/#PermitRootLogin.*/PermitRootLogin yes/g' /etc/ssh/sshd_config && systemctl restart ssh"]
                        });
                    } catch (e) {}
                }, 3500);

            } else {
                const isWindows = iso && iso.includes('windows');

                if (isWindows) {
                    const isWin11 = iso.includes('11');
                    const winIsoName = isWin11 ? 'win11-auto.iso' : 'win10-auto.iso';
                    const winUrl = isWin11 
                        ? 'https://go.microsoft.com/fwlink/?linkid=2156295' 
                        : 'https://go.microsoft.com/fwlink/?linkid=2196105';

                    try {
                        await client.post(`/nodes/${node}/storage/${targetStorage}/download-url`, {
                            url: winUrl,
                            filename: winIsoName,
                            content: 'iso'
                        });
                    } catch (e) {}

                    await client.post(`/nodes/${node}/qemu`, {
                        vmid: numericVmid,
                        name: name,
                        memory: parseInt(memory),
                        cores: parseInt(cores),
                        ostype: 'win10',
                        scsihw: 'virtio-scsi-pci',
                        ide2: `${targetStorage}:iso/${winIsoName},media=cdrom`,
                        boot: 'order=ide2;scsi0',
                        onboot: 1,
                        start: 1
                    });

                    await client.post(`/nodes/${node}/qemu/${numericVmid}/config`, {
                        scsi0: `${targetStorage}:${diskInGB}`
                    });

                } else {
                    const isUbuntu = (!iso || iso.includes('ubuntu') || iso.includes('cloud'));
                    const cloudUrl = isUbuntu 
                        ? 'https://cloud-images.ubuntu.com/noble/current/noble-server-cloudimg-amd64.img' 
                        : 'https://cloud.debian.org/images/cloud/bookworm/latest/debian-12-generic-amd64.qcow2';
                    const filename = isUbuntu ? `ubuntu-${numericVmid}.img` : `debian-${numericVmid}.qcow2`;
                    const localImagePath = `/var/tmp/${filename}`;

                    if (!fs.existsSync(localImagePath)) {
                        await new Promise((resolve, reject) => {
                            exec(`curl -L -o ${localImagePath} "${cloudUrl}"`, (err, stdout, stderr) => {
                                if (err) return reject(new Error('Cloud-Image Download fehlgeschlagen: ' + stderr));
                                resolve();
                            });
                        });
                    }

                    // --- AUTOMATISCHES CLOUD-INIT USER-DATA SNIPPET ERSTELLEN ---
                    const snippetsDir = '/var/lib/vz/snippets';
                    if (!fs.existsSync(snippetsDir)) {
                        try { fs.mkdirSync(snippetsDir, { recursive: true }); } catch (e) {}
                    }
                    const snippetFilename = `user-${numericVmid}.yaml`;
                    const snippetPath = path.join(snippetsDir, snippetFilename);
                    
                    const cloudConfigContent = `#cloud-config
users:
  - name: ${systemUser}
    sudo: ['ALL=(ALL) NOPASSWD:ALL']
    shell: /bin/bash
chpasswd:
  list: |
    ${systemUser}:${password || 'Aurora1234!'}
  expire: False
ssh_pwauth: True
packages:
  - openssh-server
  - qemu-guest-agent
runcmd:
  - systemctl enable --now ssh
  - systemctl enable --now qemu-guest-agent
  - mkdir -p /etc/ssh/sshd_config.d
  - echo "PasswordAuthentication yes" > /etc/ssh/sshd_config.d/99-custom-auth.conf
  - sed -i 's/#PasswordAuthentication yes/PasswordAuthentication yes/g' /etc/ssh/sshd_config
  - sed -i 's/PasswordAuthentication no/PasswordAuthentication yes/g' /etc/ssh/sshd_config
  - systemctl restart ssh
`;
                    try {
                        fs.writeFileSync(snippetPath, cloudConfigContent);
                    } catch (e) {
                        console.error('Konnte Cloud-Init Snippet nicht schreiben:', e);
                    }
                    // -------------------------------------------------------------

                    await client.post(`/nodes/${node}/qemu`, {
                        vmid: numericVmid,
                        name: name,
                        memory: parseInt(memory),
                        cores: parseInt(cores),
                        scsihw: 'virtio-scsi-pci',
                        net0: 'virtio,bridge=vmbr0',
                        onboot: 1
                    });

                    await new Promise((resolve, reject) => {
                        exec(`/usr/sbin/qm importdisk ${numericVmid} ${localImagePath} ${targetStorage}`, (err, stdout, stderr) => {
                            if (err) return reject(new Error('Disk Import fehlgeschlagen: ' + stderr));
                            resolve();
                        });
                    });

                    const diskName = `${targetStorage}:vm-${numericVmid}-disk-0`;
                    await client.post(`/nodes/${node}/qemu/${numericVmid}/config`, {
                        scsi0: diskName,
                        ide2: `${targetStorage}:cloudinit`,
                        boot: 'order=scsi0',
                        ciuser: systemUser,
                        cipassword: password || 'Aurora1234!',
                        ipconfig0: ip ? `ip=${ip}/24,gw=94.249.254.1` : 'ip=dhcp',
                        cicustom: `user=local:snippets/${snippetFilename}`
                    });

                    if (diskInGB > 5) {
                        try {
                            await client.put(`/nodes/${node}/qemu/${numericVmid}/resize`, {
                                disk: 'scsi0',
                                size: `${diskInGB}G`
                            });
                        } catch (e) {}
                    }

                    await client.post(`/nodes/${node}/qemu/${numericVmid}/status/start`);
                }
            }
            console.log(`[Hintergrund] System ${name} (ID: ${numericVmid}) mit User '${systemUser}' und automatischem SSH-Setup eingerichtet.`);
        } catch (error) {
            console.error(`[Hintergrund-Fehler] VM ${numericVmid}:`, error.message);
        }
    })();
});

// ------------------- GAME SERVER TEMPLATES -------------------
app.get('/api/gameservers/templates', (req, res) => {
    res.json([
        { id: 'minecraft', name: 'Minecraft Server', icon: 'fa-cubes', color: 'text-green-500', versions: ['1.20.4 (Vanilla)', '1.20.1 (Forge/Mods)', '1.16.5 (Paper)'], defaultPort: 25565, minRam: 2048 },
        { id: 'fivem', name: 'FiveM GTA V Server', icon: 'fa-car', color: 'text-orange-500', versions: ['Recommended Artifacts', 'Latest Artifacts'], defaultPort: 30120, minRam: 4096 }
    ]);
});

const PORT = 3000;
app.listen(PORT, () => console.log(`Aurora OS läuft auf http://localhost:${PORT}`));