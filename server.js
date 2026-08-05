const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const si = require('systeminformation');
const { exec } = require('child_process');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
const CONFIG_PATH = path.join(__dirname, 'config.json');

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

// ------------------- UPDATE SERVICE & APIs (GIT-BASIERT) -------------------
let updateStatus = {
    available: false,
    latestVersion: 'Neuer Commit',
    currentVersion: 'Aktiv',
    downloadUrl: null
};

async function checkForUpdates() {
    return new Promise((resolve) => {
        // Prüft im Hintergrund, ob das lokale Repo hinter dem GitHub-Repo zurück ist
        exec('git fetch && git status -uno', (err, stdout) => {
            if (err) {
                console.error('[Update] Git-Prüfung fehlgeschlagen:', err.message);
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

// Stündlicher automatischer Check
setInterval(() => {
    checkForUpdates();
}, 1000 * 60 * 60);

app.get('/api/update/status', async (req, res) => {
    const status = await checkForUpdates();
    res.json(status);
});

app.post('/api/update/install', async (req, res) => {
    if (!updateStatus.available) {
        return res.status(400).json({ success: false, message: 'Kein Update verfügbar.' });
    }

    try {
        console.log('[Update] Starte automatischen Aktualisierungsprozess...');
        
        // Antwort sofort ans Frontend senden
        res.json({ 
            success: true, 
            message: 'Update wird im Hintergrund installiert. Das System startet gleich neu.' 
        });

        // Git Pull und NPM Install ausführen
        exec('git pull && npm install', (err, stdout, stderr) => {
            if (err) {
                console.error('[Update-Fehler]:', stderr);
                return;
            }
            console.log('[Update-Erfolg]:', stdout);

            // Prozess nach kurzer Verzögerung beenden (Systemd startet die App automatisch neu)
            setTimeout(() => {
                process.exit(0);
            }, 1500);
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

// ------------------- PROXMOX STORAGE & AUTO-DOWNLOAD -------------------
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
            { volid: 'ubuntu-24.04-cloud', name: 'Ubuntu 24.04.4 LTS (Cloud-Init / 100% Automatisch)', size: 650000000 },
            { volid: 'debian-12-cloud', name: 'Debian 12 Bookworm (Cloud-Init / 100% Automatisch)', size: 450000000 }
        ];
        res.json({ success: true, isos });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/proxmox/download-url', async (req, res) => {
    const { url, filename, content, storage } = req.body;
    const config = getConfig();
    try {
        const client = pveClient();
        const targetStorage = storage || 'local';
        const targetContent = content || 'import';

        const response = await client.post(`/nodes/${config.proxmoxNode}/storage/${targetStorage}/download-url`, {
            url: url,
            filename: filename,
            content: targetContent
        });

        res.json({ success: true, message: 'Automatischer Download in Proxmox gestartet!', task: response.data });
    } catch (error) {
        res.status(500).json({ success: false, error: error.response?.data?.errors || error.message });
    }
});

app.post('/api/proxmox/download-cloud-image', async (req, res) => {
    const config = getConfig();
    try {
        const client = pveClient();
        const targetStorage = req.body.storage || 'local';
        const debianUrl = 'https://cloud.debian.org/images/cloud/bookworm/latest/debian-12-generic-amd64.qcow2';
        const filename = 'debian-12-generic-amd64.qcow2';

        const response = await client.post(`/nodes/${config.proxmoxNode}/storage/${targetStorage}/download-url`, {
            url: debianUrl,
            filename: filename,
            content: 'import'
        });

        res.json({ success: true, message: 'Debian 12 Cloud-Image wird im Hintergrund heruntergeladen!', task: response.data });
    } catch (error) {
        res.status(500).json({ success: false, error: error.response?.data?.errors || error.message });
    }
});

app.post('/api/proxmox/download-ubuntu-cloud-image', async (req, res) => {
    const config = getConfig();
    try {
        const client = pveClient();
        const targetStorage = req.body.storage || 'local';
        const ubuntuUrl = 'https://cloud-images.ubuntu.com/noble/current/noble-server-cloudimg-amd64.img';
        const filename = 'ubuntu-24.04-server-cloudimg-amd64.img';

        const response = await client.post(`/nodes/${config.proxmoxNode}/storage/${targetStorage}/download-url`, {
            url: ubuntuUrl,
            filename: filename,
            content: 'import'
        });

        res.json({ success: true, message: 'Ubuntu 24.04 LTS Cloud-Image wird im Hintergrund heruntergeladen!', task: response.data });
    } catch (error) {
        res.status(500).json({ success: false, error: error.response?.data?.errors || error.message });
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

async function waitForTask(client, node, upid) {
    for (let i = 0; i < 90; i++) {
        try {
            const res = await client.get(`/nodes/${node}/tasks/${upid}/status`);
            const data = res.data?.data;
            if (data && data.status === 'stopped') {
                if (data.exitstatus === 'OK') {
                    return true;
                } else {
                    throw new Error(`Proxmox Task fehlgeschlagen mit Status: ${data.exitstatus}`);
                }
            }
        } catch (e) {
            if (e.message && e.message.includes('fehlgeschlagen')) throw e;
        }
        await new Promise(resolve => setTimeout(resolve, 2000));
    }
    throw new Error('Download-Timeout in Proxmox überschritten.');
}

async function ensureCloudTemplate(client, node, targetStorage, isUbuntu) {
    const templateId = isUbuntu ? 9000 : 9001;
    const templateName = isUbuntu ? 'ubuntu-2404-cloud-template' : 'debian-12-cloud-template';
    const cloudUrl = isUbuntu ? 'https://cloud-images.ubuntu.com/noble/current/noble-server-cloudimg-amd64.img' : 'https://cloud.debian.org/images/cloud/bookworm/latest/debian-12-generic-amd64.qcow2';
    const filename = isUbuntu ? 'ubuntu-24.04-server-cloudimg-amd64.img' : 'debian-12-generic-amd64.qcow2';
    const localImagePath = `/var/tmp/${filename}`;

    try {
        const listRes = await client.get(`/nodes/${node}/qemu`);
        const vms = listRes.data?.data || [];
        const existingVm = vms.find(v => v.vmid === templateId);
        if (existingVm) {
            return templateId;
        }
    } catch (e) {}

    if (!fs.existsSync(localImagePath)) {
        await new Promise((resolve, reject) => {
            exec(`curl -L -o /var/tmp/${filename} "${cloudUrl}"`, (err, stdout, stderr) => {
                if (err) return reject(new Error('Cloud-Image Download fehlgeschlagen: ' + stderr));
                resolve();
            });
        });
    }

    await new Promise((resolve, reject) => {
        exec(`/usr/sbin/qm create ${templateId} --name ${templateName} --memory 2048 --cores 2 --scsihw virtio-scsi-pci --net0 virtio,bridge=vmbr0`, (err, stdout, stderr) => {
            if (err) return reject(new Error('Template VM Erstellung fehlgeschlagen: ' + stderr));
            resolve();
        });
    });

    await new Promise((resolve, reject) => {
        exec(`/usr/sbin/qm importdisk ${templateId} ${localImagePath} ${targetStorage} && /usr/sbin/qm set ${templateId} --virtio0 ${targetStorage}:vm-${templateId}-disk-0 --ide2 ${targetStorage}:cloudinit --boot order=virtio0`, (err, stdout, stderr) => {
            if (err) return reject(new Error('Template Disk Import fehlgeschlagen: ' + stderr));
            resolve();
        });
    });

    await new Promise((resolve, reject) => {
        exec(`/usr/sbin/qm template ${templateId}`, (err, stdout, stderr) => {
            if (err) return reject(new Error('Konvertierung in Template fehlgeschlagen: ' + stderr));
            resolve();
        });
    });

    return templateId;
}

app.post('/api/proxmox/create', async (req, res) => {
    const { type, vmid, name, memory, cores, storage, diskSize, ip, template, iso, password, osFlavor } = req.body;
    const config = getConfig();
    try {
        const client = pveClient();
        const diskInGB = diskSize ? parseInt(diskSize) : (type === 'lxc' ? 8 : 20);
        const targetStorage = storage || 'local-lvm';
        const node = config.proxmoxNode;

        if (type === 'lxc') {
            const lxcData = {
                vmid: parseInt(vmid),
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

            if (ip) {
                lxcData.net0 = `name=eth0,bridge=vmbr0,bootproto=static,ip=${ip}/24,gw=94.249.254.1`;
            } else {
                lxcData.net0 = 'name=eth0,bridge=vmbr0,bootproto=dhcp';
            }

            await client.post(`/nodes/${node}/lxc`, lxcData);

            setTimeout(async () => {
                try {
                    await client.post(`/nodes/${node}/lxc/${vmid}/exec`, {
                        command: ["bash", "-c", "sed -i 's/#PermitRootLogin.*/PermitRootLogin yes/g' /etc/ssh/sshd_config && systemctl restart ssh"]
                    });
                } catch (e) {}
            }, 3500);

        } else {
            const isUbuntu = (osFlavor && osFlavor.toLowerCase().includes('ubuntu')) || 
                             (name && name.toLowerCase().includes('ubuntu')) || 
                             (iso && iso.toLowerCase().includes('ubuntu')) ||
                             (!iso || iso.includes('ubuntu') || iso.includes('cloud'));

            const templateId = await ensureCloudTemplate(client, node, targetStorage, isUbuntu);

            await client.post(`/nodes/${node}/qemu/${templateId}/clone`, {
                newid: parseInt(vmid),
                name: name,
                full: 0,
                storage: targetStorage
            });

            await new Promise(resolve => setTimeout(resolve, 2500));

            const updateParams = {
                memory: parseInt(memory),
                cores: parseInt(cores),
                ciuser: 'root',
                cipassword: password || 'Aurora1234!',
                boot: 'order=virtio0' // Bootreihenfolge fix für geklonte KVM VMs
            };

            if (ip) {
                updateParams.ipconfig0 = `ip=${ip}/24,gw=94.249.254.1`;
            } else {
                updateParams.ipconfig0 = `ip=dhcp`;
            }

            await client.post(`/nodes/${node}/qemu/${vmid}/config`, updateParams);

            if (diskInGB > 10) {
                try {
                    await client.put(`/nodes/${node}/qemu/${vmid}/resize`, {
                        disk: 'virtio0',
                        size: `${diskInGB}G`
                    });
                } catch (e) {}
            }

            await client.post(`/nodes/${node}/qemu/${vmid}/status/start`);
        }

        res.json({ success: true, message: `Erfolgreich erstellt! Verbinde dich in MobaXterm über SSH: root@${ip || '94.249.254.X'}` });
    } catch (error) {
        const errorDetails = error.response?.data?.errors || error.response?.data?.message || error.message;
        console.error("Proxmox API Error:", error.response?.data || error.message);
        res.status(500).json({ success: false, error: errorDetails });
    }
});

// ------------------- GAME SERVER TEMPLATES -------------------
app.get('/api/gameservers/templates', (req, res) => {
    res.json([
        {
            id: 'minecraft',
            name: 'Minecraft Server',
            icon: 'fa-cubes',
            color: 'text-green-500',
            versions: ['1.20.4 (Vanilla)', '1.20.1 (Forge/Mods)', '1.16.5 (Paper)', '1.12.2 (Modpack)', '1.8.9 (Spigot)'],
            defaultPort: 25565,
            minRam: 2048
        },
        {
            id: 'fivem',
            name: 'FiveM GTA V Server',
            icon: 'fa-car',
            color: 'text-orange-500',
            versions: ['Recommended Artifacts', 'Latest Artifacts', 'txAdmin Full Pack'],
            defaultPort: 30120,
            minRam: 4096
        },
        {
            id: 'ls22',
            name: 'Landwirtschafts-Simulator 22',
            icon: 'fa-tractor',
            color: 'text-yellow-500',
            versions: ['LS22 Dedicated Server Standard', 'LS22 Crossplay Edition'],
            defaultPort: 10823,
            minRam: 4096
        },
        {
            id: 'ls15',
            name: 'Landwirtschafts-Simulator 15',
            icon: 'fa-wheat-awn',
            color: 'text-lime-500',
            versions: ['LS15 Dedicated Server v1.4.2'],
            defaultPort: 10815,
            minRam: 2048
        }
    ]);
});

const PORT = 3000;
app.listen(PORT, () => console.log(`Aurora OS läuft auf http://localhost:${PORT}`));