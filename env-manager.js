// config.js
const fs = require('fs');
const path = require('path');
const EnvKeys = require('./constants/EnvKeys'); // Import de l'Enum
require('dotenv').config();

class ConfigManager {
    constructor() {
        this.envPath = path.join(__dirname, '.env');
        this.refresh();
    }

    refresh() {
        // Chargement dynamique basé sur les clés de l'Enum
        Object.values(EnvKeys).forEach(key => {
            this[key] = process.env[key];
        });
        
        // Conversions de types spécifiques
        this[EnvKeys.BOT_PUBLIC] = process.env[EnvKeys.BOT_PUBLIC] === "true";
        this[EnvKeys.USE_PAIRING_CODE] = process.env[EnvKeys.USE_PAIRING_CODE] === "true";
        this[EnvKeys.DATABASE] = process.env[EnvKeys.DATABASE] === "true";
    }

    /**
     * Utilisation de l'Enum pour lire une donnée
     */
    get(key) {
        if (!Object.values(EnvKeys).includes(key)) {
            console.warn(`⚠️ Tentative de lecture d'une clé inexistante : ${key}`);
        }
        return this[key];
    }

    /**
     * Utilisation de l'Enum pour mettre à jour
     */
    async update(key, value) {
        if (!Object.values(EnvKeys).includes(key)) {
            const err = `Clé de configuration invalide : ${key}`;
            fs.appendFileSync('error_log.txt', `[${new Date().toLocaleString()}] ${err}\n`);
            return false;
        }

        try {
            this[key] = value;
            let envContent = fs.readFileSync(this.envPath, 'utf8');
            const regex = new RegExp(`^${key}=.*`, 'm');

            if (regex.test(envContent)) {
                envContent = envContent.replace(regex, `${key}=${value}`);
            } else {
                envContent += `\n${key}=${value}`;
            }

            fs.writeFileSync(this.envPath, envContent.trim() + '\n');
            return true;
        } catch (error) {
            fs.appendFileSync('error_log.txt', `[${new Date().toLocaleString()}] Erreur Enum Update: ${error.message}\n`);
            return false;
        }
    }
}

module.exports = new ConfigManager();