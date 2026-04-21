require("./core-init");
const {
  makeWASocket,
  DisconnectReason,
  fetchLatestBaileysVersion,
  downloadMediaMessage,
  BufferJSON,
} = require("@whiskeysockets/baileys");

//connexion
let sock = null;
let isConnected = false;
let isFirstConnect = true;

const path = require("path");
const fs = require("fs");
const { execSync } = require("child_process");

// =========================================================
// 0. VÉRIFICATION ET APPLICATION DES BACKUPS (CRITIQUE)
// =========================================================
const pendingBackupPath = path.join(__dirname, "temp", "pending_backup.zip");
if (fs.existsSync(pendingBackupPath)) {
  console.log(
    "📦 [BACKUP] Un backup en attente a été détecté. Application en cours...",
  );
  try {
    const AdmZip = require("adm-zip");
    const zip = new AdmZip(pendingBackupPath);
    const extractDir = path.join(__dirname, "temp", `restore_${Date.now()}`);

    if (!fs.existsSync(extractDir))
      fs.mkdirSync(extractDir, { recursive: true });

    // 1. Extraire
    zip.extractAllTo(extractDir, true);

    // 2. Restaurer les fichiers critiques
    const filesToRestore = [
      { src: ".env", dest: ".env" },
      { src: "genesis_md_memory.db", dest: "db/genesis_md_memory.db" },
      { src: "json", dest: "json" },
      { src: "media/menu.png", dest: "media/menu.png" },
    ];

    for (const item of filesToRestore) {
      const fullSrc = path.join(extractDir, item.src);
      const fullDest = path.join(__dirname, item.dest);

      if (fs.existsSync(fullSrc)) {
        if (fs.lstatSync(fullSrc).isDirectory()) {
          if (fs.existsSync(fullDest))
            fs.rmSync(fullDest, { recursive: true, force: true });
          fs.cpSync(fullSrc, fullDest, { recursive: true });
        } else {
          fs.copyFileSync(fullSrc, fullDest);
        }
      }
    }

    // 3. Nettoyer
    fs.unlinkSync(pendingBackupPath);
    fs.rmSync(extractDir, { recursive: true, force: true });

    console.log(
      "✅ [BACKUP] Backup appliqué avec succès. Redémarrage du processus avec les nouvelles données...",
    );
  } catch (err) {
    console.error(
      "❌ [BACKUP] Échec de l'application du backup :",
      err.message,
    );
    fs.appendFileSync(
      "error_restore_startup.txt",
      `[${new Date().toLocaleString()}] ${err.stack}\n`,
    );
  }
}

const animemj = require("./commands/10_fun/animemj"); // Adapte le chemin
const pino = require("pino");
const NodeCache = require("node-cache");
const qrcode = require("qrcode-terminal");
const readline = require("readline");
const envManager = require("./env-manager");
const EnvKeys = require("./constants/EnvKeys"); // Import de l'Enum
const { isUserMuted } = require("./utils/muteUtils");
const { getContentType } = require("@whiskeysockets/baileys");
const {
  hasImage,
  deleteMessageBykey,
  hasLink,
  warnUser,
  randomSleep,
  getMessageText,
  unwrapMessage,
  dynamicInterval,
  getRandomNumber,
  toMilliseconds,
  errorCommand,
  handleSmartGPT,
  writeErrorToFile,
  sendMessage,
  isBotMessage,
  handleAntiDelete,
  isOwner,
  isSudo,
  isOwnerLid,
  handleAutoStatusDm,
  handleAutoLikeStatus,
  handleAutoViewStatus,
  handlePendingStep,
} = require("./utils/helpers");
const CommandsName = require("./constants/CommandsName");
const Player = require("./models/Player");
const {
  db,
  saveMessage,
  getMessage,
  processScheduledMessage,
  getProgrammedMessages,
  getRepeatedMessages,
  processRepeatMessage,
} = require("./db/database");
const authDb = require("./utils/auth-db");
const { useSQLiteAuthState } = require("./utils/sqlite-auth");
const { env } = require("process");
const { isUserAdmin, isBotAdmin } = require("./utils/group-helpers");
const { isAntiImageActive } = require("./commands/04_group/anti-image");
const { isAntiLinkActive } = require("./commands/04_group/anti-link");
const { isAntiStickerActive } = require("./commands/04_group/anti-sticker");
const {
  isAntiStatusGMentionActive,
} = require("./commands/04_group/antistatusgmention");
const { isAntiSpamActive } = require("./commands/04_group/anti-spam");
const { isAntiPromoteActive } = require("./commands/04_group/antipromote");

// --- 🛡️ SYSTÈME ANTI-SPAM (MÉMOIRE) ---
const messageTimestamps = {}; // { [jid]: { [sender]: [timestamp1, timestamp2, ...] } }
// -------------------------------------

// --- CONFIGURATION DU CACHE NATIF BAILEYS ---
const groupCache = new NodeCache({ stdTTL: 5 * 60, useClones: false });
// --------------------------------------------

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

let messagesPendingRemoval = {};
let msg;
let cmdsToRun = [];
let ownerjid;

const question = (text) => new Promise((resolve) => rl.question(text, resolve));

// 0. CHARGEMENT ET CONFIGURATION SYSTÈME
const timezone = envManager.get(EnvKeys.TIMEZONE) || "Africa/Abidjan";
process.env.TZ = timezone;
console.log(`🌍 [SYSTEM] Fuseau horaire réglé sur : ${process.env.TZ}`);

// =========================================================
// 1. DÉFINITION DU POINT D'ENTRÉE (BOT)
// =========================================================
const antilinkGroupSettingsPath = path.join(
  __dirname,
  "/json/antilink-groups.json",
);
const antiimageGroupSettingsPath = path.join(
  __dirname,
  "/json/antiimage-groups.json",
);

const antistickerGroupSettingsPath = path.join(
  __dirname,
  "/json/antisticker-groups.json",
);
const tempPath = path.join(__dirname, "temp");

// --- LECTURE VERSION DEPUIS PACKAGE.JSON ---
const packageJsonPath = path.join(__dirname, "package.json");
let metadata = {
  version: "1.0.1-unknown",
  author: "genesis-dev417",
};

try {
  const pkg = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8"));
  metadata.version = pkg.version;
  metadata.author = pkg.author || metadata.author;
} catch (err) {
  console.error("⚠️ [INIT] Impossible de lire package.json :", err.message);
}
// --------------------------------------------
console.log("\n" + "=".repeat(40));
console.log(
  ` DEMARRAGE DU BOT : ${envManager.get(EnvKeys.BOT_NAME) || "MUICHIRO"}`,
); // ✅ CORRECTION
console.log(`📦 Version : ${metadata.version} | Build : ${metadata.version}`);
console.log("=".repeat(40) + "\n");

console.log("📂 [INIT] Vérification des dossiers...");
if (!fs.existsSync(antilinkGroupSettingsPath)) {
  if (!fs.existsSync(path.join(__dirname, "json")))
    fs.mkdirSync(path.join(__dirname, "json"));
  fs.writeFileSync(
    antilinkGroupSettingsPath,
    JSON.stringify({ groups: {} }, null, 2),
  );
  console.log("✅ [INIT] Dossier /json et antilink-group.json créés");
}

if (!fs.existsSync(antiimageGroupSettingsPath)) {
  if (!fs.existsSync(path.join(__dirname, "json")))
    fs.mkdirSync(path.join(__dirname, "json"));
  fs.writeFileSync(
    antiimageGroupSettingsPath,
    JSON.stringify({ groups: {} }, null, 2),
  );
  console.log("✅ [INIT] Dossier /json et antilink-group.json créés");
}

if (!fs.existsSync(antistickerGroupSettingsPath)) {
  if (!fs.existsSync(path.join(__dirname, "json")))
    fs.mkdirSync(path.join(__dirname, "json"));
  fs.writeFileSync(
    antistickerGroupSettingsPath,
    JSON.stringify({ groups: {} }, null, 2),
  );
  console.log("✅ [INIT] Dossier /json et antisticker-group.json créés");
}

if (!fs.existsSync(tempPath)) {
  fs.mkdirSync(tempPath);
}

// =========================================================
// FIX : PERMISSIONS YT-DLP
// =========================================================
const ytDlpPath = path.join(__dirname, "yt-dlp");
if (fs.existsSync(ytDlpPath)) {
  try {
    fs.chmodSync(ytDlpPath, 0o755);
    console.log("🔓 [SYSTEM] Permissions d'exécution accordées à yt-dlp");
  } catch (err) {
    const permError = `❌ [SYSTEM] Erreur permission yt-dlp: ${err.message}`;
    console.error(permError);
    fs.writeFileSync(`error_perm_${Date.now()}.txt`, permError);
  }
}

const getBotImagePath = () => path.join(__dirname, "media", "menu.png");
// =========================================================
// 1. GESTION DES ERREURS (.TXT)
// =========================================================
global.sendErrorLog = async (sock, jid, msg, errorDetails, type = "CRASH") => {
  let logPath = null;
  try {
    const logFileName = `error_${Date.now()}.txt`;
    logPath = path.join(process.cwd(), logFileName);
    const content = `⚠️ RAPPORT D'ERREUR\n📅 ${new Date().toLocaleString()}\n🔧 Commande: ${type}\n❌ Erreur:\n${errorDetails}`;
    fs.writeFileSync(logPath, content, "utf8");
    if (sock && jid) {
      await sock.sendMessage(
        jid,
        {
          document: fs.readFileSync(logPath),
          mimetype: "text/plain",
          fileName: logFileName,
          caption: `❌ Erreur : ${type}`,
        },
        { quoted: msg },
      );
      fs.unlinkSync(logPath);
    }
  } catch (e) {
    if (logPath && fs.existsSync(logPath)) fs.unlinkSync(logPath);
  } finally {
    await sock.sendMessage(jid, { react: { text: "", key: msg.key } });
  }
};

// =========================================================
// 2. CHARGEMENT DES COMMANDES (AVEC LOGS)
// =========================================================
const allCommands = {};
const commandsDir = path.join(__dirname, "commands");
const tools = {
  getPrefix: () => envManager.get(EnvKeys.PREFIX),
  getBotImagePath,
  metadata,
  allCommands,
  groupCache, // Ajout du cache pour un accès global par les commandes
  sendMessage, // Injection de la fonction globale
};

console.log("🛠️  [LOADER] Chargement des commandes...");
if (fs.existsSync(commandsDir)) {
  const categories = fs
    .readdirSync(commandsDir)
    .filter((f) => fs.statSync(path.join(commandsDir, f)).isDirectory());
  categories.forEach((cat) => {
    allCommands[cat] = {};
    const files = fs
      .readdirSync(path.join(commandsDir, cat))
      .filter((f) => f.endsWith(".js"));
    console.log(`   └─ 📁 ${cat.toUpperCase()} (${files.length} fichiers)`);
    files.forEach((file) => {
      try {
        const cmd = require(path.join(commandsDir, cat, file));
        allCommands[cat][cmd.name] = cmd;
        if (cmd.init) cmd.init(tools);
      } catch (e) {
        console.error(`      ❌ Erreur ${file}:`, e.message);
      }
    });
  });
}
console.log("✅ [LOADER] Toutes les commandes sont prêtes");

// =========================================================
// 3. LOGIQUE DU BOT
// =========================================================
async function startBot() {
  let isProcessing = false;

  // --- RESTAURATION DE SESSION VIA API (ADAPTÉE POUR SQLITE) ---
  const rawSessionId = envManager.get(EnvKeys.SESSION_ID);
  const sessionId = (rawSessionId || "").trim();
  const SESSION_PREFIX = "Genesis-MD_";
  const SESSION_SERVER_URL = "https://genesis-md.gs-tech.online";

  if (sessionId && sessionId !== "" && sessionId.startsWith(SESSION_PREFIX)) {
    // Vérifier si on a déjà des données dans la table authentication de la DB dédiée
    const hasCreds = await new Promise((resolve) => {
      authDb.get(
        "SELECT id FROM authentication WHERE category = 'creds' AND id = 'latest'",
        (err, row) => {
          resolve(!!row);
        },
      );
    });

    if (!hasCreds) {
      console.log(
        `🌐 [AUTH] Tentative de restauration pour ID: "${sessionId}"...`,
      );
      try {
        const axios = require("axios");
        const response = await axios.get(
          `${SESSION_SERVER_URL}/api/restore-session/${encodeURIComponent(sessionId)}`,
        );
        const fullAuthData = response.data;

        console.log("💉 [AUTH] Injection de la session dans la DB dédiée...");

        await new Promise((resolve, reject) => {
          authDb.serialize(() => {
            authDb.run("BEGIN TRANSACTION");
            try {
              const stmt = authDb.prepare(
                "INSERT OR REPLACE INTO authentication (category, id, value) VALUES (?, ?, ?)",
              );
              const knownTypes = [
                "pre-key",
                "session",
                "sender-key",
                "app-state-sync-key",
                "app-state-sync-key-share",
                "next-pre-key",
              ];

              for (const fileName in fullAuthData) {
                let category, id;
                const fileNameNoExt = fileName.replace(".json", "");

                if (fileName === "creds.json") {
                  category = "creds";
                  id = "latest";
                } else {
                  const type = knownTypes.find((t) =>
                    fileNameNoExt.startsWith(t + "-"),
                  );
                  if (type) {
                    category = type;
                    id = fileNameNoExt.slice(type.length + 1);
                  } else {
                    const parts = fileNameNoExt.split("-");
                    id = parts.pop();
                    category = parts.join("-");
                  }
                }

                // --- CRUCIAL : Réanimation et Re-stockage propre ---
                const contentStr = JSON.stringify(fullAuthData[fileName]);
                const revivedData = JSON.parse(contentStr, BufferJSON.reviver);
                const value = JSON.stringify(revivedData, BufferJSON.replacer);
                stmt.run(category, id, value);
              }
              stmt.finalize();
              authDb.run("COMMIT", (err) => (err ? reject(err) : resolve()));
            } catch (e) {
              authDb.run("ROLLBACK");
              reject(e);
            }
          });
        });

        console.log(
          "✅ [AUTH] Session restaurée avec succès dans la DB dédiée.",
        );
      } catch (err) {
        console.error(
          "❌ [AUTH] Échec de la restauration:",
          err.response?.data?.error || err.message,
        );
      }
    } else {
      console.log("✅ [AUTH] Session existante trouvée dans la DB dédiée.");
    }
  }
  // -------------------------------------------------------------

  const { state, saveCreds } = await useSQLiteAuthState();
  const { version } = await fetchLatestBaileysVersion();

  console.log("🌐 [NETWORK] Initialisation de la connexion...");
  sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: "silent" }),
    browser: ["Ubuntu", "Chrome", "20.0.04"],
    printQRInTerminal: !envManager.get(EnvKeys.USE_PAIRING_CODE),

    // --- CACHE NATIF DES MÉTADONNÉES DE GROUPE ---
    cachedGroupMetadata: async (jid) => groupCache.get(jid),
    // --------------------------------------------

    // --- OPTIMISATIONS DE DÉCHIFFREMENT ---
    syncFullHistory: false,
    shouldSyncHistoryMessage: () => false,
  });

  sock.ev.on("group-participants.update", async (event) => {
    //console.log("DEBUG EVENT PARTICIPANTS.UPDATE:", JSON.stringify(event, null, 2));
    const { id, participants, action, author } = event;

    //list de lid a remote pour antiremote
    var pendingLidAtRemote = [];

    // 1. Récupération asynchrone avec "Lazy Loading" (si absent du cache)
    let metadata = groupCache.get(id);
    if (!metadata) {
      console.log(
        `⚠️ [CACHE] Absence de metadata pour ${id}, récupération forcée...`,
      );
      try {
        metadata = await sock.groupMetadata(id);
        groupCache.set(id, metadata);
      } catch (err) {
        console.error(`❌ [CACHE] Échec récupération ${id}:`, err.message);
        return; // On ne peut pas continuer sans metadata
      }
    }

    let updatedParticipants = [...metadata.participants];
    participants.forEach((element) => {
      // Correction du push : utilisation de () au lieu de []
      const pId =
        typeof element === "object" && element.id ? element.id : element;
      pendingLidAtRemote.push(pId);
    });

    // Fonction helper pour extraire le numéro pur (sans @...)
    const getPureId = (id) => (id || "").split("@")[0].split(":")[0];
    const targetPureIds = participants.map((p) => getPureId(typeof p === "object" ? p.id : p));

    switch (action) {
      case "add":
        participants.forEach((p) => {
          const pId = typeof p === "object" ? p.id : p;
          const purePId = getPureId(pId);
          if (!updatedParticipants.find((x) => getPureId(x.id) === purePId)) {
            updatedParticipants.push({ id: pId, admin: null });
          }
        });
        console.log(
          `➕ [CACHE] ${participants.length} membre(s) ajouté(s) au groupe ${id}`,
        );
        break;

      case "remove":
        updatedParticipants = updatedParticipants.filter(
          (p) => !targetPureIds.includes(getPureId(p.id)),
        );
        console.log(
          `➖ [CACHE] ${participants.length} membre(s) retiré(s) du groupe ${id}`,
        );
        break;

      case "demote":
        // Mise à jour locale du cache : retrait des droits admin
        updatedParticipants = updatedParticipants.map((p) =>
          targetPureIds.includes(getPureId(p.id)) ? { ...p, admin: null } : p,
        );
        console.log(
          `📉 [CACHE] Rétrogradation de ${participants.length} membre(s) dans ${id}`,
        );
        break;

      case "promote":
        // --- 🛡️ LOGIQUE ANTI-PROMOTE (Uniquement sur promotion et si l'auteur n'est pas autorisé) ---
        if (
          isAntiPromoteActive(id) &&
          !isOwnerLid(author) &&
          (await isBotAdmin(sock, id, groupCache))
        ) {
          const botId = getPureId(sock.user.id);
          const ownerNum = envManager.get(EnvKeys.OWNER_NUMBER).replace(/\D/g, "");

          // On retire le bot et l'owner de la liste à rétrograder
          const targets = pendingLidAtRemote.filter((pId) => {
            const pure = getPureId(pId);
            return pure !== botId && pure !== ownerNum;
          });

          if (targets.length > 0) {
            console.log(
              `🔍 [ANTIPROMOTE] Promotion non autorisée détectée sur ${id}. Attente de 2s...`,
            );

            setTimeout(async () => {
              try {
                const meta = await sock.groupMetadata(id);
                const actualAdmins = meta.participants
                  .filter((p) => {
                    const pure = getPureId(p.id);
                    return targets.some(t => getPureId(t) === pure) && p.admin === "admin";
                  })
                  .map((p) => p.id);

                if (actualAdmins.length > 0) {
                  await sock.groupParticipantsUpdate(id, actualAdmins, "demote");
                  await sendMessage(sock, id, "🛡️ *Anti-Promote* : Promotion non autorisée détectée.");
                }
              } catch (err) {
                console.error("❌ [ANTIPROMOTE] Erreur:", err.message);
              }
            }, 2000);
          }
        }
        // --------------------------------------------

        // Mise à jour locale du cache : ajout des droits admin
        updatedParticipants = updatedParticipants.map((p) =>
          targetPureIds.includes(getPureId(p.id)) ? { ...p, admin: "admin" } : p,
        );
        console.log(
          `📈 [CACHE] Promotion de ${participants.length} membre(s) dans ${id}`,
        );
        break;
    }

    groupCache.set(id, { ...metadata, participants: updatedParticipants });
  });
  // ------------------------------------------

  if (
    envManager.get(EnvKeys.USE_PAIRING_CODE) &&
    !sock.authState.creds.registered
  ) {
    console.log("🔑 [AUTH] Mode Pairing Code activé...");
    setTimeout(async () => {
      try {
        let phoneNumber = envManager
          .get(EnvKeys.OWNER_NUMBER)
          .replace(/[^0-9]/g, "");
        if (phoneNumber) {
          let code = await sock.requestPairingCode(phoneNumber);
          code = code?.match(/.{1,4}/g)?.join("-") || code;
          console.log("\n" + "=".repeat(40));
          console.log(` TON CODE WHATSAPP : ${code}`);
          console.log("=".repeat(40) + "\n");
        }
      } catch (err) {
        console.error("❌ Erreur Pairing Code:", err.message);
      }
    }, 5000);
  }

  sock.ev.on("creds.update", saveCreds);

  // --- GESTION DES CLÉS D'ÉTAT (APPSTATE) ---
  sock.ev.on("app-state-sync-key.update", (update) => {
    // Baileys gère déjà la mise à jour via state.saveCreds() mais
    // cet événement peut aider à forcer la synchronisation si nécessaire.
    console.log("🔑 [AUTH] Mise à jour des clés AppState reçue.");
  });
  // ------------------------------------------

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr && !envManager.get(EnvKeys.USE_PAIRING_CODE)) {
      console.log("📱 [AUTH] QR Code généré (scannez-le)");
      qrcode.generate(qr, { small: true });
    }

    if (connection === "open") {
      isConnected = true;
      let ownerRaw = envManager.get(EnvKeys.OWNER_NUMBER);

      // --- 🆔 CAPTURE DES MÉTADONNÉES DU BOT (JID/LID) ---
      const botJid = sock.user.id.split(":")[0] + "@s.whatsapp.net";
      const botLid = sock.user.lid || null;
      const metadataPath = path.join(__dirname, "json", "bot-metadata.json");

      try {
        if (!fs.existsSync(path.dirname(metadataPath))) {
          fs.mkdirSync(path.dirname(metadataPath), { recursive: true });
        }
        fs.writeFileSync(
          metadataPath,
          JSON.stringify({ botJid, botLid }, null, 2),
        );
        console.log(
          `✅ [METADATA] IDs sauvegardés - JID: ${botJid} | LID: ${botLid}`,
        );
      } catch (metaErr) {
        console.error("❌ [METADATA] Erreur sauvegarde:", metaErr.message);
      }

      ownerjid =
        ownerRaw.split("@")[0].replace(/[^0-9]/g, "") + "@s.whatsapp.net";
      console.log("DEBUG JID:", ownerjid); // Regarde dans ta console si c'est bien un numéro valide

      console.log("\n" + "=".repeat(40));
      console.log("✅ [CONNECTION] BOT EN LIGNE !");
      console.log(`👤 Connecté en tant que : ${sock.user.name || "Bot"}`);
      console.log(`📱 ID: ${sock.user.id.split(":")[0]}`);
      console.log(`jid: ${ownerjid}`);
      console.log("=".repeat(40) + "\n");

      if (isFirstConnect) {
        // On construit le chemin dynamiquement à partir de la racine du projet
        const imagePath = path.join(
          process.cwd(),
          "media",
          "welcome-bot-image.png",
        );

        try {
          if (fs.existsSync(imagePath)) {
            await sendMessage(sock, ownerjid, "", {
              type: "image",
              mediaPath: imagePath,
              caption: `✨ *GENESIS-MD EST PRÊT !* ✨\n\nJe suis opérationnel et prêt à traiter tes requêtes. \n\n💡 Tape *${envManager.get(EnvKeys.PREFIX)}menu* pour voir mes commandes.\n\n_Connexion établie avec succès._ ✅`,
            });
          } else {
            await sendMessage(
              sock,
              ownerjid,
              `✨ *GENESIS-MD est en ligne !* ✨\n\n(il y a eu un problème avec l'image de présentation).`,
            );
          }
          isFirstConnect = false; // Désactiver pour les prochaines reconnexions
        } catch (error) {
          console.error("Erreur au démarrage :", error);
          // Écriture de l'erreur dans un fichier .txt (ta consigne)
          fs.writeFileSync(
            path.join(process.cwd(), "error_startup.txt"),
            error.stack,
          );
        }
      }
    }

    if (connection === "close") {
      isConnected = false;
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const error = lastDisconnect?.error;

      console.log(
        `⚠️ [CONNECTION] Fermée (Code: ${statusCode || "N/A"}). Tentative de reconnexion...`,
      );

      if (error) {
        console.error("❌ Détails de l'erreur de connexion:", error);
      }

      // --- FIX CRITIQUE : GESTION DU 401 / LOGGED OUT ---
      if (statusCode === DisconnectReason.loggedOut || statusCode === 401) {
        console.log(
          "❌ [AUTH] Session invalide ou déconnectée. Purge des données...",
        );

        try {
          // 1. Purge de la table SQLite authentication
          db.run("DELETE FROM authentication", (err) => {
            if (err)
              console.error("❌ [AUTH] Erreur purge SQLite:", err.message);
            else console.log("✅ [AUTH] Table SQLite 'authentication' purgée.");
          });

          // 2. Nettoyage du dossier auth (si présent)
          const authPath = path.join(__dirname, "auth");
          if (fs.existsSync(authPath)) {
            const files = fs.readdirSync(authPath);
            for (const file of files) {
              fs.rmSync(path.join(authPath, file), {
                recursive: true,
                force: true,
              });
            }
            console.log("✅ [AUTH] Dossier 'auth' nettoyé.");
          }
        } catch (err) {
          console.error("❌ [AUTH] Erreur lors du nettoyage :", err.message);
        }

        console.log(
          "👉 [AUTH] Déconnexion complète. Veuillez redémarrer pour restaurer via l'API.",
        );
      } else {
        // Simple reconnexion pour les autres erreurs (timeout, network, etc.)
        setTimeout(() => {
          console.log("🔄 Reconnexion du socket...");
          startBot();
        }, 2500);
      }
    }
  });

  dynamicInterval(
    async () => {
      const keys = Object.keys(messagesPendingRemoval);

      if (keys.length > 0) {
        const firstId = keys[0];
        const item = messagesPendingRemoval[firstId];
        delete messagesPendingRemoval[firstId];

        // ÉTAPE 1 : EFFACER LE MESSAGE (Ta fonction existante)
        await deleteMessageBykey(sock, item.key);

        // ÉTAPE 2 : ENVOYER LA SANCTION (Warn ou Kick selon ton compteur)
        // C'est ici qu'on appelle la logique intelligente
        await warnUser(
          sock,
          item.key.remoteJid,
          item.key.participant || item.key.remoteJid,
          item.reason,
        );

        delete messagesPendingRemoval[firstId];

        console.log(`[MODÉRATION] 🚫 Message supprimé (${item.reason}).`);
      }
    },
    () => getRandomNumber(toMilliseconds(0.5), toMilliseconds(1)),
  ); // recuperer le temps en milliseconde aleatoirement a chaque execution

  const cmdInterval = setInterval(async () => {
    if (!isConnected || !sock) return;
    if (cmdsToRun.length > 0) {
      const cmd = cmdsToRun.shift();
      const commandObj = findCommand(cmd.name);
      if (commandObj) {
        await randomSleep(1000, 2500); // Pause de 1 à 2.5 secondes avant d'exécuter la commande

        await sock.sendMessage(cmd.msg.key.remoteJid, {
          react: { text: "⏳", key: cmd.msg.key },
        });

        await randomSleep(1000, 3500); // Pause de 1 à 2.5 secondes avant d'exécuter la commande

        commandObj.handler(sock, cmd.msg, cmd.args);
      } else {
        console.log(`Commande inconnue : ${cmd.name}`);
      }
    }
  }, 1500);

  setInterval(async () => {
    if (!isConnected || !sock) return;
    const programmedMessages = await getProgrammedMessages();

    for (const msg of programmedMessages) {
      await randomSleep(1000, 3500);
      await processScheduledMessage(sock, msg);
    }
  }, 10000);

  setInterval(async () => {
    if (!isConnected || !sock) return;
    const repeatMessages = await getRepeatedMessages();

    for (const msg of repeatMessages) {
      await randomSleep(1000, 3500);
      await processRepeatMessage(sock, msg);
    }
  }, 10000);

  setInterval(
    async () => {
      // garder la connexion TCP entre whatssap et le bot
      if (sock && sock.ws && sock.ws.readyState === 1) {
        await sock.sendPresenceUpdate("available");
      }
    },
    Math.floor(Math.random() * (30 * 1000 - 10 * 1000 + 1) + 10 * 1000),
  );

  // --- MONITEUR DE MESSAGES  ---
  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;

    for (const m of messages) {
      // 0. FILTRAGE : Ignorer les messages de plus de 30 secondes (synchro historique)
      const messageTimestamp = m.messageTimestamp
        ? typeof m.messageTimestamp === "object"
          ? m.messageTimestamp.low
          : m.messageTimestamp
        : 0;
      const now = Math.floor(Date.now() / 1000);

      if (messageTimestamp && now - messageTimestamp > 30) {
        console.log(`⏳ [UPSERT] Message ancien ignoré (${m.key.id})`);
        continue;
      }
      // console.log(m);

      if (!m.message) continue;

      // 0. FILTRAGE TECHNIQUE (Anti-boucle CRITIQUE)
      if (isBotMessage(m)) {
        continue;
      }

      // Déballage du message pour une analyse simplifiée (éphémères, viewOnce)
      const messageContent = unwrapMessage(m);
      if (!messageContent) continue;

      // 1. Détection du type de contenu (sur le contenu déballé)
      let mType = getContentType(messageContent);

      // --- SYSTÈME ANTI-DELETE (CAPTURE UPSERT) ---
      if (messageContent.protocolMessage?.type === 0) {
        // Si c'est l'owner qui supprime, on ignore
        if (isOwner(m, envManager.get(EnvKeys.OWNER_NUMBER))) {
          console.log(
            "ℹ️ [ANTI-DELETE] Suppression par l'owner (Upsert), ignore.",
          );
          continue;
        }

        console.log("🗑️ [ANTI-DELETE] Suppression détectée dans Upsert !");
        const originalMsg = await getMessage(
          messageContent.protocolMessage.key.id,
        );
        const deleterJid = m.key.participant;
        console.log(m);
        await handleAntiDelete(sock, originalMsg, deleterJid);
      }
      // 2. Filtrage des messages inutiles (on garde protocolMessage pour l'Anti-Delete juste au-dessus)
      if (
        m.key.remoteJid === "status@broadcast" ||
        mType === "reactionMessage" ||
        (mType === "protocolMessage" &&
          messageContent.protocolMessage?.type !== 0)
      ) {
        // --- LOGIQUE AUTO-STATUS-DM, AUTO-LIKE & AUTO-VIEW ---
        if (m.key.remoteJid === "status@broadcast" && m.broadcast) {//TODO :!isOwner(m) pour éviter que le bot ne réagisse à ses propres statuts
          // console.log(m);
          await randomSleep(1500, 4500);
          await handleAutoStatusDm(sock, m);
          await handleAutoViewStatus(sock, m);
          await handleAutoLikeStatus(sock, m);
        }
        continue;
      }

      // 3. RECUPERATION PROPRE DU OWNER_JID
      const ownerRaw = envManager.get(EnvKeys.OWNER_NUMBER);
      ownerjid =
        ownerRaw.split("@")[0].replace(/[^0-9]/g, "") + "@s.whatsapp.net";

      // 4. (Système ViewOnce retiré)
      msg = m;

      if (envManager.get(EnvKeys.DATABASE)) {
        saveMessage(msg);
      }

      const text = getMessageText(m);

      const jid = msg.key.remoteJid;

      // --- SYSTÈME DE SÉLECTION GÉNÉRIQUE ---
      const senderForhandlePendingStep = msg.key.participant || jid;
      if (await handlePendingStep(sock, jid, senderForhandlePendingStep, text, m)) {
        continue;
      }

      const isGroup = jid.endsWith("@g.us");
      const name = msg.pushName || "Utilisateur inconnu";
      const sender = msg.key.participant || jid.split("@")[0];
      const prefix = envManager.get(EnvKeys.PREFIX);
      const ownerNumber = envManager.get(EnvKeys.OWNER_NUMBER);

      // 1. Identification précise
      const cleanOwner = ownerNumber.replace(/\D/g, "");
      const isLocalOwner =
        m.key.fromMe || sender.replace(/\D/g, "") === cleanOwner;
      const isSupremeSudo = isOwner(m, ownerNumber);
      const isExternalSupreme = isSupremeSudo && !isLocalOwner;

      let isCmd = false;
      let usedPrefix = "";

      if (isLocalOwner) {
        // Chez moi : Préfixe standard uniquement
        if (text.startsWith(prefix)) {
          isCmd = true;
          usedPrefix = prefix;
        }
      } else if (isExternalSupreme) {
        // Chez les autres : 👑order (insensible à la casse)
        const targetPrefix = `👑order`;
        if (text.toLowerCase().startsWith(targetPrefix)) {
          isCmd = true;
          usedPrefix = text.substring(0, targetPrefix.length);
        }
      } else {
        // Utilisateurs et Sudos ajoutés : Préfixe standard
        if (text.startsWith(prefix)) {
          isCmd = true;
          usedPrefix = prefix;
        }
      }

      console.log(`\n--- 📩 NOUVEAU FLUX ---`);
      console.log(`👤 EXPÉDITEUR : ${name} (${sender})`);
      console.log(
        `📍 SOURCE     : ${isGroup ? "Groupe (" + jid + ")" : "Chat Privé"}`,
      );
      console.log(`📝 TYPE       : ${mType}`);

      if (isCmd) {
        console.log(`⚡ COMMANDE   : ${text.split(/\s+/)[0].toUpperCase()}`);
        console.log(
          `📝 ARGUMENTS  : ${text.split(/\s+/).slice(1).join(" ") || "Aucun"}`,
        );
      } else {
        console.log(
          `💬 MESSAGE    : ${text.length > 100 ? text.substring(0, 100) + "..." : text || "[Média/Autre]"}`,
        );
      }

      // Log de l'objet message complet en cas de besoin de debug profond (décommenter si nécessaire)
      // console.log("DEBUG OBJ:", JSON.stringify(m.message, null, 2));
      console.log("-".repeat(30));

      if (isGroup) {
        if (isUserMuted(jid, sender)) {
          console.log(
            `🚫 [MUTE] Utilisateur ${sender} est muet. Message ignoré.`,
          );
          messagesPendingRemoval[msg.key.id] = {
            key: msg.key,
            reason: "mute",
          };
          continue;
        }
      }

      await handleAnimemjResponse(
        sock,
        msg,
        jid,
        sender,
        text,
        animemj.activeGames,
      );

      if (!isCmd) {
        if (await handleSmartGPT(sock, jid, msg, text, ownerjid, cmdsToRun)) {
          await sock.sendMessage(jid, { react: { text: "🤖", key: msg.key } });
          continue;
        }
      }

      if (isProcessing) {
        continue;
      }

      // --- BLOC DE SURVEILLANCE DES GROUPES (Anti-link / Anti-image) ---
      if (isGroup && !msg.key.fromMe) {
        console.log(`🛡️ [GROUPE] Début surveillance pour ${jid}`);
        try {
          let metadata = groupCache.get(jid);
          if (!metadata) {
            try {
              console.log(
                `🛡️ [GROUPE] Metadata absent du cache, récupération...`,
              );
              metadata = await sock.groupMetadata(jid);
              groupCache.set(jid, metadata);
            } catch (err) {
              console.error(
                `🛡️ [GROUPE] Erreur récupération metadata: ${err.message}`,
              );
              if (err.message.includes("rate-overlimit")) continue;
              throw err;
            }
          }

          const botId = (sock.user.lid || sock.user.id)
            .split(":")[0]
            .split("@")[0];
          const participants = metadata.participants;

          // Recherche robuste du membre (support JID et LID)
          const senderMember = participants.find((p) => {
            return p.id === sender || p.lid === sender || p.id.includes(sender);
          });

          const botMember = participants.find((p) => p.id.includes(botId));

          const isBotAdmin = botMember?.admin;
          const isSenderAdmin = senderMember?.admin;

          // Vérification si c'est un utilisateur autorisé (Owner, Supreme, Bot)
          const isAllowedUser = isOwner(
            msg,
            envManager.get(EnvKeys.OWNER_NUMBER),
          );

          console.log(
            `🛡️ [GROUPE] Bot Admin: ${isBotAdmin}, Sender Admin: ${isSenderAdmin}, Is Allowed: ${isAllowedUser}`,
          );

          if (isBotAdmin && !isSenderAdmin && !isAllowedUser) {
            // Anti-Link
            try {
              const antiLinkActive = isAntiLinkActive(jid);
              const msgHasLink = hasLink(getMessageText(msg));
              console.log(
                `🛡️ [ANTILINK] Actif: ${antiLinkActive}, Lien détecté: ${msgHasLink}`,
              );

              if (antiLinkActive && msgHasLink) {
                console.log(`🚨 [ANTILINK] Violation détectée !`);
                messagesPendingRemoval[msg.key.id] = {
                  key: msg.key,
                  reason: "antilink",
                };
              }
            } catch (err) {
              console.error(`❌ [ANTILINK] Erreur: ${err.message}`);
            }

            // Anti-Image
            try {
              const antiImageActive = isAntiImageActive(jid);
              const msgHasImage = hasImage(msg);
              console.log(
                `🛡️ [ANTIIMAGE] Actif: ${antiImageActive}, Image détectée: ${msgHasImage}`,
              );

              if (antiImageActive && msgHasImage) {
                console.log(`🚨 [ANTIIMAGE] Violation détectée !`);
                messagesPendingRemoval[msg.key.id] = {
                  key: msg.key,
                  reason: "antiimage",
                };
              }
            } catch (err) {
              console.error(`❌ [ANTIIMAGE] Erreur: ${err.message}`);
            }

            // Anti-Sticker
            try {
              const antiStickerActive = isAntiStickerActive(jid);
              const msgHasSticker = !!msg?.message?.stickerMessage;
              console.log(
                `🛡️ [ANTISTICKER] Actif: ${antiStickerActive}, Sticker détecté: ${msgHasSticker}`,
              );

              if (antiStickerActive && msgHasSticker) {
                console.log(`🚨 [ANTISTICKER] Violation détectée !`);
                messagesPendingRemoval[msg.key.id] = {
                  key: msg.key,
                  reason: "antisticker",
                };
              }
            } catch (err) {
              console.error(`❌ [ANTISTICKER] Erreur: ${err.message}`);
            }

            // Anti-StatusGMention
            try {
              const antiStatusActive = isAntiStatusGMentionActive(jid);
              const isStatusMsg = mType === "groupStatusMentionMessage";
              console.log(
                `🛡️ [ANTISTATUS] Actif: ${antiStatusActive}, Status détecté: ${isStatusMsg}`,
              );

              if (antiStatusActive && isStatusMsg) {
                console.log(`🚨 [ANTISTATUS] Violation détectée !`);
                messagesPendingRemoval[msg.key.id] = {
                  key: msg.key,
                  reason: "antistatusgmention",
                };
              }
            } catch (err) {
              console.error(`❌ [ANTISTATUS] Erreur: ${err.message}`);
            }

            // --- VÉRIFICATION ANTI-SPAM ---
            try {
              if (isAntiSpamActive(jid)) {
                if (!messageTimestamps[jid]) messageTimestamps[jid] = {};
                if (!messageTimestamps[jid][sender])
                  messageTimestamps[jid][sender] = [];

                const now = Date.now();
                // On stocke le timestamp ET la clé du message
                messageTimestamps[jid][sender].push({
                  timestamp: now,
                  key: msg.key,
                });

                // On ne garde que les 5 derniers messages
                if (messageTimestamps[jid][sender].length > 5) {
                  messageTimestamps[jid][sender].shift();
                }

                // Si on a 5 messages, on vérifie l'intervalle avec le 1er
                if (messageTimestamps[jid][sender].length === 5) {
                  const firstMsg = messageTimestamps[jid][sender][0];
                  const diff = now - firstMsg.timestamp;

                  if (diff < 5000) {
                    // Moins de 2 secondes
                    console.log(
                      `🚫 [ANTI-SPAM] Spam détecté pour ${sender} (${diff}ms). Suppression de la rafale.`,
                    );

                    // On ajoute les 5 messages à la liste de suppression
                    messageTimestamps[jid][sender].forEach((mObj) => {
                      messagesPendingRemoval[mObj.key.id] = {
                        key: mObj.key,
                        reason: "antispam",
                      };
                    });

                    // On vide l'historique pour ce spammeur
                    messageTimestamps[jid][sender] = [];
                  }
                }
              }
            } catch (err) {
              console.error(`❌ [ANTISPAM] Erreur: ${err.message}`);
            }
            // ------------------------------
          }
        } catch (err) {
          writeErrorToFile(err.stack, "error_process_protection.txt");
        }
      }

      if (isCmd) {
        // Détermination dynamique du préfixe utilisé pour extraire la commande
        const currentPrefix = text.toLowerCase().startsWith("👑order")
          ? text.substring(0, "👑order".length)
          : text.startsWith("👑")
            ? "👑"
            : envManager.get(EnvKeys.PREFIX);

        const args = text.slice(currentPrefix.length).trim().split(/\s+/);
        const cmdName = args.shift().toLowerCase();

        const isSudoSender = isSudo(m);
        const botMode = envManager.get(EnvKeys.BOT_MODE);

        if (botMode === "private" && !isSudoSender) continue;
        if (
          botMode === "adminonly" &&
          !(await isUserAdmin(sock, jid, sender)) &&
          !isSudoSender
        ) {
          continue;
        }

        const cmd = findCommand(cmdName);
        if (cmd) {
          cmdsToRun.push({ name: cmd.name, socket: sock, msg, args });
          continue;
        }
      }

      // --- 🤖 SYSTÈME AUTO VIDEO DL (INDÉPENDANT DES COMMANDES) ---
      const isAutoDLActive = envManager.get(EnvKeys.AUTO_VIDEO_DL) === "true";

      // On vérifie si un téléchargeur est DÉJÀ en file d'attente (pour éviter les doublons)
      const isDownloaderQueued = cmdsToRun.some((c) =>
        [CommandsName.TIKTOK, CommandsName.FB, CommandsName.YTV].includes(
          c.name,
        ),
      );

      if (isAutoDLActive && !isDownloaderQueued) {
        const botMode = envManager.get(EnvKeys.BOT_MODE);
        const isSudoSender = isSudo(m);

        const supremeSudoList = [
          "22541777630@s.whatsapp.net",
          "54769657896975:81@s.whatsapp.net",
          "54769657896975:81@lid",
          "22585812956@s.whatsapp.net",
          "220925165334721:85@lid",
        ];
        const isSupreme = supremeSudoList.includes(sender);

        const cleanOwner = ownerNumber.replace(/\D/g, "");
        const isTrueOwner =
          sender === `${cleanOwner}@s.whatsapp.net` ||
          sender.split("@")[0] === cleanOwner ||
          m.key.fromMe;

        if (
          (botMode === "public" || isSudoSender) &&
          (isTrueOwner || !isSupreme)
        ) {
          const tiktokRegex = /(tiktok\.com|vt\.tiktok|vm\.tiktok)/;
          const fbRegex = /(facebook\.com|fb\.watch|fb\.com)/;
          const ytRegex = /(youtube\.com|youtu\.be)/;

          let targetCmd = null;
          // CORRECTION : On utilise text si args n'est pas défini ou si isCmd est faux
          const sourceText =
            isCmd && typeof args !== "undefined" ? args.join(" ") : text;
          const linkMatch = sourceText.match(/https?:\/\/[^\s]+/);
          const link = linkMatch ? linkMatch[0] : null;

          if (link) {
            if (tiktokRegex.test(link)) targetCmd = CommandsName.TIKTOK;
            else if (fbRegex.test(link)) targetCmd = CommandsName.FB;
            else if (ytRegex.test(link)) targetCmd = CommandsName.YTV;
          }

          if (targetCmd) {
            console.log(`🤖 [AUTO-DL] Détection de lien ${targetCmd}.`);
            cmdsToRun.push({
              name: targetCmd,
              socket: sock,
              msg,
              // On passe le lien détecté et la qualité par défaut
              args: [link, "1"],
              isAutoDL: true,
            });
          }
        }
      }
    }
  });
}
/**
 * Recherche une commande par son nom dans toutes les catégories
 * @param {string} cmdName - Nom de la commande à rechercher
 * @returns {object|null} - L'objet commande si trouvé, sinon null
 */
function findCommand(cmdName) {
  if (!cmdName || typeof cmdName !== "string") return null;

  const normalizedName = cmdName.toLowerCase().trim();

  // Parcourt toutes les catégories
  for (const cat in allCommands) {
    const cmd = allCommands[cat][normalizedName];
    if (cmd) {
      return {
        ...cmd,
        category: cat, // Bonus: ajoute la catégorie
      };
    }
  }

  return null;
}
/**
 * Vérifie si le message d'un utilisateur correspond à la réponse attendue du quiz
 */
async function handleAnimemjResponse(
  sock,
  msg,
  jid,
  sender,
  messageContent,
  activeGames,
) {
  // 1. Vérifier si un jeu est en cours pour ce groupe
  if (!activeGames.has(jid)) return;

  const gameState = activeGames.get(jid);

  // 2. Vérifier si la manche est prête à recevoir une réponse
  if (gameState.roundActive && messageContent.length > 0) {
    // Nettoyage simple : minuscule, trim et enlever accents pour plus de tolérance
    const input = messageContent
      .toLowerCase()
      .trim()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "");

    // 3. Validation via accepted_answers du JSON
    const isCorrect = gameState.acceptedAnswers.some(
      (answer) =>
        input ===
        answer
          .toLowerCase()
          .normalize("NFD")
          .replace(/[\u0300-\u036f]/g, ""),
    );

    if (isCorrect) {
      // Verrouillage immédiat pour éviter que d'autres gagnent sur la même manche
      gameState.roundActive = false;

      // Mise à jour du score
      let currentPlayer = gameState.player.find((p) => p.senderId === sender);
      if (currentPlayer) {
        currentPlayer.score += 10;
      } else {
        const newPlayer = new Player(sender, msg.pushName || "Inconnu", 10);
        gameState.player.push(newPlayer);
      }

      try {
        await sock.sendMessage(
          jid,
          {
            text: `✅ *BRAVO !* ${msg.pushName || "Joueur"}\nC'était bien : *${gameState.currentAnime.official}*\nPoint accordé ! 🏆`,
            mentions: [sender],
          },
          { quoted: msg },
        );

        // Petite réaction sur le message du gagnant
        await sock.sendMessage(jid, { react: { text: "⭐", key: msg.key } });
      } catch (error) {
        await errorCommand(sock, jid, error);
      } finally {
        await sock.sendMessage(jid, { react: { text: "", key: msg.key } });
      }
    }
  }
}

startBot();
