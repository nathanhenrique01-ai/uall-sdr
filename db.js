// db.js — Conexao MariaDB + schema auto-provisioning

import * as mariadb from "mariadb";

var pool = null;

function normalizePhoneNumber(phone) {
  if (!phone) return null;
  var digits = String(phone).replace(/[^0-9]/g, "");
  return digits || null;
}

function normalizeSessionKey(sessionKey) {
  var key = sessionKey ? String(sessionKey).trim() : "";
  return key || "default";
}

function sanitizeAiDocuments(documents) {
  if (!Array.isArray(documents)) return [];

  return documents
    .slice(0, 50)
    .map(function(doc) {
      return {
        title: doc && doc.title ? String(doc.title).trim().slice(0, 255) : "",
        type: doc && doc.type ? String(doc.type).trim().slice(0, 100) : "texto",
        source: doc && doc.source ? String(doc.source).trim().slice(0, 255) : "",
        content: doc && doc.content ? String(doc.content).trim() : "",
      };
    })
    .filter(function(doc) {
      return doc.title || doc.content || doc.source;
    });
}

function parseAiDocuments(rawValue) {
  if (!rawValue) return [];
  try {
    return sanitizeAiDocuments(JSON.parse(rawValue));
  } catch (e) {
    return [];
  }
}

function emptyAiContextProfile(accountPhone, sessionKey) {
  return {
    accountPhone: normalizePhoneNumber(accountPhone),
    sessionKey: normalizeSessionKey(sessionKey),
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
    createdAt: null,
    updatedAt: null,
  };
}

function rowToAiContextProfile(row) {
  if (!row) return null;
  return {
    id: row.id,
    accountPhone: row.account_phone,
    sessionKey: row.session_key,
    profileName: row.profile_name,
    attendantName: row.attendant_name,
    companyName: row.company_name,
    companyDescription: row.company_description,
    aiName: row.ai_name,
    aiRole: row.ai_role,
    toneOfVoice: row.tone_of_voice,
    behaviorGuidelines: row.behavior_guidelines,
    objectives: row.objectives,
    audienceProfile: row.audience_profile,
    forbiddenTopics: row.forbidden_topics,
    salesScript: row.sales_script,
    knowledgeBase: row.knowledge_base,
    documents: parseAiDocuments(row.documents_json),
    isActive: row.is_active === 1 || row.is_active === true,
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
    updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null,
  };
}

function defaultNotificationRoutes(accountPhone) {
  return [
    {
      accountPhone: normalizePhoneNumber(accountPhone),
      routeKey: "handoff_leads",
      routeLabel: "Leads qualificados",
      targetKind: "group",
      targetId: null,
      targetName: null,
      isEnabled: true,
      thresholdMinutes: null,
    },
    {
      accountPhone: normalizePhoneNumber(accountPhone),
      routeKey: "daily_report",
      routeLabel: "Relatorio diario",
      targetKind: "group",
      targetId: null,
      targetName: null,
      isEnabled: true,
      thresholdMinutes: null,
    },
    {
      accountPhone: normalizePhoneNumber(accountPhone),
      routeKey: "improvement_report",
      routeLabel: "Analise de melhorias",
      targetKind: "group",
      targetId: null,
      targetName: null,
      isEnabled: true,
      thresholdMinutes: null,
    },
    {
      accountPhone: normalizePhoneNumber(accountPhone),
      routeKey: "inactive_leads_alert",
      routeLabel: "Alertas criticos",
      targetKind: "group",
      targetId: null,
      targetName: null,
      isEnabled: true,
      thresholdMinutes: 20,
    },
  ];
}

function mergeNotificationRoutes(rows, accountPhone) {
  var defaults = defaultNotificationRoutes(accountPhone);
  var merged = [];

  for (var i = 0; i < defaults.length; i++) {
    var baseRoute = defaults[i];
    var dbRoute = null;

    for (var j = 0; j < rows.length; j++) {
      if (rows[j].route_key === baseRoute.routeKey) {
        dbRoute = rows[j];
        break;
      }
    }

    merged.push({
      accountPhone: normalizePhoneNumber(accountPhone),
      routeKey: baseRoute.routeKey,
      routeLabel: dbRoute && dbRoute.route_label ? dbRoute.route_label : baseRoute.routeLabel,
      targetKind: dbRoute && dbRoute.target_kind ? dbRoute.target_kind : baseRoute.targetKind,
      targetId: dbRoute ? dbRoute.target_id : baseRoute.targetId,
      targetName: dbRoute ? dbRoute.target_name : baseRoute.targetName,
      isEnabled: dbRoute ? (dbRoute.is_enabled === 1 || dbRoute.is_enabled === true) : baseRoute.isEnabled,
      thresholdMinutes: dbRoute && dbRoute.threshold_minutes !== null ? Number(dbRoute.threshold_minutes) : baseRoute.thresholdMinutes,
    });
  }

  return merged;
}

function sanitizeNotificationRouteInput(route, baseRoute, accountPhone) {
  var targetKind = route && route.targetKind === "contact" ? "contact" : "group";
  var targetId = route && route.targetId ? String(route.targetId).trim().slice(0, 255) : null;
  var targetName = route && route.targetName ? String(route.targetName).trim().slice(0, 255) : null;
  var thresholdMinutes = baseRoute.thresholdMinutes;

  if (route && route.thresholdMinutes !== undefined && route.thresholdMinutes !== null && route.thresholdMinutes !== "") {
    var parsedThreshold = parseInt(route.thresholdMinutes, 10);
    thresholdMinutes = Number.isFinite(parsedThreshold) && parsedThreshold > 0 ? parsedThreshold : baseRoute.thresholdMinutes;
  }

  return {
    accountPhone: normalizePhoneNumber(accountPhone),
    routeKey: baseRoute.routeKey,
    routeLabel: route && route.routeLabel ? String(route.routeLabel).trim().slice(0, 255) : baseRoute.routeLabel,
    targetKind: targetKind,
    targetId: targetId,
    targetName: targetName,
    isEnabled: !(route && route.isEnabled === false),
    thresholdMinutes: thresholdMinutes,
  };
}

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
      CREATE TABLE IF NOT EXISTS whatsapp_auth_sessions (
        session_name    VARCHAR(255)  NOT NULL PRIMARY KEY,
        session_zip     LONGBLOB      NOT NULL,
        phone_number    VARCHAR(30)   DEFAULT NULL,
        created_at      DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at      DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_auth_phone (phone_number)
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

    await conn.query(`
      CREATE TABLE IF NOT EXISTS ai_context_profiles (
        id                   INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        account_phone        VARCHAR(30)   NOT NULL,
        session_key          VARCHAR(255)  NOT NULL DEFAULT 'default',
        profile_name         VARCHAR(255)  DEFAULT NULL,
        attendant_name       VARCHAR(255)  DEFAULT NULL,
        company_name         VARCHAR(255)  DEFAULT NULL,
        company_description  TEXT          DEFAULT NULL,
        ai_name              VARCHAR(255)  DEFAULT NULL,
        ai_role              VARCHAR(255)  DEFAULT NULL,
        tone_of_voice        TEXT          DEFAULT NULL,
        behavior_guidelines  LONGTEXT      DEFAULT NULL,
        objectives           LONGTEXT      DEFAULT NULL,
        audience_profile     TEXT          DEFAULT NULL,
        forbidden_topics     TEXT          DEFAULT NULL,
        sales_script         LONGTEXT      DEFAULT NULL,
        knowledge_base       LONGTEXT      DEFAULT NULL,
        documents_json       LONGTEXT      DEFAULT NULL,
        is_active            TINYINT(1)    NOT NULL DEFAULT 1,
        created_at           DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at           DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uq_ai_context_phone_session (account_phone, session_key),
        INDEX idx_ai_context_phone (account_phone),
        INDEX idx_ai_context_active (is_active)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    await conn.query(`
      CREATE TABLE IF NOT EXISTS notification_routes (
        id                 INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        account_phone      VARCHAR(30)   NOT NULL,
        route_key          VARCHAR(100)  NOT NULL,
        route_label        VARCHAR(255)  NOT NULL,
        target_kind        ENUM('group','contact') NOT NULL DEFAULT 'group',
        target_id          VARCHAR(255)  DEFAULT NULL,
        target_name        VARCHAR(255)  DEFAULT NULL,
        is_enabled         TINYINT(1)    NOT NULL DEFAULT 1,
        threshold_minutes  INT UNSIGNED  DEFAULT NULL,
        created_at         DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at         DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uq_notification_route (account_phone, route_key),
        INDEX idx_notification_phone (account_phone)
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

    // Torna lead_id nullable pois agora usamos session_id
    try {
      await conn.query("ALTER TABLE messages MODIFY COLUMN lead_id INT UNSIGNED NULL");
    } catch (e) {
      // Pode ja estar nullable
    }

    await conn.query(`
      CREATE TABLE IF NOT EXISTS logs (
        id              BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        timestamp       DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
        type            VARCHAR(50)     NOT NULL,
        phone           VARCHAR(50)     DEFAULT NULL,
        text            TEXT            NOT NULL,
        INDEX idx_timestamp (timestamp),
        INDEX idx_type (type),
        INDEX idx_phone (phone)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

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

export async function getNotificationRoutes(accountPhone) {
  var normalizedPhone = normalizePhoneNumber(accountPhone);
  var conn;

  if (!normalizedPhone) {
    return defaultNotificationRoutes(null);
  }

  try {
    var p = getPool();
    conn = await p.getConnection();
    var rows = await conn.query(
      "SELECT * FROM notification_routes WHERE account_phone = ? ORDER BY route_key ASC",
      [normalizedPhone]
    );
    return mergeNotificationRoutes(rows, normalizedPhone);
  } catch (err) {
    console.error("⚠️ getNotificationRoutes error:", err.message);
    return defaultNotificationRoutes(normalizedPhone);
  } finally {
    if (conn) conn.release();
  }
}

export async function getNotificationRoute(accountPhone, routeKey) {
  var routes = await getNotificationRoutes(accountPhone);
  for (var i = 0; i < routes.length; i++) {
    if (routes[i].routeKey === routeKey) {
      return routes[i];
    }
  }
  return null;
}

export async function saveNotificationRoutes(accountPhone, routes) {
  var normalizedPhone = normalizePhoneNumber(accountPhone);
  var conn;
  var defaults;

  if (!normalizedPhone) {
    throw new Error("Numero da conta conectada nao encontrado para vincular os grupos e avisos.");
  }

  defaults = defaultNotificationRoutes(normalizedPhone);
  routes = Array.isArray(routes) ? routes : [];

  try {
    var p = getPool();
    conn = await p.getConnection();

    for (var i = 0; i < defaults.length; i++) {
      var baseRoute = defaults[i];
      var incomingRoute = null;

      for (var j = 0; j < routes.length; j++) {
        if (routes[j] && routes[j].routeKey === baseRoute.routeKey) {
          incomingRoute = routes[j];
          break;
        }
      }

      var sanitizedRoute = sanitizeNotificationRouteInput(incomingRoute, baseRoute, normalizedPhone);

      await conn.query(`
        INSERT INTO notification_routes (
          account_phone, route_key, route_label, target_kind,
          target_id, target_name, is_enabled, threshold_minutes
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
          route_label = VALUES(route_label),
          target_kind = VALUES(target_kind),
          target_id = VALUES(target_id),
          target_name = VALUES(target_name),
          is_enabled = VALUES(is_enabled),
          threshold_minutes = VALUES(threshold_minutes),
          updated_at = NOW()
      `, [
        normalizedPhone,
        sanitizedRoute.routeKey,
        sanitizedRoute.routeLabel,
        sanitizedRoute.targetKind,
        sanitizedRoute.targetId,
        sanitizedRoute.targetName,
        sanitizedRoute.isEnabled ? 1 : 0,
        sanitizedRoute.thresholdMinutes,
      ]);
    }
  } catch (err) {
    console.error("⚠️ saveNotificationRoutes error:", err.message);
    throw err;
  } finally {
    if (conn) conn.release();
  }

  return await getNotificationRoutes(normalizedPhone);
}

export async function hasRemoteAuthSession(sessionName) {
  var conn;
  try {
    var p = getPool();
    conn = await p.getConnection();
    var rows = await conn.query(
      "SELECT session_name FROM whatsapp_auth_sessions WHERE session_name = ? LIMIT 1",
      [sessionName]
    );
    return rows.length > 0;
  } catch (err) {
    console.error("âš ï¸ hasRemoteAuthSession error:", err.message);
    return false;
  } finally {
    if (conn) conn.release();
  }
}

export async function getRemoteAuthSession(sessionName) {
  var conn;
  try {
    var p = getPool();
    conn = await p.getConnection();
    var rows = await conn.query(
      "SELECT session_zip, phone_number FROM whatsapp_auth_sessions WHERE session_name = ? LIMIT 1",
      [sessionName]
    );
    if (rows.length > 0) {
      return {
        sessionZip: rows[0].session_zip,
        phoneNumber: rows[0].phone_number,
      };
    }
  } catch (err) {
    console.error("âš ï¸ getRemoteAuthSession error:", err.message);
  } finally {
    if (conn) conn.release();
  }
  return null;
}

export async function saveRemoteAuthSession(sessionName, sessionZip, phoneNumber) {
  var conn;
  try {
    var p = getPool();
    conn = await p.getConnection();
    await conn.query(`
      INSERT INTO whatsapp_auth_sessions (session_name, session_zip, phone_number)
      VALUES (?, ?, ?)
      ON DUPLICATE KEY UPDATE
        session_zip = VALUES(session_zip),
        phone_number = VALUES(phone_number),
        updated_at = NOW()
    `, [
      sessionName,
      sessionZip,
      normalizePhoneNumber(phoneNumber),
    ]);
  } catch (err) {
    console.error("âš ï¸ saveRemoteAuthSession error:", err.message);
    throw err;
  } finally {
    if (conn) conn.release();
  }
}

export async function deleteRemoteAuthSession(sessionName) {
  var conn;
  try {
    var p = getPool();
    conn = await p.getConnection();
    await conn.query("DELETE FROM whatsapp_auth_sessions WHERE session_name = ?", [sessionName]);
  } catch (err) {
    console.error("âš ï¸ deleteRemoteAuthSession error:", err.message);
    throw err;
  } finally {
    if (conn) conn.release();
  }
}

export async function getAiContextProfile(accountPhone, sessionKey) {
  var normalizedPhone = normalizePhoneNumber(accountPhone);
  var normalizedSessionKey = normalizeSessionKey(sessionKey);
  var conn;

  if (!normalizedPhone) {
    return emptyAiContextProfile(null, normalizedSessionKey);
  }

  try {
    var p = getPool();
    conn = await p.getConnection();
    var rows = await conn.query(
      "SELECT * FROM ai_context_profiles WHERE account_phone = ? AND session_key = ? LIMIT 1",
      [normalizedPhone, normalizedSessionKey]
    );

    if (rows.length > 0) {
      return rowToAiContextProfile(rows[0]);
    }
  } catch (err) {
    console.error("âš ï¸ getAiContextProfile error:", err.message);
  } finally {
    if (conn) conn.release();
  }

  return emptyAiContextProfile(normalizedPhone, normalizedSessionKey);
}

export async function getActiveAiContextProfile() {
  try {
    var accountInfo = await getAccountInfo();
    var accountPhone = normalizePhoneNumber(accountInfo && accountInfo.phone);
    if (!accountPhone) return null;
    return await getAiContextProfile(accountPhone, "default");
  } catch (err) {
    console.error("âš ï¸ getActiveAiContextProfile error:", err.message);
    return null;
  }
}

export async function saveAiContextProfile(profileData) {
  var normalizedPhone = normalizePhoneNumber(profileData && profileData.accountPhone);
  var normalizedSessionKey = normalizeSessionKey(profileData && profileData.sessionKey);
  var conn;

  if (!normalizedPhone) {
    throw new Error("Numero da conta conectada nao encontrado para vincular o contexto da IA.");
  }

  var documents = sanitizeAiDocuments(profileData && profileData.documents);

  try {
    var p = getPool();
    conn = await p.getConnection();

    await conn.query(`
      INSERT INTO ai_context_profiles (
        account_phone, session_key, profile_name, attendant_name, company_name,
        company_description, ai_name, ai_role, tone_of_voice, behavior_guidelines,
        objectives, audience_profile, forbidden_topics, sales_script,
        knowledge_base, documents_json, is_active
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        profile_name = VALUES(profile_name),
        attendant_name = VALUES(attendant_name),
        company_name = VALUES(company_name),
        company_description = VALUES(company_description),
        ai_name = VALUES(ai_name),
        ai_role = VALUES(ai_role),
        tone_of_voice = VALUES(tone_of_voice),
        behavior_guidelines = VALUES(behavior_guidelines),
        objectives = VALUES(objectives),
        audience_profile = VALUES(audience_profile),
        forbidden_topics = VALUES(forbidden_topics),
        sales_script = VALUES(sales_script),
        knowledge_base = VALUES(knowledge_base),
        documents_json = VALUES(documents_json),
        is_active = VALUES(is_active),
        updated_at = NOW()
    `, [
      normalizedPhone,
      normalizedSessionKey,
      profileData.profileName || null,
      profileData.attendantName || null,
      profileData.companyName || null,
      profileData.companyDescription || null,
      profileData.aiName || null,
      profileData.aiRole || null,
      profileData.toneOfVoice || null,
      profileData.behaviorGuidelines || null,
      profileData.objectives || null,
      profileData.audienceProfile || null,
      profileData.forbiddenTopics || null,
      profileData.salesScript || null,
      profileData.knowledgeBase || null,
      JSON.stringify(documents),
      profileData.isActive === false ? 0 : 1,
    ]);
  } catch (err) {
    console.error("âš ï¸ saveAiContextProfile error:", err.message);
    throw err;
  } finally {
    if (conn) conn.release();
  }

  return await getAiContextProfile(normalizedPhone, normalizedSessionKey);
}

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

// ── LOGS ──

export async function saveLog(type, text, phone) {
  var conn;
  try {
    var p = getPool();
    conn = await p.getConnection();
    await conn.query(
      "INSERT INTO logs (type, text, phone) VALUES (?, ?, ?)",
      [type, text, phone || null]
    );
  } catch (err) {
    // Silencia erros de log para não poluir console
  } finally {
    if (conn) conn.release();
  }
}

export async function getLogs(limit, type, phone) {
  var conn;
  try {
    limit = limit || 100;
    var p = getPool();
    conn = await p.getConnection();

    var query = "SELECT * FROM logs WHERE 1=1";
    var params = [];

    if (type) {
      query += " AND type = ?";
      params.push(type);
    }
    if (phone) {
      query += " AND phone = ?";
      params.push(phone);
    }

    query += " ORDER BY timestamp DESC LIMIT ?";
    params.push(limit);

    var rows = await conn.query(query, params);
    return rows.map(function(r) {
      return {
        id: r.id,
        timestamp: new Date(r.timestamp).toISOString(),
        type: r.type,
        phone: r.phone,
        text: r.text
      };
    });
  } catch (err) {
    console.error("⚠️ getLogs error:", err.message);
    return [];
  } finally {
    if (conn) conn.release();
  }
}

// ── MULTIPLE ACCOUNTS ──

export async function getAllAccounts() {
  var conn;
  try {
    var p = getPool();
    conn = await p.getConnection();
    var rows = await conn.query("SELECT * FROM account_info ORDER BY created_at DESC");
    return rows.map(function(row) {
      return {
        id: row.id,
        name: row.account_name,
        phone: row.account_phone,
        qrCode: row.qr_code_data,
        status: row.session_status,
        lastQrAt: row.last_qr_at,
        createdAt: row.created_at,
        updatedAt: row.updated_at
      };
    });
  } catch (err) {
    console.error("⚠️ getAllAccounts error:", err.message);
    return [];
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
