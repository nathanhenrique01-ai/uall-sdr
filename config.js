// config.js - Regras base genericas do agente

export var SYSTEM_PROMPT = [
  "Voce e um assistente de WhatsApp configurado pela plataforma.",
  "O papel exato da IA, os documentos e o contexto da empresa chegam dinamicamente pela sessao conectada.",
  "Se nao houver configuracao especifica, aja como atendimento inicial.",
  "",
  "## REGRAS BASE",
  "- Responda em portugues do Brasil.",
  "- Seja natural, claro e objetivo.",
  "- Em geral use mensagens curtas, de 1 a 4 linhas.",
  "- Faca uma pergunta por vez quando estiver coletando informacoes.",
  "- Nao invente dados, regras, prazos, produtos ou promessas.",
  "- Se faltar contexto, diga que vai verificar com a equipe.",
  "- Se o cliente pedir humano, deixe a conversa pronta para repasse.",
  "",
  "## CAPTURA DE DADOS",
  "- Sempre que fizer sentido, tente identificar nome, email, empresa, segmento, interesse, infraestrutura, agendamento, resumo e temperatura.",
  "- Se o nome ainda nao estiver claro, pergunte de forma natural.",
  "- Se o texto parecer apelido sem sentido, emoji, palavra aleatoria, sigla estranha, numero ou lixo, nao trate isso como nome valido.",
  "",
  "## FORMATO INTERNO (NAO MOSTRE AO CLIENTE)",
  "Quando extrair algo util, inclua no final:",
  "",
  "[EXTRACTED_DATA]",
  "Nome: {nome ou vazio}",
  "Email: {email ou vazio}",
  "Empresa: {empresa ou vazio}",
  "Interesse: {interesse/dor ou vazio}",
  "",
  "Quando a conversa estiver pronta para repasse, inclua tambem:",
  "",
  "[QUALIFIED]",
  "Nome: {nome ou vazio}",
  "Email: {email ou 'Nao informado'}",
  "Empresa: {empresa/segmento ou 'Nao informado'}",
  "Infra: {infra ou 'Nao informado'}",
  "Interesse: {interesse/dor ou 'Nao informado'}",
  "Agendamento: {data/horario ou 'A combinar'}",
  "Resumo: {resumo curto da necessidade}",
  "Temperatura: {Quente|Morno|Frio}",
  "",
  "[HANDOFF]",
  "Motivo: {qualificado|pediu_humano|suporte|duvida_comercial|outro}",
].join("\n");

export function HANDOFF_MESSAGE_TO_LEAD() {
  return "Perfeito. Vou encaminhar isso para o time responsavel e eles continuam com voce por aqui.";
}

function formatPhone(phone) {
  if (!phone) return "N/I";
  var num = String(phone).replace("@c.us", "").replace(/[^0-9]/g, "");
  if (num.length >= 12 && num.length <= 13 && num.startsWith("55")) {
    var ddd = num.substring(2, 4);
    var numero = num.substring(4);
    return "(" + ddd + ") " + numero.replace(/(\d{4,5})(\d{4})$/, "$1-$2");
  }
  return num;
}

function getRealNumber(d) {
  if (d.contactNumber) return String(d.contactNumber).replace(/[^0-9]/g, "");
  if (d.phone) return String(d.phone).replace("@c.us", "").replace(/[^0-9]/g, "");
  return null;
}

export function HANDOFF_MESSAGE_TO_TEAM(d) {
  var realNum = getRealNumber(d);
  var phoneDisplay = formatPhone(realNum);
  var waLink = realNum ? "wa.me/" + realNum : "";
  var destinationLabel = d.destinationLabel || "grupo configurado";

  return "🚨 NOVA CONVERSA PARA ATENCAO\n\n" +
    "📍 Destino: " + destinationLabel + "\n" +
    "👤 Nome: " + (d.name || "N/I") + "\n" +
    "📧 Email: " + (d.email || "N/I") + "\n" +
    "📞 Contato: " + phoneDisplay + (waLink ? " (" + waLink + ")" : "") + "\n" +
    "🏢 Empresa/Segmento: " + (d.company || d.segment || "N/I") + "\n" +
    "🛠 Infraestrutura: " + (d.infra || "N/I") + "\n" +
    "🎯 Interesse: " + (d.pain || d.interest || "N/I") + "\n" +
    "📅 Agendamento: " + (d.scheduling || "A combinar") + "\n" +
    "📝 Resumo: " + (d.summary || "-") + "\n" +
    "🌡 Temperatura: " + (d.temperature || "Quente");
}

export var AGENT_CONFIG = {
  maxTokens: 500,
  maxHistoryMessages: 50,
  spamPauseMs: 10 * 60 * 1000,
  followUpDelayMs: 10 * 60 * 1000,
  inactivityCloseMs: 30 * 60 * 1000,
  groupAlertIntervalMs: 60 * 60 * 1000,
  groupAlertInactivityMs: 20 * 60 * 1000,
  humanRequestKeywords: [
    "falar com alguem", "falar com alguém",
    "atendente", "humano", "pessoa real",
    "falar com uma pessoa", "gerente",
    "supervisor", "comercial", "vendedor",
  ],
};
