const axios = require('axios');
const fs = require('fs');
const path = require('path');

let updateStatus = {
    available: false,
    latestVersion: null,
    currentVersion: '1.0.0',
    downloadUrl: null
};

// Aktuelle Version aus config.json laden
function getCurrentVersion() {
    try {
        const configPath = path.join(__dirname, '../config.json');
        if (fs.existsSync(configPath)) {
            const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
            if (config.version) updateStatus.currentVersion = config.version;
        }
    } catch (err) {
        console.error('Fehler beim Lesen der config.json:', err);
    }
}

// Auf Updates prüfen (z.B. über GitHub Releases)
async function checkForUpdates() {
    getCurrentVersion();
    try {
        const response = await axios.get('https://api.github.com/repos/dein-repo/aurora-os/releases/latest');
        const latestVersion = response.data.tag_name.replace('v', '');
        
        if (latestVersion !== updateStatus.currentVersion) {
            updateStatus.available = true;
            updateStatus.latestVersion = latestVersion;
            updateStatus.downloadUrl = response.data.zipball_url;
            console.log(`[Update] Neue Version ${latestVersion} verfügbar!`);
        } else {
            updateStatus.available = false;
        }
    } catch (err) {
        console.error('[Update] Fehler bei der Überprüfung:', err.message);
    }
    return updateStatus;
}

// Wöchentlicher Check (Prüfung jeden Sonntag um 03:00 Uhr)
setInterval(() => {
    const now = new Date();
    if (now.getDay() === 0 && now.getHours() === 3) {
        checkForUpdates();
    }
}, 1000 * 60 * 60);

module.exports = { checkForUpdates, getStatus: () => updateStatus };