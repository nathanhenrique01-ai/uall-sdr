// agent.js — Integracao com OpenAI (ChatGPT)

import OpenAI from "openai";
import { SYSTEM_PROMPT, AGENT_CONFIG } from "./config.js";
import { toOpenAIMessages } from "./memory.js";
import { getActiveAiContextProfile } from "./db.js";

var client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

export async function generateResponse(conversation) {
  var systemPrompt = await buildSystemPrompt();
  var messages = toOpenAIMessages(
    conversation,
    systemPrompt,
    AGENT_CONFIG.maxHistoryMessages
  );

  try {
    var completion = await client.chat.completions.create({
      model: process.env.OPENAI_MODEL || "gpt-4o-mini",
      max_tokens: AGENT_CONFIG.maxTokens,
      messages: messages,
    });

    var full = completion.choices[0].message.content.trim();
    return parseAgentResponse(full);
  } catch (error) {
    console.error("Erro OpenAI API:", error.message);
    return {
      response: "Desculpe, tive um problema tecnico momentaneo. Pode repetir sua mensagem?",
      qualified: false,
      handoff: false,
      leadData: null,
    };
  }
}

async function buildSystemPrompt() {
  try {
    var profile = await getActiveAiContextProfile();
    if (!hasCustomContext(profile)) {
      return SYSTEM_PROMPT;
    }

    return SYSTEM_PROMPT + "\n\n" + buildProfilePrompt(profile);
  } catch (error) {
    console.error("Erro ao montar prompt customizado:", error.message);
    return SYSTEM_PROMPT;
  }
}

function hasCustomContext(profile) {
  if (!profile || profile.isActive === false) return false;
  return Boolean(
    profile.attendantName ||
    profile.aiRole ||
    (profile.documents && profile.documents.length)
  );
}

function limitPromptText(text, maxChars) {
  if (!text) return "";
  var normalized = String(text).trim();
  if (!normalized) return "";
  if (normalized.length <= maxChars) return normalized;
  return normalized.slice(0, maxChars) + "\n[conteudo truncado para caber no contexto da IA]";
}

function buildProfilePrompt(profile) {
  var lines = [
    "## CONTEXTO CUSTOMIZADO DA SESSAO WHATSAPP CONECTADA",
    "As instrucoes abaixo vieram do painel da sessao conectada.",
    "Siga esse contexto como prioridade sem inventar fatos.",
  ];

  if (profile.attendantName) lines.push("- Nome do atendente que a IA deve representar: " + profile.attendantName);
  if (profile.aiRole) {
    lines.push("");
    lines.push("### O QUE A IA FAZ NESTA SESSAO");
    lines.push(limitPromptText(profile.aiRole, 300));
    lines.push("");
    lines.push(buildRoleInstructions(profile.aiRole));
  }

  if (profile.documents && profile.documents.length > 0) {
    lines.push("");
    lines.push("### DOCUMENTOS E TEXTOS DE REFERENCIA");
    for (var i = 0; i < profile.documents.length && i < 8; i++) {
      var doc = profile.documents[i];
      var title = doc.title || ("Documento " + (i + 1));
      lines.push("");
      lines.push("Documento " + (i + 1) + ": " + title);
      if (doc.type) lines.push("Tipo: " + doc.type);
      if (doc.source) lines.push("Fonte: " + doc.source);
      lines.push(limitPromptText(doc.content, 2500));
    }
  }

  return lines.join("\n");
}

function buildRoleInstructions(aiRole) {
  var normalizedRole = String(aiRole || "").trim().toLowerCase();

  if (!normalizedRole) {
    return "Atue como atendimento inicial: entenda a necessidade, colete dados basicos e encaminhe quando fizer sentido.";
  }

  if (
    normalizedRole.includes("vendedor") ||
    normalizedRole.includes("comercial") ||
    normalizedRole.includes("sdr") ||
    normalizedRole.includes("lead") ||
    normalizedRole.includes("pré-venda") ||
    normalizedRole.includes("pre-venda")
  ) {
    return [
      "Aja como atendimento comercial.",
      "Seu foco e entender a necessidade, qualificar o contato e preparar o repasse.",
      "Sempre que fizer sentido, tente obter nome, empresa, email, necessidade principal e melhor proximo passo.",
      "Quando houver dados suficientes para o time seguir, use [QUALIFIED] e [HANDOFF].",
    ].join(" ");
  }

  if (normalizedRole.includes("suporte")) {
    return [
      "Aja como assistente de suporte.",
      "Seu foco e entender o problema, contexto, impacto e urgencia.",
      "Sempre que fizer sentido, colete nome, empresa, descricao do problema, tentativas feitas e prioridade.",
      "Se depender de equipe humana, use [HANDOFF] com um resumo claro.",
    ].join(" ");
  }

  if (
    normalizedRole.includes("atendimento") ||
    normalizedRole.includes("recepc") ||
    normalizedRole.includes("triagem") ||
    normalizedRole.includes("assistente")
  ) {
    return [
      "Aja como atendimento inicial e triagem.",
      "Entenda rapidamente o motivo do contato e direcione a conversa para o fluxo certo.",
      "Colete os dados minimos necessarios antes de repassar.",
    ].join(" ");
  }

  return "Atue exatamente conforme esse papel configurado. Entenda a demanda, colete os dados necessarios e prepare o repasse quando preciso.";
}

function parseAgentResponse(full) {
  var response = full;
  var qualified = false;
  var handoff = false;
  var leadData = null;

  // Extrai dados simples durante conversa ([EXTRACTED_DATA])
  var em = response.match(/\[EXTRACTED_DATA\]([\s\S]*?)(?=\[QUALIFIED\]|\[HANDOFF\]|$)/);
  if (em) {
    leadData = parseLeadData(em[1]);
    response = response.replace(/\[EXTRACTED_DATA\][\s\S]*?(?=\[QUALIFIED\]|\[HANDOFF\]|$)/, "");
  }

  var qm = response.match(/\[QUALIFIED\]([\s\S]*?)(?=\[HANDOFF\]|$)/);
  if (qm) {
    qualified = true;
    var qualData = parseLeadData(qm[1]);
    leadData = Object.assign({}, leadData, qualData);  // merge com dados extraidos
    response = response.replace(/\[QUALIFIED\][\s\S]*?(?=\[HANDOFF\]|$)/, "");
  }

  var hm = response.match(/\[HANDOFF\]([\s\S]*?)$/);
  if (hm) {
    handoff = true;
    if (!leadData) leadData = {};
    var motivo = hm[1].match(/Motivo:\s*(.+)/);
    if (motivo) leadData.handoffReason = motivo[1].trim();
    response = response.replace(/\[HANDOFF\][\s\S]*$/, "");
  }

  return { response: response.trim(), qualified: qualified, handoff: handoff, leadData: leadData };
}

function parseLeadData(block) {
  var data = {};
  var fields = {
    "Nome": "name",
    "Email": "email",
    "E-mail": "email",
    "Contato": "contact",
    "Empresa": "company",
    "Segmento": "segment",
    "Infra": "infra",
    "Infraestrutura": "infra",
    "Interesse": "interest",
    "Agendamento": "scheduling",
    "Resumo": "summary",
    "Temperatura": "temperature",
    "Dor": "pain",
    "Porte": "size",
  };
  var labels = Object.keys(fields);
  for (var i = 0; i < labels.length; i++) {
    var m = block.match(new RegExp(labels[i] + ":\\s*(.+)", "i"));
    if (m) data[fields[labels[i]]] = m[1].trim();
  }
  // Mapeia interest pra pain se pain nao veio
  if (data.interest && !data.pain) data.pain = data.interest;
  return data;
}

export function checkHumanRequest(msg) {
  var lower = msg.toLowerCase();
  for (var i = 0; i < AGENT_CONFIG.humanRequestKeywords.length; i++) {
    if (lower.includes(AGENT_CONFIG.humanRequestKeywords[i])) return true;
  }
  return false;
}
