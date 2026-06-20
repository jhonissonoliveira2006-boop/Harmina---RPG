const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);

// Informa ao servidor para rodar os seus arquivos de interface (HTML) da pasta 'public'
app.use(express.static('public'));

// Memória temporária do servidor para guardar as fichas enquanto o servidor estiver ligado
let bancoDeDadosFichas = {};

// Quando alguém abre o site, o servidor inicia uma conexão em tempo real (Socket)
io.on('connection', (socket) => {
  console.log('⚔️ Um jogador se conectou ao Hármina RPG!');

  // Ouvinte: Quando o jogador faz login e pede a ficha dele
  socket.on('entrar-na-campanha', (dadosLogin) => {
    socket.nomeJogador = dadosLogin.usuario;
    
    // Se o jogador nunca entrou antes, cria um registro vazio para ele
    if (!bancoDeDadosFichas[socket.nomeJogador]) {
      bancoDeDadosFichas[socket.nomeJogador] = {
        senha: dadosLogin.senha,
        state: null // Aqui vai ficar salvo o objeto state da ficha dele
      };
    }

    // Verifica se a senha bate
    if (bancoDeDadosFichas[socket.nomeJogador].senha === dadosLogin.senha) {
      // Envia a ficha salva de volta para o jogador
      socket.emit('login-sucesso', bancoDeDadosFichas[socket.nomeJogador].state);
    } else {
      socket.emit('login-erro', 'Senha incorreta para este personagem!');
    }
  });

  // Ouvinte: Toda vez que o jogador alterar a vida, guarda, energia ou tomar dano
  socket.on('salvar-mudanca-ficha', (novoState) => {
    if (socket.nomeJogador && bancoDeDadosFichas[socket.nomeJogador]) {
      // Atualiza o banco de dados do servidor
      bancoDeDadosFichas[socket.nomeJogador].state = novoState;
      console.log(`💾 Ficha de [${socket.nomeJogador}] atualizada no servidor.`);

      // (Opcional) Avisa os outros jogadores ou o Mestre em tempo real
      socket.broadcast.emit('jogador-atualizou-status', {
        jogador: socket.nomeJogador,
        state: novoState
      });
    }
  });

  socket.on('disconnect', () => {
    console.log(`👋 ${socket.nomeJogador || 'Um usuário'} saiu da sessão.`);
  });
});

// Liga o servidor na porta certa do Glitch
const PORT = process.env.PORT || 3000;
http.listen(PORT, () => {
  console.log(`🚀 Servidor de Hármina rodando com sucesso!`);
});
