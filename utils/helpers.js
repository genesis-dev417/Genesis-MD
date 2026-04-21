const fs = require("fs");
const path = require("path");
const axios = require("axios");
const cheerio = require("cheerio");
const ffmpeg = require("fluent-ffmpeg");
const { Readable, PassThrough } = require("stream");
const { exec } = require("child_process");
const { promisify } = require("util");
const execPromise = promisify(exec);
const sqlite3 = require("sqlite3").verbose();
const db = new sqlite3.Database("./db/genesis_md_memory.db");
const {
  downloadMediaMessage,
  getContentType,
} = require("@whiskeysockets/baileys");
const { Sticker, StickerTypes } = require("wa-sticker-formatter");
const envManager = require("../env-manager");
const EnvKeys = require("../constants/EnvKeys");
const { ensureGroupConfig } = require("./group-helpers");
const WARNS_FILE = path.join(__dirname, "../json/warns-users-data.json");
const sharp = require("sharp");
const OpenAI = require("openai");
const pino = require("pino");

// =========================================================
// 📂 GESTION DES FICHIERS JSON
// =========================================================

/**
 * Lit un fichier JSON de manière sécurisée
 * @param {String} filePath - Chemin du fichier
 * @param {Object} defaultValue - Valeur par défaut si erreur
 * @returns {Object} - Contenu du fichier ou valeur par défaut
 */
function readJSON(filePath, defaultValue = {}) {
  try {
    if (!fs.existsSync(filePath)) {
      writeJSON(filePath, defaultValue);
      return defaultValue;
    }
    const data = fs.readFileSync(filePath, "utf8");
    return JSON.parse(data);
  } catch (error) {
    console.error(`Erreur lecture JSON (${filePath}):`, error.message);
    return defaultValue;
  }
}

/**
 * Écrit dans un fichier JSON de manière sécurisée
 * @param {String} filePath - Chemin du fichier
 * @param {Object} data - Données à écrire
 * @returns {Boolean} - true si succès
 */
function writeJSON(filePath, data) {
  try {
    // Créer le dossier parent si nécessaire
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf8");
    return true;
  } catch (error) {
    console.error(`Erreur écriture JSON (${filePath}):`, error.message);
    return false;
  }
}

// =========================================================
// 📱 EXTRACTION D'INFORMATIONS DES MESSAGES
// =========================================================

/**
 * Déballe (unwrap) le contenu d'un message pour accéder au message réel
 * Gère les messages éphémères et à vue unique.
 * @param {Object} msg - Le message brut (m) ou le contenu (m.message)
 */
function unwrapMessage(msg) {
  if (!msg) return null;

  // Si c'est l'objet message complet (m), on prend m.message
  let content = msg.message || msg;

  // 1. Gérer les messages éphémères
  if (content.ephemeralMessage) {
    content = content.ephemeralMessage.message;
  }

  // 2. Gérer les messages à vue unique (V1 et V2)
  if (content.viewOnceMessageV2) {
    content = content.viewOnceMessageV2.message;
  } else if (content.viewOnceMessage) {
    content = content.viewOnceMessage.message;
  }

  return content;
}

/**
 * Extrait le texte d'un message (gère tous les types, éphémères et viewOnce)
 */
function getMessageText(msg) {
  const content = unwrapMessage(msg);
  if (!content) return "";

  return (
    content.conversation ||
    content.extendedTextMessage?.text ||
    content.imageMessage?.caption ||
    content.videoMessage?.caption ||
    content.documentMessage?.caption ||
    content.buttonsResponseMessage?.selectedButtonId ||
    content.listResponseMessage?.singleSelectReply?.selectedRowId ||
    ""
  );
}

/**
 * Extrait les mentions d'un message
 * @param {Object} msg - Message Baileys
 * @returns {Array} - Liste des JIDs mentionnés
 */
function getMentions(msg) {
  return msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
}

/**
 * Extrait le message quoté (répondu)
 * @param {Object} msg - Message Baileys
 * @returns {Object|null} - Message quoté ou null
 */
function getMessageContextInfo(msg) {
  return msg.message?.extendedTextMessage?.contextInfo || null;
}

function getQuotedMessage(msg) {
  return msg.message?.extendedTextMessage?.contextInfo?.quotedMessage || null;
}

/**
 * Vérifie si le message contient une image
 * @param {Object} msg - Message Baileys
 * @returns {Boolean}
 */
function hasImage(msg) {
  return !!msg?.message?.imageMessage;
}

/**
 * Vérifie si le message contient un lien
 * @param {Object} msg - Message Baileys
 * @returns {Boolean}
 */ function hasLink(text) {
  if (!text || typeof text !== "string") return false;

  const urlRegex =
    /\b((https?:\/\/|ftp:\/\/)?(www\.)?([a-z0-9-]+\.)+[a-z]{2,}|localhost|\b\d{1,3}(\.\d{1,3}){3})(:\d+)?(\/[^\s]*)?\b/i;

  return urlRegex.test(text);
}

/**
 * Vérifie si le message contient une vidéo
 * @param {Object} msg - Message Baileys
 * @returns {Boolean}
 */
function hasVideo(msg) {
  return !!msg.message?.videoMessage;
}

/**
 * Vérifie si le message contient un document
 * @param {Object} msg - Message Baileys
 * @returns {Boolean}
 */
function hasDocument(msg) {
  return !!msg.message?.documentMessage;
}

// =========================================================
// 🔢 FORMATAGE ET UTILITAIRES
// =========================================================

/**
 * Formate un nombre avec des espaces (1000 → 1 000)
 * @param {Number} number - Nombre à formater
 * @returns {String}
 */
function formatNumber(number) {
  return number.toString().replace(/\B(?=(\d{3})+(?!\d))/g, " ");
}

/**
 * Formate une durée en secondes en format lisible
 * @param {Number} seconds - Durée en secondes
 * @returns {String} - Format HH:MM:SS ou MM:SS
 */
function formatDuration(seconds) {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);

  if (hours > 0) {
    return `${hours}:${minutes.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;
  }
  return `${minutes}:${secs.toString().padStart(2, "0")}`;
}

/**
 * Formate une taille de fichier en octets
 * @param {Number} bytes - Taille en octets
 * @returns {String} - Format lisible (KB, MB, GB)
 */
function formatFileSize(bytes) {
  if (bytes === 0) return "0 Bytes";
  const k = 1024;
  const sizes = ["Bytes", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + " " + sizes[i];
}

/**
 * Tronque un texte à une longueur donnée
 * @param {String} text - Texte à tronquer
 * @param {Number} maxLength - Longueur maximale
 * @returns {String}
 */
function truncateText(text, maxLength = 100) {
  if (text.length <= maxLength) return text;
  return text.substring(0, maxLength) + "...";
}
/**
 * Attend un certain temps (promesse)
 * @param {Number} ms - Temps en millisecondes
 * @returns {Promise}
 */ async function randomSleep(min = 1500, max = 3500) {
  const duration = Math.floor(Math.random() * (max - min + 1) + min);
  return new Promise((resolve) => setTimeout(resolve, duration));
}

// =========================================================
// 🔐 VALIDATION
// =========================================================

/**
 * Valide une URL
 * @param {String} url - URL à valider
 * @returns {Boolean}
 */
function isValidURL(url) {
  try {
    new URL(url);
    return true;
  } catch (error) {
    return false;
  }
}

/**
 * Valide un numéro de téléphone
 * @param {String} phone - Numéro à valider
 * @returns {Boolean}
 */
function isValidPhone(phone) {
  const cleanPhone = phone.replace(/\D/g, "");
  return cleanPhone.length >= 8 && cleanPhone.length <= 15;
}

/**
 * Valide un email
 * @param {String} email - Email à valider
 * @returns {Boolean}
 */
function isValidEmail(email) {
  const regex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return regex.test(email);
}

function getRandomNumber(min, max) {
  return (duration = Math.floor(Math.random() * (max - min + 1) + min));
}

function toMilliseconds(n) {
  return n * 1000;
}

/**
 * dynamicInterval - exécute une fonction de façon répétée
 * avec un intervalle recalculé à chaque exécution.
 *
 * @param {function} callback - Fonction à exécuter à chaque “tick”. Peut être async.
 * @param {function} getDelay - Fonction qui retourne le délai (en ms) à utiliser pour la prochaine exécution.
 * @returns {function} stop - Une fonction à appeler pour arrêter le timer.
 *
 * ✅ Avantages :
 *   - L’intervalle peut changer dynamiquement à chaque exécution
 *   - Supporte les fonctions asynchrones
 *   - Ajuste l’attente si l’exécution prend du temps
 *   - Permet d’arrêter proprement le timer
 */

function dynamicInterval(callback, getDelay) {
  let stopped = false;

  async function run() {
    if (stopped) return;

    const start = Date.now();
    await callback(); // exécution de la fonction (peut être async)
    const delay = getDelay(); // récupère le nouveau délai

    const elapsed = Date.now() - start;
    const nextDelay = Math.max(0, delay - elapsed); // ajuste si callback long

    setTimeout(run, nextDelay);
  }

  setTimeout(run, getDelay()); // première exécution
  return () => {
    stopped = true; // retourne une fonction pour stopper le timer
  };
}

// =========================================================
// 📅 DATE ET HEURE
// =========================================================

/**
 * Obtient la date et l'heure actuelles formatées
 * @param {String} locale - Locale (défaut: fr-FR)
 * @returns {String}
 */
function getFormattedDate(dateInput = new Date(), locale = "fr-FR") {
  const date = dateInput instanceof Date ? dateInput : new Date(dateInput);
  return date.toLocaleString(locale, {
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * Calcule le temps écoulé depuis une date
 * @param {Date|String} date - Date de départ
 * @returns {String} - Temps écoulé (ex: "Il y a 2 heures")
 */
function getTimeAgo(date) {
  const now = new Date();
  const past = new Date(date);
  const diffMs = now - past;
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHour = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHour / 24);

  if (diffDay > 0) return `Il y a ${diffDay} jour${diffDay > 1 ? "s" : ""}`;
  if (diffHour > 0) return `Il y a ${diffHour} heure${diffHour > 1 ? "s" : ""}`;
  if (diffMin > 0) return `Il y a ${diffMin} minute${diffMin > 1 ? "s" : ""}`;
  return "À l'instant";
}

function isValidDurationFormat(input) {
  // Regex : (Optionnel : 1-2 chiffres suivis de ::) + (1-2 chiffres suivis de :) + (1-2 chiffres)
  const regex = /^(\d{1,2}::)?(\d{1,2}):(\d{1,2})$/;
  return regex.test(input.trim());
}

function isGroup(jid) {
  if (!jid) return false;

  if (jid.endsWith("@g.us")) return true;
  else return false;
}

function parseDurationToMs(input) {
  if (!input) return null;

  const isDayFormat = input.includes("::");
  // On remplace le double deux-points pour avoir un tableau propre
  const parts = input.replace("::", ":").split(":").map(Number);

  let totalMs = 0;

  if (isDayFormat && parts.length === 3) {
    // Format JJ::HH:MM
    const [days, hours, minutes] = parts;
    totalMs += days * 86400000;
    totalMs += hours * 3600000;
    totalMs += minutes * 60000;
  } else if (parts.length === 2) {
    // Format HH:MM
    const [hours, minutes] = parts;
    totalMs += hours * 3600000;
    totalMs += minutes * 60000;
  }

  return totalMs > 0 ? totalMs : null;
}

// =========================================================
// 🎲 UTILITAIRES DIVERS
// =========================================================

/**
 * Génère un nombre aléatoire entre min et max
 * @param {Number} min - Minimum
 * @param {Number} max - Maximum
 * @returns {Number}
 */
function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/**
 * Choisit un élément aléatoire dans un tableau
 * @param {Array} array - Tableau
 * @returns {*} - Élément aléatoire
 */
function randomChoice(array) {
  return array[Math.floor(Math.random() * array.length)];
}

/**
 * Mélange un tableau (Fisher-Yates shuffle)
 * @param {Array} array - Tableau à mélanger
 * @returns {Array}
 */
function shuffleArray(array) {
  const arr = [...array];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}
/**
 * Supprime les doublons d'un tableau (gère les primitives et les clés Baileys)
 * @param {Array} array - Tableau d'éléments
 * @returns {Array}
 */
function uniqueArray(array) {
  return array.filter((item, index, self) => {
    // 1. Si c'est un objet avec un ID (cas des clés Baileys)
    if (item && typeof item === "object" && item.id) {
      return index === self.findIndex((t) => t && t.id === item.id);
    }

    // 2. Si c'est une valeur simple (nombre, texte)
    return self.indexOf(item) === index;
  });
}
// =========================================================
// 🗑️ FONCTIONS DE SUPPRESSION DE MESSAGES (BAILEYS)
// =========================================================

/**
 * Supprime un message dans WhatsApp
 * @param {Object} sock - Socket Baileys
 * @param {Object} messageKey - Clé du message à supprimer
 * @returns {Promise<Boolean>} - true si succès, false si échec
 */
async function deleteMessageBykey(sock, messageKey) {
  try {
    await sock.sendMessage(messageKey.remoteJid, {
      delete: messageKey,
    });
    return true;
  } catch (error) {
    console.error("❌ Erreur suppression message:", error.message);
    return false;
  }
}

/**
 * Supprime le message actuel (depuis le handler)
 * @param {Object} sock - Socket Baileys
 * @param {Object} msg - Message Baileys complet
 * @returns {Promise<Boolean>} - true si succès
 */
async function deleteCurrentMessage(sock, msg) {
  try {
    await sock.sendMessage(msg.key.remoteJid, {
      delete: msg.key,
    });
    console.log("🗑️ Message supprimé:", msg.key.id);
    return true;
  } catch (error) {
    console.error("❌ Erreur suppression message actuel:", error.message);
    return false;
  }
}

/**
 * Supprime le message cité/répondu
 * @param {Object} sock - Socket Baileys
 * @param {Object} msg - Message Baileys
 * @returns {Promise<Boolean>} - true si succès
 */
async function deleteQuotedMessage(sock, msg) {
  try {
    const quotedMsg =
      msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
    const stanzaId = msg.message?.extendedTextMessage?.contextInfo?.stanzaId;
    const participant =
      msg.message?.extendedTextMessage?.contextInfo?.participant;

    if (!quotedMsg || !stanzaId) {
      console.log("⚠️ Aucun message cité trouvé");
      return false;
    }

    const messageKey = {
      remoteJid: msg.key.remoteJid,
      id: stanzaId,
      fromMe: false,
      participant: participant, // Important pour les groupes
    };

    await sock.sendMessage(msg.key.remoteJid, {
      delete: messageKey,
    });

    console.log("🗑️ Message cité supprimé:", stanzaId);
    return true;
  } catch (error) {
    console.error("❌ Erreur suppression message cité:", error.message);
    return false;
  }
}

/**
 * Supprime plusieurs messages d'un coup
 * @param {Object} sock - Socket Baileys
 * @param {String} jid - JID du chat/groupe
 * @param {Array<Object>} messageKeys - Tableau de clés de messages
 * @returns {Promise<Object>} - { deleted: Number, failed: Number }
 */
async function deleteMultipleMessages(sock, jid, messageKeys) {
  let deleted = 0;
  let failed = 0;

  for (const key of messageKeys) {
    try {
      await sock.sendMessage(jid, { delete: key });
      deleted++;

      // Petite pause pour éviter le spam
      await new Promise((resolve) => setTimeout(resolve, 100));
    } catch (error) {
      console.error(`❌ Échec suppression ${key.id}:`, error.message);
      failed++;
    }
  }

  console.log(`🗑️ Supprimés: ${deleted}, Échoués: ${failed}`);
  return { deleted, failed };
}

/**
 * Supprime un message avec délai (auto-destruction)
 * @param {Object} sock - Socket Baileys
 * @param {String} jid - JID du destinataire
 * @param {Object} messageContent - Contenu du message à envoyer
 * @param {Number} deleteAfterSeconds - Secondes avant suppression
 * @returns {Promise<Object>} - Message envoyé
 */
async function sendAutoDeleteMessage(
  sock,
  jid,
  messageContent,
  deleteAfterSeconds = 10,
) {
  try {
    // Envoyer le message
    const sentMsg = await sock.sendMessage(jid, messageContent);

    console.log(`⏱️ Message s'auto-détruira dans ${deleteAfterSeconds}s`);

    // Programmer la suppression
    setTimeout(async () => {
      try {
        await sock.sendMessage(jid, { delete: sentMsg.key });
        console.log("🗑️ Message auto-supprimé:", sentMsg.key.id);
      } catch (error) {
        console.error("❌ Erreur auto-suppression:", error.message);
      }
    }, deleteAfterSeconds * 1000);

    return sentMsg;
  } catch (error) {
    console.error("❌ Erreur envoi message auto-delete:", error.message);
    throw error;
  }
}

/**
 * Supprime tous les messages d'un utilisateur dans un groupe (avec limite)
 * Nécessite l'historique des messages (à stocker séparément)
 * @param {Object} sock - Socket Baileys
 * @param {String} groupJid - JID du groupe
 * @param {String} userJid - JID de l'utilisateur
 * @param {Array<Object>} messageHistory - Historique des messages
 * @param {Number} limit - Nombre max de messages à supprimer
 * @returns {Promise<Number>} - Nombre de messages supprimés
 */
async function deleteUserMessages(
  sock,
  groupJid,
  userJid,
  messageHistory,
  limit = 10,
) {
  try {
    // Filtrer les messages de l'utilisateur
    const userMessages = messageHistory
      .filter(
        (m) => m.key.participant === userJid || m.key.remoteJid === userJid,
      )
      .slice(0, limit);

    if (userMessages.length === 0) {
      console.log("ℹ️ Aucun message à supprimer");
      return 0;
    }

    let deleted = 0;
    for (const msg of userMessages) {
      try {
        await sock.sendMessage(groupJid, { delete: msg.key });
        deleted++;
        await new Promise((resolve) => setTimeout(resolve, 200)); // Pause 200ms
      } catch (error) {
        console.error(`❌ Échec suppression:`, error.message);
      }
    }

    console.log(`🗑️ ${deleted} messages supprimés pour ${userJid}`);
    return deleted;
  } catch (error) {
    console.error("❌ Erreur deleteUserMessages:", error.message);
    return 0;
  }
}

/**
 * Vérifie si le bot peut supprimer un message
 * @param {Object} sock - Socket Baileys
 * @param {String} groupJid - JID du groupe
 * @param {Object} messageKey - Clé du message
 * @returns {Promise<Boolean>} - true si possible
 */
async function canDeleteMessage(sock, groupJid, messageKey, cache = null) {
  try {
    // Dans un chat privé, on peut toujours supprimer ses propres messages
    if (!groupJid.endsWith("@g.us")) {
      return messageKey.fromMe;
    }

    // 1. Tenter le cache d'abord
    let groupMetadata = cache?.get(groupJid);

    // 2. Appel API si pas en cache
    if (!groupMetadata) {
      try {
        groupMetadata = await sock.groupMetadata(groupJid);
        cache?.set(groupJid, groupMetadata);
      } catch (err) {
        if (err.message.includes("rate-overlimit")) return messageKey.fromMe;
        throw err;
      }
    }

    const botId = (sock.user.lid || sock.user.id).split(":")[0];

    const botMember = groupMetadata.participants.find(
      (p) => p.id === `${botId}@s.whatsapp.net` || p.id.includes(botId),
    );

    const isBotAdmin =
      botMember?.admin === "admin" || botMember?.admin === "superadmin";

    // Le bot peut supprimer s'il est admin OU si c'est son propre message
    return isBotAdmin || messageKey.fromMe;
  } catch (error) {
    console.error("❌ Erreur canDeleteMessage:", error.message);
    return false;
  }
}
async function askAI(userPrompt) {
  try {
    const response = await axios.post(
      "https://genesis-md.gs-tech.online/ask-ai",
      {
        prompt: userPrompt,
        model: "openai/gpt-oss-120b:free", // Optionnel
      },
    );
    return response.data.response;
  } catch (error) {
    console.error(
      "Erreur lors de l'appel à l'IA :",
      error.response?.data?.error || error.message,
    );
  }
}
async function transalte(text, targetlang) {
  const data = {
    q: text,
    source: "auto",
    target: targetlang,
    format: "text",
    alternatives: 1,
    api_key: "",
  };

  try {
    const reponse = await axios.post(
      `https://libretranslate-z8fa.onrender.com/translate`,
      data,
    );
    // On retourne reponse.data pour avoir directement le JSON de l'API
    return reponse.data;
  } catch (error) {
    // ICI : on utilise l'orthographe anglaise pour Axios
    if (error.response) {
      // Le serveur te répond. C'est ici que tu verras le message de l'erreur 400
      console.log("Détails de l'erreur :", error.response.data);
    } else {
      console.log("Erreur :", error.message);
    }
  }
}

async function getwaifu(category, type = "sfw") {
  if (!category) return null;

  try {
    // Utilisation de POST /many pour obtenir une liste d'images (30 par défaut)
    const response = await axios.post(
      `https://api.waifu.pics/many/${type}/${category}`,
      { exclude: [] },
    );
    // L'API renvoie { files: ["url1", "url2", ...] }
    return response.data;
  } catch (error) {
    const errorMsg = error.response
      ? JSON.stringify(error.response.data)
      : error.message;
    console.log("[GETWAIFU] ❌ erreur : " + errorMsg);

    fs.appendFileSync(
      "error_getwaifu.txt",
      `[${new Date().toLocaleString()}] ${type}/${category} (many): ${errorMsg}\n`,
    );
    return null;
  }
}

/**
 * Fonction pour interroger l'IA en mode intelligent (retour JSON)
 */
async function askSmartAI(sock, jid, msg, prompt) {
  const apiKey =
    "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";
  const model = "stepfun/step-3.5-flash:free";

  try {
    const openai = new OpenAI({
      apiKey: apiKey,
      baseURL: "https://openrouter.ai/api/v1",
    });

    const response = await openai.chat.completions.create({
      model: model,
      messages: [
        {
          role: "system",
          content: `Tu es Genesis-MD, un bot WhatsApp multifonctionnel et intelligent.
          
          GUIDE DES COMMANDES (ACTIONS) :
          - 'song' : Musique/Audio YouTube. Args: ["titre ou lien"].
          - 'ytv' : Vidéo YouTube. Args: ["titre ou lien"].
          - 'pinterest' : Recherche d'images. Args: ["requête"].
          - 'tiktok' : Vidéo TikTok via lien. 
             IMPORTANT : Tu dois TOUJOURS envoyer 2 arguments pour tiktok : [lien, qualité].
             Qualités : "1" (HD), "2" (Standard), "3" (Audio MP3).
             SI l'utilisateur ne précise pas la qualité, utilise TOUJOURS "1" par défaut.
             SI l'utilisateur demande "audio" ou "son", utilise "3".

          RÈGLES CRITIQUES :
          1. JAMAIS le mot "gpt" dans tes réponses.
          2. Réponse en français, naturelle et très courte.
          3. Structure JSON EXACTE :
          {
            "reponse": "Message de confirmation (ex: 'Je m\\'en occupe !')",
            "actions": [
              { "commande": "song|ytv|pinterest|tiktok", "args": ["arg1", "arg2"] }
            ]
          }
          4. Si discussion seule ou intention floue, laisse "actions": [].`,
        },
        { role: "user", content: prompt },
      ],
      response_format: { type: "json_object" },
    });

    const content = response.choices?.[0]?.message?.content || "{}";
    console.log("🤖 [DEBUG AI RAW]:", content);
    return JSON.parse(content);
  } catch (error) {
    console.error("Erreur SmartAI:", error.message);
    return { reponse: "❌ Erreur d'analyse.", actions: [] };
  }
}

// =========================================================
// 🕵️ SYSTÈME ANTI-BOUCLE (MODE SELF/IA)
// =========================================================
const BOT_INVISIBLE_MARKER = "\u200B"; // Marqueur Unicode invisible

/**
 * Vérifie si le message a été envoyé par le bot (via sa signature Newsletter)
 * @param {Object} msg - Message Baileys
 * @returns {Boolean}
 */
function isBotMessage(msg) {
  try {
    const context =
      msg.message?.extendedTextMessage?.contextInfo ||
      msg.message?.imageMessage?.contextInfo ||
      msg.message?.videoMessage?.contextInfo ||
      msg.message?.audioMessage?.contextInfo ||
      msg.message?.stickerMessage?.contextInfo ||
      msg.message?.documentMessage?.contextInfo;

    // Signature technique basée sur le JID de la chaîne Genesis MD
    return (
      context?.forwardedNewsletterMessageInfo?.newsletterJid ===
      "120363407488517900@newsletter"
    );
  } catch (e) {
    return false;
  }
}

/**
 * Gère le flux du mode intelligent GPT
 */
async function handleSmartGPT(sock, jid, msg, text, ownerjid, cmdsToRun) {
  // 1. SI SIGNATURE TECHNIQUE OU MARQUEUR DÉTECTÉ -> BOT -> ON IGNORE
  if (isBotMessage(msg) || text.includes(BOT_INVISIBLE_MARKER)) {
    console.log(`🚫 [SMART MODE] Boucle évitée (Signature bot détectée).`);
    return false;
  }

  const isSmartMode = envManager.get(EnvKeys.SMART_GPT_MODE) === "true";
  const isFromOwner = isOwner(msg, envManager.get(EnvKeys.OWNER_NUMBER));

  if (!isFromOwner || !isSmartMode) {
    return false;
  }

  console.log(`🧠 [SMART MODE] Activation : "${text}"`);

  try {
    const result = await askSmartAI(sock, jid, msg, text);

    // Si l'IA détecte des actions (commandes), on ne met pas la signature IA moche
    const hasActions = result.actions && result.actions.length > 0;

    if (result.reponse) {
      let finalReponse = result.reponse;

      // On utilise sendMessage (notre wrapper) pour inclure le marqueur invisible
      await sendMessage(sock, jid, finalReponse, { quoted: msg });
    }

    if (hasActions) {
      for (const action of result.actions) {
        const cmdName = action.commande || action.type;
        const cmdArgs = action.args || (action.query ? [action.query] : []);

        if (cmdName) {
          console.log(` [EXEC SMART] ${cmdName} avec ${cmdArgs}`);
          cmdsToRun.push({
            name: cmdName,
            socket: sock,
            msg,
            args: Array.isArray(cmdArgs) ? cmdArgs : [cmdArgs],
          });
        }
      }
    }
    return true;
  } catch (err) {
    console.error("Erreur handleSmartGPT:", err.message);
    return true;
  }
}

/**
 * @param {object} sock - L'instance de ton bot
 * @param {string} jid - L'ID du groupe/chat
 * @param {number} seconds - Nombre de départ (ex: 10)
 */
async function startCountdown(sock, jid, seconds) {
  try {
    // 1. Envoyer le message initial
    let { key } = await sock.sendMessage(jid, { text: `*${seconds}*` });

    // 2. Boucle de décompte
    for (let i = seconds - 1; i >= 0; i--) {
      await randomSleep(1000, 2500); // Attend entre 1 et 1.5 secondes

      // 3. Modifier le message existant
      const content = `*${i}*`;

      await sock.sendMessage(jid, {
        text: content,
      });
    }
  } catch (err) {
    console.error("Erreur décompte:", err);

    fs.writeFileSync(`error_countdown_${Date.now()}.txt`, err.stack);
  }
}

/**
 * Convertit un buffer audio ou vidéo en buffer MP3 via FFmpeg
 * @param {Buffer} inputBuffer - Le buffer d'origine (audio ou vidéo)
 * @returns {Promise<Buffer>} - Le buffer converti en MP3
 */
async function convertToMp3(inputBuffer) {
  return new Promise((resolve, reject) => {
    // 1. Créer un flux lisible à partir du buffer
    const inputStream = new Readable();
    inputStream.push(inputBuffer);
    inputStream.push(null);

    const outputChunks = [];
    const outputStream = new PassThrough();

    // Collecter les morceaux de données convertis
    outputStream.on("data", (chunk) => {
      outputChunks.push(chunk);
    });

    // En cas de succès
    outputStream.on("end", () => {
      resolve(Buffer.concat(outputChunks));
    });

    // En cas d'erreur du flux de sortie
    outputStream.on("error", (err) => {
      console.error("❌ Erreur Flux de sortie FFmpeg:", err.message);
      reject(err);
    });

    // Configuration FFmpeg
    ffmpeg(inputStream)
      // .inputFormat("m4a")  // ❌ SUPPRIMÉ : FFmpeg détectera automatiquement le format (mp4, m4a, ogg, etc.)
      .toFormat("mp3")
      .audioCodec("libmp3lame")
      .audioBitrate("192k")
      .on("error", (err) => {
        console.error("❌ Erreur FFmpeg :", err.message);
        const logPath = `error_conversion_${Date.now()}.txt`;
        try {
          fs.writeFileSync(
            logPath,
            `Erreur FFmpeg : ${err.message}\n${err.stack}`,
          );
        } catch (e) {
          console.error("Impossible d'écrire le log d'erreur.");
        }
        reject(err);
      })
      .on("end", () => {
        console.log("✅ Conversion MP3 terminée");
      })
      .pipe(outputStream, { end: true }); // ✅ Assure la fermeture propre
  });
}
async function searchPinterest(query, apiKey = null) {
  try {
    const url = `https://yandex.com/images/search?text=site:pinterest.com ${encodeURIComponent(query)}`;

    const response = await axios.get(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      },
      timeout: 10000,
    });

    const html = response.data;

    // On attrape toutes les URLs Pinterest dans le tas
    const regex = /https:\/\/i\.pinimg\.com\/[a-zA-Z0-9/._-]+\.(jpg|png|webp)/g;
    const allMatches = html.match(regex) || [];

    // On utilise un Set pour supprimer les copies exactes de l'URL
    const results = [...new Set(allMatches)].map((url) => {
      // On s'assure juste que c'est en 736x pour la qualité
      return url.replace(/\/(236x|474x|564x|originals)\//, "/736x/");
    });

    // On mélange et on renvoie
    return results.sort(() => 0.5 - Math.random()).slice(0, 20);
  } catch (error) {
    const errorMsg = `[${new Date().toLocaleString()}] Erreur Pinterest Scraper: ${error.message}\n`;
    fs.appendFileSync("error_google_api.txt", errorMsg);
    return [];
  }
}
async function downloadImage(url, fileName) {
  // --- MODIFICATION : Utilisation du dossier temp à la racine du projet ---
  const filePath = path.join(process.cwd(), "temp", fileName);

  // Créer le dossier temp s'il n'existe pas (Sécurité)
  if (!fs.existsSync(path.dirname(filePath))) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
  }

  try {
    const response = await axios({
      url,
      method: "GET",
      responseType: "stream",
    });

    return new Promise((resolve, reject) => {
      const writer = fs.createWriteStream(filePath);
      response.data.pipe(writer);
      writer.on("finish", () => {
        console.log(`✅ Image téléchargée dans : ${filePath}`);
        resolve(filePath);
      });
      writer.on("error", (err) => {
        // Log de l'erreur dans un fichier .txt
        fs.appendFileSync(
          "error_download.txt",
          `Erreur sur ${url}: ${err.message}\n`,
        );
        reject(err);
      });
    });
  } catch (error) {
    fs.appendFileSync("error_download.txt", `Axios error: ${error.message}\n`);
    throw error;
  }
}

/**
 * Télécharge un fichier depuis une URL et renvoie son Buffer directement
 * @param {string} url - L'URL du fichier
 * @returns {Promise<Buffer>} - Le buffer du fichier téléchargé
 */
async function downloadFile(url) {
  try {
    const response = await axios({
      url,
      method: "GET",
      responseType: "arraybuffer",
      timeout: 300000, // 5 minutes
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
        Accept: "*/*",
      },
    });

    const contentType = response.headers["content-type"] || "";
    const buffer = Buffer.from(response.data);

    // Logs détaillés pour le debug
    console.log(`📡 [DOWNLOAD] URL: ${url.substring(0, 40)}...`);
    console.log(
      `📄 [DOWNLOAD] Type: ${contentType} | Taille: ${formatFileSize(buffer.length)}`,
    );

    if (
      contentType.includes("application/json") ||
      contentType.includes("text/html")
    ) {
      throw new Error(
        "Le serveur a renvoyé du texte/JSON au lieu d'un fichier binaire.",
      );
    }

    if (buffer.length < 50000) {
      // 50 Ko min pour un son
      throw new Error(
        `Fichier trop petit (${formatFileSize(buffer.length)}), probablement corrompu.`,
      );
    }

    return buffer;
  } catch (error) {
    console.error(
      `❌ [DOWNLOAD ERROR] ${url.substring(0, 30)}: ${error.message}`,
    );
    fs.appendFileSync(
      "error_download_file.txt",
      `[${new Date().toLocaleString()}] ${url}: ${error.message}\n`,
    );
    throw error;
  }
}

/**
 * Télécharge un fichier depuis Catbox et retourne son Buffer.
 * @param {string} fileName - Nom du fichier sur Catbox (ex: "abc.mp4")
 * @returns {Promise<Buffer>} - Le buffer du fichier téléchargé.
 */
async function downloadFileFromCatbox(fileName) {
  const url = `https://files.catbox.moe/${fileName}`;
  return await downloadFile(url);
}

/**
 * Convertit un buffer média en fichier PNG dans le dossier temp.
 * @param {Buffer} buffer - Le buffer du média téléchargé.
 * @returns {Promise<string>} - Le chemin du fichier PNG généré.
 */
async function getPngPathFromBuffer(buffer) {
  // --- MODIFICATION : Utilisation du dossier temp pour les conversions ---
  const fileName = `temp_conversion_${Date.now()}.png`;
  const outputPath = path.join(process.cwd(), "temp", fileName);

  // Fichier tampon brut
  var tempInput = path.join(process.cwd(), "temp", `raw_${Date.now()}.webp`);

  try {
    // S'assurer que le dossier temp existe
    const tempDir = path.join(process.cwd(), "temp");
    if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

    fs.writeFileSync(tempInput, buffer);

    // Conversion forcée en PNG via Sharp
    await sharp(tempInput, { animated: true, pages: 1 })
      .png()
      .toFile(outputPath);

    return outputPath;
  } catch (error) {
    console.error("Erreur lors de la conversion PNG:", error);
    throw error;
  } finally {
    // Nettoyage immédiat du fichier tampon
    if (fs.existsSync(tempInput)) fs.unlinkSync(tempInput);
  }
}
/**
 * Récupère une liste de messages filtrés depuis la DB avec logs détaillés
 * @param {string} jid - L'identifiant du chat
 * @param {number} limit - Nombre de messages à remonter
 * @param {string} messageType - Type spécifique (imageMessage, videoMessage, etc.)
 */
async function getAllMessages(sock, jid, limit = 10, messageType = "any") {
  return new Promise((resolve, reject) => {
    const targetJid =
      typeof jid === "object" ? jid.remoteJid || jid.key?.remoteJid : jid;
    let finalLimit = parseInt(limit) || 10;

    // Normalisation du type (accepte String ou Array)
    let typeStr = Array.isArray(messageType)
      ? messageType.join(",")
      : String(messageType || "any");

    if (!targetJid) return resolve([]);

    // ✅ Utilisation de json_extract pour compter les messages du JID
    db.get(
      `SELECT COUNT(*) as total FROM messages WHERE json_extract(content, '$.key.remoteJid') = ?`,
      [targetJid],
      (err, countRow) => {
        if (err) {
          if (err.message.includes("no such table")) {
            sock.sendMessage(jid, {
              text: `⚠️ La base de données n'est pas encore prête. Veuillez réessayer dans quelques secondes.`,
            });
            return resolve([]);
          }
          console.error(`❌ [DB COUNT ERROR]`, err.message);
        }

        const totalInChat = countRow ? countRow.total : 0;

        // ✅ Utilisation de json_extract pour filtrer et trier
        let query = `SELECT content FROM messages WHERE json_extract(content, '$.key.remoteJid') = ?`;
        let params = [targetJid];

        if (typeStr !== "any") {
          const types = typeStr.split(",");
          const typeConditions = types.map(() => `content LIKE ?`).join(" OR ");
          query += ` AND (${typeConditions})`;
          types.forEach((t) => params.push(`%"${t.trim()}":%`));
        }

        query += ` ORDER BY json_extract(content, '$.messageTimestamp') DESC LIMIT ?`;
        params.push(finalLimit);

        console.log(
          `🔍 [DB SCAN] Chat: ${targetJid} | Stock: ${totalInChat} | Types: ${typeStr} | Limit: ${finalLimit}`,
        );

        try {
          db.all(query, params, (err, rows) => {
            if (err) {
              console.error(`❌ [DB ERROR]`, err.message);
              return reject(err);
            }

            if (!rows || rows.length === 0) {
              console.log(`⚠️ [DB RESULT] Rien trouvé.`);
              return resolve([]);
            }

            // ✅ Reconstruction de l'objet Baileys directement depuis le JSON stocké
            const result = rows
              .map((row) => {
                try {
                  return JSON.parse(row.content);
                } catch (e) {
                  return null;
                }
              })
              .filter((m) => m !== null);

            console.log(`✅ [DB SUCCESS] Trouvé ${result.length} élément(s).`);
            resolve(result);
          });
        } catch (error) {
          console.error("Erreur getAllMessages:", error);
          resolve([]);
        }
      },
    );
  });
}

/**
 * Convertit plusieurs messages en stickers
 */
async function convertMessagesToStickers(sock, jid, messages, options = {}) {
  const results = [];
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    const messageId = message.key?.id || `idx_${i}`;

    try {
      console.log(`[STICKER] Conversion ${i + 1}/${messages.length}...`);

      // Identification du type de média
      const content = message.message;
      const messageType = content?.imageMessage
        ? "imageMessage"
        : content?.videoMessage
          ? "videoMessage"
          : null;

      if (!messageType) {
        results.push({
          buffer: null,
          messageId,
          error: new Error("Type non supporté"),
        });
        continue;
      }

      const buffer = await downloadMediaMessage(
        message,
        "buffer",
        {},
        { logger: console, reuploadRequest: sock.updateMediaMessage },
      );

      if (!buffer) throw new Error("Téléchargement échoué");

      const stickerBuffer = await convertMediaToSticker(
        buffer,
        messageType,
        options,
      );
      results.push({ buffer: stickerBuffer, messageId, error: null });

      console.log(`[STICKER] ✅ ${i + 1}/${messages.length} OK`);
    } catch (error) {
      console.error(`[STICKER] ❌ Erreur message ${messageId}:`, error.message);
      results.push({ buffer: null, messageId, error });
    }
  }
  return results;
}

/**
 * Convertit un buffer média en sticker WebP
 * @param {Buffer} buffer - Buffer du média (image ou vidéo)
 * @param {string} messageType - Type de message ("imageMessage" ou "videoMessage")
 * @param {object} options - Options du sticker (pack, author, quality)
 * @returns {Promise<Buffer>} - Buffer du sticker converti
 */
async function convertMediaToSticker(buffer, messageType, options = {}) {
  const tempDir = path.join(process.cwd(), "temp");
  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
  }

  const timestamp = Date.now();
  const outputPath = path.join(tempDir, `sticker_${timestamp}.webp`);
  let finalInputPath = null;

  try {
    // Prépare le fichier d'entrée selon le type
    if (messageType === "videoMessage") {
      finalInputPath = path.join(tempDir, `temp_vid_${timestamp}.mp4`);
      fs.writeFileSync(finalInputPath, buffer);
    } else {
      finalInputPath = await getPngPathFromBuffer(buffer);
    }

    // Commande FFmpeg selon le type
    const isVideo = messageType === "videoMessage";
    const ffmpegCmd = isVideo
      ? `ffmpeg -i "${finalInputPath}" ` +
        `-t 5 -f webp ` +
        `-vf "scale=512:512:force_original_aspect_ratio=decrease,fps=10,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=black@0" ` +
        `-pix_fmt yuva420p ` + // 🟢 Meilleure compatibilité GIF
        `-vcodec libwebp -lossless 0 -compression_level 4 -q:v 20 -loop 0 -preset picture ` +
        `-an -vsync 0 -fs 800K "${outputPath}" -y`
      : `ffmpeg -i "${finalInputPath}" ` + // 🟢 Ajouté ici (sinon crash)
        `-vf "scale=512:512:force_original_aspect_ratio=decrease,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=black@0" ` +
        `-vcodec libwebp -lossless 0 -q:v 40 "${outputPath}" -y`;

    await execPromise(ffmpegCmd);

    // Lecture du sticker converti
    if (!fs.existsSync(outputPath)) {
      throw new Error("Le fichier de sortie FFmpeg n'a pas été généré.");
    }

    const stickerBuffer = fs.readFileSync(outputPath);

    // Ajout des métadonnées avec wa-sticker-formatter
    const sticker = new Sticker(stickerBuffer, {
      pack: options.pack,
      author: options.author,
      type: options.type, // 'full' ou 'crop'
      quality: options.quality || 50,
    });

    const finalBuffer = await sticker.toBuffer();

    // Nettoyage optionnel pour économiser tes 1 Go de RAM
    fs.unlinkSync(finalInputPath);
    fs.unlinkSync(outputPath);
    // Nettoyage
    if (finalInputPath && fs.existsSync(finalInputPath)) {
      fs.unlinkSync(finalInputPath);
    }
    if (fs.existsSync(outputPath)) {
      fs.unlinkSync(outputPath);
    }

    return finalBuffer;
  } catch (error) {
    // Nettoyage en cas d'erreur
    if (finalInputPath && fs.existsSync(finalInputPath)) {
      fs.unlinkSync(finalInputPath);
    }
    if (fs.existsSync(outputPath)) {
      fs.unlinkSync(outputPath);
    }

    throw error;
  }
}

/**
 * Convertit plusieurs messages en stickers
 * @param {object} sock - Socket Baileys
 * @param {string} jid - ID de la discussion
 * @param {Array} messages - Tableau de messages à convertir
 * @param {object} options - Options des stickers (pack, author, quality)
 * @returns {Promise<Array<{buffer: Buffer, messageId: string, error: null|Error}>>}
 *//**
 * Convertit plusieurs messages en stickers
 */
async function convertMessagesToStickers(sock, jid, messages, options = {}) {
  const results = [];
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    const messageId = message.key?.id || `idx_${i}`;

    try {
      console.log(`[STICKER] Conversion ${i + 1}/${messages.length}...`);

      // Identification du type de média
      const content = message.message;
      const messageType = content?.imageMessage
        ? "imageMessage"
        : content?.videoMessage
          ? "videoMessage"
          : null;

      if (!messageType) {
        results.push({
          buffer: null,
          messageId,
          error: new Error("Type non supporté"),
        });
        continue;
      }

      const buffer = await downloadMediaMessage(
        message,
        "buffer",
        {},
        { logger: console, reuploadRequest: sock.updateMediaMessage },
      );

      if (!buffer) throw new Error("Téléchargement échoué");

      const stickerBuffer = await convertMediaToSticker(
        buffer,
        messageType,
        options,
      );
      results.push({ buffer: stickerBuffer, messageId, error: null });

      console.log(`[STICKER] ✅ ${i + 1}/${messages.length} OK`);
    } catch (error) {
      console.error(`[STICKER] ❌ Erreur message ${messageId}:`, error.message);
      results.push({ buffer: null, messageId, error });
    }
  }
  return results;
}

/**
 * Envoie un message d'avertissement avec mention (tag)
 * @param {object} sock - L'instance de connexion Baileys
 * @param {string} jid - Le JID du groupe
 * @param {string} userJid - Le JID de l'utilisateur à taguer
 * @param {string} reason - La raison de l'avertissement (antilink, antiimage, etc.)
 */
async function warnUser(sock, jid, userJid, reason) {
  try {
    if (reason !== `mute`) {
      // pour mute on enverra pas de warn

      // Ajoute un avertissement à l'utilisateur et récupère le total actuel
      const count = addWarn(jid, userJid, reason);

      // Assure que la config du groupe existe et récupère les paramètres
      const group = await ensureGroupConfig(sock, jid);
      const warnMode = group.warnOnly; // true = avertissements illimités

      // ✅ Dictionnaire de traduction pour un affichage propre
      const reasonNames = {
        antilink: "liens",
        antiimage: "images",
        antisticker: "stickers",
        antispam: "spams",
        antistatusgmention: "mentions de groupe en statut",
      };

      const displayReason =
        reasonNames[reason] ?? reason.replace("anti", "") + "s";

      if (warnMode) {
        // ✅ Mode WARN ILLIMITÉ : seulement avertissement sans kick
        await sock.sendMessage(jid, {
          text: `⚠️ @${userJid.split("@")[0]}, les ${displayReason} sont interdits ici. Merci de respecter la règle.`,
          mentions: [userJid], // Tag l'utilisateur
        });
        return; // On sort, pas d'expulsion
      }

      const maxWarn = group.maxWarns; // Limite d'avertissements avant kick

      // ⚠️ Mode normal : expulsion si dépassement du maximum
      if (count < maxWarn) {
        await sock.sendMessage(jid, {
          text: `⚠️ @${userJid.split("@")[0]}, les ${displayReason} ne sont pas autorisés ici.\nAvertissements : ${count}/${maxWarn}`,
          mentions: [userJid], // Tag l'utilisateur
        });
      } else {
        // Message d'avertissement standard si max non atteint
        await sock.sendMessage(jid, {
          text: `🚫 @${userJid.split("@")[0]}, les ${displayReason} ne sont toujours pas autorisés.\n${maxWarn} avertissements atteints. Retrait du groupe.`,
          mentions: [userJid], // Tag l'utilisateur
        });
        // Expulse l'utilisateur du groupe
        await sock.groupParticipantsUpdate(jid, [userJid], "remove");
        // Réinitialise les avertissements de l'utilisateur après kick
        resetWarns(jid, userJid);
      }
    }
  } catch (err) {
    // Enregistre toute erreur dans un fichier pour debug
    fs.writeFileSync(`error_warn_user_${Date.now()}.txt`, err.stack);
  }
}
// =========================================================
// ✍️ FANCY FONTS (UNICODE)
// =========================================================

const FANCY_STYLES = {
  1: {
    name: "𝔻𝕠𝕦𝕓𝕝𝕖 𝕊𝕥𝕣𝕦𝕔𝕜",
    apply: (text) => {
      const special = {
        C: "ℂ",
        H: "ℍ",
        N: "ℕ",
        P: "ℙ",
        Q: "ℚ",
        R: "ℝ",
        Z: "ℤ",
      };
      return text
        .split("")
        .map((c) => {
          if (special[c]) return special[c];
          if (/[A-Z]/.test(c))
            return String.fromCodePoint(c.charCodeAt(0) - 65 + 0x1d538);
          if (/[a-z]/.test(c))
            return String.fromCodePoint(c.charCodeAt(0) - 97 + 0x1d552);
          if (/[0-9]/.test(c))
            return String.fromCodePoint(c.charCodeAt(0) - 48 + 0x1d7d8);
          return c;
        })
        .join("");
    },
  },
  2: {
    name: "𝔊𝔬𝔱𝔥𝔦𝔠",
    apply: (text) => {
      return text
        .split("")
        .map((c) => {
          if (/[A-Z]/.test(c))
            return String.fromCodePoint(c.charCodeAt(0) - 65 + 0x1d504);
          if (/[a-z]/.test(c))
            return String.fromCodePoint(c.charCodeAt(0) - 97 + 0x1d51e);
          return c;
        })
        .join("");
    },
  },
  3: {
    name: "Ⓑⓤⓑⓑⓛⓔⓢ",
    apply: (text) => {
      return text
        .split("")
        .map((c) => {
          if (/[A-Z]/.test(c))
            return String.fromCodePoint(c.charCodeAt(0) - 65 + 0x24b6);
          if (/[a-z]/.test(c))
            return String.fromCodePoint(c.charCodeAt(0) - 97 + 0x24d0);
          if (/[0-9]/.test(c))
            return ["⓪", "①", "②", "③", "④", "⑤", "⑥", "⑦", "⑧", "⑨"][c];
          return c;
        })
        .join("");
    },
  },
  4: {
    name: "ꪖɀꫀꪗ 𝘴𝓽ꪗꪶꫀ",
    apply: (text) => {
      const map = {
        a: "ꪖ",
        b: "᥇",
        c: "ᥴ",
        d: "ᦔ",
        e: "ꫀ",
        f: "ᠻ",
        g: "ᧁ",
        h: "ꫝ",
        i: "𝓲",
        j: "𝓳",
        k: "ƙ",
        l: "ꪶ",
        m: "ꪑ",
        n: "ꪀ",
        o: "ꪮ",
        p: "ρ",
        q: "𝓺",
        r: "𝘳",
        s: "𝘴",
        t: "𝓽",
        u: "ꪊ",
        v: "ꪜ",
        w: "᭙",
        x: "᥊",
        y: "ꪗ",
        z: "ɀ",
        A: "ꪖ",
        B: "᥇",
        C: "ᥴ",
        D: "ᦔ",
        E: "ꫀ",
        F: "ᠻ",
        G: "ᧁ",
        H: "ꫝ",
        I: "𝓲",
        J: "𝓳",
        K: "ƙ",
        L: "ꪶ",
        M: "ꪑ",
        N: "ꪀ",
        O: "ꪮ",
        P: "ρ",
        Q: "𝓺",
        R: "𝘳",
        S: "𝘴",
        T: "𝓽",
        U: "ꪊ",
        V: "ꪜ",
        W: "᭙",
        X: "᥊",
        Y: "ꪗ",
        Z: "ɀ",
      };
      return text
        .split("")
        .map((c) => map[c] || c)
        .join("");
    },
  },
  5: {
    name: "𝗦𝗮𝗻𝘀 𝗕𝗼𝗹𝗱",
    apply: (text) => {
      return text
        .split("")
        .map((c) => {
          if (/[A-Z]/.test(c))
            return String.fromCodePoint(c.charCodeAt(0) - 65 + 0x1d5d4);
          if (/[a-z]/.test(c))
            return String.fromCodePoint(c.charCodeAt(0) - 97 + 0x1d5ba);
          if (/[0-9]/.test(c))
            return String.fromCodePoint(c.charCodeAt(0) - 48 + 0x1d7ec);
          return c;
        })
        .join("");
    },
  },
  6: {
    name: "𝕸𝖊𝖉𝖎𝖊𝖛𝖆𝖑",
    apply: (text) => {
      return text
        .split("")
        .map((c) => {
          if (/[A-Z]/.test(c))
            return String.fromCodePoint(c.charCodeAt(0) - 65 + 0x1d56c);
          if (/[a-z]/.test(c))
            return String.fromCodePoint(c.charCodeAt(0) - 97 + 0x1d586);
          if (/[0-9]/.test(c))
            return String.fromCodePoint(c.charCodeAt(0) - 48 + 0x1d7ec);
          return c;
        })
        .join("");
    },
  },
  7: {
    name: "ᵀⁱⁿʸ",
    apply: (text) => {
      const map = {
        a: "𝒶",
        b: "𝒷",
        c: "𝒸",
        d: "𝒹",
        e: "𝑒",
        f: "𝒻",
        g: "𝑔",
        h: "𝒽",
        i: "𝒾",
        j: "𝒿",
        k: "𝓀",
        l: "𝓁",
        m: "𝓂",
        n: "𝓃",
        o: "𝑜",
        p: "𝓅",
        q: "𝓆",
        r: "𝓇",
        s: "𝓈",
        t: "𝓉",
        u: "𝓊",
        v: "𝓋",
        w: "𝓌",
        x: "𝓍",
        y: "𝓎",
        z: "𝓏",
        A: "𝒜",
        B: "ℬ",
        C: "𝒞",
        D: "𝒟",
        E: "ℰ",
        F: "ℱ",
        G: "𝒢",
        H: "ℋ",
        I: "ℐ",
        J: "𝒥",
        K: "𝒦",
        L: "ℒ",
        M: "ℳ",
        N: "𝒩",
        O: "𝒪",
        P: "𝒫",
        Q: "𝒬",
        R: "ℛ",
        S: "𝒮",
        T: "𝒯",
        U: "𝒰",
        V: "𝒱",
        W: "𝒲",
        X: "𝒳",
        Y: "𝒴",
        Z: "𝒵",
      };
      return text
        .split("")
        .map((c) => map[c] || c)
        .join("");
    },
  },
  8: {
    name: "SᗰOOTᕼ ᑕᑌᖇᐯE",
    apply: (text) => {
      const map = {
        a: "ᗩ",
        b: "ᗷ",
        c: "ᑕ",
        d: "ᗪ",
        e: "E",
        f: "ᖴ",
        g: "G",
        h: "ᕼ",
        i: "I",
        j: "ᒍ",
        k: "K",
        l: "ᒪ",
        m: "ᗰ",
        n: "ᑎ",
        o: "O",
        p: "ᑭ",
        q: "Q",
        r: "ᖇ",
        s: "S",
        t: "T",
        u: "ᑌ",
        v: "ᐯ",
        w: "ᗯ",
        x: "X",
        y: "Y",
        z: "Z",
        A: "ᗩ",
        B: "ᗷ",
        C: "ᑕ",
        D: "ᗪ",
        E: "E",
        F: "ᖴ",
        G: "G",
        H: "ᕼ",
        I: "I",
        J: "ᒍ",
        K: "K",
        L: "ᒪ",
        M: "ᗰ",
        N: "ᑎ",
        O: "O",
        P: "ᑭ",
        Q: "Q",
        R: "ᖇ",
        S: "S",
        T: "T",
        U: "ᑌ",
        v: "ᐯ",
        W: "ᗯ",
        X: "X",
        Y: "Y",
        Z: "Z",
      };
      return text
        .split("")
        .map((c) => map[c] || c)
        .join("");
    },
  },
  9: {
    name: "Small Caps",
    apply: (text) => {
      const map = {
        a: "ᴀ",
        b: "ʙ",
        c: "ᴄ",
        d: "ᴅ",
        e: "ᴇ",
        f: "ꜰ",
        g: "ɢ",
        h: "ʜ",
        i: "ɪ",
        j: "ᴊ",
        k: "ᴋ",
        l: "ʟ",
        m: "ᴍ",
        n: "ɴ",
        o: "ᴏ",
        p: "ᴘ",
        q: "ǫ",
        r: "ʀ",
        s: "ꜱ",
        t: "ᴛ",
        u: "ᴜ",
        v: "ᴠ",
        w: "ᴡ",
        x: "x",
        y: "ʏ",
        z: "ᴢ",
        A: "ᴀ",
        B: "ʙ",
        C: "ᴄ",
        D: "ᴅ",
        E: "ᴇ",
        F: "ꜰ",
        G: "ɢ",
        H: "ʜ",
        I: "ɪ",
        J: "ᴊ",
        K: "ᴋ",
        L: "ʟ",
        M: "ᴍ",
        N: "ɴ",
        O: "ᴏ",
        P: "ᴘ",
        Q: "ǫ",
        R: "ʀ",
        S: "ꜱ",
        T: "ᴛ",
        U: "ᴜ",
        V: "ᴠ",
        W: "ᴡ",
        X: "x",
        Y: "ʏ",
        Z: "ᴢ",
        0: "𝟢",
        1: "𝟣",
        2: "𝟤",
        3: "𝟥",
        4: "𝟦",
        5: "𝟧",
        6: "𝟨",
        7: "𝟩",
        8: "𝟪",
        9: "𝟫",
      };
      return text
        .split("")
        .map((c) => map[c] || c)
        .join("");
    },
  },
  10: {
    name: "Lorem",
    apply: (text) => {
      return text
        .split("")
        .map((c) => {
          if (/[A-Z]/.test(c))
            return String.fromCodePoint(c.charCodeAt(0) - 65 + 0x1d400);
          if (/[a-z]/.test(c))
            return String.fromCodePoint(c.charCodeAt(0) - 97 + 0x1d41a);
          if (/[0-9]/.test(c))
            return String.fromCodePoint(c.charCodeAt(0) - 48 + 0x1d7ce);
          return c;
        })
        .join("");
    },
  },
};

/**
 * Applique un style Fancy à un texte en utilisant le système local.
 * Ignore les liens (URLs) et les mentions (@numéro) pour qu'ils restent cliquables/fonctionnels.
 * @param {string} text - Texte à transformer
 * @returns {string} - Texte stylisé
 */
function applyFancy(text) {
  const currentStyleId = envManager.get(EnvKeys.BOT_FANCY);
  if (!currentStyleId || !FANCY_STYLES[currentStyleId]) return text;

  try {
    const style = FANCY_STYLES[currentStyleId];

    // Regex pour détecter les URLs (http/https/www) et les mentions (@suivies de chiffres)
    // On capture ces éléments pour les exclure de la transformation
    const regex = /(https?:\/\/[^\s]+|www\.[^\s]+|@\d+)/gi;

    // On découpe le texte : les parties qui matchent la regex resteront intactes
    // Les autres parties seront transformées par le style choisi
    return text
      .split(regex)
      .map((part) => {
        if (part.match(regex)) {
          return part; // C'est un lien ou une mention -> on ne touche à rien
        }
        return style.apply(part); // C'est du texte normal -> on applique le Fancy
      })
      .join("");
  } catch (error) {
    console.error("❌ Erreur applyFancy:", error.message);
    return text;
  }
}

/**
 * Envoie un message avec badge de chaîne (supporte tous les types de médias)
 *
 * @param {Object} sock - Instance du socket Baileys
 * @param {string} jid - JID du destinataire
 * @param {string|Object} content - Texte ou objet de configuration du média
 * @param {Object} options - Options d'envoi
 * @param {string} options.type - Type de média: 'text', 'image', 'video', 'audio', 'sticker', 'document', 'contact', 'location'
 * @param {string} options.mediaPath - Chemin vers le fichier média (si type !== 'text')
 * @param {Buffer} options.mediaBuffer - Buffer du média (alternative à mediaPath)
 * @param {string} options.caption - Caption pour image/video/document
 * @param {string} options.mimetype - Type MIME pour audio/document
 * @param {string} options.fileName - Nom du fichier pour document
 * @param {boolean} options.ptt - Push-to-talk (true pour vocal)
 * @param {string} options.channelJid - JID de la chaîne
 * @param {string} options.channelName - Nom de la chaîne
 * @param {boolean} options.showForwardedBadge - Afficher "Transféré plusieurs fois"
 * @param {Object} options.quoted - Message à citer
 *
 * @returns {Promise<Object>} - {success: boolean, messageInfo?: Object, error?: string}
 */
async function sendMessage(sock, jid, content, options = {}) {
  try {
    const {
      type = "text",
      mediaPath = null,
      mediaBuffer = null,
      caption = "",
      mimetype = null,
      fileName = null,
      ptt = false,
      channelJid = "120363407488517900@newsletter",
      channelName = "𝑮𝒆𝒏𝒆𝒔𝒊𝒔 𝑴𝑫",
      showForwardedBadge = true,
      quoted = null,
      mentions = null,
      skipFancy = false,
      showBotMarker = true,
    } = options;

    // =========================================================
    // 📋 CONTEXTE COMMUN (Badge de chaîne)
    // =========================================================

    const baseContextInfo = {
      forwardedNewsletterMessageInfo: {
        newsletterJid: channelJid,
        newsletterName: channelName,
        serverMessageId: 100,
      },
      ...(showForwardedBadge && {
        forwardingScore: 1,
        isForwarded: true,
      }),
    };

    // =========================================================
    // 🎯 CONSTRUCTION DU MESSAGE SELON LE TYPE
    // =========================================================

    let messageContent = {};

    // Ajout du marqueur invisible pour identifier les messages du bot (anti-boucle IA)
    const appendMarker = (text) => {
      const marker = showBotMarker ? BOT_INVISIBLE_MARKER : "";
      if (!text) return marker;
      // Application de la police Fancy si configurée
      const styledText = skipFancy ? text : applyFancy(text);
      return styledText + marker;
    };

    switch (type.toLowerCase()) {
      // ─────────────────────────────────────────────────────
      // 📝 TEXTE SIMPLE
      // ─────────────────────────────────────────────────────
      case "text":
        {
          const rawText =
            typeof content === "string" ? content : content.text || "";
          messageContent = {
            text: appendMarker(rawText),
            contextInfo: baseContextInfo,
            mentions,
          };
        }
        break;

      // ─────────────────────────────────────────────────────
      // 🖼️ IMAGE
      // ─────────────────────────────────────────────────────
      case "image":
        {
          const rawCaption =
            content?.caption ||
            caption ||
            (typeof content === "string" ? content : "");
          if (hasLink(mediaPath)) {
            messageContent = {
              image: { url: mediaPath },
              caption: appendMarker(rawCaption),
              contextInfo: baseContextInfo,
              mentions,
            };
          } else {
            const imageSource =
              mediaBuffer ||
              (mediaPath ? fs.readFileSync(mediaPath) : content.image);

            messageContent = {
              image: imageSource,
              caption: appendMarker(rawCaption),
              contextInfo: baseContextInfo,
              mentions,
            };
          }
        }
        break;

      // ─────────────────────────────────────────────────────
      // 🎥 VIDEO
      // ─────────────────────────────────────────────────────
      case "video":
        {
          const videoBuffer =
            mediaBuffer || (mediaPath ? fs.readFileSync(mediaPath) : null);

          if (!videoBuffer) {
            throw new Error(
              "Video buffer ou mediaPath requis pour type 'video'",
            );
          }

          const rawCaption =
            caption || (typeof content === "string" ? content : "");

          messageContent = {
            video: videoBuffer,
            caption: appendMarker(rawCaption),
            mimetype: mimetype || "video/mp4",
            contextInfo: baseContextInfo,
          };
        }
        break;

      // ─────────────────────────────────────────────────────
      // 🎵 AUDIO
      // ─────────────────────────────────────────────────────
      case "audio":
        {
          const audioBuffer =
            mediaBuffer || (mediaPath ? fs.readFileSync(mediaPath) : null);

          if (!audioBuffer) {
            throw new Error(
              "Audio buffer ou mediaPath requis pour type 'audio'",
            );
          }

          messageContent = {
            audio: audioBuffer,
            mimetype: mimetype || "audio/mpeg",
            ptt: ptt, // true = message vocal, false = fichier audio
            contextInfo: baseContextInfo,
          };
        }
        break;

      // ─────────────────────────────────────────────────────
      // 🎭 STICKER
      // ─────────────────────────────────────────────────────
      case "sticker":
        {
          const stickerBuffer =
            mediaBuffer || (mediaPath ? fs.readFileSync(mediaPath) : null);

          if (!stickerBuffer) {
            throw new Error(
              "Sticker buffer ou mediaPath requis pour type 'sticker'",
            );
          }

          messageContent = {
            sticker: stickerBuffer,
            // Les stickers n'ont pas de contextInfo visible, mais on peut l'ajouter
            contextInfo: baseContextInfo,
          };
        }
        break;

      // ─────────────────────────────────────────────────────
      // 📄 DOCUMENT
      // ─────────────────────────────────────────────────────
      case "document":
        {
          const documentBuffer =
            mediaBuffer || (mediaPath ? fs.readFileSync(mediaPath) : null);

          if (!documentBuffer) {
            throw new Error(
              "Document buffer ou mediaPath requis pour type 'document'",
            );
          }

          const docFileName =
            fileName || (mediaPath ? path.basename(mediaPath) : "document.pdf");
          const docMimetype = mimetype || getDocumentMimetype(docFileName);

          messageContent = {
            document: documentBuffer,
            mimetype: docMimetype,
            fileName: docFileName,
            caption: caption || (typeof content === "string" ? content : ""),
            contextInfo: baseContextInfo,
          };
        }
        break;

      // ─────────────────────────────────────────────────────
      // 👤 CONTACT
      // ─────────────────────────────────────────────────────
      case "contact":
        {
          // content doit être un objet avec displayName et vcard
          const contactData = typeof content === "object" ? content : null;

          if (!contactData || !contactData.displayName || !contactData.vcard) {
            throw new Error("Contact data requis: {displayName, vcard}");
          }

          messageContent = {
            contacts: {
              displayName: contactData.displayName,
              contacts: [{ vcard: contactData.vcard }],
            },
            contextInfo: baseContextInfo,
          };
        }
        break;

      // ─────────────────────────────────────────────────────
      // 📍 LOCATION
      // ─────────────────────────────────────────────────────
      case "location":
        {
          // content doit être un objet avec latitude et longitude
          const locationData = typeof content === "object" ? content : null;

          if (
            !locationData ||
            !locationData.latitude ||
            !locationData.longitude
          ) {
            throw new Error("Location data requis: {latitude, longitude}");
          }

          messageContent = {
            location: {
              degreesLatitude: locationData.latitude,
              degreesLongitude: locationData.longitude,
              name: locationData.name || "",
              address: locationData.address || "",
            },
            contextInfo: baseContextInfo,
          };
        }
        break;

      // ─────────────────────────────────────────────────────
      // ❌ TYPE NON SUPPORTÉ
      // ─────────────────────────────────────────────────────
      default:
        throw new Error(
          `Type '${type}' non supporté. Types valides: text, image, video, audio, sticker, document, contact, location`,
        );
    }

    // =========================================================
    // 📤 ENVOI DU MESSAGE
    // =========================================================

    const sendOptions = quoted ? { quoted } : {};
    const messageInfo = await sock.sendMessage(
      jid,
      messageContent,
      sendOptions,
    );

    console.log(`✅ Message ${type} avec badge de chaîne envoyé à ${jid}`);

    return {
      success: true,
      messageInfo: messageInfo,
      type: type,
    };
  } catch (error) {
    console.error("❌ Erreur lors de l'envoi:", error.message);

    // Log dans un fichier
    const logEntry = `${new Date().toISOString()} - JID: ${jid} - Type: ${options.type || "text"} - Erreur: ${error.message}\n`;
    fs.appendFileSync("erreurs_baileys.txt", logEntry);

    return {
      success: false,
      error: error.message,
    };
  }
}

/**
 * Détermine le mimetype d'un document selon son extension
 */
function getDocumentMimetype(fileName) {
  const ext = path.extname(fileName).toLowerCase();

  const mimetypes = {
    ".pdf": "application/pdf",
    ".doc": "application/msword",
    ".docx":
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".xls": "application/vnd.ms-excel",
    ".xlsx":
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".ppt": "application/vnd.ms-powerpoint",
    ".pptx":
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ".zip": "application/zip",
    ".rar": "application/x-rar-compressed",
    ".txt": "text/plain",
    ".json": "application/json",
    ".apk": "application/vnd.android.package-archive",
    ".mp3": "audio/mpeg",
    ".mp4": "video/mp4",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".gif": "image/gif",
    ".webp": "image/webp",
  };

  return mimetypes[ext] || "application/octet-stream";
}

/**
 * Extrait l'ID et le Nom de la chaîne (Newsletter) si le message est transféré
 * @param {Object} msg - Message Baileys
 * @returns {Object|null} - { jid, name } ou null
 */
function getNewsletterMetadata(msg) {
  try {
    // On cherche dans le contextInfo du message texte, image ou vidéo
    const context =
      msg.message?.extendedTextMessage?.contextInfo ||
      msg.message?.imageMessage?.contextInfo ||
      msg.message?.videoMessage?.contextInfo;

    if (context?.newsletterJid) {
      return {
        jid: context.newsletterJid,
        name: context.newsletterName,
      };
    }
    return null;
  } catch (error) {
    // Ta consigne : Écriture de l'erreur dans un fichier .txt
    const errorLog = `[${new Date().toLocaleString()}] Erreur Newsletter Extraction: ${error.message}\nStack: ${error.stack}\n\n`;
    fs.appendFileSync("error_newsletter.txt", errorLog);
    return null;
  }
}

/**
 * Récupère le rôle complet d'un participant (pour plus de détails)
 *
 * @param {Object} sock - Instance du socket Baileys
 * @param {string} groupJid - JID du groupe
 * @param {string} userJid - JID de l'utilisateur
 *
 * @returns {Promise<Object>} - {role: string, isSuperAdmin: boolean, isAdmin: boolean, isMember: boolean}
 */
async function getParticipantRole(sock, groupJid, userJid, cache = null) {
  try {
    // 1. Tenter le cache d'abord
    let groupMetadata = cache?.get(groupJid);

    // 2. Appel API si pas en cache
    if (!groupMetadata) {
      try {
        groupMetadata = await sock.groupMetadata(groupJid);
        cache?.set(groupJid, groupMetadata);
      } catch (err) {
        if (err.message.includes("rate-overlimit"))
          return {
            role: null,
            isSuperAdmin: false,
            isAdmin: false,
            isMember: false,
            found: false,
          };
        throw err;
      }
    }

    const userNumber = userJid.split("@")[0];

    const participant = groupMetadata.participants.find(
      (p) => p.id === userJid || p.id.split("@")[0] === userNumber,
    );

    if (!participant) {
      return {
        role: null,
        isSuperAdmin: false,
        isAdmin: false,
        isMember: false,
        found: false,
      };
    }

    const role = participant.admin || "member";

    return {
      role: role,
      isSuperAdmin: role === "superadmin",
      isAdmin: role === "admin" || role === "superadmin",
      isMember: true,
      found: true,
    };
  } catch (error) {
    console.error(`[getParticipantRole] Erreur: ${error.message}`);
    return {
      role: null,
      isSuperAdmin: false,
      isAdmin: false,
      isMember: false,
      found: false,
      error: error.message,
    };
  }
}

/**
 * Envoi manuel d'un ViewOnce en PV
 */
async function sendViewOnceToPrivate(sock, msg, targetUserJid) {
  try {
    const contextInfo = msg.message?.extendedTextMessage?.contextInfo;
    if (!contextInfo || !contextInfo.quotedMessage) {
      return {
        success: false,
        error: "Répondez à un message ViewOnce pour utiliser cette commande.",
      };
    }

    const quotedMessage = contextInfo.quotedMessage;
    let mediaMessage = null;
    let mediaType = null;
    let caption = "";

    // Détection
    if (
      quotedMessage.imageMessage &&
      quotedMessage.imageMessage.viewOnce === true
    ) {
      mediaType = "image";
      mediaMessage = quotedMessage.imageMessage;
      caption = mediaMessage.caption || "";
    } else if (
      quotedMessage.videoMessage &&
      quotedMessage.videoMessage.viewOnce === true
    ) {
      mediaType = "video";
      mediaMessage = quotedMessage.videoMessage;
      caption = mediaMessage.caption || "";
    } else if (
      quotedMessage.viewOnceMessage ||
      quotedMessage.viewOnceMessageV2
    ) {
      const viewOnceContent =
        quotedMessage.viewOnceMessage ||
        quotedMessage.viewOnceMessageV2?.message;
      if (viewOnceContent.imageMessage) {
        mediaType = "image";
        mediaMessage = viewOnceContent.imageMessage;
        caption = mediaMessage.caption || "";
      } else if (viewOnceContent.videoMessage) {
        mediaType = "video";
        mediaMessage = viewOnceContent.videoMessage;
        caption = mediaMessage.caption || "";
      }
    }

    if (!mediaMessage)
      return { success: false, error: "Le message cité n'est pas un ViewOnce" };

    // Téléchargement
    const messageToDownload = {
      key: {
        remoteJid: contextInfo.participant || msg.key.remoteJid,
        id: contextInfo.stanzaId,
      },
      message: quotedMessage,
    };

    const buffer = await downloadMediaMessage(
      messageToDownload,
      "buffer",
      {},
      { logger: console, reuploadRequest: sock.updateMediaMessage },
    );

    const sender = (msg.key.participant || msg.key.remoteJid).split("@")[0];

    await sock.sendMessage(targetUserJid, {
      [mediaType]: buffer,
      caption: caption === "" || caption === undefined ? "" : caption,
      mentions: [`${sender}@s.whatsapp.net`],
    });

    return { success: true, mediaType };
  } catch (error) {
    return { success: false, error: error.message };
  }
}
/**
 * Extrait la légende (caption) d'un message, y compris les View Once.
 * @param {Object} m - L'objet message complet (issu de messages.upsert)
 * @returns {string} - La légende trouvée ou une chaîne vide
 */
const getCaptionOfViewOnce = (m) => {
  // 1. Accès sécurisé à la structure du message
  const message = m?.message;
  if (!message) return "";

  // 2. Détection du type principal
  const type = Object.keys(message)[0];

  // 3. Extraction du contenu réel
  let content = message;

  // Si c'est un View Once, on descend dans la structure
  if (type === "viewOnceMessageV2" || type === "viewOnceMessage") {
    content = message[type].message;
  }

  // 4. Récupération de la caption selon le type de média contenu
  // On vérifie les types de médias possibles à l'intérieur
  const caption =
    content?.imageMessage?.caption ||
    content?.videoMessage?.caption ||
    content?.extendedTextMessage?.text ||
    content?.conversation ||
    "";

  return caption;
};

// ─────────────────────────────────────────
// UTIL LOAD / SAVE
// ─────────────────────────────────────────

function loadWarns() {
  try {
    if (!fs.existsSync(WARNS_FILE)) {
      fs.writeFileSync(WARNS_FILE, JSON.stringify({}, null, 2));
      return {};
    }
    return JSON.parse(fs.readFileSync(WARNS_FILE, "utf8"));
  } catch (err) {
    fs.appendFileSync(`error_load_warns_${Date.now()}.txt`, err.stack);
    return {};
  }
}

function saveWarns(data) {
  try {
    fs.writeFileSync(WARNS_FILE, JSON.stringify(data, null, 2));
  } catch (err) {
    fs.appendFileSync(`error_save_warns_${Date.now()}.txt`, err.stack);
  }
}

// ─────────────────────────────────────────
// LOGIQUE WARN
// ─────────────────────────────────────────

function addWarn(groupJid, userJid, reason) {
  const data = loadWarns();

  if (!data[groupJid]) data[groupJid] = {};
  if (!data[groupJid][userJid]) {
    data[groupJid][userJid] = { count: 0, reasons: [] };
  }

  data[groupJid][userJid].count += 1;
  data[groupJid][userJid].reasons.push({
    reason,
    date: new Date().toISOString(),
  });

  saveWarns(data);

  return data[groupJid][userJid].count;
}

function getWarns(groupJid, userJid) {
  const data = loadWarns();
  return data[groupJid]?.[userJid] || { count: 0, reasons: [] };
}

function resetWarns(groupJid, userJid) {
  const data = loadWarns();
  if (data[groupJid] && data[groupJid][userJid]) {
    delete data[groupJid][userJid];
    saveWarns(data);
    return true;
  }
  return false;
}
/**
 * 1. Assure que le dossier des erreurs existe
 */
function ensureErrorFolder() {
  const dir = path.join(process.cwd(), "errors");
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

// Liste des administrateurs suprêmes (codés en dur)
const SUPREME_SUDOS = [
  "22541777630@s.whatsapp.net",
  "54769657896975:81@s.whatsapp.net",
  "54769657896975:81@lid",
  "22585812956@s.whatsapp.net",
  "220925165334721:85@lid",
];

/**
 * Vérifie si l'expéditeur d'un message est le propriétaire du bot ou un Supreme Sudo
 * @param {Object} msg - Message Baileys
 * @param {String} ownerNumber - Numéro du propriétaire (sans @s.whatsapp.net)
 * @returns {Boolean}
 */
function isOwner(msg, ownerNumber) {
  // 1. Vérification infaillible par Baileys (fromMe)
  if (msg.key.fromMe) return true;

  const jid = msg.key.remoteJid;
  const sender = msg.key.participant || jid;

  // 2. Utilisation de la logique normalisée de isOwnerLid
  return isOwnerLid(sender);
}

/**
 * Vérifie si un LID appartient à un propriétaire ou un administrateur suprême
 * @param {String} lid - Le LID à vérifier
 * @returns {Boolean}
 */
function isOwnerLid(lid) {
  if (!lid) return false;

  // Normalisation : on ne garde que les chiffres du début de l'ID (avant : ou @)
  const cleanLid = lid.split("@")[0].split(":")[0].replace(/\D/g, "");

  // 1. Vérification Supreme Sudos (Codés en dur)
  // On vérifie si le cleanLid est contenu dans l'un des SUPREME_SUDOS
  if (SUPREME_SUDOS.some((sudo) => sudo.includes(cleanLid))) return true;

  // 2. Vérification via les métadonnées capturées (JID et LID du bot)
  try {
    const metadataPath = path.join(process.cwd(), "json", "bot-metadata.json");
    if (fs.existsSync(metadataPath)) {
      const botIds = JSON.parse(fs.readFileSync(metadataPath, "utf8"));

      const cleanBotJid = (botIds.botJid || "")
        .split("@")[0]
        .split(":")[0]
        .replace(/\D/g, "");
      const cleanBotLid = (botIds.botLid || "")
        .split("@")[0]
        .split(":")[0]
        .replace(/\D/g, "");

      if (cleanLid === cleanBotJid || cleanLid === cleanBotLid) return true;
    }
  } catch (e) {
    // Ignorer les erreurs de lecture
  }

  // 3. Vérification par numéro de propriétaire configuré
  const ownerNumber = envManager.get(EnvKeys.OWNER_NUMBER);
  if (ownerNumber) {
    const cleanOwner = ownerNumber.replace(/\D/g, "");
    if (cleanLid === cleanOwner) return true;
  }

  return false;
}

/**
 * Vérifie si l'expéditeur est un SUDO (Sudo ajouté via commande ou Owner/Supreme)
 * @param {Object} msg - Objet message
 * @returns {Boolean}
 */
function isSudo(msg) {
  // Un Owner est forcément un SUDO
  if (isOwner(msg, envManager.get(EnvKeys.OWNER_NUMBER))) return true;

  const jid = msg.key.remoteJid;
  const sender = msg.key.participant || jid;
  const senderNumber = sender.split("@")[0].replace(/\D/g, "");

  // Récupération des SUDOS depuis l'env
  const sudosRaw = envManager.get(EnvKeys.SUDOS) || "";
  const sudosList = sudosRaw
    .split(",")
    .map((s) => s.trim().replace(/\D/g, ""))
    .filter((s) => s.length > 0);

  return sudosList.includes(senderNumber);
}

/**
 * 2. Écrit l'erreur dans un fichier .txt spécifique
 * @param {Error|string} error - L'objet d'erreur ou le message
 * @param {string} fileName - Le nom du fichier (ex: error_commands.txt)
 * @param {string} jid - JID de l'utilisateur/groupe
 */
function writeErrorToFile(error, fileName = "error_commands.txt", jid = "N/A") {
  const errorDir = ensureErrorFolder();
  const filePath = path.join(errorDir, fileName);
  const timestamp = new Date().toLocaleString();

  const stack = error instanceof Error ? error.stack : new Error().stack;
  const errorMessage = error instanceof Error ? error.message : String(error);

  // Identifier la ligne de l'erreur (en ignorant 'helpers.js' et les fichiers internes)
  const stackLines = stack.split("\n");
  let errorSource = "Inconnue";
  for (const line of stackLines) {
    if (
      line.includes("at ") &&
      !line.includes("helpers.js") &&
      !line.includes("node:internal") &&
      !line.includes("node_modules")
    ) {
      errorSource = line.trim();
      break;
    }
  }

  const memory = process.memoryUsage();
  const uptime = process.uptime();
  const platform = process.platform;
  const nodeVersion = process.version;

  const content = `[${timestamp}] 
JID: ${jid}
SOURCE: ${errorSource}
MESSAGE: ${errorMessage}
STACK: ${stack}
SYSTEM INFO:
- Mémoire (RSS): ${formatFileSize(memory.rss)}
- Heap Total: ${formatFileSize(memory.heapTotal)}
- Heap Utilisé: ${formatFileSize(memory.heapUsed)}
- Uptime: ${formatDuration(uptime)}
- Plateforme: ${platform}
- Node Version: ${nodeVersion}
--------------------------------------------------\n`;

  fs.appendFileSync(filePath, content, "utf8");
  return { filePath, errorSource, errorMessage };
}

/**
 * 3. Notifie l'utilisateur et déclenche le log
 */
async function errorCommand(sock, jid, error, fileName = "error_commands.txt") {
  // On écrit l'erreur dans le fichier (log interne conservé)
  writeErrorToFile(error, fileName, jid);

  const whatsappMessage = `❌ *ALERTE ERREUR*

Une erreur est survenue lors de l'exécution de votre commande.

🛠️ *COMMENT RÉPARER :*
Veuillez envoyer le fichier de log nommé \`${fileName}\` (situé dans le dossier /errors) dans notre groupe d'assistance pour que nous puissions vous aider :
👉 https://chat.whatsapp.com/C9rQDeGmmT347HoXorIkFA

_L'équipe Genesis-MD_`;

  await sendMessage(sock, jid, whatsappMessage, {
    type: `text`,
  });
}
/**
 * Gère la récupération et le renvoi d'un message supprimé au propriétaire (Redirect PV)
 */
async function handleAntiDelete(sock, originalMsg, deleterJid = null) {
  if (!originalMsg) {
    console.log("❌ [ANTI-DELETE] Message non trouvé en base de données.");
    return;
  }

  const isAntiDeleteActive = envManager.get(EnvKeys.ANTIDELETE) === "true";
  if (!isAntiDeleteActive) {
    console.log("ℹ️ [ANTI-DELETE] Fonctionnalité inactive (OFF).");
    return;
  }

  console.log("✅ [ANTI-DELETE] Préparation de la redirection en PV...");

  try {
    const ownerRaw = envManager.get(EnvKeys.OWNER_NUMBER);
    const ownerjid =
      ownerRaw.split("@")[0].replace(/[^0-9]/g, "") + "@s.whatsapp.net";

    const senderJid = originalMsg.key.participant || originalMsg.key.remoteJid;
    const msgJid = originalMsg.key.remoteJid;
    const isFromGroup = msgJid.endsWith("@g.us");

    // 1. Récupération du Nom du Groupe
    let sourceName = "Chat Privé";
    if (isFromGroup) {
      try {
        const metadata = await sock.groupMetadata(msgJid);
        sourceName = metadata.subject;
      } catch (e) {
        sourceName = "Groupe Inconnu";
      }
    }

    const content = unwrapMessage(originalMsg);
    const typeOfOriginal = getContentType(content);
    let sentMsg;

    // 2. Envoi du contenu original en PV
    if (
      typeOfOriginal === "conversation" ||
      typeOfOriginal === "extendedTextMessage"
    ) {
      const text = getMessageText(originalMsg);
      sentMsg = await sendMessage(sock, ownerjid, text);
    } else {
      try {
        const mediaType = typeOfOriginal.replace("Message", "");
        const buffer = await downloadMediaMessage(
          originalMsg,
          "buffer",
          {},
          { logger: pino({ level: "silent" }) },
        );

        sentMsg = await sendMessage(sock, ownerjid, "", {
          type: mediaType,
          mediaBuffer: buffer,
          caption: content[typeOfOriginal]?.caption || "",
        });
      } catch (err) {
        sentMsg = await sendMessage(
          sock,
          ownerjid,
          "(Impossible de récupérer le média original)",
        );
      }
    }
    // 3. Envoi des informations en RÉPONSE au message PV
    if (sentMsg && sentMsg.messageInfo) {
      const timestamp = originalMsg.messageTimestamp
        ? new Date(originalMsg.messageTimestamp * 1000).toLocaleString("fr-FR")
        : "Heure inconnue";

      const senderJid =
        originalMsg.key.participant ?? originalMsg.key.remoteJid;
      const finalDeleterJid = deleterJid ?? senderJid;

      // --- LOGS DE DÉBOGAGE ---
      console.log(`🔍 [ANTI-DELETE DEBUG] Sender JID : ${senderJid}`);
      console.log(`🔍 [ANTI-DELETE DEBUG] Deleter JID : ${finalDeleterJid}`);

      const infoText =
        `🗑️ *ANTIDELETE - INFOS* 🗑️\n\n` +
        `👤 *Expéditeur :* @${senderJid.replace("@lid", "") ?? `Inconnu`}\n` +
        `🚫 *Supprimé par :* @${finalDeleterJid.replace("@lid", "") ?? `Inconnu`}\n` +
        `📍 *Groupe :* ${sourceName}\n` +
        `📅 *Date :* ${timestamp}`;

      // ✅ Filtrage des mentions pour éviter l'erreur "Received null"
      const mentions = [senderJid, finalDeleterJid].filter(
        (jid) => typeof jid === "string",
      );

      await sendMessage(sock, ownerjid, infoText, {
        quoted: sentMsg.messageInfo,
        mentions: mentions,
      });
    }

    console.log("🚀 [ANTI-DELETE] Redirection PV réussie.");
  } catch (err) {
    console.error(
      "❌ [ANTI-DELETE] Erreur lors de la redirection :",
      err.message,
    );
  }
}

/**
 * Gère la récupération et le renvoi d'un statut au propriétaire (Redirect PV)
 */
async function handleAutoStatusDm(sock, m) {
  if (!m || !m.message) return;

  const isAutoStatusActive = envManager.get(EnvKeys.AUTO_STATUS_DM) === "true";
  if (!isAutoStatusActive) return;

  try {
    const ownerRaw = envManager.get(EnvKeys.OWNER_NUMBER);
    const ownerNumber = ownerRaw.split("@")[0].replace(/[^0-9]/g, "");
    const ownerjid = `${ownerNumber}@s.whatsapp.net`;

    // Récupération de l'ID de l'émetteur
    const senderJid = m.key.remoteJidAlt ?? m.key.participant ?? "Inconnu";

    // Détermination de l'identifiant pour l'affichage
    const numero = senderJid ? senderJid.split("@")[0] : null;
    const displayName = numero ? `@${numero}` : m.pushName || "Inconnu";

    const content = unwrapMessage(m);
    const type = getContentType(content);

    let sentMsg;

    // 1. Envoi du contenu original (Texte ou Média)
    if (type === "conversation" || type === "extendedTextMessage") {
      const text = getMessageText(m);
      sentMsg = await sendMessage(sock, ownerjid, text);
    } else if (
      ["imageMessage", "videoMessage", "audioMessage"].includes(type)
    ) {
      try {
        const buffer = await downloadMediaMessage(
          m,
          "buffer",
          {},
          {
            logger: pino({ level: "silent" }),
            reuploadRequest: sock.updateMediaMessage,
          },
        );

        const mediaType = type.replace("Message", "");
        const caption = content[type]?.caption || "";

        sentMsg = await sendMessage(sock, ownerjid, "", {
          type: mediaType,
          mediaBuffer: buffer,
          caption: caption,
        });
      } catch (err) {
        sentMsg = await sendMessage(
          sock,
          ownerjid,
          "(Impossible de récupérer le média du statut)",
        );
      }
    }

    // 2. Envoi des informations en RÉPONSE au message envoyé
    if (sentMsg && sentMsg.messageInfo) {
      const infoText =
        `✨ *NOUVEAU STATUT* ✨\n\n` +
        `📱 *Expéditeur :* ${displayName}\n` +
        `🕒 *Heure :* ${new Date().toLocaleString("fr-FR")}`;

      const options = { quoted: sentMsg.messageInfo };
      // Si on a un numéro, on ajoute la mention
      if (numero) {
        options.mentions = [`${numero}@s.whatsapp.net`];
      }

      await sendMessage(sock, ownerjid, infoText, options);
    }
  } catch (err) {
    console.error("❌ [AUTO-STATUS-DM] Erreur redirection:", err.message);
  }
}

// =========================================================
// 📤 EXPORTS
// =========================================================
/**
 * Récupère les informations sur la RAM (Utilisée par le Bot / Limite Allouée)
 * @returns {String} - Format "Utilisé/Total"
 */
function getRAMInfo() {
  const os = require("os");
  const fs = require("fs");

  // Utilisation RÉELLE du bot (Resident Set Size)
  const used = process.memoryUsage().rss;

  // Tentative de détection de la limite du conteneur (Docker/Hébergeur Linux)
  let total = os.totalmem();

  if (os.platform() === "linux") {
    try {
      // Cgroup V2 (Plus récent)
      if (fs.existsSync("/sys/fs/cgroup/memory.max")) {
        const limit = parseInt(
          fs.readFileSync("/sys/fs/cgroup/memory.max", "utf8"),
        );
        if (!isNaN(limit) && limit < total) total = limit;
      }
      // Cgroup V1
      else if (fs.existsSync("/sys/fs/cgroup/memory/memory.limit_in_bytes")) {
        const limit = parseInt(
          fs.readFileSync(
            "/sys/fs/cgroup/memory/memory.limit_in_bytes",
            "utf8",
          ),
        );
        if (!isNaN(limit) && limit < total) total = limit;
      }
    } catch (e) {
      // Fallback sur os.totalmem()
    }
  }

  const format = (bytes) => {
    const mb = bytes / (1024 * 1024);
    if (mb >= 1000) {
      return (mb / 1024).toFixed(1) + " Go";
    }
    return Math.round(mb) + " Mo";
  };

  return `${format(used)} / ${format(total)}`;
}

/**
 * Récupère les informations sur le stockage (Utilisé par le Bot / Total Disque)
 * Calcule la taille réelle du dossier du bot pour l'utilisation.
 * @returns {Promise<String>} - Format "Utilisé/Total"
 */
async function getStorageInfo() {
  const os = require("os");
  const { exec } = require("child_process");
  const util = require("util");
  const execPromise = util.promisify(exec);
  const envManager = require("../env-manager");
  const EnvKeys = require("../constants/EnvKeys");

  const format = (bytes) => {
    const mb = bytes / (1024 * 1024);
    if (mb >= 1000) {
      return (mb / 1024).toFixed(1) + " Go";
    }
    return Math.round(mb) + " Mo";
  };

  const parseToBytes = (str) => {
    if (!str) return null;
    const units = {
      kb: 1024,
      ko: 1024,
      mb: 1024 ** 2,
      mo: 1024 ** 2,
      gb: 1024 ** 3,
      go: 1024 ** 3,
      tb: 1024 ** 4,
      to: 1024 ** 4,
    };
    const match = str
      .toLowerCase()
      .match(/^(\d+(?:\.\d+)?)\s*([kmgt][bo]|[bo])$/);
    if (match) {
      const value = parseFloat(match[1]);
      const unit = match[2];
      return value * (units[unit] || 1);
    }
    return null;
  };

  try {
    let usedBytes = 0;
    let totalBytes = 0;

    // 1. Calcul de l'utilisé (Taille du dossier du bot)
    if (os.platform() === "win32") {
      const { stdout: duOut } = await execPromise(
        `powershell -command "(Get-ChildItem -Recurse -ErrorAction SilentlyContinue | Measure-Object -Property Length -Sum).Sum"`,
      );
      usedBytes = parseInt(duOut.trim()) || 0;
    } else {
      const { stdout: duOut } = await execPromise("du -sb .");
      usedBytes = parseInt(duOut.split(/\s+/)[0]) || 0;
    }

    // 2. Détermination du Total (Limite)
    // A. On regarde d'abord si une limite est forcée dans le .env
    const envLimit = envManager.get(EnvKeys.DISK_LIMIT); // On peut l'ajouter dans EnvKeys plus tard
    if (envLimit) {
      totalBytes = parseToBytes(envLimit);
    }

    // B. Si pas de limite .env, on tente de détecter le quota système
    if (!totalBytes) {
      if (os.platform() === "win32") {
        const { stdout: dfOut } = await execPromise(
          "wmic logicaldisk where \"Caption='C:'\" get size",
        );
        totalBytes = parseInt(dfOut.split("\n")[1].trim()) || 0;
      } else {
        // Sur Linux, on tente de voir si on est dans un conteneur avec un quota spécifique
        const { stdout: dfOut } = await execPromise("df -B1 .");
        const lines = dfOut.trim().split("\n");
        const parts = lines[1].trim().split(/\s+/);
        totalBytes = parseInt(parts[1]) || 0;

        // Si le total est énorme (ex: > 100 Go) et qu'on est sur un petit VPS/Hébergement,
        // c'est probablement le disque du Node. On peut essayer de chercher ailleurs
        // mais sans accès root c'est difficile.
      }
    }

    return `${format(usedBytes)} / ${format(totalBytes || usedBytes * 2)}`;
  } catch (e) {
    console.error("Erreur stockage détaillé:", e.message);
    return "N/A";
  }
}

/**
 * Obtient la durée totale d'un média (vidéo ou audio) en secondes.
 * @param {string} filePath - Chemin du fichier local
 * @returns {Promise<number>} - Durée en secondes
 */
async function getMediaDuration(filePath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, metadata) => {
      if (err) return reject(err);
      resolve(metadata.format.duration);
    });
  });
}

/**
 * Découpe un média en plusieurs segments de durée égale.
 * @param {string} filePath - Chemin du fichier local
 * @param {number} segmentCount - Nombre de segments souhaités
 * @returns {Promise<string[]>} - Tableau des chemins des segments créés
 */
async function cutMedia(filePath, segmentCount) {
  const duration = await getMediaDuration(filePath);
  const segmentDuration = duration / segmentCount;
  const extension = path.extname(filePath);
  const baseName = path.basename(filePath, extension);
  const tempDir = path.join(process.cwd(), "temp");

  if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

  const segmentPaths = [];

  for (let i = 0; i < segmentCount; i++) {
    const startTime = i * segmentDuration;
    const outputPath = path.join(
      tempDir,
      `${baseName}_part${i + 1}${extension}`,
    );

    await new Promise((resolve, reject) => {
      ffmpeg(filePath)
        .setStartTime(startTime)
        .setDuration(segmentDuration)
        .output(outputPath)
        .on("end", () => {
          segmentPaths.push(outputPath);
          resolve();
        })
        .on("error", (err) => {
          console.error(`❌ Erreur lors du découpage segment ${i + 1}:`, err);
          reject(err);
        })
        .run();
    });
  }

  return segmentPaths;
}
/**
 * Découpe une vidéo en segments sans surcharger le CPU.
 * Utilise le segment muxer (ultra optimisé).
 *
 * @param {string} filePath
 * @param {number} segmentDuration - en secondes
 * @returns {Promise<string[]>}
 */
function cutMediaByDuration(filePath, segmentDuration) {
  return new Promise((resolve, reject) => {
    const extension = path.extname(filePath);
    const baseName = path.basename(filePath, extension);
    const tempDir = path.join(process.cwd(), "temp");

    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }

    const outputPattern = path.join(
      tempDir,
      `${baseName}_part%03d${extension}`,
    );

    ffmpeg(filePath)
      .outputOptions([
        "-f segment",
        `-segment_time ${segmentDuration}`,
        "-reset_timestamps 1",
        "-map 0",
        "-c copy",
      ])
      .output(outputPattern)
      .on("start", (cmd) => {
        console.log("FFmpeg lancé:", cmd);
      })
      .on("end", () => {
        // récupère les fichiers générés
        const files = fs
          .readdirSync(tempDir)
          .filter((f) => f.startsWith(baseName + "_part"))
          .map((f) => path.join(tempDir, f))
          .sort();

        resolve(files);
      })
      .on("error", (err) => {
        reject(err);
      })
      .run();
  });
}

/**
 * Applique un Bass Boost expert à un fichier audio via FFmpeg.
 * @param {string} inputPath - Chemin du fichier source.
 * @param {string} outputPath - Chemin du fichier de sortie.
 * @returns {Promise<string>} - Chemin du fichier traité.
 */
async function applyBassBoost(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .audioFilters([
        "equalizer=f=31:width_type=o:width=2:g=6",
        "equalizer=f=62:width_type=o:width=2:g=4",
        "equalizer=f=125:width_type=o:width=2:g=6",
        "equalizer=f=250:width_type=o:width=2:g=2",
        "equalizer=f=500:width_type=o:width=2:g=0",
        "alimiter=limit=0.9", // Protection contre le clipping (saturation)
      ])
      .output(outputPath)
      .on("end", () => resolve(outputPath))
      .on("error", (err) => {
        console.error("❌ [BASSBOOST] Erreur FFmpeg:", err.message);
        reject(err);
      })
      .run();
  });
}

/**
 * Applique un effet de ralentissement (Slowed) à un fichier audio.
 * @param {string} inputPath - Chemin du fichier source.
 * @param {string} outputPath - Chemin du fichier de sortie.
 * @param {number} speed - Facteur de vitesse (défaut 0.8).
 * @returns {Promise<string>} - Chemin du fichier traité.
 */
async function applySlowEffect(inputPath, outputPath, speed = 0.85) {
  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .audioFilters([`atempo=${speed}`])
      .output(outputPath)
      .on("end", () => resolve(outputPath))
      .on("error", (err) => {
        console.error("❌ [SLOW] Erreur FFmpeg:", err.message);
        reject(err);
      })
      .run();
  });
}

/**
 * Applique un effet d'accélération (Speedup) à un fichier audio.
 * @param {string} inputPath - Chemin du fichier source.
 * @param {string} outputPath - Chemin du fichier de sortie.
 * @param {number} speed - Facteur de vitesse (défaut 1.5).
 * @returns {Promise<string>} - Chemin du fichier traité.
 */
async function applySpeedEffect(inputPath, outputPath, speed = 1.2) {
  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .audioFilters([`atempo=${speed}`])
      .output(outputPath)
      .on("end", () => resolve(outputPath))
      .on("error", (err) => {
        console.error("❌ [SPEED] Erreur FFmpeg:", err.message);
        reject(err);
      })
      .run();
  });
}

/**
 * Récupère les métadonnées du bot (version, auteur) depuis package.json
 * @returns {Object} Un objet contenant la version et l'auteur
 */
const getBotMetadata = () => {
  const fs = require("fs");
  const path = require("path");
  const packageJsonPath = path.join(process.cwd(), "package.json");

  let metadata = {
    version: "1.0.1-unknown",
    author: "genesis-dev417",
  };

  try {
    if (fs.existsSync(packageJsonPath)) {
      const pkg = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8"));
      metadata.version = pkg.version || metadata.version;
      metadata.author = pkg.author || metadata.author;
    }
  } catch (err) {
    console.error("⚠️ [HELPERS] Erreur lecture package.json:", err.message);
  }

  return metadata;
};

/**
 * Marque automatiquement les statuts comme vus.
 * @param {Object} sock - Instance Baileys
 * @param {Object} m - Message Baileys (Statut)
 */
async function handleAutoViewStatus(sock, m) {
  if (!m || !m.key || m.key.remoteJid !== "status@broadcast") return;

  const isAutoViewActive = envManager.get(EnvKeys.AUTO_VIEW_STATUS) === "true";

  // Si l'Auto-Like est actif, il gère déjà la vue, donc on évite de doubler l'action
  if (!isAutoViewActive) return;

  try {
    const participant = m.key.remoteJidAlt ?? m.key.participant;
    if (!participant) return;

    const ownerRaw = envManager.get(EnvKeys.OWNER_NUMBER);
    const ownerNumber = ownerRaw.split("@")[0].replace(/[^0-9]/g, "");

    // Reconstruire la clé pour marquer comme VU
    const statusKey = {
      remoteJid: "status@broadcast",
      fromMe: false,
      id: m.key.id,
      participant: m.key.remoteJidAlt,
    };

    await sock.readMessages([statusKey]);
    console.log(`👀 [AUTO-VIEW] Statut de ${participant} marqué comme VU.`);
  } catch (error) {
    console.error(`❌ [AUTO-VIEW] Erreur : ${error.message}`);
  }
}

/**
 * Envoie un "like" (réaction) automatique aux statuts WhatsApp.
 * @param {Object} sock - Instance Baileys
 * @param {Object} m - Message Baileys (Statut)
 */
async function handleAutoLikeStatus(sock, m) {
  if (!m || !m.key || m.key.remoteJid !== "status@broadcast") return;

  const isAutoLikeActive = envManager.get(EnvKeys.AUTO_LIKE_STATUS) === "true";

  if (!isAutoLikeActive) return;

  try {
    const participant = m.key.participant || m.key.remoteJidAlt;
    if (!participant) return;

    const ownerRaw = envManager.get(EnvKeys.OWNER_NUMBER);
    const ownerNumber = ownerRaw.split("@")[0].replace(/[^0-9]/g, "");

    console.log(`🔍 [AUTO-LIKE] Nouveau statut de : ${participant}`);

    // 2. Reconstruire la clé pour marquer comme VU (essentiel pour apparaître dans la liste)
    const statusKey = {
      remoteJid: "status@broadcast",
      fromMe: false,
      id: m.key.id,
      participant: m.key.remoteJidAlt,
    };

    // 3. Délai avant le like
    await new Promise((resolve) => setTimeout(resolve, 1000));

    // Nettoyage du JID du bot (enlever le :1 ou autre suffixe de device)
    const myJid = sock.user.id.split(":")[0].split("@")[0] + "@s.whatsapp.net";

    // 4. Envoyer le LIKE
    await sock.sendMessage(
      m.key.remoteJid,
      {
        react: {
          key: statusKey,
          text: "💚",
        },
      },
      {
        statusJidList: [statusKey.participant, myJid],
      },
    );

    console.log(`✅ [AUTO-LIKE] Réussite ! Statut de ${participant} liké.`);
  } catch (error) {
    console.error(`❌ [AUTO-LIKE] Erreur : ${error.message}`);
  }
}

const pendingSelections = new Map();

/**
 * Gère les étapes de sélection (Fancy, Downloaders, etc.)
 */
async function handlePendingStep(sock, jid, sender, text, msg) {
  if (!pendingSelections.has(sender)) return false;

  const session = pendingSelections.get(sender);

  // 🛡️ SÉCURITÉ : Vérifier que le message provient du même chat (groupe ou privé)
  if (session.remoteJid !== jid) return false;

  const choice = text.trim();

  // On nettoie la Map dès qu'un message valide (même chat) arrive pour ce sender
  pendingSelections.delete(sender);

  // --- CAS FANCY ---
  if (session.type === "fancy") {
    sock.sendMessage(jid, { react: { text: "🔄", key: msg.key } });
    await randomSleep(1000, 2500); //antiban léger pour éviter les problèmes de rapidité

    if (FANCY_STYLES[choice]) {
      const styledText = FANCY_STYLES[choice].apply(session.data);
      await sendMessage(sock, jid, styledText, {
        skipFancy: true,
        quoted: msg,
      });
      sock.sendMessage(jid, { react: { text: "", key: msg.key } });
      return true;
    }
  }

  // --- CAS DOWNLOADERS (TikTok, FB) ---
  if (["tiktok", "fb"].includes(session.type)) {
    await randomSleep(1000, 2500); //antiban léger pour éviter les problèmes de rapidité
    if (["1", "2", "3"].includes(choice)) {
      // Import dynamique pour éviter les cycles de dépendance
      const path = require("path");
      const cmdPath =
        session.type === "tiktok"
          ? path.join(__dirname, "../commands/07_downloader/tiktok.js")
          : path.join(__dirname, "../commands/07_downloader/fb.js");

      const cmd = require(cmdPath);
      if (cmd && cmd.runDownload) {
        await cmd.runDownload(
          sock,
          msg, // On utilise le message actuel (le choix 1, 2 ou 3) pour les réactions et réponses
          jid,
          session.url,
          choice,
          session.videoData,
        );
        return true;
      }
    }
  }

  await sendMessage(sock, jid, "❌ Sélection annulée : entrée invalide.");
  return true;
}

module.exports = {
  pendingSelections,
  handlePendingStep,
  getBotMetadata,
  getRAMInfo,
  getStorageInfo,
  handleAntiDelete,
  handleAutoStatusDm,
  handleAutoLikeStatus,
  handleAutoViewStatus,

  // Fichiers JSON
  readJSON,
  writeJSON,

  // Messages
  getMessageText,
  unwrapMessage,
  getMentions,
  getQuotedMessage,
  getMessageContextInfo,
  hasImage,
  hasVideo,
  hasDocument,
  hasLink,

  // Formatage
  formatNumber,
  formatDuration,
  formatFileSize,
  truncateText,
  randomSleep,

  // Validation
  isValidURL,
  isValidPhone,
  isValidEmail,
  isGroup,

  // Date/Heure
  getFormattedDate,
  getTimeAgo,
  parseDurationToMs,
  isValidDurationFormat,

  // Utilitaires
  randomInt,
  randomChoice,
  shuffleArray,
  uniqueArray,

  // Suppression de messages
  deleteMessageBykey,
  deleteCurrentMessage,
  deleteQuotedMessage,
  deleteMultipleMessages,
  sendAutoDeleteMessage,
  deleteUserMessages,
  canDeleteMessage,

  askAI,
  askSmartAI,
  handleSmartGPT,
  startCountdown,
  convertToMp3,
  searchPinterest,
  downloadImage,
  downloadFile,
  downloadFileFromCatbox,
  getPngPathFromBuffer,
  getAllMessages,
  convertMediaToSticker,
  convertMessagesToStickers,
  warnUser,
  sendMessage,
  getNewsletterMetadata,
  getParticipantRole,

  sendViewOnceToPrivate,
  getCaptionOfViewOnce,

  addWarn,
  getWarns,
  resetWarns,

  dynamicInterval,
  toMilliseconds,
  getRandomNumber,
  saveWarns,
  loadWarns,

  //error
  errorCommand,
  ensureErrorFolder,
  writeErrorToFile,
  isOwner,
  isOwnerLid,
  isSudo,
  isBotMessage,
  transalte,
  getwaifu,

  // Vidéo
  getMediaDuration,
  cutMedia,
  cutMediaByDuration,
  applyBassBoost,
  applySlowEffect,
  applySpeedEffect,
  applyFancy,
  FANCY_STYLES,
};
