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

function carregarDados() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const conteudo = fs.readFileSync(DATA_FILE, 'utf8');
      const json = JSON.parse(conteudo);
      bancoDeDadosFichas = json.fichas || {};
      historicoChat = json.historicoChat || [];
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
    const payload = JSON.stringify({ fichas: bancoDeDadosFichas, historicoChat }, null, 2);
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
    fs.writeFileSync(DATA_FILE, JSON.stringify({ fichas: bancoDeDadosFichas, historicoChat }, null, 2), 'utf8');
  } catch (erro) {
    console.error('⚠️ Falha ao salvar no encerramento:', erro.message);
  }
  process.exit(0);
}
process.on('SIGINT', encerrarComCuidado);
process.on('SIGTERM', encerrarComCuidado);
