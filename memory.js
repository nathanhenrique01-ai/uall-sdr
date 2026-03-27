// memory.js — Armazenamento em MariaDB

import { getPool, getOrCreateSession, getSessionMessages, addSessionMessage } from "./db.js";

function sanitize(phone) {
  return phone.replace(/[^0-9a-zA-Z@._-]/g, "");
}

function newConversation(phone) {
  return {
    phone: sanitize(phone),
    contactNumber: null,
    currentSessionId: null,
    name: null,
    email: null,
    company: null,
    segment: null,
    pain: null,
    size: null,
    temperature: null,
    summary: null,
    infra: null,
    interest: null,
    scheduling: null,
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

function rowToConv(row, messages) {
  return {
    phone: row.phone,
    contactNumber: row.contact_number,
    name: row.name,
    email: row.email,
    company: row.company,
    segment: row.segment,
    pain: row.pain,
    size: row.size,
    temperature: row.temperature,
    summary: row.summary,
    infra: row.infra,
    interest: row.interest,
    scheduling: row.scheduling,
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

function isoToMysqlDatetime(isoString) {
  if (!isoString) return null;
  try {
    var date = new Date(isoString);
    var year = date.getUTCFullYear();
    var month = String(date.getUTCMonth() + 1).padStart(2, "0");
    var day = String(date.getUTCDate()).padStart(2, "0");
    var hours = String(date.getUTCHours()).padStart(2, "0");
    var minutes = String(date.getUTCMinutes()).padStart(2, "0");
    var seconds = String(date.getUTCSeconds()).padStart(2, "0");
    return year + "-" + month + "-" + day + " " + hours + ":" + minutes + ":" + seconds;
  } catch (e) {
    return null;
  }
}

export async function loadConversation(phone) {
  var conn;
  try {
    var pool = getPool();
    conn = await pool.getConnection();
    var sPhone = sanitize(phone);

    var rows = await conn.query("SELECT * FROM leads WHERE phone = ?", [sPhone]);
    if (rows.length === 0) {
      return newConversation(phone);
    }

    var lead = rows[0];
    var session = await getOrCreateSession(lead.id);
    var messages = await getSessionMessages(session.id);
    var conv = rowToConv(lead, messages);
    conv.currentSessionId = session.id;
    return conv;
  } catch (err) {
    console.error("DB loadConversation error:", err.message);
    return newConversation(phone);
  } finally {
    if (conn) conn.release();
  }
}

export async function saveConversation(phone, conv) {
  conv.updatedAt = new Date().toISOString();

  var conn;
  try {
    var pool = getPool();
    conn = await pool.getConnection();
    var sPhone = sanitize(phone);

    await conn.query(`
      INSERT INTO leads (
        phone, contact_number, name, email, company, segment, pain, size,
        temperature, summary, infra, interest, scheduling, status,
        bot_active, agent_exchanges, created_at, updated_at, handed_off_at, paused_at
      )
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
      isoToMysqlDatetime(conv.createdAt) || new Date().toISOString().slice(0, 19).replace("T", " "),
      conv.handedOffAt ? isoToMysqlDatetime(conv.handedOffAt) : null,
      conv.pausedAt ? isoToMysqlDatetime(conv.pausedAt) : null,
    ]);
  } catch (err) {
    console.error("DB saveConversation error:", err.message);
  } finally {
    if (conn) conn.release();
  }
}

export async function addMessage(conv, role, content) {
  var timestamp = new Date().toISOString();
  conv.messages.push({ role: role, content: content, timestamp: timestamp });

  if (conv.currentSessionId) {
    try {
      await addSessionMessage(conv.currentSessionId, role, content);
    } catch (e) {
      console.error("Erro ao adicionar msg na sessao:", e.message);
    }
  }

  return conv;
}

export function toOpenAIMessages(conv, systemPrompt, max) {
  max = max || 50;
  var recent = conv.messages.slice(-max);
  var msgs = [{ role: "system", content: systemPrompt }];
  for (var i = 0; i < recent.length; i++) {
    var r = recent[i].role;
    msgs.push({
      role: r === "lead" ? "user" : "assistant",
      content: recent[i].content,
    });
  }
  return msgs;
}

export function markHandedOff(conv, data) {
  conv.status = "handed_off";
  conv.botActive = false;
  conv.handedOffAt = new Date().toISOString();
  var keys = ["name", "email", "company", "segment", "pain", "size", "temperature", "summary", "infra", "interest", "scheduling"];
  for (var i = 0; i < keys.length; i++) {
    if (data[keys[i]]) conv[keys[i]] = data[keys[i]];
  }
  return conv;
}

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

export async function listAllLeads() {
  var conn;
  try {
    var pool = getPool();
    conn = await pool.getConnection();

    var rows = await conn.query(`
      SELECT l.*,
        (SELECT COUNT(*) FROM messages WHERE lead_id = l.id OR session_id IN (SELECT id FROM sessions WHERE lead_id = l.id)) as total_messages,
        (
          SELECT m.content
          FROM messages m
          LEFT JOIN sessions s ON s.id = m.session_id
          WHERE m.lead_id = l.id OR s.lead_id = l.id
          ORDER BY m.created_at DESC
          LIMIT 1
        ) as last_message
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
    console.error("DB listAllLeads error:", err.message);
    return [];
  } finally {
    if (conn) conn.release();
  }
}

export async function getConversation(phone) {
  return await loadConversation(phone);
}

export async function loadAllConversations() {
  var conn;
  try {
    var pool = getPool();
    conn = await pool.getConnection();

    var leads = await conn.query("SELECT * FROM leads ORDER BY updated_at DESC");
    var result = [];

    for (var i = 0; i < leads.length; i++) {
      var lead = leads[i];
      var sessions = await conn.query(
        "SELECT id FROM sessions WHERE lead_id = ? ORDER BY started_at ASC",
        [lead.id]
      );

      var sessionIds = sessions.map(function(session) { return session.id; });
      var msgs = [];

      if (sessionIds.length > 0) {
        var placeholders = sessionIds.map(function() { return "?"; }).join(",");
        msgs = await conn.query(
          "SELECT role, content, created_at FROM messages WHERE lead_id = ? OR session_id IN (" + placeholders + ") ORDER BY created_at ASC",
          [lead.id].concat(sessionIds)
        );
      } else {
        msgs = await conn.query(
          "SELECT role, content, created_at FROM messages WHERE lead_id = ? ORDER BY created_at ASC",
          [lead.id]
        );
      }

      var messages = msgs.map(function(m) {
        return { role: m.role, content: m.content, timestamp: new Date(m.created_at).toISOString() };
      });

      result.push(rowToConv(lead, messages));
    }

    return result;
  } catch (err) {
    console.error("DB loadAllConversations error:", err.message);
    return [];
  } finally {
    if (conn) conn.release();
  }
}
