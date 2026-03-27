// agent.js — Integracao com OpenAI (ChatGPT)

import OpenAI from "openai";
import { SYSTEM_PROMPT, AGENT_CONFIG } from "./config.js";
import { toOpenAIMessages } from "./memory.js";

var client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

export async function generateResponse(conversation) {
  var messages = toOpenAIMessages(
    conversation,
    SYSTEM_PROMPT,
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
