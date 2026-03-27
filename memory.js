// memory.js — Armazenamento de conversas com suporte a takeover

import fs from "fs";
import path from "path";

var DATA_DIR = path.join(process.cwd(), "data", "conversations");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function sanitize(phone) {
  return phone.replace(/[^0-9]/g, "");
}
function fp(phone) {
  return path.join(DATA_DIR, sanitize(phone) + ".json");
}

export function loadConversation(phone) {
  var p = fp(phone);
  if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, "utf-8"));
  return {
    phone: sanitize(phone),
    contactNumber: null,    // numero real do contato (via getContact)
    name: null, company: null, segment: null,
    pain: null, size: null, temperature: null,
    summary: null, infra: null, interest: null, scheduling: null,
    status: "active",       // active | paused | handed_off
    botActive: true,        // true = bot responde | false = humano assumiu
    agentExchanges: 0,      // contador de respostas do bot
    messages: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    handedOffAt: null,
    pausedAt: null,
  };
}

export function saveConversation(phone, conv) {
  conv.updatedAt = new Date().toISOString();
  fs.writeFileSync(fp(phone), JSON.stringify(conv, null, 2), "utf-8");
}

export function addMessage(conv, role, content) {
  conv.messages.push({ role: role, content: content, timestamp: new Date().toISOString() });
  return conv;
}

export function toOpenAIMessages(conv, systemPrompt, max) {
  max = max || 30;
  var recent = conv.messages.slice(-max);
  var msgs = [{ role: "system", content: systemPrompt }];
  for (var i = 0; i < recent.length; i++) {
    var r = recent[i].role;
    // lead = user, agent e human = assistant (pra IA a resposta do humano parece dela)
    msgs.push({
      role: (r === "lead") ? "user" : "assistant",
      content: recent[i].content,
    });
  }
  return msgs;
}

export function markHandedOff(conv, data) {
  conv.status = "handed_off";
  conv.botActive = false;
  conv.handedOffAt = new Date().toISOString();
  var keys = ["name","company","segment","pain","size","temperature","summary","infra","interest","scheduling"];
  for (var i = 0; i < keys.length; i++) {
    if (data[keys[i]]) conv[keys[i]] = data[keys[i]];
  }
  return conv;
}

// Pausa o bot (humano assume)
export function pauseBot(phone) {
  var conv = loadConversation(phone);
  conv.botActive = false;
  conv.status = "paused";
  conv.pausedAt = new Date().toISOString();
  saveConversation(phone, conv);
  return conv;
}

// Reativa o bot
export function resumeBot(phone) {
  var conv = loadConversation(phone);
  conv.botActive = true;
  conv.status = "active";
  conv.pausedAt = null;
  saveConversation(phone, conv);
  return conv;
}

export function listAllLeads() {
  if (!fs.existsSync(DATA_DIR)) return [];
  var files = fs.readdirSync(DATA_DIR).filter(function(f) { return f.endsWith(".json"); });
  return files.map(function(f) {
    var conv = JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), "utf-8"));
    return {
      phone: conv.phone, contactNumber: conv.contactNumber || null,
      name: conv.name, company: conv.company,
      segment: conv.segment, pain: conv.pain, temperature: conv.temperature,
      status: conv.status, botActive: conv.botActive,
      totalMessages: conv.messages.length,
      agentExchanges: conv.agentExchanges || 0,
      lastMessage: conv.messages.length > 0 ? conv.messages[conv.messages.length - 1].content : "",
      updatedAt: conv.updatedAt, createdAt: conv.createdAt,
    };
  });
}

export function getConversation(phone) {
  return loadConversation(phone);
}
