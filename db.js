// db.js — Conexao MariaDB + schema auto-provisioning

import * as mariadb from "mariadb";

var pool = null;

export function getPool() {
  if (!pool) {
    pool = mariadb.createPool({
      host: process.env.DB_HOST || "localhost",
      port: parseInt(process.env.DB_PORT || "3306"),
      user: process.env.DB_USER || "root",
      password: process.env.DB_PASS || "root",
      database: process.env.DB_NAME || "uall_sdr",
      connectionLimit: 10,
      charset: "utf8mb4",
    });
  }
  return pool;
}

export async function initDb() {
  // Primeiro cria o banco se nao existir (conecta sem especificar database)
  var tempPool = null;
  try {
    tempPool = mariadb.createPool({
      host: process.env.DB_HOST || "localhost",
      port: parseInt(process.env.DB_PORT || "3306"),
      user: process.env.DB_USER || "root",
      password: process.env.DB_PASS || "root",
      connectionLimit: 1,
    });
    var tempConn = await tempPool.getConnection();
    var dbName = process.env.DB_NAME || "uall_sdr";
    await tempConn.query("CREATE DATABASE IF NOT EXISTS `" + dbName + "` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci");
    tempConn.release();
    await tempPool.end();
  } catch (e) {
    console.error("⚠️ Nao foi possivel criar o banco:", e.message);
    if (tempPool) try { await tempPool.end(); } catch (x) {}
  }

  var p = getPool();
  var conn;
  try {
    conn = await p.getConnection();

    await conn.query(`
      CREATE TABLE IF NOT EXISTS leads (
        id              INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        phone           VARCHAR(50)  NOT NULL UNIQUE,
        contact_number  VARCHAR(30)  DEFAULT NULL,
        name            VARCHAR(255) DEFAULT NULL,
        email           VARCHAR(255) DEFAULT NULL,
        company         VARCHAR(255) DEFAULT NULL,
        segment         VARCHAR(255) DEFAULT NULL,
        pain            TEXT         DEFAULT NULL,
        size            VARCHAR(100) DEFAULT NULL,
        temperature     VARCHAR(50)  DEFAULT NULL,
        summary         TEXT         DEFAULT NULL,
        infra           TEXT         DEFAULT NULL,
        interest        TEXT         DEFAULT NULL,
        scheduling      TEXT         DEFAULT NULL,
        status          ENUM('active','paused','handed_off') NOT NULL DEFAULT 'active',
        bot_active      TINYINT(1)   NOT NULL DEFAULT 1,
        agent_exchanges INT UNSIGNED NOT NULL DEFAULT 0,
        created_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        handed_off_at   DATETIME     DEFAULT NULL,
        paused_at       DATETIME     DEFAULT NULL,
        INDEX idx_status (status),
        INDEX idx_updated (updated_at),
        INDEX idx_temperature (temperature)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    await conn.query(`
      CREATE TABLE IF NOT EXISTS messages (
        id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        lead_id     INT UNSIGNED    NOT NULL,
        role        ENUM('lead','agent','human') NOT NULL,
        content     TEXT            NOT NULL,
        created_at  DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_lead_created (lead_id, created_at),
        CONSTRAINT fk_messages_lead FOREIGN KEY (lead_id)
          REFERENCES leads(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    await conn.query(`
      CREATE TABLE IF NOT EXISTS whatsapp_session (
        id              INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        session_key     VARCHAR(255)  NOT NULL UNIQUE,
        session_data    LONGTEXT      NOT NULL,
        phone_number    VARCHAR(30)   DEFAULT NULL,
        created_at      DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at      DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_phone (phone_number)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    await conn.query(`
      CREATE TABLE IF NOT EXISTS account_info (
        id              INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        account_name    VARCHAR(255)  DEFAULT NULL,
        account_phone   VARCHAR(30)   DEFAULT NULL,
        qr_code_data    LONGTEXT      DEFAULT NULL,
        session_status  ENUM('disconnected','authenticating','ready','error') DEFAULT 'disconnected',
        last_qr_at      DATETIME      DEFAULT NULL,
        created_at      DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at      DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    await conn.query(`
      CREATE TABLE IF NOT EXISTS sessions (
        id              INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        lead_id         INT UNSIGNED    NOT NULL,
        session_number  INT UNSIGNED    NOT NULL DEFAULT 1,
        started_at      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
        expires_at      DATETIME        NOT NULL,
        status          ENUM('active','expired','closed') DEFAULT 'active',
        INDEX idx_lead_active (lead_id, status),
        INDEX idx_expires (expires_at),
        CONSTRAINT fk_sessions_lead FOREIGN KEY (lead_id)
          REFERENCES leads(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    // Adiciona coluna session_id na tabela messages se nao existir
    try {
      await conn.query("ALTER TABLE messages ADD COLUMN session_id INT UNSIGNED");
    } catch (e) {
      // Coluna pode ja existir
    }

    try {
      await conn.query("ALTER TABLE messages ADD CONSTRAINT fk_messages_session FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE SET NULL");
    } catch (e) {
      // Constraint pode ja existir
    }

    console.log("✅ MariaDB conectado — banco uall_sdr pronto");
  } catch (err) {
    console.error("⚠️ MariaDB indisponivel:", err.message);
    console.log("   O sistema vai funcionar com arquivos JSON como fallback.");
  } finally {
    if (conn) conn.release();
  }
}

// ── SESSION DATA ──

export async function saveSessionData(sessionKey, sessionData, phoneNumber) {
  var conn;
  try {
    var p = getPool();
    conn = await p.getConnection();
    await conn.query(`
      INSERT INTO whatsapp_session (session_key, session_data, phone_number)
      VALUES (?, ?, ?)
      ON DUPLICATE KEY UPDATE
        session_data = VALUES(session_data),
        phone_number = VALUES(phone_number),
        updated_at = NOW()
    `, [sessionKey, JSON.stringify(sessionData), phoneNumber]);
  } catch (err) {
    console.error("⚠️ saveSessionData error:", err.message);
  } finally {
    if (conn) conn.release();
  }
}

export async function getSessionData(sessionKey) {
  var conn;
  try {
    var p = getPool();
    conn = await p.getConnection();
    var rows = await conn.query("SELECT session_data FROM whatsapp_session WHERE session_key = ?", [sessionKey]);
    if (rows.length > 0) {
      try {
        return JSON.parse(rows[0].session_data);
      } catch (e) {
        return rows[0].session_data;
      }
    }
  } catch (err) {
    console.error("⚠️ getSessionData error:", err.message);
  } finally {
    if (conn) conn.release();
  }
  return null;
}

// ── ACCOUNT INFO ──

export async function updateAccountInfo(accountData) {
  var conn;
  try {
    var p = getPool();
    conn = await p.getConnection();
    var rows = await conn.query("SELECT id FROM account_info LIMIT 1");
    if (rows.length > 0) {
      // Update existing
      await conn.query(`
        UPDATE account_info SET
          account_name = ?,
          account_phone = ?,
          qr_code_data = ?,
          session_status = ?,
          last_qr_at = CASE WHEN ? IS NOT NULL THEN NOW() ELSE last_qr_at END
        WHERE id = ?
      `, [
        accountData.name || null,
        accountData.phone || null,
        accountData.qrCode || null,
        accountData.status || 'disconnected',
        accountData.qrCode ? 1 : null,
        rows[0].id
      ]);
    } else {
      // Insert new
      await conn.query(`
        INSERT INTO account_info (account_name, account_phone, qr_code_data, session_status, last_qr_at)
        VALUES (?, ?, ?, ?, CASE WHEN ? IS NOT NULL THEN NOW() ELSE NULL END)
      `, [
        accountData.name || null,
        accountData.phone || null,
        accountData.qrCode || null,
        accountData.status || 'disconnected',
        accountData.qrCode ? 1 : null
      ]);
    }
  } catch (err) {
    console.error("⚠️ updateAccountInfo error:", err.message);
  } finally {
    if (conn) conn.release();
  }
}

export async function getAccountInfo() {
  var conn;
  try {
    var p = getPool();
    conn = await p.getConnection();
    var rows = await conn.query("SELECT * FROM account_info LIMIT 1");
    if (rows.length > 0) {
      return {
        id: rows[0].id,
        name: rows[0].account_name,
        phone: rows[0].account_phone,
        qrCode: rows[0].qr_code_data,
        status: rows[0].session_status,
        lastQrAt: rows[0].last_qr_at
      };
    }
  } catch (err) {
    console.error("⚠️ getAccountInfo error:", err.message);
  } finally {
    if (conn) conn.release();
  }
  return null;
}

// ── SESSIONS (24h) ──

export async function getOrCreateSession(leadId, sessionDurationMs) {
  var conn;
  try {
    sessionDurationMs = sessionDurationMs || 24 * 60 * 60 * 1000; // 24h default
    var p = getPool();
    conn = await p.getConnection();

    // Busca sessao ativa
    var rows = await conn.query(
      "SELECT * FROM sessions WHERE lead_id = ? AND status = 'active' AND expires_at > NOW() ORDER BY started_at DESC LIMIT 1",
      [leadId]
    );

    if (rows.length > 0) {
      return rows[0];
    }

    // Marca sessoes expiradas
    await conn.query(
      "UPDATE sessions SET status = 'expired' WHERE lead_id = ? AND expires_at <= NOW() AND status = 'active'",
      [leadId]
    );

    // Conta quantas sessoes ja existem (numero da sessao)
    var countRows = await conn.query("SELECT COUNT(*) as cnt FROM sessions WHERE lead_id = ?", [leadId]);
    var sessionNumber = (countRows[0].cnt || 0) + 1;

    // Cria nova sessao
    var expiresAt = new Date(Date.now() + sessionDurationMs).toISOString().slice(0, 19).replace('T', ' ');
    var result = await conn.query(
      "INSERT INTO sessions (lead_id, session_number, expires_at) VALUES (?, ?, ?)",
      [leadId, sessionNumber, expiresAt]
    );

    return {
      id: result.insertId,
      lead_id: leadId,
      session_number: sessionNumber,
      started_at: new Date().toISOString(),
      expires_at: expiresAt,
      status: 'active'
    };
  } catch (err) {
    console.error("⚠️ getOrCreateSession error:", err.message);
    throw err;
  } finally {
    if (conn) conn.release();
  }
}

export async function getSessionMessages(sessionId) {
  var conn;
  try {
    var p = getPool();
    conn = await p.getConnection();
    var rows = await conn.query(
      "SELECT role, content, created_at FROM messages WHERE session_id = ? ORDER BY created_at ASC",
      [sessionId]
    );
    return rows.map(function(m) {
      return { role: m.role, content: m.content, timestamp: new Date(m.created_at).toISOString() };
    });
  } catch (err) {
    console.error("⚠️ getSessionMessages error:", err.message);
    return [];
  } finally {
    if (conn) conn.release();
  }
}

export async function addSessionMessage(sessionId, role, content) {
  var conn;
  try {
    var p = getPool();
    conn = await p.getConnection();
    var msgTimestamp = new Date().toISOString().slice(0, 19).replace('T', ' ');
    await conn.query(
      "INSERT INTO messages (session_id, role, content, created_at) VALUES (?, ?, ?, ?)",
      [sessionId, role, content, msgTimestamp]
    );
  } catch (err) {
    console.error("⚠️ addSessionMessage error:", err.message);
  } finally {
    if (conn) conn.release();
  }
}

export async function closeDb() {
  if (pool) {
    try { await pool.end(); } catch (e) {}
    pool = null;
  }
}
