# Genesis-MD

Bot WhatsApp multifonction basé sur Baileys.

## Architecture de Sécurité (Intégrité)

Le projet utilise une vérification d'intégrité au démarrage pour prévenir toute modification non autorisée du code source.

### Fonctionnement :
- **Point d'entrée :** `index.js` appelle systématiquement `require('./utils/core-init');` lors de son initialisation.
- **Vérification :** Le module `core-init.js` (obscurci) calcule en temps réel le hash SHA256 et la taille des dossiers critiques (`index.js`, `commands/`, `utils/`, `constants/`).
- **Validation :** Ces valeurs sont comparées à un jeu de données de référence. Si une disparité est détectée, le processus est immédiatement tué (`process.exit(1)`).
- **Exclusion :** Le fichier `utils/core-init.js` est exclu du calcul d'intégrité pour éviter les dépendances circulaires.

### Maintenance :
- **Version saine :** Une copie non-obscurcie, `core-init-healthy.js`, est conservée à la racine du projet pour référence et audit.
- **Obscurcissement :** Le script `obfuscate.js` protège le code de production.
- **Mise à jour :** En cas de modification du code, les hashes dans `core-init.js` et `core-init-healthy.js` doivent être recalculés avant l'obscurcissement et le déploiement.

---
*Dernière mise à jour : 12 avril 2026*
