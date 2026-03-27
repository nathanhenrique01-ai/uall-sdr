// reports.js — Relatorios diarios automaticos

import cron from "node-cron";
import fs from "fs";
import path from "path";
import OpenAI from "openai";
import { loadAllConversations as loadAllConvsFromDb } from "./memory.js";

var openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

async function getLast24hData() {
  var now = new Date();
  var cutoff = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  var all = await loadAllConvsFromDb();

  var total24h = 0;
  var qualified = 0;
  var active = 0;
  var paused = 0;
  var handedOff = 0;
  var totalMessages = 0;
  var botMessages = 0;
  var leadMessages = 0;
  var humanMessages = 0;
  var temperatures = { Quente: 0, Morno: 0, Frio: 0 };
  var interests = {};
  var segments = {};
  var leadDetails = [];

  for (var i = 0; i < all.length; i++) {
    var conv = all[i];
    var convDate = new Date(conv.updatedAt || conv.createdAt);

    // Conta conversas ativas nas ultimas 24h
    if (convDate >= cutoff) {
      total24h++;

      // Conta mensagens das ultimas 24h
      for (var j = 0; j < conv.messages.length; j++) {
        var msg = conv.messages[j];
        var msgDate = new Date(msg.timestamp);
        if (msgDate >= cutoff) {
          totalMessages++;
          if (msg.role === "agent") botMessages++;
          else if (msg.role === "lead") leadMessages++;
          else if (msg.role === "human") humanMessages++;
        }
      }

      if (conv.temperature && temperatures[conv.temperature] !== undefined) {
        temperatures[conv.temperature]++;
      }
      if (conv.interest || conv.pain) {
        var int = conv.interest || conv.pain;
        interests[int] = (interests[int] || 0) + 1;
      }
      if (conv.company || conv.segment) {
        var seg = conv.company || conv.segment;
        segments[seg] = (segments[seg] || 0) + 1;
      }

      leadDetails.push({
        name: conv.name || "Sem nome",
        phone: conv.phone,
        company: conv.company || conv.segment || "N/I",
        status: conv.status,
        temperature: conv.temperature || "N/A",
        interest: conv.interest || conv.pain || "N/I",
        exchanges: conv.agentExchanges || 0,
        scheduling: conv.scheduling || null,
      });
    }

    // Contadores gerais
    if (conv.status === "active") active++;
    else if (conv.status === "paused") paused++;
    else if (conv.status === "handed_off") handedOff++;
  }

  qualified = handedOff;

  return {
    total24h: total24h,
    totalAll: all.length,
    qualified: qualified,
    active: active,
    paused: paused,
    handedOff: handedOff,
    totalMessages: totalMessages,
    botMessages: botMessages,
    leadMessages: leadMessages,
    humanMessages: humanMessages,
    temperatures: temperatures,
    interests: interests,
    segments: segments,
    leadDetails: leadDetails,
  };
}

async function buildDailyReport() {
  var d = await getLast24hData();
  var now = new Date();
  var dateStr = now.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric" });

  var report = "📊 *RELATÓRIO DIÁRIO - U-ALL SDR AGENT*\n";
  report += "📅 " + dateStr + " — Últimas 24 horas\n";
  report += "━━━━━━━━━━━━━━━━━━━━━━\n\n";

  report += "📈 *RESUMO GERAL*\n";
  report += "• Leads ativos nas últimas 24h: *" + d.total24h + "*\n";
  report += "• Total de leads na base: *" + d.totalAll + "*\n";
  report += "• Transferidos para comercial: *" + d.handedOff + "*\n";
  report += "• Bot ativo: *" + d.active + "*\n";
  report += "• Humano respondendo: *" + d.paused + "*\n\n";

  report += "💬 *MENSAGENS (24h)*\n";
  report += "• Total: *" + d.totalMessages + "*\n";
  report += "• Do lead: *" + d.leadMessages + "*\n";
  report += "• Do bot: *" + d.botMessages + "*\n";
  report += "• Do humano: *" + d.humanMessages + "*\n\n";

  if (d.total24h > 0) {
    report += "🌡️ *TEMPERATURA DOS LEADS*\n";
    report += "• 🔴 Quente: *" + d.temperatures.Quente + "*\n";
    report += "• 🟡 Morno: *" + d.temperatures.Morno + "*\n";
    report += "• 🔵 Frio: *" + d.temperatures.Frio + "*\n\n";

    var intKeys = Object.keys(d.interests);
    if (intKeys.length > 0) {
      report += "🎯 *INTERESSES*\n";
      for (var i = 0; i < intKeys.length; i++) {
        report += "• " + intKeys[i] + ": *" + d.interests[intKeys[i]] + "*\n";
      }
      report += "\n";
    }

    var segKeys = Object.keys(d.segments);
    if (segKeys.length > 0) {
      report += "🏢 *EMPRESAS/SEGMENTOS*\n";
      for (var j = 0; j < segKeys.length; j++) {
        report += "• " + segKeys[j] + ": *" + d.segments[segKeys[j]] + "*\n";
      }
      report += "\n";
    }

    report += "👥 *DETALHES DOS LEADS (24h)*\n";
    for (var k = 0; k < d.leadDetails.length; k++) {
      var l = d.leadDetails[k];
      var statusEmoji = l.status === "handed_off" ? "✅" : (l.status === "paused" ? "⏸" : "🤖");
      report += statusEmoji + " " + l.name + " — " + l.company + " — " + l.temperature;
      if (l.scheduling) report += " — 📅 " + l.scheduling;
      report += "\n";
    }
  } else {
    report += "ℹ️ Nenhuma atividade nas últimas 24 horas.\n";
  }

  report += "\n━━━━━━━━━━━━━━━━━━━━━━\n";
  report += "🤖 _Relatório gerado automaticamente pelo U-All SDR Agent_";

  return report;
}

async function buildImprovementReport() {
  var d = await getLast24hData();
  var all = await loadAllConvsFromDb();
  var now = new Date();
  var cutoff = new Date(now.getTime() - 24 * 60 * 60 * 1000);

  // Coleta conversas recentes para analise
  var recentConvSummaries = [];
  for (var i = 0; i < all.length; i++) {
    var conv = all[i];
    var convDate = new Date(conv.updatedAt || conv.createdAt);
    if (convDate < cutoff) continue;

    var msgs = conv.messages.slice(-10).map(function(m) {
      return m.role + ": " + m.content;
    }).join("\n");

    recentConvSummaries.push(
      "Lead: " + (conv.name || "Sem nome") + " | Status: " + conv.status +
      " | Trocas: " + (conv.agentExchanges || 0) + " | Temp: " + (conv.temperature || "N/A") +
      "\n" + msgs
    );
  }

  if (recentConvSummaries.length === 0) {
    return "📋 *ANÁLISE DE MELHORIAS - U-ALL SDR AGENT*\n\nℹ️ Sem conversas nas últimas 24h para analisar.\n\n🤖 _Gerado automaticamente_";
  }

  var prompt = [
    "Voce e um analista de vendas da U-All Solutions. Analise as conversas do SDR bot das ultimas 24 horas e gere um relatorio CURTO e PRATICO de melhorias.",
    "",
    "DADOS DO DIA:",
    "- Total de leads: " + d.total24h,
    "- Transferidos: " + d.handedOff,
    "- Bot ativo: " + d.active,
    "- Mensagens totais: " + d.totalMessages,
    "- Taxa de conversao (transferidos/total): " + (d.total24h > 0 ? Math.round(d.handedOff / d.total24h * 100) : 0) + "%",
    "",
    "CONVERSAS RECENTES:",
    recentConvSummaries.join("\n---\n"),
    "",
    "Gere o relatorio em formato WhatsApp (use *negrito* e emojis) com:",
    "1. O QUE FUNCIONOU BEM (maximo 3 pontos)",
    "2. O QUE PRECISA MELHORAR (maximo 3 pontos com sugestoes concretas)",
    "3. SUGESTAO DO DIA (1 acao pratica para o time implementar)",
    "",
    "Seja direto, pratico e especifico. Maximo 20 linhas.",
  ].join("\n");

  try {
    var completion = await openai.chat.completions.create({
      model: process.env.OPENAI_MODEL || "gpt-4o-mini",
      max_tokens: 600,
      messages: [
        { role: "system", content: prompt },
        { role: "user", content: "Gere o relatorio de melhorias para hoje." },
      ],
    });

    var analysis = completion.choices[0].message.content.trim();

    var dateStr = now.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric" });
    return "📋 *ANÁLISE DE MELHORIAS - U-ALL SDR AGENT*\n" +
      "📅 " + dateStr + "\n" +
      "━━━━━━━━━━━━━━━━━━━━━━\n\n" +
      analysis + "\n\n" +
      "━━━━━━━━━━━━━━━━━━━━━━\n" +
      "🤖 _Análise gerada por IA — U-All SDR Agent_";
  } catch (err) {
    console.error("Erro ao gerar analise de melhorias:", err.message);
    return "📋 *ANÁLISE DE MELHORIAS*\n\n⚠️ Erro ao gerar análise: " + err.message + "\n\n🤖 _U-All SDR Agent_";
  }
}

export function startScheduledReports(wppGetter, routeResolver, ioRef) {
  // Relatorio diario as 14:00
  cron.schedule("0 14 * * *", async function() {
    console.log("Gerando relatorio diario das 14h...");
    var ts = new Date().toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
    try {
      var wpp = wppGetter();
      if (!wpp) {
        console.error("WhatsApp nao conectado, relatorio nao enviado");
        ioRef.emit("log", { type: "error", text: "[" + ts + "] Relatorio 14h: WhatsApp desconectado" });
        return;
      }

      var resolvedDailyRoute = await routeResolver("daily_report", wpp);
      if (!resolvedDailyRoute || !resolvedDailyRoute.targetId) {
        ioRef.emit("log", { type: "error", text: "[" + ts + "] Relatorio 14h: configure um grupo no painel" });
        return;
      }

      var report = await buildDailyReport();
      await wpp.sendMessage(resolvedDailyRoute.targetId, report);
      ioRef.emit("log", { type: "info", text: "[" + ts + "] ✅ Relatório diário enviado para o grupo" });
      console.log("Relatorio diario enviado!");
    } catch (err) {
      console.error("Erro ao enviar relatorio:", err.message);
      ioRef.emit("log", { type: "error", text: "[" + ts + "] Erro relatorio 14h: " + err.message });
    }
  }, { timezone: "America/Sao_Paulo" });

  // Analise de melhorias as 17:00
  cron.schedule("0 17 * * *", async function() {
    console.log("Gerando analise de melhorias das 17h...");
    var ts = new Date().toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
    try {
      var wpp = wppGetter();
      if (!wpp) {
        console.error("WhatsApp nao conectado, analise nao enviada");
        ioRef.emit("log", { type: "error", text: "[" + ts + "] Analise 17h: WhatsApp desconectado" });
        return;
      }

      var resolvedImprovementRoute = await routeResolver("improvement_report", wpp);
      if (!resolvedImprovementRoute || !resolvedImprovementRoute.targetId) {
        ioRef.emit("log", { type: "error", text: "[" + ts + "] Analise 17h: configure um grupo no painel" });
        return;
      }

      var report = await buildImprovementReport();
      await wpp.sendMessage(resolvedImprovementRoute.targetId, report);
      ioRef.emit("log", { type: "info", text: "[" + ts + "] ✅ Análise de melhorias enviada para o grupo" });
      console.log("Analise de melhorias enviada!");
    } catch (err) {
      console.error("Erro ao enviar analise:", err.message);
      ioRef.emit("log", { type: "error", text: "[" + ts + "] Erro analise 17h: " + err.message });
    }
  }, { timezone: "America/Sao_Paulo" });

  // Alerta a cada 1h: conversas com 20+ min sem retorno do lead
  cron.schedule("0 * * * *", async function() {
    var ts = new Date().toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
    try {
      var wpp = wppGetter();
      if (!wpp) return;

      var resolvedAlertRoute = await routeResolver("inactive_leads_alert", wpp);
      if (!resolvedAlertRoute || !resolvedAlertRoute.targetId) return;

      var all = await loadAllConvsFromDb();
      var now = Date.now();
      var inactivityMinutes = resolvedAlertRoute.route && resolvedAlertRoute.route.thresholdMinutes ? resolvedAlertRoute.route.thresholdMinutes : 20;
      var inactivityMs = inactivityMinutes * 60 * 1000;
      var staleLeads = [];

      for (var i = 0; i < all.length; i++) {
        var conv = all[i];
        if (conv.status !== "active" || !conv.botActive) continue;
        if (!conv.messages || conv.messages.length === 0) continue;

        var lastMsg = conv.messages[conv.messages.length - 1];
        var lastTime = new Date(lastMsg.timestamp).getTime();
        var minInactive = Math.round((now - lastTime) / 60000);

        // Se a ultima msg foi do bot e faz mais que o limite configurado
        if (lastMsg.role === "agent" && (now - lastTime) > inactivityMs) {
          var contactNum = conv.contactNumber || conv.phone;
          var displayNum = String(contactNum).replace(/[^0-9]/g, "");
          if (displayNum.length >= 12 && displayNum.startsWith("55")) {
            var ddd = displayNum.substring(2, 4);
            var num = displayNum.substring(4);
            displayNum = "(" + ddd + ") " + num.replace(/(\d{4,5})(\d{4})$/, "$1-$2");
          }
          staleLeads.push({
            name: conv.name || "Sem nome",
            phone: displayNum,
            minutes: minInactive,
          });
        }
      }

      if (staleLeads.length > 0) {
        var msg = "⏰ *ALERTA - CONVERSAS SEM RETORNO*\n\n";
        msg += "Os seguintes leads nao responderam ha mais de " + inactivityMinutes + " minutos:\n\n";
        for (var j = 0; j < staleLeads.length; j++) {
          var s = staleLeads[j];
          msg += "• " + s.name + " (" + s.phone + ") — " + s.minutes + " min sem resposta\n";
        }
        msg += "\n⚡ _Considere enviar uma mensagem manual para reengajar!_";

        await wpp.sendMessage(resolvedAlertRoute.targetId, msg);
        ioRef.emit("log", { type: "info", text: "[" + ts + "] ⏰ Alerta de inatividade enviado (" + staleLeads.length + " leads)" });
      }
    } catch (err) {
      console.error("Erro alerta inatividade:", err.message);
    }
  }, { timezone: "America/Sao_Paulo" });

  console.log("📊 Relatorios agendados: 14:00 (diario) e 17:00 (melhorias) e a cada 1h (alertas) — Horario de Brasilia");
}
