const express = require('express');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');

const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);

app.disable('x-powered-by');
app.use(express.static('public'));

// ═══════════════════════════════════════════
// PERSISTÊNCIA EM DISCO
// ═══════════════════════════════════════════
const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'fichas.json');
const MAX_HISTORICO_CHAT = 50;

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

let bancoDeDadosFichas = {};
let historicoChat = [];

// Estado do Boneco — agora inclui energia e foco para mecânicas inteligentes
let boneco = {
  vita:    { max: 8, cur: 8 },
  guard:   { max: 6, cur: 6 },
  energy:  { max: 6, cur: 6 },
  focoAtivo:      false,
  emCombate:      false,
  atacouUltimoTurno: false,
  turno:   0
};

function carregarDados() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const conteudo = fs.readFileSync(DATA_FILE, 'utf8');
      const json = JSON.parse(conteudo);
      bancoDeDadosFichas = json.fichas || {};
      historicoChat     = json.historicoChat || [];
      if (json.boneco) {
        boneco.vita  = json.boneco.vita  || boneco.vita;
        boneco.guard = json.boneco.guard || boneco.guard;
        boneco.energy = json.boneco.energy || boneco.energy;
      }
      console.log(`📂 Dados carregados: ${Object.keys(bancoDeDadosFichas).length} ficha(s), ${historicoChat.length} mensagem(ns).`);
    }
  } catch (erro) {
    console.error('⚠️ Não foi possível carregar dados:', erro.message);
    bancoDeDadosFichas = {};
    historicoChat = [];
  }
}

let salvamentoAgendado = null;
function salvarDados() {
  if (salvamentoAgendado) clearTimeout(salvamentoAgendado);
  salvamentoAgendado = setTimeout(() => {
    const tmpFile = DATA_FILE + '.tmp';
    const payload = JSON.stringify({
      fichas: bancoDeDadosFichas,
      historicoChat,
      boneco: { vita: boneco.vita, guard: boneco.guard, energy: boneco.energy }
    }, null, 2);
    try {
      fs.writeFileSync(tmpFile, payload, 'utf8');
      fs.renameSync(tmpFile, DATA_FILE);
    } catch (erro) {
      console.error('⚠️ Falha ao salvar dados:', erro.message);
    }
  }, 800);
}

carregarDados();

// ═══════════════════════════════════════════
// VALIDAÇÃO
// ═══════════════════════════════════════════
function textoValido(valor, tamanhoMax) {
  return typeof valor === 'string' && valor.trim().length > 0 && valor.length <= tamanhoMax;
}

function escaparHtml(texto) {
  return String(texto)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// ═══════════════════════════════════════════
// MAPA DE SOCKETS — username (lowercase) → socket
// Necessário para: mensagens privadas, desafios de combate, lista de presença.
// ═══════════════════════════════════════════
const jogadoresSocketMap = new Map();

// ═══════════════════════════════════════════
// BONECO DE TREINO — MODO INTELIGENTE
//
// O Boneco agora usa as mesmas mecânicas do sistema:
//   • Gasta 1⚡ por ataque normal; 2⚡ para segundo ataque no mesmo turno
//   • Regen passivo: +1⚡/turno se atacou; +2⚡ se não atacou (foco)
//   • Reage ao dano de acordo com o estado:
//       – Guarda alta + energia ok  → recebe normalmente
//       – Energia ≥ custo_esquiva   → esquiva (gasta custoAtaque+1 energia)
//       – Guarda zerada ou energia baixa → Postura Defensiva (gratuita)
//   • Canaliza Foco quando sem energia (turno sem ataque → +2 regen e +2 dano no próximo)
//   • Faz segundo ataque quando energia ≥ 3 (30% de chance)
//   • Narra cada ação com status ao final
// ═══════════════════════════════════════════
const NOME_BONECO = 'Boneco de Treino';

function resetarBoneco() {
  boneco = {
    vita:    { max: 8, cur: 8 },
    guard:   { max: 6, cur: 6 },
    energy:  { max: 6, cur: 6 },
    focoAtivo: false,
    emCombate: false,
    atacouUltimoTurno: false,
    turno: 0
  };
  salvarDados();
}

function statusBoneco() {
  return `❤️ ${boneco.vita.cur}/${boneco.vita.max} · 🔰 ${boneco.guard.cur}/${boneco.guard.max} · ⚡ ${boneco.energy.cur}/${boneco.energy.max}`;
}

function detectarMecanicaServidor(texto) {
  let m = texto.match(/(\d+)\s*de\s*dano/i);
  if (m) return { tipo: 'dano', valor: parseInt(m[1], 10) };

  m = texto.match(/(\d+)\s*de\s*cura/i)
    || texto.match(/cur[ao]u?\s+(\d+)/i)
    || texto.match(/recuper[ao]u?\s+(\d+)/i)
    || texto.match(/restaur[ao]u?\s+(\d+)/i);
  if (m) return { tipo: 'cura', valor: parseInt(m[1], 10) };

  return null;
}

function mensagemAlvejaBoneco(texto) {
  return texto.toLowerCase().includes('boneco');
}

// Boneco decide como reagir ao dano recebido, usando mecânicas reais
function bonecoReceberDano(dano, custoAtaqueOponente) {
  const b = boneco;
  const custo = custoAtaqueOponente || 1;
  const custoEsquiva = custo + 1;

  // Esquiva: se tiver energia suficiente (igual ao do sistema do jogador)
  if (b.energy.cur >= custoEsquiva && Math.random() < 0.40) {
    b.energy.cur -= custoEsquiva;
    return `desvia do ataque (🌀 Esquiva, −${custoEsquiva}⚡)! O dano de ${dano} é completamente evitado.`;
  }

  // Postura Defensiva: gratuita, mas perde turno de ataque
  if (b.guard.cur <= 2 || b.energy.cur <= 1) {
    const defTotal = 1 + Math.floor(b.vita.max / 3);
    const bloqueado = Math.min(dano, defTotal);
    const vazamento = Math.floor(bloqueado / 6);
    const danoFinal = Math.max(0, dano - defTotal) + vazamento;
    const cg = Math.min(b.guard.cur, danoFinal);
    b.guard.cur -= cg;
    const cv = Math.min(b.vita.cur, danoFinal - cg);
    b.vita.cur -= cv;
    return `entra em Postura Defensiva (🛡️ Def ${defTotal})! Barrou ${bloqueado}. Dano final: ${danoFinal} (🔰−${cg} · ❤️−${cv}).`;
  }

  // Receber normalmente (Guarda absorve primeiro)
  const cg = Math.min(b.guard.cur, dano);
  b.guard.cur -= cg;
  const cv = Math.min(b.vita.cur, dano - cg);
  b.vita.cur -= cv;
  return `sofreu ${dano} de dano (🔰−${cg} · ❤️−${cv}).`;
}

// Boneco decide se e como vai atacar neste turno
function bonecoDecidirAtaque() {
  const b = boneco;
  b.turno++;

  // Regen de energia (espelha a regra do jogador)
  const regenE = b.atacouUltimoTurno ? 1 : 2;
  b.energy.cur = Math.min(b.energy.max, b.energy.cur + regenE);
  // Regen passivo de guarda (1/turno, narrativo)
  b.guard.cur = Math.min(b.guard.max, b.guard.cur + 1);
  b.atacouUltimoTurno = false;

  // KO
  if (b.vita.cur <= 0) return null;

  // Sem energia → Canalizar Foco (não ataca, ganha bônus no próximo turno)
  if (b.energy.cur < 1) {
    b.focoAtivo = true;
    return {
      tipo: 'foco',
      fala: `O Boneco de Treino não possui energia para atacar e 🌟 canaliza seu foco. Próximo ataque será mais poderoso! (${statusBoneco()})`
    };
  }

  // Monta o ataque
  let dano = 1 + Math.floor(Math.random() * 3); // 1-3 base
  let extra = '';
  let custoTotal = 1;

  // Aplica bônus de foco acumulado
  if (b.focoAtivo) {
    dano += 2;
    extra = ' com Foco acumulado (+2 dano)';
    b.focoAtivo = false;
  }

  // Segundo ataque: 30% de chance se energia ≥ 3
  let danoSegundo = 0;
  if (b.energy.cur >= 3 && Math.random() < 0.30) {
    danoSegundo = 1 + Math.floor(Math.random() * 2);
    custoTotal = 2;
  }

  b.energy.cur = Math.max(0, b.energy.cur - custoTotal);
  b.atacouUltimoTurno = true;

  const falas = [
    `O Boneco de Treino avança e desfere um golpe certeiro, causando ${dano} de dano${extra}.`,
    `O Boneco de Treino gira e acerta um contra-golpe no adversário, causando ${dano} de dano${extra}.`,
    `Os mecanismos do Boneco disparam uma lâmina, causando ${dano} de dano${extra}.`,
    `O Boneco de Treino avança com força total, causando ${dano} de dano${extra}.`
  ];

  let fala = falas[Math.floor(Math.random() * falas.length)];
  if (danoSegundo > 0) {
    fala += ` Imediatamente realiza um ⚡⚔️ segundo ataque (−1⚡ extra), causando mais ${danoSegundo} de dano!`;
  }
  fala += ` (${statusBoneco()})`;

  return { tipo: 'ataque', fala };
}

function emitirComoBoneco(texto) {
  const msg = { nome: NOME_BONECO, texto, tipo: 'normal', timestamp: new Date().toISOString() };
  historicoChat.push(msg);
  if (historicoChat.length > MAX_HISTORICO_CHAT) historicoChat.shift();
  io.emit('chat-mensagem', msg);
}

function processarReacaoDoBoneco(mensagem) {
  // Comando de reset
  if (mensagem.tipo === 'ooc' && /resetar\s+boneco/i.test(mensagem.texto)) {
    resetarBoneco();
    setTimeout(() => emitirComoBoneco(`O Boneco de Treino foi remontado e está pronto para o combate! (${statusBoneco()})`), 400);
    return;
  }

  if (mensagem.tipo !== 'normal' || !mensagemAlvejaBoneco(mensagem.texto)) return;

  const mecanica = detectarMecanicaServidor(mensagem.texto);
  if (!mecanica) return;

  let resultado;
  if (mecanica.tipo === 'cura') {
    boneco.vita.cur = Math.min(boneco.vita.max, boneco.vita.cur + mecanica.valor);
    resultado = `recebeu ${mecanica.valor} de cura (${statusBoneco()})`;
  } else {
    resultado = bonecoReceberDano(mecanica.valor, 1);
    boneco.emCombate = true;
  }
  salvarDados();

  setTimeout(() => {
    emitirComoBoneco(`O Boneco de Treino ${resultado}`);

    if (boneco.vita.cur <= 0) {
      setTimeout(() => {
        emitirComoBoneco(`O Boneco de Treino se estilhaça e cai, completamente destruído! Use "// resetar boneco" ou o botão no menu (⋮) para remontá-lo.`);
        boneco.emCombate = false;
      }, 700);
    } else if (mecanica.tipo === 'dano') {
      // Contra-ataque após receber dano
      setTimeout(() => {
        const acao = bonecoDecidirAtaque();
        if (acao) emitirComoBoneco(acao.fala);
      }, 1100);
    }
  }, 700);
}

// ═══════════════════════════════════════════
// ÁRBITRO NARRATIVO DE IA
// A chave da API fica EXCLUSIVAMENTE aqui, nunca é enviada ao cliente.
// Configure via variável de ambiente: GEMINI_API_KEY=...
// ═══════════════════════════════════════════
const GEMINI_API_KEY  = process.env.GEMINI_API_KEY || '';
const ARBITER_MODEL   = 'gemini-2.0-flash';
const ARBITER_MAX_TOK = 800;
const ARBITER_ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${ARBITER_MODEL}:generateContent`;

// Sistema de rate-limit simples: máx. 1 pedido a cada 4s por socket
const arbiterCooldown = new Map(); // socketId → timestamp

async function chamarArbitroIA(payload) {
  const { mecanica, fichasCtx, historicoTxt, acoesTxt, decisaoAnterior, argumentoContestacao } = payload;

  const sistemPrompt = `Você é o Árbitro Narrativo do sistema Hármina RPG — um árbitro imparcial que avalia solicitações de ativação de mecânicas narrativas durante combates sem mestre presencial.

REGRAS GERAIS:
- Mensagens iniciadas com "//" são fora do personagem e devem ser ignoradas.
- Você NÃO decide vencedores, NÃO altera fichas, NÃO inventa fatos ausentes no histórico.
- Avalie apenas coerência narrativa, plausibilidade no cenário e consistência com as regras.
- Seja justo, transparente e explique sempre o motivo.

SISTEMA HÁRMINA — REGRAS RESUMIDAS:
- Furtividade: requer distração visual/auditiva, ambiente favorável, vantagem de Guarda.
- Imobilização: requer Energia + Vita >= oponente, custo 2⚡.
- Vantagem narrativa: requer preparação prévia, uso criativo de habilidades ou fraqueza do cenário.
- Dons e Vocações: levados em conta para plausibilidade da ação.
- Poder Único: habilidade especial do personagem — pode justificar ações extraordinárias.

FORMATO DE RESPOSTA: Responda SOMENTE com JSON válido, sem markdown, sem texto adicional:
{"aprovado": true/false, "confianca": 0.0-1.0, "mecanica": "nome da mecânica", "motivo": "explicação detalhada em português"}`;

  let userContent = `FICHAS EM COMBATE:\n${(fichasCtx || []).join('\n') || '(nenhuma ficha ativa)'}\n\n`;
  userContent += `HISTÓRICO COMPLETO DE AÇÕES NARRATIVAS:\n${historicoTxt || '(vazio)'}\n\n`;
  userContent += `AÇÕES SELECIONADAS PARA AVALIAÇÃO:\n${acoesTxt || '(nenhuma selecionada)'}\n\n`;
  userContent += `MECÂNICA SOLICITADA: ${mecanica}`;

  if (decisaoAnterior && argumentoContestacao) {
    userContent += `\n\nDECISÃO ANTERIOR: ${JSON.stringify(decisaoAnterior)}`;
    userContent += `\n\nARGUMENTO DE CONTESTAÇÃO: ${argumentoContestacao}`;
    userContent += `\n\nReavalie a decisão considerando o argumento acima. Mantenha, corrija ou revogue, sempre justificando.`;
  }

  // fetch nativo está disponível no Node.js 18+
  const resp = await fetch(`${ARBITER_ENDPOINT}?key=${GEMINI_API_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: sistemPrompt }] },
      contents: [{ role: 'user', parts: [{ text: userContent }] }],
      generationConfig: { maxOutputTokens: ARBITER_MAX_TOK, temperature: 0.2 },
    }),
  });

  if (!resp.ok) {
    const errBody = await resp.text().catch(() => '');
    throw new Error(`Gemini API HTTP ${resp.status}: ${errBody.slice(0, 200)}`);
  }

  const data = await resp.json();
  const rawText = ((data.candidates || [])[0]?.content?.parts || [])
    .map(b => b.text || '').join('').trim();
  const clean   = rawText.replace(/^```json?|```$/gm, '').trim();
  const decisao = JSON.parse(clean);

  if (typeof decisao.aprovado !== 'boolean' || typeof decisao.motivo !== 'string') {
    throw new Error('Resposta da IA em formato inesperado.');
  }

  return decisao;
}

// ═══════════════════════════════════════════
// SOCKET.IO
// ═══════════════════════════════════════════
io.on('connection', (socket) => {
  console.log(`⚔️ Jogador conectado. (${io.engine.clientsCount} online)`);
  socket.emit('historico-chat', historicoChat);
  io.emit('presenca-atualizada', { total: io.engine.clientsCount });

  // ── Login / Ficha ──────────────────────────────────────────────────────
  socket.on('entrar-na-campanha', (dadosLogin) => {
    if (!dadosLogin || !textoValido(dadosLogin.usuario, 40) || !textoValido(dadosLogin.senha, 200)) {
      socket.emit('login-erro', 'Usuário ou senha inválidos.');
      return;
    }

    const usuario = dadosLogin.usuario.trim();
    const chave   = usuario.toLowerCase();

    if (!bancoDeDadosFichas[chave]) {
      bancoDeDadosFichas[chave] = {
        usuario,
        senhaHash: bcrypt.hashSync(dadosLogin.senha, 10),
        state: null
      };
      salvarDados();
    }

    const registro = bancoDeDadosFichas[chave];

    if (bcrypt.compareSync(dadosLogin.senha, registro.senhaHash)) {
      socket.nomeJogador = registro.usuario;
      // Registra no mapa para roteamento privado/combate
      jogadoresSocketMap.set(chave, socket);
      socket.emit('login-sucesso', registro.state);
    } else {
      socket.emit('login-erro', 'Senha incorreta para este personagem!');
    }
  });

  // ── Salvar Ficha ───────────────────────────────────────────────────────
  socket.on('salvar-mudanca-ficha', (novoState) => {
    if (!socket.nomeJogador) return;
    const chave = socket.nomeJogador.toLowerCase();
    if (!bancoDeDadosFichas[chave]) return;
    const tam = JSON.stringify(novoState || {}).length;
    if (tam > 500_000) {
      console.warn(`⚠️ Ficha de [${socket.nomeJogador}] rejeitada: payload grande demais (${tam} bytes).`);
      return;
    }
    bancoDeDadosFichas[chave].state = novoState;
    salvarDados();
    socket.broadcast.emit('jogador-atualizou-status', { jogador: socket.nomeJogador, state: novoState });
  });

  // ── Chat ───────────────────────────────────────────────────────────────
  socket.on('chat-mensagem', (dados) => {
    if (!socket.nomeJogador) {
      socket.emit('login-erro', 'Você precisa estar logado para falar na mesa.');
      return;
    }
    if (!dados || !textoValido(dados.texto, 1000)) return;

    const agora = Date.now();
    if (socket.ultimaMensagemEm && agora - socket.ultimaMensagemEm < 400) return;
    socket.ultimaMensagemEm = agora;

    const mensagem = {
      nome:      socket.nomeJogador,
      texto:     escaparHtml(dados.texto.trim()),
      tipo:      dados.tipo === 'ooc' ? 'ooc' : 'normal',
      timestamp: new Date().toISOString()
    };

    historicoChat.push(mensagem);
    if (historicoChat.length > MAX_HISTORICO_CHAT) historicoChat.shift();
    salvarDados();
    io.emit('chat-mensagem', mensagem);
    processarReacaoDoBoneco(mensagem);
  });

  // ── Chat Privado ────────────────────────────────────────────────────────
  socket.on('chat-privado', ({ para, texto }) => {
    if (!socket.nomeJogador) return;
    if (!textoValido(texto, 1000)) return;
    const alvo = jogadoresSocketMap.get(String(para).toLowerCase());
    if (alvo) {
      alvo.emit('chat-privado', {
        de:    socket.nomeJogador,
        texto: escaparHtml(texto.trim())
      });
    }
  });

  // ── Digitando ──────────────────────────────────────────────────────────
  socket.on('digitando', () => {
    if (!socket.nomeJogador) return;
    socket.broadcast.emit('digitando', { nome: socket.nomeJogador });
  });

  socket.on('parou-de-digitar', () => {
    if (!socket.nomeJogador) return;
    socket.broadcast.emit('parou-de-digitar', { nome: socket.nomeJogador });
  });

  // ── COMBATE: Desafio ────────────────────────────────────────────────────
  // Quando o jogador clica em "Convidar para Combate" e seleciona um alvo,
  // o servidor roteia o desafio para o socket daquele jogador.
  socket.on('desafio-combate', ({ para }) => {
    if (!socket.nomeJogador) return;
    const alvo = jogadoresSocketMap.get(String(para).toLowerCase());
    if (alvo) {
      alvo.emit('desafio-recebido', { de: socket.nomeJogador });
    }
  });

  // ── COMBATE: Resposta ao Desafio ────────────────────────────────────────
  // O jogador desafiado responde; o servidor informa ambos e, se aceito,
  // emite 'combate-iniciado' para os dois, ativando as mecânicas.
  socket.on('resposta-desafio', ({ para, aceito }) => {
    if (!socket.nomeJogador) return;
    const alvo = jogadoresSocketMap.get(String(para).toLowerCase());
    if (alvo) {
      alvo.emit('resposta-desafio', { de: socket.nomeJogador, aceito });
      if (aceito) {
        socket.emit('combate-iniciado',  { oponente: para });
        alvo.emit('combate-iniciado',    { oponente: socket.nomeJogador });
      }
    }
  });

  // ── COMBATE: Encerrar ───────────────────────────────────────────────────
  socket.on('encerrar-combate', ({ jogador2 }) => {
    if (!socket.nomeJogador) return;
    const alvo = jogadoresSocketMap.get(String(jogador2).toLowerCase());
    if (alvo) alvo.emit('combate-encerrado', {});
  });

  // ── Lista de Jogadores Online (para modal de desafio) ──────────────────
  socket.on('solicitar-presenca-lista', () => {
    const lista = [];
    for (const [, s] of jogadoresSocketMap) {
      if (s.nomeJogador && s !== socket) lista.push(s.nomeJogador);
    }
    socket.emit('presenca-lista', lista);
  });

  // ── ÁRBITRO DE IA: Solicitação ──────────────────────────────────────────
  // O cliente envia apenas contexto narrativo (fichas, histórico, mecânica).
  // A chave da API nunca sai deste arquivo — fica em process.env.GEMINI_API_KEY.
  socket.on('arbiter-solicitar', async (payload) => {
    if (!socket.nomeJogador) return;

    // Rate-limit: 1 pedido a cada 4 segundos por socket
    const agora = Date.now();
    const ultimo = arbiterCooldown.get(socket.id) || 0;
    if (agora - ultimo < 4000) {
      socket.emit('arbiter-resposta', { erro: 'Aguarde alguns segundos antes de solicitar outra avaliação.' });
      return;
    }
    arbiterCooldown.set(socket.id, agora);

    // Valida chave
    if (!GEMINI_API_KEY) {
      socket.emit('arbiter-resposta', { erro: 'Árbitro de IA não configurado. Defina GEMINI_API_KEY no servidor.' });
      return;
    }

    // Valida payload mínimo
    if (!payload || !textoValido(payload.mecanica, 200)) {
      socket.emit('arbiter-resposta', { erro: 'Mecânica inválida na solicitação.' });
      return;
    }

    // Sanitiza — remove campos desnecessários, limita tamanho
    const payloadSeguro = {
      mecanica:             String(payload.mecanica).slice(0, 200),
      fichasCtx:            Array.isArray(payload.fichasCtx)
                              ? payload.fichasCtx.map(s => String(s).slice(0, 500)).slice(0, 20)
                              : [],
      historicoTxt:         String(payload.historicoTxt || '').slice(0, 8000),
      acoesTxt:             String(payload.acoesTxt || '').slice(0, 4000),
      decisaoAnterior:      payload.decisaoAnterior || null,
      argumentoContestacao: payload.argumentoContestacao
                              ? String(payload.argumentoContestacao).slice(0, 1000)
                              : null,
    };

    const eContestacao = !!(payloadSeguro.decisaoAnterior && payloadSeguro.argumentoContestacao);

    try {
      const decisao = await chamarArbitroIA(payloadSeguro);
      socket.emit('arbiter-resposta', { decisao, eContestacao });
      console.log(`⚖️ Árbitro [${socket.nomeJogador}]: ${decisao.aprovado ? '✅' : '❌'} "${payloadSeguro.mecanica}" (${Math.round((decisao.confianca || 0) * 100)}%)`);
    } catch (err) {
      console.error(`⚠️ Árbitro IA erro [${socket.nomeJogador}]:`, err.message);
      socket.emit('arbiter-resposta', { erro: 'Erro ao consultar a IA. Tente novamente em instantes.' });
    }
  });

  // ── Desconexão ─────────────────────────────────────────────────────────
  socket.on('disconnect', () => {
    if (socket.nomeJogador) {
      const chave = socket.nomeJogador.toLowerCase();
      // Remove do mapa apenas se for este exato socket (evita apagar reconexão)
      if (jogadoresSocketMap.get(chave) === socket) {
        jogadoresSocketMap.delete(chave);
      }
    }
    arbiterCooldown.delete(socket.id);
    console.log(`👋 ${socket.nomeJogador || 'Anônimo'} saiu. (${io.engine.clientsCount} online)`);
    io.emit('presenca-atualizada', { total: io.engine.clientsCount });
  });
});

// ── Health Check ────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    jogadoresOnline: io.engine.clientsCount,
    fichasSalvas: Object.keys(bancoDeDadosFichas).length
  });
});

// ── Iniciar Servidor ────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
http.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Servidor Hármina rodando na porta ${PORT}!`);
  if (!GEMINI_API_KEY) {
    console.warn('⚠️  GEMINI_API_KEY não definida — Árbitro de IA desativado.');
    console.warn('   Configure com: export GEMINI_API_KEY=...');
  } else {
    console.log('⚖️  Árbitro Narrativo de IA (Gemini): ativo.');
  }
});

// ── Encerramento Gracioso ───────────────────────────────────────────────────
function encerrarComCuidado() {
  console.log('💾 Salvando dados antes de encerrar...');
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify({
      fichas: bancoDeDadosFichas,
      historicoChat,
      boneco: { vita: boneco.vita, guard: boneco.guard, energy: boneco.energy }
    }, null, 2), 'utf8');
  } catch (erro) {
    console.error('⚠️ Falha ao salvar no encerramento:', erro.message);
  }
  process.exit(0);
}
process.on('SIGINT',  encerrarComCuidado);
process.on('SIGTERM', encerrarComCuidado);
