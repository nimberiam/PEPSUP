require('dotenv').config();
const express = require('express');

const app = express();
app.use(express.json());

const PEPSUP_BASE = 'https://api.pepsup.com/api/v1';
const GEMINI_MODEL = 'gemini-3.6-flash';

const TOOLS = [
  {
    name: 'get_evenements',
    description: "Retourne les événements de l'association, avec filtres optionnels.",
    parameters: {
      type: 'object',
      properties: {
        page: { type: 'integer', description: 'Numéro de page (défaut 0)' },
        search: { type: 'string' },
        published: { type: 'boolean' },
        paying: { type: 'boolean' },
        dateStart: { type: 'string', description: 'dd/MM/yyyy' },
        dateEnd: { type: 'string', description: 'dd/MM/yyyy' }
      }
    }
  },
  {
    name: 'get_dossiers_adhesions',
    description: "Retourne les dossiers d'adhésion de la période active, avec filtres optionnels.",
    parameters: {
      type: 'object',
      properties: {
        page: { type: 'integer' },
        search: { type: 'string' },
        status: { type: 'string', enum: ['CREATING','TO_PROCESS','UPDATE_TO_PROCESS','TO_PAY','PAYING','PROCESSED','REFUNDED','PAYING_STRIPE','REFUSED'] }
      }
    }
  },
  {
    name: 'get_contacts',
    description: "Retourne les contacts/membres de l'association, avec filtres optionnels.",
    parameters: {
      type: 'object',
      properties: {
        city: { type: 'string' },
        sortBy: { type: 'string' },
        sortDir: { type: 'string', enum: ['ASC', 'DESC'] }
      }
    }
  },
  {
    name: 'get_commandes_boutique',
    description: 'Retourne les commandes de la boutique en ligne, avec filtres optionnels.',
    parameters: {
      type: 'object',
      properties: {
        page: { type: 'integer' },
        search: { type: 'string' },
        status: { type: 'string', enum: ['TO_PROCESS','TO_PAY','PAYING','PAID','REFUNDED'] },
        delivery: { type: 'string', enum: ['DELIVERABLE','IN_DELIVERING','DELIVERED'] },
        dateMin: { type: 'string', description: 'dd/MM/yyyy' },
        dateMax: { type: 'string', description: 'dd/MM/yyyy' }
      }
    }
  }
];

const ENDPOINT_MAP = {
  get_evenements: '/evenements',
  get_dossiers_adhesions: '/dossiers-adhesions',
  get_contacts: '/contacts',
  get_commandes_boutique: '/commandes-boutique'
};

const SYSTEM_PROMPT = () => `Tu es l'assistant de données de l'association Pep's Up. Tu réponds en français, de façon claire, concise et factuelle, aux questions sur les événements, dossiers d'adhésion, contacts et commandes boutique.
Utilise systématiquement les outils fournis pour aller chercher les données réelles avant de répondre — ne suppose jamais de chiffres. Si une question nécessite plusieurs appels, fais-les. Donne des réponses synthétiques (chiffres clés, listes courtes), pas de tableaux bruts.
Date du jour : ${new Date().toLocaleDateString('fr-FR')}.`;

async function callPepsUp(toolName, input) {
  const url = new URL(PEPSUP_BASE + ENDPOINT_MAP[toolName]);
  Object.entries(input || {}).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
  });

  const res = await fetch(url, {
    headers: {
      'X-API-KEY': process.env.PEPSUP_API_KEY,
      'X-API-SECRET': process.env.PEPSUP_API_SECRET,
      Accept: 'application/json'
    }
  });

  if (!res.ok) return { error: `HTTP ${res.status} sur ${ENDPOINT_MAP[toolName]}` };
  return res.json();
}

async function askGemini(conversation) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${process.env.GEMINI_API_KEY}`;

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: SYSTEM_PROMPT() }] },
      contents: conversation,
      tools: [{ functionDeclarations: TOOLS }]
    })
  });

  if (!res.ok) throw new Error(`Appel Gemini API échoué (${res.status}): ${await res.text()}`);
  return res.json();
}

app.post('/ask', async (req, res) => {
  const question = req.body.question;
  if (!question) return res.status(400).json({ error: 'Champ "question" manquant.' });

  const conversation = [{ role: 'user', parts: [{ text: question }] }];
  const toolCallsLog = [];

  try {
    for (let i = 0; i < 6; i++) {
      const data = await askGemini(conversation);
      const parts = data.candidates?.[0]?.content?.parts || [];
      const functionCalls = parts.filter((p) => p.functionCall);
      const text = parts.filter((p) => p.text).map((p) => p.text).join('\n').trim();

      conversation.push({ role: 'model', parts });

      if (functionCalls.length === 0) {
        return res.json({ answer: text, toolCalls: toolCallsLog });
      }

      const responseParts = [];
      for (const fc of functionCalls) {
        const { name, args } = fc.functionCall;
        toolCallsLog.push({ tool: name, input: args });
        const result = await callPepsUp(name, args);
        responseParts.push({ functionResponse: { name, response: result } });
      }
      conversation.push({ role: 'user', parts: responseParts });
    }
    res.status(500).json({ error: "L'agent n'a pas conclu après plusieurs itérations." });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Agent Pep's Up en écoute sur http://localhost:${PORT}`));
