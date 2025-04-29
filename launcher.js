const localtunnel = require('localtunnel');
const express = require('express');
const WebSocket = require('ws');
const http = require('http');
const path = require('path');
const { exec } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
const multer = require('multer');
const net = require('net');

const run = promisify(exec);

// Argumentos
const SUBDOMAIN = process.argv[2];
const PORT = parseInt(process.argv[3]);

if (!SUBDOMAIN || !PORT) {
  console.error('Uso: editor.exe <subdomínio> <porta>');
  process.exit(1);
}

let serverInstance;
let tunnelInstance;
let interval;
let shuttingDown = false;
let clients = new Set(); // WebSocket clients

// --- Funções utilitárias ---

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
  console.warn(`⚠️ Porta ${port} ainda não escutando após ${retries} tentativas.`);
}

function broadcast(message) {
  clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(message));
    }
  });
}

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

const isPkg = typeof process.pkg !== 'undefined';

// --- Configurações Express ---
const app = express();
const uploadFolder = isPkg
  ? path.join(process.cwd(), 'uploads')
  : path.join(__dirname, 'uploads');

  if (!fs.existsSync(uploadFolder)) {
    fs.mkdirSync(uploadFolder, { recursive: true });
  }

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadFolder),
  filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname)
});
const upload = multer({ storage: storage });

// --- Rotas HTTP ---
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(uploadFolder));

app.post('/upload', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).send('Nenhum arquivo enviado.');
  console.log(`📂 Arquivo enviado: ${req.file.filename}`);
  broadcast({ type: 'filesUpdated' });
  res.send('Upload concluído!');
});

app.get('/uploads', (req, res) => {
  fs.readdir(uploadFolder, (err, files) => {
    if (err) return res.status(500).json([]);
    res.json(files);
  });
});

app.delete('/uploads/:filename', (req, res) => {
  const filename = req.params.filename;
  const filepath = path.join(uploadFolder, filename);
  if (!fs.existsSync(filepath)) {
    return res.status(404).send('Arquivo não encontrado.');
  }
  fs.unlink(filepath, (err) => {
    if (err) {
      console.error('Erro ao excluir arquivo:', err);
      return res.status(500).send('Erro ao excluir arquivo.');
    }
    console.log(`🗑️ Arquivo excluído: ${filename}`);
    broadcast({ type: 'filesUpdated' });
    res.send('Arquivo excluído.');
  });
});

// --- Servidor HTTP + WebSocket ---
serverInstance = http.createServer(app);
const wss = new WebSocket.Server({ server: serverInstance });

let currentText = '';

wss.on('connection', (ws) => {
  ws.isAlive = true;
  clients.add(ws);

  ws.send(JSON.stringify({ type: 'init', text: currentText }));

  ws.on('pong', () => {
    ws.isAlive = true;
  });

  ws.on('message', (message) => {
    const data = JSON.parse(message);
    if (data.type === 'ping') return;
    if (data.type === 'update') {
      currentText = data.text;
      clients.forEach(client => {
        if (client !== ws && client.readyState === WebSocket.OPEN) {
          client.send(JSON.stringify({ type: 'update', text: currentText }));
        }
      });
    }
  });

  ws.on('close', () => {
    clients.delete(ws);
    console.log('🔴 Cliente desconectado');
  });
});

interval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

// --- Inicia o túnel LocalTunnel ---
async function startTunnel() {
  if (tunnelInstance) {
    try {
      console.log('🔌 Fechando túnel anterior...');
      await tunnelInstance.close();
    } catch (e) {
      console.warn('⚠️ Falha ao fechar túnel antigo.');
    }
    tunnelInstance = null;
    await new Promise(resolve => setTimeout(resolve, 2000)); // espera 2 segundos
  }

  try {
    tunnelInstance = await localtunnel({ port: PORT, subdomain: SUBDOMAIN });
    console.log(`🌐 Tunnel ativo: ${tunnelInstance.url}`);

    try {
      const { stdout } = await run(`curl -s https://loca.lt/mytunnelpassword`);
      const password = stdout.trim();
      console.log(`🔐 Tunnel Password: ${password}`);
    } catch {
      console.warn('⚠️ Não foi possível obter senha do túnel automaticamente.');
    }

    tunnelInstance.on('close', () => {
      if (!shuttingDown) {
        console.warn('⛔ Tunnel foi fechado. Reconectando em 5s...');
        setTimeout(startTunnel, 5000);
      }
    });

    tunnelInstance.on('error', (err) => {
      if (!shuttingDown) {
        console.error('❌ Erro no túnel:', err.message);
        setTimeout(startTunnel, 5000);
      }
    });

  } catch (err) {
    if (!shuttingDown) {
      console.error('❌ Falha ao criar túnel:', err.message);
      setTimeout(startTunnel, 5000);
    }
  }
}

// --- Execução principal ---
(async () => {
  console.log(`📌 Subdomínio: ${SUBDOMAIN}`);
  console.log(`📌 Porta: ${PORT}`);

  await killPortIfBusy(PORT);
  serverInstance.listen(PORT, async () => {
    console.log(`🚀 Servidor rodando em http://localhost:${PORT}`);
    await waitForPortToBeListening(PORT);
    await startTunnel();
  });
})();
