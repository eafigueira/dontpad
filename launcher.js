const localtunnel = require('localtunnel');
const express = require('express');
const WebSocket = require('ws');
const http = require('http');
const path = require('path');
const { exec } = require('child_process');
const { promisify } = require('util');
const run = promisify(exec);
const net = require('net');

const SUBDOMAIN = process.argv[2];
const PORT = parseInt(process.argv[3]);

if (!SUBDOMAIN || !PORT) {
  console.error('Uso: editor.exe <subdomínio> <porta>');
  process.exit(1);
}

let serverInstance;
let tunnelInstance;
let interval;
let shuttingDown = false; // 🚨 usado para evitar reconexão após Ctrl+C

function stopServer() {
  if (interval) clearInterval(interval);
  if (serverInstance) {
    serverInstance.close(() => {
      console.log('🛑 Servidor finalizado.');
    });
  }
}

function stopTunnel() {
  if (tunnelInstance) {
    tunnelInstance.close();
    console.log('🔌 Tunnel encerrado.');
  }
}

process.on('SIGINT', () => {
  console.log('\n🧼 Encerrando...');
  shuttingDown = true;
  stopTunnel();
  stopServer();
  setTimeout(() => process.exit(0), 1000);
});

async function killPortIfBusy(port) {
  console.log(`🔍 Verificando se a porta ${port} está em uso...`);
  try {
    const { stdout } = await run(`netstat -aon | findstr :${port}`);
    const lines = stdout.trim().split('\n').filter(Boolean);

    const pids = new Set();
    for (const line of lines) {
      const parts = line.trim().split(/\s+/);
      const pid = parts[parts.length - 1];
      if (pid && !isNaN(pid) && pid !== '0') {
        pids.add(pid);
      }
    }

    if (pids.size === 0) {
      console.log(`✅ Porta ${port} está livre.`);
      return;
    }

    for (const pid of pids) {
      console.log(`⚠️ Porta ${port} em uso. Finalizando PID ${pid}...`);
      await run(`taskkill /PID ${pid} /F`).catch(() => {
        console.warn(`⚠️ Falha ao matar PID ${pid} (talvez já tenha sido finalizado).`);
      });
    }

  } catch (e) {
    console.warn('⚠️ Não foi possível verificar a porta:', e.message);
  }
}

async function waitForPortToBeListening(port, retries = 20, delay = 300) {
  for (let i = 0; i < retries; i++) {
    const isOpen = await new Promise((resolve) => {
      const socket = new net.Socket();
      socket
        .setTimeout(1000)
        .once('error', () => resolve(false))
        .once('timeout', () => resolve(false))
        .connect(port, '127.0.0.1', () => {
          socket.end();
          resolve(true);
        });
    });

    if (isOpen) return;
    console.log(`⏳ Aguardando o servidor escutar na porta ${port}...`);
    await new Promise((r) => setTimeout(r, delay));
  }

  console.warn(`⚠️ Porta ${port} não está escutando após ${retries} tentativas.`);
}

async function waitForPortToBeFree(port, maxRetries = 20, delay = 500) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      const { stdout } = await run(`netstat -aon | findstr :${port}`);
      if (!stdout.includes('LISTENING')) {
        return;
      }
      console.log(`⏳ Aguardando liberação da porta ${port}...`);
      await new Promise((r) => setTimeout(r, delay));
    } catch {
      return;
    }
  }
  console.warn(`⚠️ Porta ${port} ainda parece estar ocupada após tentativas.`);
}

function startServer(port) {
  return new Promise((resolve) => {
    const app = express();
    const server = http.createServer(app);
    const wss = new WebSocket.Server({ server });
    serverInstance = server;

    let currentText = '';
    const clients = new Set();

    app.use(express.static(path.join(__dirname, 'public')));

    wss.on('connection', (ws) => {
      ws.isAlive = true;
      ws.on('pong', () => ws.isAlive = true);

      clients.add(ws);
      console.log('🟢 Cliente conectado via WS');

      ws.send(JSON.stringify({ type: 'init', text: currentText }));

      ws.on('message', (message) => {
        const data = JSON.parse(message);
        if (data.type === 'ping') return;
        if (data.type === 'update') {
          currentText = data.text;
          for (const client of clients) {
            if (client !== ws && client.readyState === WebSocket.OPEN) {
              client.send(JSON.stringify({ type: 'update', text: currentText }));
            }
          }
        }
      });

      ws.on('close', () => {
        clients.delete(ws);
        console.log('🔴 Cliente desconectado');
      });
    });

    interval = setInterval(() => {
      wss.clients.forEach((ws) => {
        if (!ws.isAlive) {
          console.log('⚠️ Cliente inativo. Encerrando...');
          return ws.terminate();
        }
        ws.isAlive = false;
        ws.ping();
      });
    }, 30000);

    server.listen(port, () => {
      console.log(`🚀 Servidor rodando em http://localhost:${port}`);
      resolve();
    });
  });
}

async function startTunnel() {
  try {
    tunnelInstance = await localtunnel({ port: PORT, subdomain: SUBDOMAIN });
    console.log(`🌐 Tunnel ativo: ${tunnelInstance.url}`);

    try {
      const { stdout } = await run(`curl -s https://loca.lt/mytunnelpassword`);
      const password = stdout.trim();
      console.log(`🔐 Tunnel Password: ${password}`);
    } catch {
      console.warn('⚠️ Não foi possível obter a senha do túnel.');
    }

    tunnelInstance.on('close', () => {
      if (!shuttingDown) {
        console.warn('⛔ Tunnel foi fechado. Tentando reconectar em 10s...');
        setTimeout(startTunnel, 10000);
      }
    });

    tunnelInstance.on('error', (err) => {
      if (!shuttingDown) {
        console.error('❌ Erro no túnel:', err.message);
        setTimeout(startTunnel, 10000);
      }
    });

  } catch (err) {
    if (!shuttingDown) {
      console.error('❌ Falha ao iniciar túnel:', err.message);
      setTimeout(startTunnel, 10000);
    }
  }
}

(async () => {
  console.log(`📌 Subdomínio: ${SUBDOMAIN}`);
  console.log(`📌 Porta: ${PORT}`);

  await killPortIfBusy(PORT);
  await waitForPortToBeFree(PORT);
  await startServer(PORT);
  await waitForPortToBeListening(PORT); // 🆕 só inicia túnel quando a porta escutar
  await startTunnel();
})();