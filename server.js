const express = require('express');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');

const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);

// Não expõe qual framework o servidor usa (boa prática básica de segurança)
app.disable('x-powered-by');

// Informa ao servidor para rodar os seus arquivos de interface (HTML) da pasta 'public'
app.use(express.static('public'));

// ═══════════════════════════════════════════
// PERSISTÊNCIA EM DISCO
// Tudo isso antes vivia só em memória (let bancoDeDadosFichas = {}), o que
// significa que cada vez que o Glitch reiniciasse ou "dormisse" o projeto,
// TODAS as fichas e senhas cadastradas eram perdidas. Agora gravamos em
// um arquivo JSON na pasta /data, que sobrevive a reinícios.
// ═══════════════════════════════════════════
const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'fichas.json');
const MAX_HISTORICO_CHAT = 50; // quantas mensagens recentes guardamos para quem entra depois

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

let bancoDeDadosFichas = {};
let historicoChat = [];
let boneco = { vita: { max: 8, cur: 8 }, guard: { max: 6, cur: 6 } };

function carregarDados() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const conteudo = fs.readFileSync(DATA_FILE, 'utf8');
      const json = JSON.parse(conteudo);
      bancoDeDadosFichas = json.fichas || {};
      historicoChat = json.historicoChat || [];
      boneco = json.boneco || { vita: { max: 8, cur: 8 }, guard: { max: 6, cur: 6 } };
      console.log(`📂 Dados carregados: ${Object.keys(bancoDeDadosFichas).length} ficha(s), ${historicoChat.length} mensagem(ns) de chat.`);
    }
  } catch (erro) {
    console.error('⚠️ Não foi possível carregar data/fichas.json, iniciando vazio:', erro.message);
    bancoDeDadosFichas = {};
    historicoChat = [];
  }
}

let salvamentoAgendado = null;
function salvarDados() {
  // "Debounce": se várias mudanças chegarem em sequência rápida, salva só uma vez,
  // evitando gravar no disco a cada tecla digitada.
  if (salvamentoAgendado) clearTimeout(salvamentoAgendado);
  salvamentoAgendado = setTimeout(() => {
    const tmpFile = DATA_FILE + '.tmp';
    const payload = JSON.stringify({ fichas: bancoDeDadosFichas, historicoChat, boneco }, null, 2);
    try {
      // Grava em arquivo temporário e renomeia por cima do original:
      // se o processo cair no meio da gravação, o arquivo original não fica corrompido.
      fs.writeFileSync(tmpFile, payload, 'utf8');
      fs.renameSync(tmpFile, DATA_FILE);
    } catch (erro) {
      console.error('⚠️ Falha ao salvar dados:', erro.message);
    }
  }, 800);
}

carregarDados();

// ═══════════════════════════════════════════
// VALIDAÇÃO DE ENTRADA
// O servidor antigo confiava 100% no que o cliente mandava. Qualquer
// pessoa podia, por exemplo, mandar `usuario: null` e travar o servidor,
// ou mandar uma ficha de 50MB e estourar a memória.
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
// BONECO DE TREINO
// Um "jogador" simples controlado pelo servidor, pra você testar a mecânica
// de combate sozinho — já que quase ninguém aparece na mesa pra treinar com
// você. Ele entende as mesmas frases de dano/cura que os jogadores reais
// usam ("causo 5 de dano", "curo 3 de vida"), aplica o efeito a si mesmo
// quando a ação parece dirigida a ele (nome citado ou termos genéricos como
// "inimigo"/"adversário"/"opositor"), revida com um contra-ataque aleatório,
// e pode ser remontado a qualquer momento com "// resetar boneco".
// ═══════════════════════════════════════════
const NOME_BONECO = 'Boneco de Treino';

function detectarMecanica(texto) {
  let m = texto.match(/(\d+)\s*de\s*dano/i);
  if (m) return { tipo: 'dano', valor: parseInt(m[1], 10) };

  m = texto.match(/(\d+)\s*de\s*cura/i)
    || texto.match(/cur[ao]u?\s+(\d+)/i)
    || texto.match(/recuper[ao]u?\s+(\d+)/i)
    || texto.match(/restaur[ao]u?\s+(\d+)/i);
  if (m) return { tipo: 'cura', valor: parseInt(m[1], 10) };

  return null;
}

// IMPORTANTE: o boneco só reage quando é citado pelo NOME, nunca por termos
// genéricos ("inimigo", "adversário"...). Esses termos são ambíguos demais
// pra uma reação automática sem confirmação humana — dois jogadores reais
// lutando entre si também os usam o tempo todo, e o boneco não pode se
// meter no combate deles. (Os termos genéricos continuam funcionando
// normalmente do lado do jogador, onde existe sempre uma confirmação manual
// antes de aplicar qualquer efeito.)
function mensagemAlvejaBoneco(texto) {
  return texto.toLowerCase().includes('boneco');
}

function aplicarMecanicaNoBoneco(mecanica) {
  if (mecanica.tipo === 'cura') {
    boneco.vita.cur = Math.min(boneco.vita.max, boneco.vita.cur + mecanica.valor);
    return `recebeu ${mecanica.valor} de cura`;
  }
  const consumidoGuarda = Math.min(boneco.guard.cur, mecanica.valor);
  boneco.guard.cur -= consumidoGuarda;
  const restante = mecanica.valor - consumidoGuarda;
  const consumidoVita = Math.min(boneco.vita.cur, restante);
  boneco.vita.cur -= consumidoVita;
  return `sofreu ${mecanica.valor} de dano`;
}

function statusBoneco() {
  return `❤️ ${boneco.vita.cur}/${boneco.vita.max} · 🔰 ${boneco.guard.cur}/${boneco.guard.max}`;
}

function falaContraAtaqueBoneco() {
  const dano = 1 + Math.floor(Math.random() * 4); // 1 a 4 de dano
  const falas = [
    `O Boneco de Treino revida com um golpe direto no oponente, causando ${dano} de dano.`,
    `O Boneco de Treino gira e acerta um contra-golpe no adversário, causando ${dano} de dano.`,
    `Os mecanismos do Boneco de Treino disparam uma lâmina contra o inimigo, causando ${dano} de dano.`
  ];
  return falas[Math.floor(Math.random() * falas.length)];
}

function emitirComoBoneco(texto) {
  const msg = { nome: NOME_BONECO, texto, tipo: 'normal', timestamp: new Date().toISOString() };
  historicoChat.push(msg);
  if (historicoChat.length > MAX_HISTORICO_CHAT) historicoChat.shift();
  io.emit('chat-mensagem', msg);
}

function resetarBoneco() {
  boneco = { vita: { max: 8, cur: 8 }, guard: { max: 6, cur: 6 } };
  salvarDados();
}

// Processa uma mensagem de jogador em busca de reações do Boneco de Treino.
// Roda DEPOIS da mensagem do jogador já ter sido transmitida normalmente.
function processarReacaoDoBoneco(mensagem) {
  if (mensagem.tipo === 'ooc' && /resetar\s+boneco/i.test(mensagem.texto)) {
    resetarBoneco();
    setTimeout(() => emitirComoBoneco(`O Boneco de Treino foi remontado e está pronto pra apanhar de novo. (${statusBoneco()})`), 400);
    return;
  }

  if (mensagem.tipo !== 'normal' || !mensagemAlvejaBoneco(mensagem.texto)) return;

  const mecanica = detectarMecanica(mensagem.texto);
  if (!mecanica) return;

  const resultado = aplicarMecanicaNoBoneco(mecanica);
  salvarDados();

  setTimeout(() => {
    emitirComoBoneco(`O Boneco de Treino ${resultado} (${statusBoneco()}).`);

    if (boneco.vita.cur <= 0) {
      setTimeout(() => emitirComoBoneco(`O Boneco de Treino se estilhaça e cai, destruído. Escreva "// resetar boneco" para remontá-lo.`), 700);
    } else if (mecanica.tipo === 'dano') {
      // Só contra-ataca quando sofre dano, pra não revidar uma cura
      setTimeout(() => emitirComoBoneco(falaContraAtaqueBoneco()), 900);
    }
  }, 700);
}

// Quando alguém abre o site, o servidor inicia uma conexão em tempo real (Socket)
io.on('connection', (socket) => {
  console.log(`⚔️ Um jogador se conectou ao Hármina RPG! (${io.engine.clientsCount} online)`);

  // Manda pro recém-chegado as últimas mensagens da mesa, pra sala não parecer vazia
  socket.emit('historico-chat', historicoChat);

  // Avisa a todos quantos jogadores estão online agora
  io.emit('presenca-atualizada', { total: io.engine.clientsCount });

  // Ouvinte: Quando o jogador faz login e pede a ficha dele
  socket.on('entrar-na-campanha', (dadosLogin) => {
    if (!dadosLogin || !textoValido(dadosLogin.usuario, 40) || !textoValido(dadosLogin.senha, 200)) {
      socket.emit('login-erro', 'Usuário ou senha inválidos.');
      return;
    }

    const usuario = dadosLogin.usuario.trim();
    const chave = usuario.toLowerCase();

    // Se o jogador nunca entrou antes, cria um registro vazio para ele
    if (!bancoDeDadosFichas[chave]) {
      bancoDeDadosFichas[chave] = {
        usuario, // nome original (com maiúsculas) para exibir
        senhaHash: bcrypt.hashSync(dadosLogin.senha, 10),
        state: null
      };
      salvarDados();
    }

    const registro = bancoDeDadosFichas[chave];

    // Compara a senha de forma segura (hash), nunca em texto puro
    if (bcrypt.compareSync(dadosLogin.senha, registro.senhaHash)) {
      socket.nomeJogador = registro.usuario;
      socket.emit('login-sucesso', registro.state);
    } else {
      socket.emit('login-erro', 'Senha incorreta para este personagem!');
    }
  });

  // Ouvinte: Toda vez que o jogador alterar a vida, guarda, energia ou tomar dano
  socket.on('salvar-mudanca-ficha', (novoState) => {
    if (!socket.nomeJogador) return; // precisa estar logado

    const chave = socket.nomeJogador.toLowerCase();
    if (!bancoDeDadosFichas[chave]) return;

    // Limite de tamanho defensivo: evita que um cliente malicioso (ou um bug)
    // mande um objeto gigantesco e estoure a memória do servidor.
    const tamanhoAproximado = JSON.stringify(novoState || {}).length;
    if (tamanhoAproximado > 500_000) {
      console.warn(`⚠️ Ficha de [${socket.nomeJogador}] rejeitada: payload grande demais (${tamanhoAproximado} bytes).`);
      return;
    }

    bancoDeDadosFichas[chave].state = novoState;
    salvarDados();
    console.log(`💾 Ficha de [${socket.nomeJogador}] atualizada no servidor.`);

    // Avisa os outros jogadores ou o Mestre em tempo real
    socket.broadcast.emit('jogador-atualizou-status', {
      jogador: socket.nomeJogador,
      state: novoState
    });
  });

  // Ouvinte: chat da mesa
  socket.on('chat-mensagem', (dados) => {
    if (!socket.nomeJogador) {
      socket.emit('login-erro', 'Você precisa estar logado para falar na mesa.');
      return;
    }
    if (!dados || !textoValido(dados.texto, 1000)) return;

    // Rate limit simples: no máximo 1 mensagem a cada 400ms por jogador, pra evitar spam/flood
    const agora = Date.now();
    if (socket.ultimaMensagemEm && agora - socket.ultimaMensagemEm < 400) return;
    socket.ultimaMensagemEm = agora;

    const mensagem = {
      // O nome SEMPRE vem da sessão autenticada no servidor, nunca do que o
      // cliente mandar — antes era possível qualquer jogador se passar por outro.
      nome: socket.nomeJogador,
      texto: escaparHtml(dados.texto.trim()),
      tipo: dados.tipo === 'ooc' ? 'ooc' : 'normal',
      timestamp: new Date().toISOString()
    };

    historicoChat.push(mensagem);
    if (historicoChat.length > MAX_HISTORICO_CHAT) historicoChat.shift();
    salvarDados();

    io.emit('chat-mensagem', mensagem);

    processarReacaoDoBoneco(mensagem);
  });

  // Ouvintes: indicador de "está digitando"
  socket.on('digitando', () => {
    if (!socket.nomeJogador) return;
    socket.broadcast.emit('digitando', { nome: socket.nomeJogador });
  });

  socket.on('parou-de-digitar', () => {
    if (!socket.nomeJogador) return;
    socket.broadcast.emit('parou-de-digitar', { nome: socket.nomeJogador });
  });

  socket.on('disconnect', () => {
    console.log(`👋 ${socket.nomeJogador || 'Um usuário'} saiu da sessão. (${io.engine.clientsCount} online)`);
    io.emit('presenca-atualizada', { total: io.engine.clientsCount });
  });
});

socket.on('desafio-combate', ({de, para}) => ...)
socket.on('resposta-desafio', ({de, para, aceito}) => ...)
socket.on('encerrar-combate', ({jogador1, jogador2}) => ...)
socket.on('solicitar-presenca-lista', () => ...)

// Rota simples de status — útil para serviços de monitoramento (ex.: UptimeRobot)
// manterem o projeto acordado no Glitch e para você checar rapidamente se está no ar.
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    jogadoresOnline: io.engine.clientsCount,
    fichasSalvas: Object.keys(bancoDeDadosFichas).length
  });
});

// Liga o servidor na porta certa do Glitch
const PORT = process.env.PORT || 3000;
http.listen(PORT, () => {
  console.log(`🚀 Servidor de Hármina rodando com sucesso na porta ${PORT}!`);
});

// Salva tudo antes de encerrar (ex.: quando o Glitch reinicia o projeto)
function encerrarComCuidado() {
  console.log('💾 Salvando dados antes de encerrar...');
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify({ fichas: bancoDeDadosFichas, historicoChat, boneco }, null, 2), 'utf8');
  } catch (erro) {
    console.error('⚠️ Falha ao salvar no encerramento:', erro.message);
  }
  process.exit(0);
}
process.on('SIGINT', encerrarComCuidado);
process.on('SIGTERM', encerrarComCuidado);

