// memory.js — Armazenamento em MariaDB (principal) + JSON (fallback)

import fs from "fs";
import path from "path";
import { getPool, getOrCreateSession, getSessionMessages, addSessionMessage } from "./db.js";

var DATA_DIR = path.join(process.cwd(), "data", "conversations");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function sanitize(phone) {
  return phone.replace(/[^0-9a-zA-Z@._-]/g, "");
}
function fp(phone) {
  return path.join(DATA_DIR, sanitize(phone).replace(/[^0-9]/g, "") + ".json");
}

function newConversation(phone) {
  return {
    phone: sanitize(phone),
    contactNumber: null,
    currentSessionId: null,  // ID da sessao ativa
    name: null, email: null, company: null, segment: null,
    pain: null, size: null, temperature: null,
    summary: null, infra: null, interest: null, scheduling: null,
    status: "active",
    botActive: true,
    agentExchanges: 0,
    messages: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    handedOffAt: null,
    pausedAt: null,
  };
}

// ── Helpers DB ──

async function getLeadIdByPhone(conn, phone) {
  var rows = await conn.query("SELECT id FROM leads WHERE phone = ?", [sanitize(phone)]);
  return rows.length > 0 ? rows[0].id : null;
}

function rowToConv(row, messages) {
  return {
    phone: row.phone,
    contactNumber: row.contact_number,
    name: row.name, email: row.email, company: row.company, segment: row.segment,
    pain: row.pain, size: row.size, temperature: row.temperature,
    summary: row.summary, infra: row.infra, interest: row.interest, scheduling: row.scheduling,
    status: row.status,
    botActive: row.bot_active === 1 || row.bot_active === true,
    agentExchanges: row.agent_exchanges || 0,
    messages: messages || [],
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : new Date().toISOString(),
    updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : new Date().toISOString(),
    handedOffAt: row.handed_off_at ? new Date(row.handed_off_at).toISOString() : null,
    pausedAt: row.paused_at ? new Date(row.paused_at).toISOString() : null,
  };
}

// ── JSON Fallback ──

function loadFromJson(phone) {
  var p = fp(phone);
  if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, "utf-8"));
  return null;
}

function saveToJson(phone, conv) {
  try {
    fs.writeFileSync(fp(phone), JSON.stringify(conv, null, 2), "utf-8");
  } catch (e) {}
}

// ── LOAD ──

export async function loadConversation(phone) {
  var conn;
  try {
    var pool = getPool();
    conn = await pool.getConnection();
    var sPhone = sanitize(phone);

    var rows = await conn.query("SELECT * FROM leads WHERE phone = ?", [sPhone]);
    if (rows.length === 0) {
      // Tenta carregar do JSON (migracao)
      var jsonConv = loadFromJson(phone);
      if (jsonConv) return jsonConv;
      return newConversation(phone);
    }

    var lead = rows[0];

    // Busca sessao ativa (ou cria nova)
    var session = await getOrCreateSession(lead.id);

    // Carrega apenas mensagens da sessao ativa
    var messages = await getSessionMessages(session.id);

    var conv = rowToConv(lead, messages);
    conv.currentSessionId = session.id;
    return conv;
  } catch (err) {
    console.error("⚠️ DB loadConversation fallback JSON:", err.message);
    var jsonConv = loadFromJson(phone);
    if (jsonConv) return jsonConv;
    return newConversation(phone);
  } finally {
    if (conn) conn.release();
  }
}

// ── HELPERS ──

function isoToMysqlDatetime(isoString) {
  if (!isoString) return null;
  try {
    var date = new Date(isoString);
    var year = date.getUTCFullYear();
    var month = String(date.getUTCMonth() + 1).padStart(2, '0');
    var day = String(date.getUTCDate()).padStart(2, '0');
    var hours = String(date.getUTCHours()).padStart(2, '0');
    var minutes = String(date.getUTCMinutes()).padStart(2, '0');
    var seconds = String(date.getUTCSeconds()).padStart(2, '0');
    return year + '-' + month + '-' + day + ' ' + hours + ':' + minutes + ':' + seconds;
  } catch (e) {
    return null;
  }
}

// ── SAVE ──

export async function saveConversation(phone, conv) {
  conv.updatedAt = new Date().toISOString();
  saveToJson(phone, conv); // sempre salva JSON como backup

  var conn;
  try {
    var pool = getPool();
    conn = await pool.getConnection();
    var sPhone = sanitize(phone);

    // Upsert lead
    await conn.query(`
      INSERT INTO leads (phone, contact_number, name, email, company, segment, pain, size, temperature, summary, infra, interest, scheduling, status, bot_active, agent_exchanges, created_at, updated_at, handed_off_at, paused_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), ?, ?)
      ON DUPLICATE KEY UPDATE
        contact_number = VALUES(contact_number),
        name = VALUES(name),
        email = VALUES(email),
        company = VALUES(company),
        segment = VALUES(segment),
        pain = VALUES(pain),
        size = VALUES(size),
        temperature = VALUES(temperature),
        summary = VALUES(summary),
        infra = VALUES(infra),
        interest = VALUES(interest),
        scheduling = VALUES(scheduling),
        status = VALUES(status),
        bot_active = VALUES(bot_active),
        agent_exchanges = VALUES(agent_exchanges),
        updated_at = NOW(),
        handed_off_at = VALUES(handed_off_at),
        paused_at = VALUES(paused_at)
    `, [
      sPhone,
      conv.contactNumber || null,
      conv.name || null,
      conv.email || null,
      conv.company || null,
      conv.segment || null,
      conv.pain || null,
      conv.size || null,
      conv.temperature || null,
      conv.summary || null,
      conv.infra || null,
      conv.interest || null,
      conv.scheduling || null,
      conv.status || "active",
      conv.botActive ? 1 : 0,
      conv.agentExchanges || 0,
      isoToMysqlDatetime(conv.createdAt) || new Date().toISOString().slice(0, 19).replace('T', ' '),
      conv.handedOffAt ? isoToMysqlDatetime(conv.handedOffAt) : null,
      conv.pausedAt ? isoToMysqlDatetime(conv.pausedAt) : null,
    ]);

    // Mensagens agora sao inseridas via addMessage/addSessionMessage
    // (nao precisam ser inseridas aqui no saveConversation)
  } catch (err) {
    console.error("⚠️ DB saveConversation error:", err.message);
  } finally {
    if (conn) conn.release();
  }
}

// ── ADD MESSAGE (in-memory + DB session) ──

export async function addMessage(conv, role, content) {
  var timestamp = new Date().toISOString();
  conv.messages.push({ role: role, content: content, timestamp: timestamp });

  // Salva no banco da sessao se tiver sessionId
  if (conv.currentSessionId) {
    try {
      await addSessionMessage(conv.currentSessionId, role, content);
    } catch (e) {
      console.error("Erro ao adicionar msg na sessao:", e.message);
    }
  }

  return conv;
}

// ── OPENAI MESSAGES ──

export function toOpenAIMessages(conv, systemPrompt, max) {
  max = max || 50;
  var recent = conv.messages.slice(-max);
  var msgs = [{ role: "system", content: systemPrompt }];
  for (var i = 0; i < recent.length; i++) {
    var r = recent[i].role;
    msgs.push({
      role: (r === "lead") ? "user" : "assistant",
      content: recent[i].content,
    });
  }
  return msgs;
}

// ── MARK HANDED OFF ──

export function markHandedOff(conv, data) {
  conv.status = "handed_off";
  conv.botActive = false;
  conv.handedOffAt = new Date().toISOString();
  var keys = ["name","email","company","segment","pain","size","temperature","summary","infra","interest","scheduling"];
  for (var i = 0; i < keys.length; i++) {
    if (data[keys[i]]) conv[keys[i]] = data[keys[i]];
  }
  return conv;
}

// ── PAUSE / RESUME ──

export async function pauseBot(phone) {
  var conv = await loadConversation(phone);
  conv.botActive = false;
  conv.status = "paused";
  conv.pausedAt = new Date().toISOString();
  await saveConversation(phone, conv);
  return conv;
}

export async function resumeBot(phone) {
  var conv = await loadConversation(phone);
  conv.botActive = true;
  conv.status = "active";
  conv.pausedAt = null;
  await saveConversation(phone, conv);
  return conv;
}

// ── LIST ALL LEADS ──

export async function listAllLeads() {
  var conn;
  try {
    var pool = getPool();
    conn = await pool.getConnection();

    var rows = await conn.query(`
      SELECT l.*,
        (SELECT COUNT(*) FROM messages WHERE lead_id = l.id) as total_messages,
        (SELECT content FROM messages WHERE lead_id = l.id ORDER BY created_at DESC LIMIT 1) as last_message
      FROM leads l
      ORDER BY l.updated_at DESC
    `);

    return rows.map(function(r) {
      return {
        phone: r.phone,
        contactNumber: r.contact_number,
        name: r.name,
        email: r.email,
        company: r.company,
        segment: r.segment,
        pain: r.pain,
        temperature: r.temperature,
        status: r.status,
        botActive: r.bot_active === 1 || r.bot_active === true,
        totalMessages: Number(r.total_messages) || 0,
        agentExchanges: r.agent_exchanges || 0,
        lastMessage: r.last_message || "",
        updatedAt: r.updated_at ? new Date(r.updated_at).toISOString() : null,
        createdAt: r.created_at ? new Date(r.created_at).toISOString() : null,
      };
    });
  } catch (err) {
    console.error("⚠️ DB listAllLeads fallback JSON:", err.message);
    // Fallback: le dos arquivos JSON
    if (!fs.existsSync(DATA_DIR)) return [];
    var files = fs.readdirSync(DATA_DIR).filter(function(f) { return f.endsWith(".json"); });
    return files.map(function(f) {
      var conv = JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), "utf-8"));
      return {
        phone: conv.phone, contactNumber: conv.contactNumber || null,
        name: conv.name, email: conv.email, company: conv.company,
        segment: conv.segment, pain: conv.pain, temperature: conv.temperature,
        status: conv.status, botActive: conv.botActive,
        totalMessages: conv.messages.length,
        agentExchanges: conv.agentExchanges || 0,
        lastMessage: conv.messages.length > 0 ? conv.messages[conv.messages.length - 1].content : "",
        updatedAt: conv.updatedAt, createdAt: conv.createdAt,
      };
    });
  } finally {
    if (conn) conn.release();
  }
}

// ── GET CONVERSATION (alias) ──

export async function getConversation(phone) {
  return await loadConversation(phone);
}

// ── LOAD ALL CONVERSATIONS (para reports.js) ──

export async function loadAllConversations() {
  var conn;
  try {
    var pool = getPool();
    conn = await pool.getConnection();

    var leads = await conn.query("SELECT * FROM leads ORDER BY updated_at DESC");
    var result = [];
    for (var i = 0; i < leads.length; i++) {
      var lead = leads[i];
      var msgs = await conn.query(
        "SELECT role, content, created_at FROM messages WHERE lead_id = ? ORDER BY created_at ASC",
        [lead.id]
      );
      var messages = msgs.map(function(m) {
        return { role: m.role, content: m.content, timestamp: new Date(m.created_at).toISOString() };
      });
      result.push(rowToConv(lead, messages));
    }
    return result;
  } catch (err) {
    console.error("⚠️ DB loadAllConversations fallback JSON:", err.message);
    if (!fs.existsSync(DATA_DIR)) return [];
    var files = fs.readdirSync(DATA_DIR).filter(function(f) { return f.endsWith(".json"); });
    return files.map(function(f) {
      return JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), "utf-8"));
    });
  } finally {
    if (conn) conn.release();
  }
}
