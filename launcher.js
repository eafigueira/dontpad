const localtunnel = require('localtunnel');
const express = require('express');
const WebSocket = require('ws');
const http = require('http');
const https = require('https');
const path = require('path');
const { exec, spawn } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
const multer = require('multer');
const net = require('net');

const run = promisify(exec);

const SUBDOMAIN = process.argv[2];
const PORT = parseInt(process.argv[3], 10);
const TUNNEL_MODE = (process.argv[4] || process.env.TUNNEL_MODE || 'lt').toLowerCase();
const TUNNEL_HOST = process.env.TUNNEL_HOST || 'https://loca.lt';
const TUNNEL_RELEASE_TOKEN = process.env.TUNNEL_RELEASE_TOKEN || '';
const SUBDOMAIN_WAIT_MS = 5000;
const SUBDOMAIN_RELEASE_POLL_MS = 1000;
const SUBDOMAIN_RELEASE_POLLS = 8;

if (!SUBDOMAIN || !PORT) {
  console.error('Uso: editor.exe <subdomínio> <porta> [lt|none|cloudflare]');
  console.error('  lt         — túnel loca.lt/localtunnel (padrão)');
  console.error('  none       — só localhost/LAN (sem túnel externo)');
  console.error('  cloudflare — cloudflared quick tunnel (mais estável; precisa cloudflared no PATH)');
  process.exit(1);
}

let serverInstance;
let tunnelInstance;
let cloudflareProcess;
let interval;
let shuttingDown = false;
let clients = new Set();
let tunnelUrl = null;
let tunnelReconnectTimer = null;
let tunnelHealthTimer = null;
let tunnelBackoffMs = 2000;
const TUNNEL_BACKOFF_MAX = 60000;
let tunnelStarting = false;
let tunnelHealthFailures = 0;

const isPkg = typeof process.pkg !== 'undefined';
const BASE_DIR = isPkg ? process.cwd() : __dirname;
const STATE_FILE = path.join(BASE_DIR, 'state.json');
const TUNNEL_URL_FILE = path.join(BASE_DIR, 'tunnel-url.txt');

// --- Utilitários ---

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
    // findstr retorna código 1 quando não há linhas = porta livre
    if (e.code === 1) {
      console.log(`✅ Porta ${port} está livre.`);
      return;
    }
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
  clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(message));
    }
  });
}

function clearTunnelTimers() {
  if (tunnelReconnectTimer) {
    clearTimeout(tunnelReconnectTimer);
    tunnelReconnectTimer = null;
  }
  if (tunnelHealthTimer) {
    clearInterval(tunnelHealthTimer);
    tunnelHealthTimer = null;
  }
}

function resetTunnelBackoff() {
  tunnelBackoffMs = 2000;
  tunnelHealthFailures = 0;
}

function scheduleTunnelReconnect(reason) {
  if (shuttingDown || tunnelReconnectTimer || TUNNEL_MODE === 'none') return;

  const delaySec = (tunnelBackoffMs / 1000).toFixed(1);
  console.warn(`⛔ ${reason}. Reconectando em ${delaySec}s...`);

  tunnelReconnectTimer = setTimeout(() => {
    tunnelReconnectTimer = null;
    startTunnel();
  }, tunnelBackoffMs);

  tunnelBackoffMs = Math.min(Math.round(tunnelBackoffMs * 1.5), TUNNEL_BACKOFF_MAX);
}

async function closeTunnel() {
  clearTunnelTimers();

  if (cloudflareProcess) {
    cloudflareProcess.kill();
    cloudflareProcess = null;
  }

  if (tunnelInstance) {
    try {
      await tunnelInstance.close();
    } catch {
      // ignore
    }
    tunnelInstance = null;
  }

  tunnelUrl = null;
}

function stopServer() {
  if (interval) clearInterval(interval);
  if (serverInstance) {
    serverInstance.close(() => {
      console.log('🛑 Servidor finalizado.');
    });
  }
}

function getTunnelApiOrigin() {
  try {
    return new URL(TUNNEL_HOST).origin;
  } catch {
    return 'https://loca.lt';
  }
}

function tunnelApiRequest(method, apiPath, headers = {}) {
  return new Promise((resolve) => {
    const url = new URL(apiPath, getTunnelApiOrigin());
    const lib = url.protocol === 'https:' ? https : http;
    const req = lib.request(
      {
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname + url.search,
        method,
        timeout: 12000,
        headers,
      },
      (res) => {
        let body = '';
        res.on('data', (chunk) => {
          body += chunk;
        });
        res.on('end', () => {
          let json = null;
          try {
            json = JSON.parse(body);
          } catch {
            // resposta não-JSON
          }
          resolve({ status: res.statusCode, body, json });
        });
      }
    );
    req.on('timeout', () => {
      req.destroy();
      resolve({ status: 0, body: '', json: null });
    });
    req.on('error', () => resolve({ status: 0, body: '', json: null }));
    req.end();
  });
}

async function checkSubdomainStatus(subdomain) {
  const res = await tunnelApiRequest(
    'GET',
    `/api/tunnels/${encodeURIComponent(subdomain)}/status`
  );

  if (res.status === 404) {
    return { state: 'free' };
  }
  if (res.status === 200 && res.json) {
    return {
      state: 'in_use',
      connectedSockets: res.json.connected_sockets ?? 0,
    };
  }
  return { state: 'unknown', httpStatus: res.status };
}

async function requestSubdomainRelease(subdomain) {
  if (!TUNNEL_RELEASE_TOKEN) {
    return { attempted: false };
  }

  const authHeader = TUNNEL_RELEASE_TOKEN.startsWith('Bearer ')
    ? TUNNEL_RELEASE_TOKEN
    : `Bearer ${TUNNEL_RELEASE_TOKEN}`;

  const res = await tunnelApiRequest(
    'DELETE',
    `/api/tunnels/${encodeURIComponent(subdomain)}`,
    { Authorization: authHeader }
  );

  if (res.status >= 200 && res.status < 300) {
    return { attempted: true, ok: true };
  }

  const message = (res.json && res.json.error) || res.body || `HTTP ${res.status}`;
  return { attempted: true, ok: false, message };
}

async function waitUntilSubdomainFree(subdomain, reason) {
  const status = await checkSubdomainStatus(subdomain);

  if (status.state === 'free') {
    return true;
  }

  if (status.state === 'in_use') {
    console.warn('');
    console.warn(`⚠️ Subdomínio "${subdomain}" em uso no loca.lt (${reason}).`);
    console.warn(`   Conexões ativas no servidor: ${status.connectedSockets}`);
    console.warn('   Feche outro editor.exe/lt ou aguarde liberar.');
    console.warn(`   Nova verificação em ${SUBDOMAIN_WAIT_MS / 1000}s...`);
    console.warn('');
    return false;
  }

  return true;
}

async function releaseSubdomainOnShutdown() {
  if (TUNNEL_MODE !== 'lt' || !getTunnelApiOrigin().includes('loca.lt')) {
    return;
  }

  const release = await requestSubdomainRelease(SUBDOMAIN);
  if (release.attempted) {
    if (release.ok) {
      console.log('🔓 API de liberação aceitou o pedido (DELETE /api/tunnels).');
    } else {
      console.warn(`⚠️ API de liberação: ${release.message}`);
    }
  }

  console.log(`🔍 Confirmando se "${SUBDOMAIN}" foi liberado...`);

  for (let i = 0; i < SUBDOMAIN_RELEASE_POLLS; i++) {
    await new Promise((r) => setTimeout(r, SUBDOMAIN_RELEASE_POLL_MS));
    const status = await checkSubdomainStatus(SUBDOMAIN);
    if (status.state === 'free') {
      console.log(`✅ Subdomínio "${SUBDOMAIN}" livre no loca.lt.`);
      return;
    }
  }

  const final = await checkSubdomainStatus(SUBDOMAIN);
  if (final.state === 'in_use') {
    console.warn(`⚠️ "${SUBDOMAIN}" ainda consta em uso (${final.connectedSockets} socket(s)).`);
    if (!TUNNEL_RELEASE_TOKEN) {
      console.warn('   Defina TUNNEL_RELEASE_TOKEN se tiver token para DELETE /api/tunnels/{nome}.');
    }
    console.warn('   Pode ser outro processo ou atraso do servidor — tente de novo em alguns minutos.');
  } else if (final.state === 'unknown') {
    console.warn('⚠️ Não foi possível confirmar liberação (API indisponível).');
  }
}

async function stopTunnel() {
  await closeTunnel();
  await releaseSubdomainOnShutdown();
  console.log('🔌 Tunnel encerrado.');
}

async function gracefulShutdown() {
  if (shuttingDown) return;
  console.log('\n🧼 Encerrando...');
  shuttingDown = true;
  clearTunnelTimers();
  await stopTunnel();
  stopServer();
  setTimeout(() => process.exit(0), 1000);
}

process.on('SIGINT', gracefulShutdown);
process.on('SIGTERM', gracefulShutdown);

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const data = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      if (typeof data.text === 'string') return data.text;
    }
  } catch (e) {
    console.warn('⚠️ Não foi possível carregar estado:', e.message);
  }
  return '';
}

let saveStateTimer;
function scheduleSaveState(text) {
  clearTimeout(saveStateTimer);
  saveStateTimer = setTimeout(() => {
    fs.writeFile(STATE_FILE, JSON.stringify({ text, updatedAt: Date.now() }), () => {});
  }, 400);
}

function tunnelSlug(url) {
  return new URL(url).hostname.split('.')[0];
}

function tunnelHasRequestedSubdomain(url) {
  return tunnelSlug(url) === SUBDOMAIN;
}

function publishTunnelUrl(url) {
  tunnelUrl = url;
  fs.writeFileSync(TUNNEL_URL_FILE, `${url}\n`, 'utf8');
  console.log('');
  console.log(`🌐 URL pública: ${url}`);
  console.log(`   (salva em ${TUNNEL_URL_FILE})`);
  console.log('');
}

function attachLocalTunnelListeners(instance) {
  instance.on('close', () => {
    if (!shuttingDown) {
      tunnelInstance = null;
      tunnelUrl = null;
      scheduleTunnelReconnect('túnel fechado pelo servidor');
    }
  });

  instance.on('error', (err) => {
    if (!shuttingDown) {
      console.error('❌ Erro no túnel:', err.message);
      tunnelInstance = null;
      tunnelUrl = null;
      scheduleTunnelReconnect(err.message);
    }
  });
}

async function fetchTunnelPassword() {
  if (!TUNNEL_HOST.includes('loca.lt')) return;
  try {
    const { stdout } = await run('curl -s --max-time 10 https://loca.lt/mytunnelpassword');
    const password = stdout.trim();
    if (password) {
      console.log(`🔐 Senha na 1ª visita ao loca.lt: ${password}`);
      console.log('   (é o seu IP público — visitantes digitam na página de aviso do loca.lt)');
    }
  } catch {
    console.warn('⚠️ Não foi possível obter senha do túnel automaticamente.');
  }
}

function startTunnelHealthCheck() {
  if (tunnelHealthTimer || !tunnelUrl || TUNNEL_MODE === 'none') return;

  tunnelHealthTimer = setInterval(async () => {
    if (!tunnelUrl || shuttingDown) return;

    const url = new URL(tunnelUrl);
    const lib = url.protocol === 'https:' ? https : http;
    const ok = await new Promise((resolve) => {
      const req = lib.request(
        {
          hostname: url.hostname,
          port: url.port || (url.protocol === 'https:' ? 443 : 80),
          path: '/health',
          method: 'GET',
          timeout: 15000,
          headers: { 'bypass-tunnel-reminder': 'true' },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode === 200);
        }
      );
      req.on('timeout', () => {
        req.destroy();
        resolve(false);
      });
      req.on('error', () => resolve(false));
      req.end();
    });

    if (ok) {
      tunnelHealthFailures = 0;
      return;
    }

    tunnelHealthFailures++;
    if (tunnelHealthFailures >= 2) {
      console.warn('⚠️ Health check do túnel falhou — forçando reconexão.');
      tunnelHealthFailures = 0;
      forceTunnelReconnect('túnel não responde ao health check');
    }
  }, 45000);
}

async function forceTunnelReconnect(reason) {
  if (tunnelStarting || shuttingDown) return;
  clearTunnelTimers();
  await closeTunnel();
  scheduleTunnelReconnect(reason);
}

async function startLocalTunnel() {
  while (!shuttingDown) {
    const ready = await waitUntilSubdomainFree(SUBDOMAIN, 'verificado via GET /api/tunnels/.../status');
    if (!ready) {
      await new Promise((r) => setTimeout(r, SUBDOMAIN_WAIT_MS));
      continue;
    }

    const instance = await localtunnel({
      port: PORT,
      subdomain: SUBDOMAIN,
      host: TUNNEL_HOST,
      local_host: '127.0.0.1',
    });

    if (tunnelHasRequestedSubdomain(instance.url)) {
      tunnelInstance = instance;
      publishTunnelUrl(instance.url);
      await fetchTunnelPassword();
      attachLocalTunnelListeners(instance);
      return;
    }

    const received = tunnelSlug(instance.url);
    console.warn('');
    console.warn(`⚠️ Pedido de "${SUBDOMAIN}" retornou "${received}" (conflito após abrir túnel).`);
    console.warn('   Fechando túnel incorreto e tentando de novo...');
    console.warn('');

    try {
      await instance.close();
    } catch {
      // ignore
    }

    await new Promise((r) => setTimeout(r, SUBDOMAIN_WAIT_MS));
  }
}

function startCloudflareTunnel() {
  return new Promise((resolve, reject) => {
    if (cloudflareProcess) {
      cloudflareProcess.kill();
      cloudflareProcess = null;
    }

    const child = spawn(
      'cloudflared',
      ['tunnel', '--url', `http://127.0.0.1:${PORT}`, '--no-autoupdate'],
      { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }
    );
    cloudflareProcess = child;

    let settled = false;
    const tryResolve = (text) => {
      const match = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
      if (match && !settled) {
        settled = true;
        publishTunnelUrl(match[0]);
        resolve();
      }
    };

    child.stdout.on('data', (chunk) => tryResolve(chunk.toString()));
    child.stderr.on('data', (chunk) => tryResolve(chunk.toString()));

    child.on('error', (err) => {
      if (err.code === 'ENOENT') {
        reject(
          new Error(
            'cloudflared não encontrado no PATH. Baixe em https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/install-and-setup/installation/'
          )
        );
      } else {
        reject(err);
      }
    });

    child.on('close', (code) => {
      cloudflareProcess = null;
      if (!shuttingDown && settled) {
        tunnelUrl = null;
        scheduleTunnelReconnect(`cloudflared encerrou (código ${code})`);
      }
    });

    setTimeout(() => {
      if (!settled) {
        child.kill();
        reject(new Error('timeout aguardando URL do cloudflared (60s)'));
      }
    }, 60000);
  });
}

async function startTunnel() {
  if (TUNNEL_MODE === 'none' || shuttingDown) return;
  if (tunnelStarting) return;

  tunnelStarting = true;
  clearTunnelTimers();

  try {
    await closeTunnel();
    await new Promise((r) => setTimeout(r, 1500));

    if (TUNNEL_MODE === 'cloudflare') {
      await startCloudflareTunnel();
    } else {
      await startLocalTunnel();
    }

    resetTunnelBackoff();
    startTunnelHealthCheck();
  } catch (err) {
    console.error('❌ Falha ao criar túnel:', err.message);
    if (!shuttingDown) scheduleTunnelReconnect(err.message);
  } finally {
    tunnelStarting = false;
  }
}

// --- Express ---
const app = express();
const uploadFolder = isPkg
  ? path.join(process.cwd(), 'uploads')
  : path.join(__dirname, 'uploads');

if (!fs.existsSync(uploadFolder)) {
  fs.mkdirSync(uploadFolder, { recursive: true });
}

const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadFolder),
  filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname),
});
const upload = multer({
  storage,
  limits: { fileSize: MAX_UPLOAD_BYTES },
});

function safeUploadFilename(originalName) {
  const base = path.basename(originalName || 'arquivo').replace(/[^\w.\-()+ ]/g, '_');
  return `${Date.now()}-${base}`;
}

const pendingUploads = new Map();
const UPLOAD_SESSION_MS = 5 * 60 * 1000;

function clearPendingUpload(id) {
  const pending = pendingUploads.get(id);
  if (!pending) return;
  if (pending.timer) clearTimeout(pending.timer);
  pendingUploads.delete(id);
}

function saveUploadedBuffer(originalName, buffer, cb) {
  if (!buffer || buffer.length === 0) {
    return cb(new Error('Arquivo vazio.'));
  }
  if (buffer.length > MAX_UPLOAD_BYTES) {
    return cb(new Error(`Arquivo excede ${MAX_UPLOAD_BYTES / 1024 / 1024} MB.`));
  }
  const filename = safeUploadFilename(originalName);
  const filepath = path.join(uploadFolder, filename);
  fs.writeFile(filepath, buffer, (err) => {
    if (err) return cb(err);
    console.log(`📂 Arquivo enviado: ${filename}`);
    broadcast({ type: 'filesUpdated' });
    cb(null, filename);
  });
}

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    tunnel: tunnelUrl,
    tunnelMode: TUNNEL_MODE,
    clients: clients.size,
  });
});

app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(uploadFolder));

app.post('/upload', (req, res) => {
  upload.single('file')(req, res, (err) => {
    if (err) {
      console.error('Upload HTTP:', err.message);
      return res.status(400).send(err.message);
    }
    if (!req.file) return res.status(400).send('Nenhum arquivo enviado.');
    console.log(`📂 Arquivo enviado: ${req.file.filename}`);
    broadcast({ type: 'filesUpdated' });
    res.send('Upload concluído!');
  });
});

app.get('/uploads', (req, res) => {
  fs.readdir(uploadFolder, { withFileTypes: true }, (err, entries) => {
    if (err) {
      console.error('Erro ao listar uploads:', err);
      return res.status(500).json([]);
    }

    const files = entries
      .filter((entry) => entry.isFile() && !entry.name.startsWith('.'))
      .map((entry) => entry.name);

    res.json(files);
  });
});

app.delete('/uploads/:filename', (req, res) => {
  const filename = req.params.filename;
  const filepath = path.normalize(path.join(uploadFolder, filename));

  if (!filepath.startsWith(uploadFolder)) {
    console.warn('⚠️ Tentativa de acesso fora da pasta de uploads:', filepath);
    return res.status(400).send('Caminho inválido.');
  }

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

// --- HTTP + WebSocket ---
serverInstance = http.createServer(app);
const WS_CHUNK_MAX = 512 * 1024;

const wss = new WebSocket.Server({
  server: serverInstance,
  maxPayload: WS_CHUNK_MAX + 64 * 1024,
});

let currentText = loadState();

wss.on('connection', (ws) => {
  ws.isAlive = true;
  clients.add(ws);

  ws.send(JSON.stringify({ type: 'init', text: currentText }));

  ws.on('pong', () => {
    ws.isAlive = true;
  });

  ws.on('message', (message) => {
    let data;
    try {
      data = JSON.parse(message);
    } catch {
      return;
    }
    if (data.type === 'ping') return;

    if (data.type === 'uploadStart') {
      const { id, name, size, totalChunks } = data;
      if (
        typeof id !== 'string' ||
        typeof name !== 'string' ||
        typeof size !== 'number' ||
        typeof totalChunks !== 'number' ||
        size <= 0 ||
        size > MAX_UPLOAD_BYTES ||
        totalChunks < 1 ||
        totalChunks > 10000
      ) {
        ws.send(JSON.stringify({ type: 'uploadDone', id, ok: false, error: 'Upload inválido.' }));
        return;
      }
      clearPendingUpload(id);
      pendingUploads.set(id, {
        name,
        size,
        totalChunks,
        chunks: new Array(totalChunks),
        received: 0,
        ws,
        timer: setTimeout(() => clearPendingUpload(id), UPLOAD_SESSION_MS),
      });
      ws.send(JSON.stringify({ type: 'uploadProgress', id, percent: 0 }));
      return;
    }

    if (data.type === 'uploadChunk') {
      const { id, index, data: chunkData } = data;
      const pending = pendingUploads.get(id);
      if (
        !pending ||
        pending.ws !== ws ||
        typeof index !== 'number' ||
        typeof chunkData !== 'string' ||
        index < 0 ||
        index >= pending.totalChunks
      ) {
        return;
      }
      if (pending.chunks[index]) return;

      let chunk;
      try {
        chunk = Buffer.from(chunkData, 'base64');
      } catch {
        ws.send(JSON.stringify({ type: 'uploadDone', id, ok: false, error: 'Chunk inválido.' }));
        clearPendingUpload(id);
        return;
      }

      pending.chunks[index] = chunk;
      pending.received++;
      const percent = Math.min(99, Math.round((pending.received / pending.totalChunks) * 100));
      ws.send(JSON.stringify({ type: 'uploadProgress', id, percent }));
      return;
    }

    if (data.type === 'uploadEnd') {
      const { id } = data;
      const pending = pendingUploads.get(id);
      if (!pending || pending.ws !== ws) {
        ws.send(JSON.stringify({ type: 'uploadDone', id, ok: false, error: 'Sessão de upload não encontrada.' }));
        return;
      }
      clearPendingUpload(id);

      if (pending.received !== pending.totalChunks || pending.chunks.some((c) => !c)) {
        ws.send(JSON.stringify({ type: 'uploadDone', id, ok: false, error: 'Upload incompleto.' }));
        return;
      }

      const buffer = Buffer.concat(pending.chunks);
      saveUploadedBuffer(pending.name, buffer, (err, filename) => {
        if (err) {
          ws.send(JSON.stringify({ type: 'uploadDone', id, ok: false, error: err.message }));
          return;
        }
        ws.send(JSON.stringify({ type: 'uploadProgress', id, percent: 100 }));
        ws.send(JSON.stringify({ type: 'uploadDone', id, ok: true, filename }));
      });
      return;
    }

    if (data.type === 'uploadFile') {
      const uploadId = `legacy-${Date.now()}`;
      if (typeof data.name !== 'string' || typeof data.data !== 'string') {
        ws.send(JSON.stringify({ type: 'uploadDone', id: uploadId, ok: false, error: 'Dados inválidos.' }));
        return;
      }
      let buffer;
      try {
        buffer = Buffer.from(data.data, 'base64');
      } catch {
        ws.send(JSON.stringify({ type: 'uploadDone', id: uploadId, ok: false, error: 'Base64 inválido.' }));
        return;
      }
      saveUploadedBuffer(data.name, buffer, (err, filename) => {
        if (err) {
          ws.send(JSON.stringify({ type: 'uploadDone', id: uploadId, ok: false, error: err.message }));
          return;
        }
        ws.send(JSON.stringify({ type: 'uploadDone', id: uploadId, ok: true, filename }));
      });
      return;
    }

    if (data.type === 'update' && typeof data.text === 'string') {
      currentText = data.text;
      scheduleSaveState(currentText);
      clients.forEach((client) => {
        if (client !== ws && client.readyState === WebSocket.OPEN) {
          client.send(JSON.stringify({ type: 'update', text: currentText }));
        }
      });
    }
  });

  ws.on('close', () => {
    clients.delete(ws);
    for (const [id, pending] of pendingUploads) {
      if (pending.ws === ws) clearPendingUpload(id);
    }
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

// --- Main ---
(async () => {
  console.log(`📌 Subdomínio: ${SUBDOMAIN}`);
  console.log(`📌 Porta: ${PORT}`);
  console.log(`📌 Túnel: ${TUNNEL_MODE}${TUNNEL_MODE === 'lt' ? ` (${TUNNEL_HOST})` : ''}`);
  if (currentText) console.log('📄 Estado anterior restaurado do disco.');

  await killPortIfBusy(PORT);
  serverInstance.listen(PORT, async () => {
    console.log(`🚀 Servidor: http://localhost:${PORT}`);
    if (TUNNEL_MODE === 'none') {
      console.log('ℹ️ Modo sem túnel — use IP da máquina na mesma rede, ex.: http://192.168.x.x:' + PORT);
      return;
    }
    await waitForPortToBeListening(PORT);
    await startTunnel();
  });
})();
