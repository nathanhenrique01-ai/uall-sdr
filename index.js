// index.js — Servidor com takeover humano

import "dotenv/config";
import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { exec } from "child_process";
import pkg from "whatsapp-web.js";
var Client = pkg.Client;
var LocalAuth = pkg.LocalAuth;
import QRCode from "qrcode";

import { generateResponse, checkHumanRequest } from "./agent.js";
import {
  loadConversation, saveConversation, addMessage,
  markHandedOff, listAllLeads, getConversation,
  pauseBot, resumeBot,
} from "./memory.js";
import { HANDOFF_MESSAGE_TO_LEAD, HANDOFF_MESSAGE_TO_TEAM, AGENT_CONFIG } from "./config.js";
import { startScheduledReports } from "./reports.js";

if (!process.env.OPENAI_API_KEY) {
  console.error("OPENAI_API_KEY nao configurada. Edite o arquivo .env");
  process.exit(1);
}

var __dirname = path.dirname(fileURLToPath(import.meta.url));
var PORT = process.env.PORT || 3000;

var SESSION_DIR = path.join(__dirname, "data", "whatsapp-session");
var CLEAN_FLAG = path.join(__dirname, "data", ".clean-session");
if (fs.existsSync(CLEAN_FLAG)) {
  try {
    fs.rmSync(SESSION_DIR, { recursive: true, force: true });
    fs.unlinkSync(CLEAN_FLAG);
  } catch (e) {}
}

var app = express();
var server = createServer(app);
var io = new Server(server);

// Timers de follow-up (cobra lead apos 10 min sem resposta)
var followUpTimers = {};
// Timers de encerramento (fecha conversa apos 30 min sem resposta)
var closeTimers = {};
app.use(express.static(path.join(__dirname, "public")));

var state = {
  whatsappStatus: "disconnected",
  qrDataUrl: null,
  stats: { total: 0, active: 0, paused: 0, handedOff: 0 },
};

function refreshStats() {
  var leads = listAllLeads();
  state.stats = {
    total: leads.length,
    active: leads.filter(function(l) { return l.status === "active"; }).length,
    paused: leads.filter(function(l) { return l.status === "paused"; }).length,
    handedOff: leads.filter(function(l) { return l.status === "handed_off"; }).length,
  };
}

function broadcastUpdate() {
  refreshStats();
  io.emit("stats", state.stats);
  io.emit("leads", listAllLeads());
}

// ── Socket.io ──
io.on("connection", function(socket) {
  console.log("Dashboard conectado");
  refreshStats();
  socket.emit("status", state.whatsappStatus);
  if (state.qrDataUrl) socket.emit("qr", state.qrDataUrl);
  socket.emit("stats", state.stats);
  socket.emit("leads", listAllLeads());

  socket.on("get-conversation", function(phone) {
    socket.emit("conversation-detail", getConversation(phone));
  });

  socket.on("get-leads", function() {
    broadcastUpdate();
  });

  // ── TAKEOVER: Pausar bot (humano assume) ──
  socket.on("pause-bot", function(phone) {
    var conv = pauseBot(phone);
    var ts = new Date().toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
    io.emit("log", { type: "info", text: "[" + ts + "] 🔴 Bot PAUSADO para " + phone.replace("@c.us", "") + " — voce assumiu a conversa" });
    broadcastUpdate();
    socket.emit("conversation-detail", getConversation(phone));
  });

  // ── REATIVAR: Bot volta a responder ──
  socket.on("resume-bot", function(phone) {
    var conv = resumeBot(phone);
    var ts = new Date().toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
    io.emit("log", { type: "info", text: "[" + ts + "] 🟢 Bot REATIVADO para " + phone.replace("@c.us", "") });
    broadcastUpdate();
    socket.emit("conversation-detail", getConversation(phone));
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

      var sendResult = await wpp.sendMessage(fullPhone, text);
      console.log("Mensagem enviada com sucesso:", sendResult && sendResult.id ? sendResult.id._serialized : "ok");

      // Salva no historico como "human" e pausa o bot automaticamente
      var conv = loadConversation(fullPhone);
      addMessage(conv, "human", text);
      // Quando humano envia pelo dashboard, pausa o bot para nao conflitar
      if (conv.botActive) {
        conv.botActive = false;
        conv.status = "paused";
        conv.pausedAt = new Date().toISOString();
        io.emit("log", { type: "info", text: "[" + ts + "] ⏸ Bot pausado automaticamente (humano assumiu)" });
      }
      saveConversation(fullPhone, conv);

      io.emit("log", { type: "out", text: "[" + ts + "] 👤 Voce -> " + phone.replace("@c.us", "") + ": " + text });

      broadcastUpdate();
      io.emit("conversation-detail", getConversation(fullPhone));
    } catch (err) {
      console.error("Erro ao enviar mensagem humana:", err);
      io.emit("log", { type: "error", text: "[" + ts + "] Erro ao enviar: " + err.message });
      // Log detalhado para debug
      if (err.stack) console.error("Stack:", err.stack);
    }
  });

  // ── WhatsApp reconexao ──
  socket.on("reconnect-whatsapp", function() {
    startWhatsApp();
  });

  socket.on("reset-session", function() {
    try { fs.rmSync(SESSION_DIR, { recursive: true, force: true }); } catch (e) {}
    startWhatsApp();
  });
});

// ── WhatsApp ──
var wpp = null;

function startWhatsApp() {
  if (wpp) {
    try { wpp.destroy(); } catch (e) {}
    wpp = null;
  }

  state.whatsappStatus = "disconnected";
  io.emit("status", "disconnected");

  wpp = new Client({
    authStrategy: new LocalAuth({ dataPath: "./data/whatsapp-session" }),
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

  wpp.on("qr", async function(qr) {
    console.log("QR Code gerado");
    state.whatsappStatus = "qr";
    state.qrDataUrl = await QRCode.toDataURL(qr, { width: 280, margin: 2 });
    io.emit("status", "qr");
    io.emit("qr", state.qrDataUrl);
  });

  wpp.on("authenticated", function() { console.log("WhatsApp autenticado"); });

  wpp.on("ready", function() {
    console.log("WhatsApp ONLINE");
    state.whatsappStatus = "connected";
    state.qrDataUrl = null;
    io.emit("status", "connected");
    broadcastUpdate();
  });

  wpp.on("auth_failure", function() {
    state.whatsappStatus = "disconnected";
    io.emit("status", "disconnected");
    io.emit("log", { type: "error", text: "Falha na autenticacao. Clique em 'Resetar Sessao'." });
    try {
      fs.mkdirSync(path.join(__dirname, "data"), { recursive: true });
      fs.writeFileSync(CLEAN_FLAG, "1");
    } catch (e) {}
  });

  wpp.on("disconnected", function(reason) {
    console.log("Desconectado:", reason);
    state.whatsappStatus = "disconnected";
    io.emit("status", "disconnected");
    if (reason === "LOGOUT") {
      io.emit("log", { type: "error", text: "WhatsApp deslogado. Clique em 'Reconectar'." });
      try { fs.rmSync(SESSION_DIR, { recursive: true, force: true }); } catch (e) {}
    } else {
      io.emit("log", { type: "info", text: "Conexao perdida. Reconectando em 10s..." });
      setTimeout(function() { startWhatsApp(); }, 10000);
    }
  });

  // ── Mensagens ──
  wpp.on("message", async function(message) {
    try {
      // Ignora: status, mensagens proprias, e QUALQUER grupo
      if (message.from === "status@broadcast") return;
      if (message.fromMe) return;
      if (message.isGroupMsg) return;
      if (message.from && message.from.endsWith("@g.us")) return;
      if (message.to && message.to.endsWith("@g.us")) return;

      var phone = message.from;

      // Busca o numero real do contato
      var contactNumber = null;
      try {
        var contact = await message.getContact();
        if (contact && contact.number) {
          contactNumber = contact.number;
        }
      } catch (e) {}

      var body = message.body ? message.body.trim() : "";

      if (!body) {
        // So responde se for midia real (audio, imagem, video, documento, sticker)
        var hasMedia = message.hasMedia || message.type === "audio" || message.type === "ptt" || message.type === "image" || message.type === "video" || message.type === "document" || message.type === "sticker";
        if (hasMedia) {
          var convCheck = loadConversation(phone);
          if (convCheck.botActive) {
            await wpp.sendMessage(phone, "Oi! No momento consigo processar apenas mensagens de texto. Pode me descrever por escrito o que precisa? 😊");
          }
        }
        return;
      }

      var ts = new Date().toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
      var shortPhone = phone.replace("@c.us", "");

      // Sempre loga a mensagem
      io.emit("log", { type: "in", text: "[" + ts + "] " + shortPhone + ": " + body });

      var conv = loadConversation(phone);

      // Salva o numero real do contato (diferente do ID interno do WhatsApp)
      if (contactNumber && !conv.contactNumber) {
        conv.contactNumber = contactNumber;
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
      saveConversation(phone, conv);

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
          saveConversation(phone, conv);
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
        saveConversation(phone, conv);
        await wpp.sendMessage(phone, "Oi! Vi que voce enviou a mesma mensagem algumas vezes. Vou pausar por 10 minutos, ok? Quando voltar, te respondo com calma! ✅");
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
        await wpp.sendMessage(phone, humanMsg);
        addMessage(conv, "agent", humanMsg);
        await doHandoff(phone, conv, { handoffReason: "pediu_humano", contactNumber: conv.contactNumber || null });
        return;
      }

      // ── Limite de 50 mensagens do bot ──
      if ((conv.agentExchanges || 0) >= 50) {
        await wpp.sendMessage(phone, "Oi! Ja conversamos bastante e quero garantir o melhor atendimento. Vou te transferir para um dos nossos consultores. Um momento! ✅");
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

      addMessage(conv, "agent", result.response);
      conv.agentExchanges = (conv.agentExchanges || 0) + 1;

      if (result.handoff || result.qualified) {
        var ld = Object.assign({}, result.leadData, { phone: phone, contactNumber: conv.contactNumber || null });
        await wpp.sendMessage(phone, result.response);
        await doHandoff(phone, conv, ld);
        return;
      }

      saveConversation(phone, conv);
      await wpp.sendMessage(phone, result.response);
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
            var freshConv = loadConversation(phone);
            if (freshConv.messages.length > 0 && freshConv.botActive && freshConv.status === "active") {
              var lastMsg = freshConv.messages[freshConv.messages.length - 1];
              if (lastMsg.role === "agent") {
                var followUpText = "Oi! Ainda esta por ai? Estou aguardando sua resposta pra gente continuar. 😊";
                addMessage(freshConv, "agent", followUpText);
                saveConversation(phone, freshConv);
                await wpp.sendMessage(phone, followUpText);
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
            var freshConv = loadConversation(phone);
            if (freshConv.messages.length > 0 && freshConv.botActive && freshConv.status === "active") {
              var lastMsg = freshConv.messages[freshConv.messages.length - 1];
              if (lastMsg.role === "agent") {
                var closeText = "Oi! Como nao tive retorno, vou encerrar nosso atendimento por aqui. Mas fique tranquilo(a), nosso setor de vendas pode entrar em contato futuramente. Foi um prazer falar com voce! ✅";
                addMessage(freshConv, "agent", closeText);
                freshConv.status = "closed";
                freshConv.botActive = false;
                saveConversation(phone, freshConv);
                await wpp.sendMessage(phone, closeText);
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

  console.log("Inicializando WhatsApp...");
  wpp.initialize().catch(function(err) {
    console.error("Erro ao inicializar WhatsApp:", err.message);
    io.emit("status", "disconnected");
    io.emit("log", { type: "error", text: "Erro ao iniciar: " + err.message + ". Clique em 'Reconectar'." });
  });
}

async function findGroupByName(name) {
  try {
    var chats = await wpp.getChats();
    for (var i = 0; i < chats.length; i++) {
      if (chats[i].isGroup && chats[i].name && chats[i].name.toLowerCase().includes(name.toLowerCase())) {
        console.log("Grupo encontrado: " + chats[i].name + " (" + chats[i].id._serialized + ")");
        return chats[i].id._serialized;
      }
    }
  } catch (err) {
    console.error("Erro ao buscar grupo:", err.message);
  }
  return null;
}

async function doHandoff(phone, conv, leadData) {
  var handoffName = process.env.HANDOFF_NAME || "nosso time comercial";
  var notifyNumber = process.env.HANDOFF_NOTIFY_NUMBER;
  var groupName = process.env.HANDOFF_GROUP_NAME || "LEADS";

  markHandedOff(conv, leadData);
  saveConversation(phone, conv);

  // NAO envia mensagem ao lead aqui — a resposta da IA ja inclui a despedida

  var ts = new Date().toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
  io.emit("log", {
    type: "handoff",
    text: "[" + ts + "] 🔔 HANDOFF: " + phone.replace("@c.us", "") + " - " + (leadData.handoffReason || "qualificado") + " - " + (leadData.name || "sem nome"),
  });

  var teamMsg = HANDOFF_MESSAGE_TO_TEAM(Object.assign({}, leadData, { phone: phone, contactNumber: leadData.contactNumber || conv.contactNumber || null }));

  // Envia para o grupo de leads
  try {
    var groupId = process.env.HANDOFF_GROUP_ID;
    if (!groupId) {
      groupId = await findGroupByName(groupName);
    }
    if (groupId) {
      await wpp.sendMessage(groupId, teamMsg);
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
      await wpp.sendMessage(notifyNumber, teamMsg);
    } catch (err) {
      console.error("Erro ao notificar:", err.message);
    }
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
  startWhatsApp();

  // Agenda relatorios diarios no grupo
  var cachedGroupId = null;
  startScheduledReports(
    function() { return wpp; },
    async function(wppInstance) {
      if (cachedGroupId) return cachedGroupId;
      var groupName = process.env.HANDOFF_GROUP_NAME || "LEADS";
      var groupId = process.env.HANDOFF_GROUP_ID;
      if (!groupId) {
        groupId = await findGroupByName(groupName);
      }
      if (groupId) cachedGroupId = groupId;
      return groupId;
    },
    io
  );
});

process.on("SIGINT", async function() {
  console.log("\nEncerrando...");
  if (wpp) { try { await wpp.destroy(); } catch (e) {} }
  process.exit(0);
});
