// index.js — Servidor com takeover humano

import "dotenv/config";
import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import multer from "multer";
import path from "path";
import fs from "fs";
import os from "os";
import { fileURLToPath } from "url";
import { exec } from "child_process";
import { PDFParse } from "pdf-parse";
import mammoth from "mammoth";
import XLSX from "xlsx";
import WordExtractor from "word-extractor";
import pkg from "whatsapp-web.js";
var Client = pkg.Client;
var RemoteAuth = pkg.RemoteAuth;
import QRCode from "qrcode";

import { generateResponse, checkHumanRequest } from "./agent.js";
import {
  loadConversation, saveConversation, addMessage,
  markHandedOff, listAllLeads, getConversation,
  pauseBot, resumeBot,
} from "./memory.js";
import { HANDOFF_MESSAGE_TO_LEAD, HANDOFF_MESSAGE_TO_TEAM, AGENT_CONFIG } from "./config.js";
import { startScheduledReports } from "./reports.js";
import { MariaDbAuthStore } from "./dbAuthStore.js";
import {
  initDb, closeDb, updateAccountInfo, getAccountInfo,
  saveLog, getAiContextProfile, saveAiContextProfile, deleteRemoteAuthSession,
  getNotificationRoutes, saveNotificationRoutes, getNotificationRoute,
} from "./db.js";

if (!process.env.OPENAI_API_KEY) {
  console.error("OPENAI_API_KEY nao configurada. Edite o arquivo .env");
  process.exit(1);
}

var __dirname = path.dirname(fileURLToPath(import.meta.url));
var PORT = process.env.PORT || 3000;

// Mata qualquer processo que esteja usando a mesma porta antes de iniciar
function killPort(port) {
  return new Promise(function(resolve) {
    if (process.platform === "win32") {
      // Usa PowerShell que e mais confiavel que netstat+findstr no Windows
      var psCmd = 'powershell -Command "Get-NetTCPConnection -LocalPort ' + port + ' -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess"';
      exec(psCmd, function(err, stdout) {
        if (err || !stdout.trim()) {
          // Fallback: tenta netstat
          exec('netstat -ano | findstr :' + port, function(err2, stdout2) {
            if (err2 || !stdout2.trim()) return resolve();
            var lines = stdout2.trim().split("\n");
            var pids = [];
            for (var i = 0; i < lines.length; i++) {
              if (lines[i].indexOf("LISTENING") === -1) continue;
              var parts = lines[i].trim().split(/\s+/);
              var pid = parts[parts.length - 1];
              if (pid && pid !== "0" && pid !== String(process.pid) && pids.indexOf(pid) === -1) {
                pids.push(pid);
              }
            }
            if (pids.length === 0) return resolve();
            exec('taskkill /F /PID ' + pids.join(' /PID '), function() {
              console.log("⚠️ Processo anterior na porta " + port + " encerrado (PIDs: " + pids.join(", ") + ")");
              setTimeout(resolve, 1500);
            });
          });
          return;
        }
        var pids = stdout.trim().split("\n").map(function(p) { return p.trim(); }).filter(function(p) {
          return p && p !== "0" && p !== String(process.pid);
        });
        // Remove duplicatas
        pids = pids.filter(function(v, i, a) { return a.indexOf(v) === i; });
        if (pids.length === 0) return resolve();
        exec('taskkill /F /PID ' + pids.join(' /PID '), function() {
          console.log("⚠️ Processo anterior na porta " + port + " encerrado (PIDs: " + pids.join(", ") + ")");
          setTimeout(resolve, 1500);
        });
      });
    } else {
      exec('lsof -ti:' + port, function(err, stdout) {
        if (err || !stdout.trim()) return resolve();
        var pids = stdout.trim().split("\n").filter(function(p) { return p && p !== String(process.pid); });
        if (pids.length === 0) return resolve();
        exec('kill -9 ' + pids.join(" "), function() {
          console.log("⚠️ Processo anterior na porta " + port + " foi encerrado");
          setTimeout(resolve, 1000);
        });
      });
    }
  });
}

// ── Multiple WhatsApp Accounts ──
var wppClients = {};  // { accountPhone: Client }
var wppStatus = {};   // { accountPhone: "connected"|"qr"|"disconnected" }
var wppStarting = {}; // { accountPhone: boolean }
var wppRestartTimers = {}; // { accountPhone: timer }

var WHATSAPP_RUNTIME_BASE = path.join(os.tmpdir(), "uall-sdr-wwebjs");
var LEGACY_DATA_DIR = path.join(__dirname, "data");
var LEGACY_WPP_SESSION_DIR = path.join(LEGACY_DATA_DIR, "whatsapp-session");
var LEGACY_CONVERSATIONS_DIR = path.join(LEGACY_DATA_DIR, "conversations");
var upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    files: 30,
    fileSize: 20 * 1024 * 1024,
  },
});

var app = express();
var server = createServer(app);
var io = new Server(server);
var ioEmit = io.emit.bind(io);

// Timers de follow-up (cobra lead apos 10 min sem resposta)
var followUpTimers = {};
// Timers de encerramento (fecha conversa apos 30 min sem resposta)
var closeTimers = {};

// Cache de chats — salva o chat object quando recebe msg pra poder responder depois
var chatCache = {};

function persistLogEntry(entry, phoneOverride) {
  if (!entry || !entry.text) return;
  saveLog(entry.type || "info", entry.text, phoneOverride || entry.phone || null).catch(function(err) {
    console.error("Falha ao salvar log no banco:", err.message);
  });
}

// Função de logging que salva no banco e emite pro dashboard
function emitLog(type, text, phone) {
  io.emit("log", { type: type, text: text });
  // Salva no banco de forma não-bloqueante (fire-and-forget)
  saveLog(type, text, phone).catch(function(e) {
    // Silencia erros de log
  });
}

// Envia mensagem de forma segura — usa cache de chat pra evitar erro de LID
emitLog = function(type, text, phone) {
  var entry = { type: type, text: text, phone: phone || null };
  ioEmit("log", entry);
  persistLogEntry(entry, phone);
};

io.emit = function(eventName) {
  if (eventName === "log") {
    persistLogEntry(arguments[1]);
  }
  return ioEmit.apply(io, arguments);
};

async function safeSendMessage(wppClient, phone, text) {
  // 1. Tenta usar o chat cacheado (mais confiavel — pega o chat real do WhatsApp)
  if (chatCache[phone]) {
    try {
      await chatCache[phone].sendMessage(text);
      return;
    } catch (e) {
      console.log("⚠️ Chat cache falhou para " + phone + ": " + e.message);
      // Cache pode estar stale, tenta re-buscar
      try {
        var freshChat = await wppClient.getChatById(chatCache[phone].id._serialized);
        if (freshChat) {
          chatCache[phone] = freshChat;
          await freshChat.sendMessage(text);
          return;
        }
      } catch (e2) {}
    }
  }

  // 2. Tenta envio direto (funciona pra numeros normais @c.us)
  try {
    await wppClient.sendMessage(phone, text);
    return;
  } catch (err) {
    if (!err.message || !err.message.includes("No LID")) throw err;
    console.log("⚠️ LID error para " + phone + ", tentando alternativas...");
  }

  // 3. Tira sufixos de forma mais robusta
  var rawNum = phone.replace(/[@]c\.us|[@]lid/g, "");
  try {
    var allChats = await wppClient.getChats();
    for (var i = 0; i < allChats.length; i++) {
      var c = allChats[i];
      if (!c.id || !c.id._serialized) continue;
      var cId = c.id._serialized;
      // Compara pelo numero (pode estar como @c.us ou @lid)
      if (cId.includes(rawNum) || (c.id.user && c.id.user === rawNum)) {
        chatCache[phone] = c;
        console.log("✅ Chat encontrado via busca: " + cId);
        await c.sendMessage(text);
        return;
      }
    }
  } catch (e4) {
    console.log("⚠️ Busca de chats falhou:", e4.message);
  }

  // 4. Tenta com getNumberId (converte numero pra ID valido)
  try {
    var numberId = await wppClient.getNumberId(rawNum);
    if (numberId && numberId._serialized) {
      console.log("✅ getNumberId resolveu: " + numberId._serialized);
      await wppClient.sendMessage(numberId._serialized, text);
      return;
    }
  } catch (e5) {}

  // 5. Tenta via getChatById com @lid
  try {
    var lidId = rawNum + "@lid";
    var lidChat = await wppClient.getChatById(lidId);
    if (lidChat) {
      chatCache[phone] = lidChat;
      console.log("✅ Chat encontrado via @lid: " + lidId);
      await lidChat.sendMessage(text);
      return;
    }
  } catch (e6) {}

  // 6. Tenta envio com numero limpo + @c.us (fallback simples)
  try {
    var cleanId = rawNum + "@c.us";
    console.log("✅ Tentando com numero limpo: " + cleanId);
    await wppClient.sendMessage(cleanId, text);
    return;
  } catch (e6b) {}

  // 7. Busca pelo contactNumber real salvo no DB
  try {
    var conv = await loadConversation(phone);
    if (conv.contactNumber) {
      var realPhone = conv.contactNumber.replace(/[^0-9]/g, "") + "@c.us";
      console.log("✅ Usando contactNumber do DB: " + realPhone);
      await wppClient.sendMessage(realPhone, text);
      return;
    }
  } catch (e7) {}

  throw new Error("Nao foi possivel enviar mensagem para " + phone + ". Contato pode ter formato LID incompativel. Tente responder diretamente pelo WhatsApp.");
}

function normalizePhoneNumber(phone) {
  if (!phone) return null;
  var digits = String(phone).replace(/[^0-9]/g, "");
  return digits || null;
}

function normalizePossibleContactName(value) {
  var normalized = value ? String(value).replace(/\s+/g, " ").trim() : "";
  var digitsOnly = normalized.replace(/[^0-9]/g, "");
  var alphaChars = normalized.replace(/[^A-Za-zÀ-ÿ]/g, "");
  var invalidWords = [
    "oi", "ola", "olá", "bom dia", "boa tarde", "boa noite",
    "teste", "teste 123", "cliente", "lead", "whatsapp",
    "sem nome", "nao informado", "não informado", "unknown"
  ];

  if (!normalized || normalized.length < 2 || normalized.length > 60) return null;
  if (digitsOnly && digitsOnly === normalized.replace(/\D/g, "")) return null;
  if (!alphaChars || alphaChars.length < 2) return null;
  if (/[@#_*~|/\\]/.test(normalized)) return null;
  if (/^\d+$/.test(normalized)) return null;
  if (invalidWords.indexOf(normalized.toLowerCase()) !== -1) return null;
  if (digitsOnly.length >= 6) return null;

  return normalized;
}

function extractSmartContactName(contact, message) {
  var candidates = [];
  var bestName = null;

  if (contact) {
    candidates.push(contact.pushname);
    candidates.push(contact.name);
    candidates.push(contact.shortName);
    candidates.push(contact.verifiedName);
  }

  if (message) {
    candidates.push(message.notifyName);
    candidates.push(message._data && message._data.notifyName);
  }

  for (var i = 0; i < candidates.length; i++) {
    bestName = normalizePossibleContactName(candidates[i]);
    if (bestName) return bestName;
  }

  return null;
}

function buildAiContextApiResponse(accountInfo, profile) {
  var accountPhone = normalizePhoneNumber(accountInfo && accountInfo.phone);
  return {
    success: true,
    account: {
      name: accountInfo && accountInfo.name ? accountInfo.name : null,
      phone: accountPhone,
      status: wppStatus[accountPhone] || (accountInfo && accountInfo.status) || "disconnected",
      lastQrAt: accountInfo && accountInfo.lastQrAt ? accountInfo.lastQrAt : null,
    },
    profile: profile || {
      accountPhone: accountPhone,
      sessionKey: "default",
      profileName: null,
      attendantName: null,
      companyName: null,
      companyDescription: null,
      aiName: null,
      aiRole: null,
      toneOfVoice: null,
      behaviorGuidelines: null,
      objectives: null,
      audienceProfile: null,
      forbiddenTopics: null,
      salesScript: null,
      knowledgeBase: null,
      documents: [],
      isActive: true,
    },
  };
}

function buildNotificationRoutesApiResponse(accountInfo, routes, groups) {
  var accountPhone = normalizePhoneNumber(accountInfo && accountInfo.phone);
  return {
    success: true,
    account: {
      name: accountInfo && accountInfo.name ? accountInfo.name : null,
      phone: accountPhone,
      status: wppStatus[accountPhone] || (accountInfo && accountInfo.status) || "disconnected",
    },
    routes: routes || [],
    groups: groups || [],
  };
}

async function getWhatsAppGroups(clientInstance) {
  var activeClient = clientInstance || wpp;

  if (!activeClient) {
    return [];
  }

  try {
    var chats = await activeClient.getChats();
    return chats
      .filter(function(chat) {
        return chat && chat.isGroup && chat.id && chat.id._serialized && chat.name;
      })
      .map(function(chat) {
        return {
          id: chat.id._serialized,
          name: chat.name,
        };
      })
      .sort(function(a, b) {
        return a.name.localeCompare(b.name, "pt-BR");
      });
  } catch (err) {
    console.error("Erro ao listar grupos do WhatsApp:", err.message);
    return [];
  }
}

async function resolveNotificationRoute(routeKey, clientInstance) {
  var accountInfo = await getAccountInfo();
  var accountPhone = normalizePhoneNumber(accountInfo && accountInfo.phone);
  var route;

  if (!accountPhone) {
    return { route: null, targetId: null };
  }

  route = await getNotificationRoute(accountPhone, routeKey);
  if (!route || !route.isEnabled) {
    return { route: route, targetId: null };
  }

  if (route.targetId) {
    return { route: route, targetId: route.targetId };
  }

  if (route.targetName) {
    return {
      route: route,
      targetId: await findGroupByName(route.targetName, clientInstance),
    };
  }

  return { route: route, targetId: null };
}

async function cleanupLegacyWorkspaceStorage() {
  try {
    await fs.promises.rm(LEGACY_WPP_SESSION_DIR, { recursive: true, force: true });
  } catch (e) {}

  try {
    await fs.promises.rm(LEGACY_CONVERSATIONS_DIR, { recursive: true, force: true });
  } catch (e) {}
}

function truncateContextText(text, maxChars) {
  var normalized = text ? String(text).trim() : "";
  if (!normalized) return "";
  if (normalized.length <= maxChars) return normalized;
  return normalized.slice(0, maxChars) + "\n[conteudo truncado automaticamente]";
}

async function extractTextFromDocBuffer(buffer, extension) {
  var tempPath = path.join(os.tmpdir(), "uall-import-" + Date.now() + "-" + Math.random().toString(36).slice(2) + extension);
  try {
    await fs.promises.writeFile(tempPath, buffer);
    var extractor = new WordExtractor();
    var extracted = await extractor.extract(tempPath);
    return extracted && typeof extracted.getBody === "function" ? extracted.getBody() : "";
  } finally {
    try { await fs.promises.unlink(tempPath); } catch (e) {}
  }
}

async function extractTextFromUploadedFile(file) {
  var extension = path.extname(file.originalname || "").toLowerCase();
  var buffer = file.buffer;

  if (!buffer || !buffer.length) {
    throw new Error("arquivo vazio");
  }

  if ([".txt", ".md", ".markdown", ".csv", ".json"].indexOf(extension) !== -1) {
    return buffer.toString("utf8");
  }

  if (extension === ".pdf") {
    var parser = new PDFParse({ data: buffer });
    try {
      var pdf = await parser.getText();
      return pdf && pdf.text ? pdf.text : "";
    } finally {
      await parser.destroy().catch(function() {});
    }
  }

  if (extension === ".docx") {
    var docx = await mammoth.extractRawText({ buffer: buffer });
    return docx && docx.value ? docx.value : "";
  }

  if (extension === ".doc") {
    return await extractTextFromDocBuffer(buffer, extension);
  }

  if (extension === ".xlsx" || extension === ".xls") {
    var workbook = XLSX.read(buffer, { type: "buffer" });
    var parts = [];
    for (var i = 0; i < workbook.SheetNames.length; i++) {
      var sheetName = workbook.SheetNames[i];
      var sheet = workbook.Sheets[sheetName];
      var csv = XLSX.utils.sheet_to_csv(sheet);
      if (csv && csv.trim()) {
        parts.push("Planilha: " + sheetName + "\n" + csv.trim());
      }
    }
    return parts.join("\n\n");
  }

  throw new Error("tipo de arquivo nao suportado");
}

async function importAiContextFilesToProfile(accountPhone, files) {
  var currentProfile = await getAiContextProfile(accountPhone, "default");
  var existingDocuments = Array.isArray(currentProfile.documents) ? currentProfile.documents.slice() : [];
  var imported = [];
  var skipped = [];

  for (var i = 0; i < files.length; i++) {
    var file = files[i];
    try {
      var extractedText = await extractTextFromUploadedFile(file);
      var trimmedText = truncateContextText(extractedText, 120000);

      if (!trimmedText) {
        skipped.push({ fileName: file.originalname, reason: "arquivo sem texto aproveitavel" });
        continue;
      }

      imported.push({
        title: file.originalname,
        type: "arquivo_importado",
        source: "upload:" + file.originalname,
        content: trimmedText,
      });
    } catch (err) {
      skipped.push({ fileName: file.originalname, reason: err.message });
    }
  }

  var profileToSave = Object.assign({}, currentProfile, {
    accountPhone: accountPhone,
    sessionKey: "default",
    documents: existingDocuments.concat(imported).slice(-50),
    isActive: true,
  });

  var savedProfile = await saveAiContextProfile(profileToSave);
  return {
    profile: savedProfile,
    imported: imported.map(function(doc) { return doc.title; }),
    skipped: skipped,
  };
}

app.use(express.json({ limit: "10mb" }));
app.use(express.static(path.join(__dirname, "public")));

var state = {
  whatsappStatus: "disconnected",
  qrDataUrl: null,
  stats: { total: 0, active: 0, paused: 0, handedOff: 0 },
};

async function refreshStats() {
  var leads = await listAllLeads();
  state.stats = {
    total: leads.length,
    active: leads.filter(function(l) { return l.status === "active"; }).length,
    paused: leads.filter(function(l) { return l.status === "paused"; }).length,
    handedOff: leads.filter(function(l) { return l.status === "handed_off"; }).length,
  };
}

async function broadcastUpdate() {
  await refreshStats();
  io.emit("stats", state.stats);
  io.emit("leads", await listAllLeads());
}

// ── Socket.io ──
app.get("/api/ai-context", async function(req, res) {
  try {
    var accountInfo = await getAccountInfo();
    var accountPhone = normalizePhoneNumber(accountInfo && accountInfo.phone);
    var profile = accountPhone ? await getAiContextProfile(accountPhone, "default") : null;
    res.json(buildAiContextApiResponse(accountInfo, profile));
  } catch (err) {
    res.status(500).json({
      success: false,
      error: "Nao foi possivel carregar o contexto da IA.",
      details: err.message,
    });
  }
});

app.post("/api/ai-context", async function(req, res) {
  try {
    var accountInfo = await getAccountInfo();
    var accountPhone = normalizePhoneNumber(accountInfo && accountInfo.phone);

    if (!accountPhone) {
      return res.status(400).json({
        success: false,
        error: "Conecte um WhatsApp por QR Code antes de salvar o contexto desta sessao.",
      });
    }

    var profile = await saveAiContextProfile(Object.assign({}, req.body || {}, {
      accountPhone: accountPhone,
      sessionKey: "default",
    }));

    res.json(buildAiContextApiResponse(accountInfo, profile));
  } catch (err) {
    res.status(500).json({
      success: false,
      error: "Nao foi possivel salvar o contexto da IA.",
      details: err.message,
    });
  }
});

app.post("/api/ai-context/import", upload.array("files", 30), async function(req, res) {
  try {
    var accountInfo = await getAccountInfo();
    var accountPhone = normalizePhoneNumber(accountInfo && accountInfo.phone);
    var files = req.files || [];

    if (!accountPhone) {
      return res.status(400).json({
        success: false,
        error: "Conecte um WhatsApp por QR Code antes de importar arquivos.",
      });
    }

    if (!files.length) {
      return res.status(400).json({
        success: false,
        error: "Nenhum arquivo enviado.",
      });
    }

    var importResult = await importAiContextFilesToProfile(accountPhone, files);
    res.json({
      success: true,
      account: {
        name: accountInfo && accountInfo.name ? accountInfo.name : null,
        phone: accountPhone,
        status: wppStatus[accountPhone] || (accountInfo && accountInfo.status) || "disconnected",
      },
      profile: importResult.profile,
      imported: importResult.imported,
      skipped: importResult.skipped,
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      error: "Nao foi possivel importar os arquivos para o contexto da IA.",
      details: err.message,
    });
  }
});

app.get("/api/whatsapp/groups", async function(req, res) {
  try {
    var groups = await getWhatsAppGroups();
    res.json({
      success: true,
      groups: groups,
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      error: "Nao foi possivel listar os grupos do WhatsApp.",
      details: err.message,
    });
  }
});

app.get("/api/notification-routes", async function(req, res) {
  try {
    var accountInfo = await getAccountInfo();
    var accountPhone = normalizePhoneNumber(accountInfo && accountInfo.phone);
    var routes = await getNotificationRoutes(accountPhone);
    var groups = await getWhatsAppGroups();
    res.json(buildNotificationRoutesApiResponse(accountInfo, routes, groups));
  } catch (err) {
    res.status(500).json({
      success: false,
      error: "Nao foi possivel carregar os grupos e avisos.",
      details: err.message,
    });
  }
});

app.post("/api/notification-routes", async function(req, res) {
  try {
    var accountInfo = await getAccountInfo();
    var accountPhone = normalizePhoneNumber(accountInfo && accountInfo.phone);

    if (!accountPhone) {
      return res.status(400).json({
        success: false,
        error: "Conecte um WhatsApp por QR Code antes de salvar os grupos e avisos.",
      });
    }

    var routes = await saveNotificationRoutes(accountPhone, req.body && req.body.routes);
    var groups = await getWhatsAppGroups();
    res.json(buildNotificationRoutesApiResponse(accountInfo, routes, groups));
  } catch (err) {
    res.status(500).json({
      success: false,
      error: "Nao foi possivel salvar os grupos e avisos.",
      details: err.message,
    });
  }
});

// ── ROTAS DE GERENCIAMENTO DE CONTAS ──

app.get("/api/accounts", async function(req, res) {
  try {
    var { getAllAccounts } = await import("./db.js");
    var accounts = await getAllAccounts();
    // Adiciona status em tempo real
    var result = accounts.map(function(acc) {
      return {
        ...acc,
        liveStatus: wppStatus[acc.phone] || "disconnected"
      };
    });
    res.json({ success: true, accounts: result });
  } catch (err) {
    res.status(500).json({
      success: false,
      error: "Erro ao listar contas.",
      details: err.message
    });
  }
});

app.post("/api/accounts/new-qr", async function(req, res) {
  try {
    var accountPhone = req.body && req.body.accountPhone;
    if (!accountPhone) {
      return res.status(400).json({
        success: false,
        error: "accountPhone é obrigatório"
      });
    }
    var normalized = normalizePhoneNumber(accountPhone);
    await startWhatsAppClient(normalized, true);
    res.json({ success: true, message: "Novo QR Code gerado para " + normalized });
  } catch (err) {
    res.status(500).json({
      success: false,
      error: "Erro ao gerar novo QR Code.",
      details: err.message
    });
  }
});

app.post("/api/accounts/:accountPhone/disconnect", async function(req, res) {
  try {
    var accountPhone = normalizePhoneNumber(req.params.accountPhone);
    await stopWhatsAppClient(accountPhone);
    res.json({ success: true, message: "Conta desconectada: " + accountPhone });
  } catch (err) {
    res.status(500).json({
      success: false,
      error: "Erro ao desconectar conta.",
      details: err.message
    });
  }
});

io.on("connection", function(socket) {
  console.log("Dashboard conectado");
  // Inicia com primeira conta conectada
  var firstAccount = Object.keys(wppClients)[0];
  socket.selectedAccount = firstAccount;

  refreshStats();
  socket.emit("accounts", Object.keys(wppClients));
  socket.emit("selectedAccount", socket.selectedAccount);
  socket.emit("status", wppStatus[socket.selectedAccount] || "disconnected");
  if (state.qrDataUrl && state.qrAccountPhone === socket.selectedAccount) {
    socket.emit("qr", state.qrDataUrl);
  }
  socket.emit("stats", state.stats);
  listAllLeads().then(function(l) { socket.emit("leads", l); });

  socket.on("get-conversation", async function(phone) {
    socket.emit("conversation-detail", await getConversation(phone));
  });

  socket.on("get-leads", function() {
    broadcastUpdate();
  });

  // ── TAKEOVER: Pausar bot (humano assume) ──
  socket.on("pause-bot", async function(phone) {
    var conv = await pauseBot(phone);
    var ts = new Date().toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
    io.emit("log", { type: "info", text: "[" + ts + "] 🔴 Bot PAUSADO para " + phone.replace("@c.us", "") + " — voce assumiu a conversa" });
    broadcastUpdate();
    socket.emit("conversation-detail", await getConversation(phone));
  });

  // ── REATIVAR: Bot volta a responder ──
  socket.on("resume-bot", async function(phone) {
    var conv = await resumeBot(phone);
    var ts = new Date().toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
    io.emit("log", { type: "info", text: "[" + ts + "] 🟢 Bot REATIVADO para " + phone.replace("@c.us", "") });
    broadcastUpdate();
    socket.emit("conversation-detail", await getConversation(phone));
  });

  // ── ENVIAR MENSAGEM COMO HUMANO ──
  socket.on("send-human-message", async function(data) {
    var phone = data && data.phone;
    var text = data && data.text;
    var ts = new Date().toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });

    if (!phone || !text) {
      io.emit("log", { type: "error", text: "[" + ts + "] Erro: telefone ou texto vazio" });
      return;
    }
    if (!wpp) {
      io.emit("log", { type: "error", text: "[" + ts + "] Erro: WhatsApp nao conectado" });
      return;
    }

    try {
      // Envia via WhatsApp
      var fullPhone = phone.includes("@c.us") ? phone : phone + "@c.us";
      console.log("Enviando mensagem humana para:", fullPhone);

      var sendResult = await safeSendMessage(wpp,fullPhone, text);
      console.log("Mensagem enviada com sucesso:", sendResult && sendResult.id ? sendResult.id._serialized : "ok");

      // Salva no historico como "human" e pausa o bot automaticamente
      var conv = await loadConversation(fullPhone);
      await addMessage(conv, "human", text);
      // Quando humano envia pelo dashboard, pausa o bot para nao conflitar
      if (conv.botActive) {
        conv.botActive = false;
        conv.status = "paused";
        conv.pausedAt = new Date().toISOString();
        io.emit("log", { type: "info", text: "[" + ts + "] ⏸ Bot pausado automaticamente (humano assumiu)" });
      }
      await saveConversation(fullPhone, conv);

      io.emit("log", { type: "out", text: "[" + ts + "] 👤 Voce -> " + phone.replace("@c.us", "") + ": " + text });

      broadcastUpdate();
      io.emit("conversation-detail", await getConversation(fullPhone));
    } catch (err) {
      console.error("Erro ao enviar mensagem humana:", err);
      io.emit("log", { type: "error", text: "[" + ts + "] Erro ao enviar: " + err.message });
      // Log detalhado para debug
      if (err.stack) console.error("Stack:", err.stack);
    }
  });

  // ── Selecionar Conta ──
  socket.on("select-account", function(accountPhone) {
    socket.selectedAccount = accountPhone;
    socket.emit("selectedAccount", accountPhone);
    socket.emit("status", wppStatus[accountPhone] || "disconnected");
    if (state.qrDataUrl && state.qrAccountPhone === accountPhone) {
      socket.emit("qr", state.qrDataUrl);
    }
    socket.emit("stats", state.stats);
    listAllLeads().then(function(l) { socket.emit("leads", l); });
  });

  // ── WhatsApp reconexao ──
  socket.on("reconnect-whatsapp", function(accountPhone) {
    if (!accountPhone && socket.selectedAccount) {
      accountPhone = socket.selectedAccount;
    }
    if (accountPhone) {
      startWhatsAppClient(normalizePhoneNumber(accountPhone), false);
    }
  });

  socket.on("reset-session", function(accountPhone) {
    if (!accountPhone && socket.selectedAccount) {
      accountPhone = socket.selectedAccount;
    }
    if (accountPhone) {
      startWhatsAppClient(normalizePhoneNumber(accountPhone), true);
    }
  });
});

// ── WhatsApp ──

async function clearWhatsAppRuntime(accountPhone) {
  try {
    var runtimeDir = path.join(WHATSAPP_RUNTIME_BASE, normalizePhoneNumber(accountPhone));
    await fs.promises.rm(runtimeDir, { recursive: true, force: true });
  } catch (e) {}
}

async function clearWhatsAppSession(accountPhone) {
  var normalizedPhone = normalizePhoneNumber(accountPhone);
  try {
    await deleteRemoteAuthSession("RemoteAuth-" + normalizedPhone);
  } catch (e) {}
  await clearWhatsAppRuntime(accountPhone);
  await cleanupLegacyWorkspaceStorage();
}

function scheduleWhatsAppRestart(accountPhone, delayMs) {
  if (wppRestartTimers[accountPhone]) return;
  wppRestartTimers[accountPhone] = setTimeout(function() {
    delete wppRestartTimers[accountPhone];
    startWhatsAppClient(normalizePhoneNumber(accountPhone), false);
  }, delayMs);
}

async function startWhatsAppClient(accountPhone, resetSession) {
  var normalizedPhone = normalizePhoneNumber(accountPhone);
  if (wppStarting[normalizedPhone]) return;
  wppStarting[normalizedPhone] = true;

  try {
    if (wppRestartTimers[normalizedPhone]) {
      clearTimeout(wppRestartTimers[normalizedPhone]);
      delete wppRestartTimers[normalizedPhone];
    }

    if (wppClients[normalizedPhone]) {
      try { await wppClients[normalizedPhone].destroy(); } catch (e) {}
      delete wppClients[normalizedPhone];
    }

    if (resetSession) {
      await clearWhatsAppSession(normalizedPhone);
    }

    wppStatus[normalizedPhone] = "disconnected";
    state.qrDataUrl = null;
    state.qrAccountPhone = normalizedPhone;
    io.emit("status", "disconnected");

    var runtimeDir = path.join(WHATSAPP_RUNTIME_BASE, normalizedPhone);
    var clientId = normalizedPhone;

    wppClients[normalizedPhone] = new Client({
      authStrategy: new RemoteAuth({
        clientId: clientId,
        store: new MariaDbAuthStore(),
        dataPath: runtimeDir,
        backupSyncIntervalMs: 60000,
      }),
    puppeteer: {
      headless: true,
      args: [
        "--no-sandbox", "--disable-setuid-sandbox",
        "--disable-dev-shm-usage", "--disable-gpu",
        "--disable-extensions", "--disable-default-apps",
        "--disable-translate", "--no-first-run",
      ],
    },
    webVersionCache: {
      type: "remote",
      remotePath: "https://raw.githubusercontent.com/niconeitor/niconeitor/refs/heads/master/niconeitor.json",
    },
  });

    var clientInstance = wppClients[normalizedPhone];

    clientInstance.on("qr", async function(qr) {
      console.log("QR Code gerado para " + normalizedPhone);
      wppStatus[normalizedPhone] = "qr";
      state.qrDataUrl = await QRCode.toDataURL(qr, { width: 280, margin: 2 });
      state.qrAccountPhone = normalizedPhone;

      // Salva o QR code no banco
      try {
        await updateAccountInfo({
          phone: normalizedPhone,
          qrCode: qr,
          status: 'authenticating'
        });
      } catch (e) {
        console.error("Erro ao salvar QR code:", e.message);
      }

      io.emit("status", "qr");
      io.emit("qr", state.qrDataUrl);
    });

    clientInstance.on("authenticated", function() { console.log("WhatsApp autenticado para " + normalizedPhone); });

  clientInstance.on("ready", async function() {
    console.log("WhatsApp ONLINE para " + normalizedPhone);
    wppStatus[normalizedPhone] = "connected";
    state.qrDataUrl = null;
    var connectedPhone = null;
    var connectedName = "WhatsApp";

    try {
      var me = await clientInstance.getContactById(clientInstance.info.wid._serialized);
      connectedName = me && me.name ? me.name : connectedName;
      connectedPhone = me && me.number ? me.number : null;
    } catch (e) {}

    // A sessao do WhatsApp agora e persistida diretamente no MariaDB via RemoteAuth.

    // Salva informacoes da conta no banco
    try {
      await updateAccountInfo({
        name: connectedName,
        phone: connectedPhone,
        status: 'ready'
      });
      console.log("✅ Informacoes da conta salvas no banco para " + normalizedPhone);
    } catch (e) {
      console.error("Erro ao salvar account info:", e.message);
      try {
        await updateAccountInfo({ status: 'ready' });
      } catch (e2) {}
    }

    io.emit("status", "connected");
    broadcastUpdate();
  });

  clientInstance.on("auth_failure", async function() {
    wppStatus[normalizedPhone] = "disconnected";
    io.emit("status", "disconnected");
    await clearWhatsAppSession(normalizedPhone);
    emitLog("error", "Falha na autenticacao para " + normalizedPhone + ". Clique em 'Resetar Sessao'.");
  });

  clientInstance.on("disconnected", async function(reason) {
    console.log("Desconectado (" + normalizedPhone + "):", reason);
    wppStatus[normalizedPhone] = "disconnected";

    // Salva status desconectado no banco
    try {
      await updateAccountInfo({ status: 'disconnected' });
    } catch (e) {}

    io.emit("status", "disconnected");
    if (reason === "LOGOUT") {
      await clearWhatsAppSession(normalizedPhone);
      emitLog("error", "WhatsApp deslogado para " + normalizedPhone + ". Clique em 'Reconectar'.");
    } else {
      emitLog("info", "Conexao perdida para " + normalizedPhone + ". Reconectando em 10s...");
      scheduleWhatsAppRestart(normalizedPhone, 10000);
    }
  });

  // ── Mensagens ──
  clientInstance.on("message", async function(message) {
    try {
      // Ignora: status, mensagens proprias, e QUALQUER grupo
      if (message.from === "status@broadcast") return;
      if (message.fromMe) return;
      if (message.isGroupMsg) return;
      if (message.from && message.from.endsWith("@g.us")) return;
      if (message.to && message.to.endsWith("@g.us")) return;

      var phone = message.from;
      var contactNumber = null;
      var smartContactName = null;

      // Busca o numero real do contato ANTES de tudo (pra normalizar a chave)
      try {
        var contact = await message.getContact();
        if (contact && contact.number) {
          contactNumber = contact.number;
          // Normaliza: usa sempre o numero real como chave primaria
          // Isso evita criar multiplos registros pra mesma pessoa
          phone = contactNumber + "@c.us";
        }
        smartContactName = extractSmartContactName(contact, message);
      } catch (e) {}

      // Cacheia o chat pra poder responder depois (evita erro de LID)
      try {
        var chatObj = await message.getChat();
        if (chatObj) chatCache[phone] = chatObj;
      } catch (e) {}

      var body = message.body ? message.body.trim() : "";

      if (!body) {
        // So responde se for midia real (audio, imagem, video, documento, sticker)
        var hasMedia = message.hasMedia || message.type === "audio" || message.type === "ptt" || message.type === "image" || message.type === "video" || message.type === "document" || message.type === "sticker";
        if (hasMedia) {
          var convCheck = await loadConversation(phone);
          if (convCheck.botActive) {
            await safeSendMessage(clientInstance, phone, "Oi! No momento consigo processar apenas mensagens de texto. Pode me descrever por escrito o que precisa? 😊");
          }
        }
        return;
      }

      var ts = new Date().toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
      var shortPhone = phone.replace("@c.us", "");

      // Sempre loga a mensagem
      io.emit("log", { type: "in", text: "[" + ts + "] " + shortPhone + ": " + body });

      var conv = await loadConversation(phone);
      var isFirstMessage = conv.messages.length === 0;

      // Salva o numero real do contato (diferente do ID interno do WhatsApp)
      if (contactNumber && !conv.contactNumber) {
        conv.contactNumber = contactNumber;
      }
      if (smartContactName && !normalizePossibleContactName(conv.name)) {
        conv.name = smartContactName;
      }

      // ── AUTO-SAVE: Salva o lead no banco imediatamente na primeira mensagem ──
      if (isFirstMessage) {
        try {
          await saveConversation(phone, conv);
          io.emit("log", { type: "info", text: "[" + ts + "] 📌 Novo lead criado no banco: " + shortPhone });
        } catch (e) {
          console.error("Erro ao salvar novo lead:", e.message);
        }
      }

      // ── Reset por inatividade (30 min) ──
      // Se o lead ficou 30+ minutos sem mandar mensagem, reseta a conversa
      // para tratar como um novo contato (pergunta nome, empresa etc)
      var INACTIVITY_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutos
      if (conv.messages.length > 0) {
        var lastMsg = conv.messages[conv.messages.length - 1];
        var lastTime = new Date(lastMsg.timestamp).getTime();
        var now = Date.now();
        if (now - lastTime > INACTIVITY_TIMEOUT_MS) {
          io.emit("log", { type: "info", text: "[" + ts + "] 🔄 " + shortPhone + " — inativo por 30+ min, resetando conversa" });
          // Preserva dados do contato mas reseta o fluxo
          var savedContactNumber = conv.contactNumber;
          conv.messages = [];
          conv.agentExchanges = 0;
          conv.status = "active";
          conv.botActive = true;
          conv.name = null;
          conv.company = null;
          conv.segment = null;
          conv.pain = null;
          conv.size = null;
          conv.temperature = null;
          conv.summary = null;
          conv.infra = null;
          conv.interest = null;
          conv.scheduling = null;
          conv.handedOffAt = null;
          conv.pausedAt = null;
          conv.contactNumber = savedContactNumber;
        }
      }

      // Sempre salva a mensagem do lead no historico
      addMessage(conv, "lead", body);
      await saveConversation(phone, conv);

      // Atualiza dashboard em tempo real
      broadcastUpdate();
      io.emit("conversation-update", { phone: conv.phone, message: { role: "lead", content: body, timestamp: new Date().toISOString() } });

      // ── Se bot PAUSADO (humano assumiu) → nao responde ──
      if (!conv.botActive || conv.status === "paused") {
        io.emit("log", { type: "info", text: "[" + ts + "] ⏸ " + shortPhone + " — bot pausado, aguardando resposta humana" });
        return;
      }

      // ── Se ja transferido → nao responde ──
      if (conv.status === "handed_off") {
        io.emit("log", { type: "info", text: "[" + ts + "] " + shortPhone + " ja transferido" });
        return;
      }

      // ── Anti-spam: mesma mensagem repetida 3+ vezes = pausa 10 min ──
      var spamPause = AGENT_CONFIG.spamPauseMs || 600000;

      // Checa se esta em pausa por spam
      if (conv.spamPausedUntil) {
        var pauseEnd = new Date(conv.spamPausedUntil).getTime();
        if (Date.now() < pauseEnd) {
          io.emit("log", { type: "info", text: "[" + ts + "] 🚫 " + shortPhone + " — em pausa por spam" });
          return;
        } else {
          conv.spamPausedUntil = null;
          await saveConversation(phone, conv);
        }
      }

      // Detecta mensagem repetida (3+ vezes a mesma msg seguida)
      var bodyLower = body.toLowerCase().trim();
      var repeatCount = 0;
      for (var i = conv.messages.length - 1; i >= 0; i--) {
        var m = conv.messages[i];
        if (m.role !== "lead") break;
        if (m.content.toLowerCase().trim() === bodyLower) {
          repeatCount++;
        } else {
          break;
        }
      }

      if (repeatCount >= 3) {
        conv.spamPausedUntil = new Date(Date.now() + spamPause).toISOString();
        await saveConversation(phone, conv);
        await safeSendMessage(clientInstance, phone, "Oi! Vi que voce enviou a mesma mensagem algumas vezes. Vou pausar por 10 minutos, ok? Quando voltar, te respondo com calma! ✅");
        io.emit("log", { type: "info", text: "[" + ts + "] 🚫 " + shortPhone + " — spam detectado (msg repetida), pausando 10 min" });
        broadcastUpdate();
        return;
      }

      // ── Cancela timers pendentes (lead respondeu) ──
      if (followUpTimers[phone]) {
        clearTimeout(followUpTimers[phone]);
        delete followUpTimers[phone];
      }
      if (closeTimers[phone]) {
        clearTimeout(closeTimers[phone]);
        delete closeTimers[phone];
      }

      // ── Checa se pediu humano ──
      if (checkHumanRequest(body)) {
        var humanMsg = "Claro! Vou encaminhar voce para o nosso setor de vendas e eles vao entrar em contato com voce. Ate logo! ✅";
        await safeSendMessage(clientInstance, phone, humanMsg);
        addMessage(conv, "agent", humanMsg);
        await doHandoff(phone, conv, { handoffReason: "pediu_humano", contactNumber: conv.contactNumber || null });
        return;
      }

      // ── Limite de 50 mensagens do bot ──
      if ((conv.agentExchanges || 0) >= 50) {
        await safeSendMessage(clientInstance, phone, "Oi! Ja conversamos bastante e quero garantir o melhor atendimento. Vou te transferir para um dos nossos consultores. Um momento! ✅");
        await doHandoff(phone, conv, { handoffReason: "limite_50_msgs", contactNumber: conv.contactNumber || null });
        return;
      }

      // ── Gera resposta com IA ──
      try {
        var chat = await message.getChat();
        chat.sendStateTyping();
      } catch (e) {}

      var result = await generateResponse(conv);

      // Delay proporcional ao tamanho da resposta (simula digitacao humana)
      var responseLen = result.response.length;
      var baseDelay = 2000; // minimo 2s
      var typingDelay = Math.min(responseLen * 30, 8000); // ~30ms por caractere, max 8s extra
      var randomJitter = Math.floor(Math.random() * 1500); // variacao aleatoria
      var delay = baseDelay + typingDelay + randomJitter;
      await new Promise(function(resolve) { setTimeout(resolve, delay); });

      io.emit("log", { type: "out", text: "[" + ts + "] 🤖 -> " + shortPhone + ": " + result.response });

      await addMessage(conv, "agent", result.response);
      conv.agentExchanges = (conv.agentExchanges || 0) + 1;

      // ── Aplica dados extraídos à conversa ──
      if (result.leadData) {
        var keys = ["name", "email", "company", "segment", "pain", "size", "temperature", "summary", "infra", "interest", "scheduling"];
        for (var k = 0; k < keys.length; k++) {
          var key = keys[k];
          if (result.leadData[key] && !conv[key]) {
            if (key === "name") {
              var extractedName = normalizePossibleContactName(result.leadData[key]);
              if (extractedName) {
                conv[key] = extractedName;
              }
            } else {
              conv[key] = result.leadData[key];
            }
          }
        }
      }

      if (result.handoff || result.qualified) {
        var ld = Object.assign({}, result.leadData, { phone: phone, contactNumber: conv.contactNumber || null });
        await safeSendMessage(clientInstance, phone, result.response);
        await doHandoff(phone, conv, ld);
        return;
      }

      await saveConversation(phone, conv);
      await safeSendMessage(clientInstance, phone, result.response);
      broadcastUpdate();

      // ── Follow-up: se o lead nao responder em 10 min, cobra ──
      if (conv.status === "active" && conv.botActive) {
        var followUpDelay = AGENT_CONFIG.followUpDelayMs || 600000;
        var closeDelay = AGENT_CONFIG.inactivityCloseMs || 1800000;

        // Cancela timers anteriores
        if (followUpTimers[phone]) clearTimeout(followUpTimers[phone]);
        if (closeTimers[phone]) clearTimeout(closeTimers[phone]);

        // Timer 10 min: cobra o lead
        followUpTimers[phone] = setTimeout(async function() {
          try {
            var freshConv = await loadConversation(phone);
            if (freshConv.messages.length > 0 && freshConv.botActive && freshConv.status === "active") {
              var lastMsg = freshConv.messages[freshConv.messages.length - 1];
              if (lastMsg.role === "agent") {
                var followUpText = "Oi! Ainda esta por ai? Estou aguardando sua resposta pra gente continuar. 😊";
                addMessage(freshConv, "agent", followUpText);
                await saveConversation(phone, freshConv);
                await safeSendMessage(clientInstance, phone, followUpText);
                var fts = new Date().toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
                io.emit("log", { type: "out", text: "[" + fts + "] ⏰ Follow-up -> " + phone.replace("@c.us", "") });
                broadcastUpdate();
              }
            }
            delete followUpTimers[phone];
          } catch (e) {
            console.error("Erro follow-up:", e.message);
          }
        }, followUpDelay);

        // Timer 30 min: encerra a conversa
        closeTimers[phone] = setTimeout(async function() {
          try {
            var freshConv = await loadConversation(phone);
            if (freshConv.messages.length > 0 && freshConv.botActive && freshConv.status === "active") {
              var lastMsg = freshConv.messages[freshConv.messages.length - 1];
              if (lastMsg.role === "agent") {
                var closeText = "Oi! Como nao tive retorno, vou encerrar nosso atendimento por aqui. Mas fique tranquilo(a), nosso setor de vendas pode entrar em contato futuramente. Foi um prazer falar com voce! ✅";
                addMessage(freshConv, "agent", closeText);
                freshConv.status = "closed";
                freshConv.botActive = false;
                await saveConversation(phone, freshConv);
                await safeSendMessage(clientInstance, phone, closeText);
                var cts = new Date().toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
                io.emit("log", { type: "info", text: "[" + cts + "] 🔒 Conversa encerrada por inatividade -> " + phone.replace("@c.us", "") });
                broadcastUpdate();
              }
            }
            delete closeTimers[phone];
          } catch (e) {
            console.error("Erro close:", e.message);
          }
        }, closeDelay);
      }

    } catch (err) {
      console.error("Erro:", err);
      io.emit("log", { type: "error", text: "Erro: " + err.message });
    }
  });

  } catch (err) {
    console.error("Erro ao configurar listeners do WhatsApp para " + normalizedPhone + ":", err.message);
    io.emit("status", "disconnected");
    io.emit("log", { type: "error", text: "Erro ao configurar cliente: " + err.message });
  }

  console.log("Inicializando WhatsApp para " + normalizedPhone + "...");
  try {
    await clientInstance.initialize();
  } catch (err) {
    console.error("Erro ao inicializar WhatsApp para " + normalizedPhone + ":", err.message);
    io.emit("status", "disconnected");
    io.emit("log", { type: "error", text: "Erro ao iniciar " + normalizedPhone + ": " + err.message + ". Clique em 'Reconectar'." });
    scheduleWhatsAppRestart(normalizedPhone, 5000);
  } finally {
    wppStarting[normalizedPhone] = false;
  }
}

async function stopWhatsAppClient(accountPhone) {
  var normalizedPhone = normalizePhoneNumber(accountPhone);

  if (!wppClients[normalizedPhone]) {
    console.log("Cliente WhatsApp nao encontrado para " + normalizedPhone);
    return;
  }

  try {
    console.log("Parando cliente WhatsApp para " + normalizedPhone);
    var clientInstance = wppClients[normalizedPhone];

    // Destruir o cliente
    try {
      await clientInstance.destroy();
    } catch (e) {
      console.error("Erro ao destruir cliente:", e.message);
    }

    // Remover do mapa de clientes
    delete wppClients[normalizedPhone];

    // Atualizar status
    wppStatus[normalizedPhone] = "disconnected";

    // Broadcast status para Socket.IO
    io.emit("status", "disconnected");
    io.emit("log", { type: "info", text: "Cliente WhatsApp para " + normalizedPhone + " foi parado" });

    console.log("✅ Cliente WhatsApp para " + normalizedPhone + " foi parado com sucesso");
  } catch (err) {
    console.error("Erro ao parar WhatsApp para " + normalizedPhone + ":", err.message);
    io.emit("log", { type: "error", text: "Erro ao parar cliente " + normalizedPhone + ": " + err.message });
  }
}

async function findGroupByName(name, clientInstance) {
  var activeClient = clientInstance || wpp;
  var normalizedName;

  if (!activeClient || !name) {
    return null;
  }

  try {
    var chats = await activeClient.getChats();
    normalizedName = String(name).trim().toLowerCase();

    for (var i = 0; i < chats.length; i++) {
      if (chats[i].isGroup && chats[i].name && chats[i].name.toLowerCase() === normalizedName) {
        console.log("Grupo encontrado: " + chats[i].name + " (" + chats[i].id._serialized + ")");
        return chats[i].id._serialized;
      }
    }

    for (var j = 0; j < chats.length; j++) {
      if (chats[j].isGroup && chats[j].name && chats[j].name.toLowerCase().includes(normalizedName)) {
        console.log("Grupo encontrado: " + chats[j].name + " (" + chats[j].id._serialized + ")");
        return chats[j].id._serialized;
      }
    }
  } catch (err) {
    console.error("Erro ao buscar grupo:", err.message);
  }
  return null;
}

async function doHandoffLegacy(phone, conv, leadData) {
  var resolvedRoute;
  var teamMsg;

  markHandedOff(conv, leadData);
  await saveConversation(phone, conv);

  // NAO envia mensagem ao lead aqui — a resposta da IA ja inclui a despedida

  var ts = new Date().toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
  io.emit("log", {
    type: "handoff",
    text: "[" + ts + "] 🔔 HANDOFF: " + phone.replace("@c.us", "") + " - " + (leadData.handoffReason || "qualificado") + " - " + (leadData.name || "sem nome"),
  });

  resolvedRoute = await resolveNotificationRoute("handoff_leads", wpp);
  teamMsg = HANDOFF_MESSAGE_TO_TEAM(Object.assign({}, leadData, {
    phone: phone,
    contactNumber: leadData.contactNumber || conv.contactNumber || null,
    destinationLabel: resolvedRoute && resolvedRoute.route ? resolvedRoute.route.routeLabel : null,
  }));

  // Envia para o grupo de leads
  try {
    var groupId = process.env.HANDOFF_GROUP_ID;
    if (!groupId) {
      groupId = await findGroupByName(groupName);
    }
    if (groupId) {
      await safeSendMessage(wpp,groupId, teamMsg);
      io.emit("log", { type: "info", text: "[" + ts + "] ✅ Resumo enviado para o grupo de leads" });
    } else {
      io.emit("log", { type: "error", text: "[" + ts + "] ⚠️ Grupo '" + groupName + "' nao encontrado. Configure HANDOFF_GROUP_ID ou HANDOFF_GROUP_NAME no .env" });
    }
  } catch (err) {
    console.error("Erro ao enviar para grupo:", err.message);
    io.emit("log", { type: "error", text: "[" + ts + "] Erro ao enviar para grupo: " + err.message });
  }

  // Envia tambem para o numero individual se configurado
  if (notifyNumber && notifyNumber !== "5511999999999@c.us") {
    try {
      await safeSendMessage(wpp,notifyNumber, teamMsg);
    } catch (err) {
      console.error("Erro ao notificar:", err.message);
    }
  }

  broadcastUpdate();
}

async function doHandoff(phone, conv, leadData) {
  var ts = new Date().toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
  var resolvedRoute;
  var teamMsg;
  var safeLeadName;

  safeLeadName = normalizePossibleContactName(leadData && leadData.name) || normalizePossibleContactName(conv && conv.name) || null;
  leadData = Object.assign({}, leadData, {
    name: safeLeadName,
  });

  markHandedOff(conv, leadData);
  await saveConversation(phone, conv);

  io.emit("log", {
    type: "handoff",
    text: "[" + ts + "] 🔔 HANDOFF: " + phone.replace("@c.us", "") + " - " + (leadData.handoffReason || "qualificado") + " - " + (leadData.name || "sem nome"),
  });

  resolvedRoute = await resolveNotificationRoute("handoff_leads", wpp);
  teamMsg = HANDOFF_MESSAGE_TO_TEAM(Object.assign({}, leadData, {
    phone: phone,
    contactNumber: leadData.contactNumber || conv.contactNumber || null,
    destinationLabel: resolvedRoute && resolvedRoute.route ? resolvedRoute.route.routeLabel : null,
  }));

  try {
    if (resolvedRoute && resolvedRoute.targetId) {
      await safeSendMessage(wpp, resolvedRoute.targetId, teamMsg);
      io.emit("log", { type: "info", text: "[" + ts + "] ✅ Resumo enviado para o grupo configurado no painel" });
    } else {
      io.emit("log", {
        type: "error",
        text: "[" + ts + "] ⚠️ Nenhum grupo configurado para leads qualificados. Ajuste em 'Grupos e avisos' no painel.",
      });
    }
  } catch (err) {
    console.error("Erro ao enviar para grupo:", err.message);
    io.emit("log", { type: "error", text: "[" + ts + "] Erro ao enviar para grupo: " + err.message });
  }

  broadcastUpdate();
}

function openBrowser(url) {
  var cmd;
  switch (process.platform) {
    case "win32": cmd = "start " + url; break;
    case "darwin": cmd = "open " + url; break;
    default: cmd = "xdg-open " + url; break;
  }
  exec(cmd, function() {});
}

process.on("uncaughtException", function(err) {
  console.error("Erro nao tratado:", err.message);
  io.emit("log", { type: "error", text: "Erro interno: " + err.message });
});
process.on("unhandledRejection", function(err) {
  var msg = err && err.message ? err.message : String(err);
  console.error("Promise rejeitada:", msg);
  io.emit("log", { type: "error", text: "Erro async: " + msg });
});

// Mata processo anterior e inicia servidor
killPort(PORT).then(function() {
  return initDb();
}).then(function() {
  return cleanupLegacyWorkspaceStorage();
}).then(function() {
server.listen(PORT, function() {
  var url = "http://localhost:" + PORT;
  console.log("");
  console.log("========================================");
  console.log("  U-All SDR Agent - Dashboard");
  console.log("  " + url);
  console.log("  Motor IA: ChatGPT (" + (process.env.OPENAI_MODEL || "gpt-4o-mini") + ")");
  console.log("========================================");
  console.log("");
  openBrowser(url);
  startWhatsApp(false);

  startScheduledReports(
    function() { return wpp; },
    async function(routeKey, wppInstance) {
      return await resolveNotificationRoute(routeKey, wppInstance);
    },
    io
  );
});
}); // fim killPort().then

process.on("SIGINT", async function() {
  console.log("\nEncerrando...");
  if (wpp) { try { await wpp.destroy(); } catch (e) {} }
  try { await closeDb(); } catch (e) {}
  process.exit(0);
});
