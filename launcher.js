const { exec } = require('child_process');
const { promisify } = require('util');
const localtunnel = require('localtunnel');

const run = promisify(exec);

const SUBDOMAIN = process.argv[2];
const PORT = process.argv[3];

if (!SUBDOMAIN) {
  console.error('⚠️ Subdomínio não fornecido. Forneça <subdomínio> [porta]');
  process.exit(1);
}

if (!PORT) {
  console.error('⚠️ Porta não fornecida. Forneça <subdomínio> [porta]');
  process.exit(2);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function killPortIfBusy(port) {
  console.log(`🔍 Verificando se a porta ${port} está em uso...`);
  const { stdout } = await run(`netstat -aon | findstr :${port}`).catch(() => ({ stdout: '' }));

  const lines = stdout.trim().split('\n').filter(Boolean);

  for (const line of lines) {
    const parts = line.trim().split(/\s+/);
    const pid = parts[parts.length - 1]; // último campo é o PID
    if (pid && !isNaN(pid)) {
      console.log(`⚠️ Porta ${port} em uso. Finalizando PID ${pid}...`);
      await run(`taskkill /PID ${pid} /F`).catch(() => {
        console.warn(`⚠️ Falha ao matar o PID ${pid}. Pode já ter sido finalizado.`);
      });
    }
  }

  if (!lines.length) {
    console.log(`✅ Porta ${port} está livre.`);
  }
}


async function startTunnel() {
  try {
    const tunnel = await localtunnel({ port: PORT, subdomain: SUBDOMAIN });

    console.log(`🔗 Tunnel ativo em: ${tunnel.url}`);

    try {
      const { stdout: pwd } = await run(`curl -s https://loca.lt/mytunnelpassword`);
      const password = pwd.trim();
      console.log(`🔐 Tunnel Password: ${password}`);
    } catch (e) {
      console.warn('⚠️ Falha ao obter a senha do túnel.');
    }

    tunnel.on('close', () => {
      console.warn('⛔ Tunnel foi fechado. Tentando reconectar em 10s...');
      setTimeout(startTunnel, 10000);
    });

    tunnel.on('error', (err) => {
      console.error('❌ Erro no tunnel:', err.message);
      console.log('⏳ Tentando reconectar em 10s...');
      setTimeout(startTunnel, 10000);
    });

  } catch (err) {
    console.error('❌ Erro ao iniciar túnel:', err.message);
    console.log('⏳ Tentando reconectar em 10s...');
    setTimeout(startTunnel, 10000);
  }
}

async function main() {
  console.log(`📌 Subdomínio: ${SUBDOMAIN}`);
  console.log(`📌 Porta: ${PORT}`);

  await killPortIfBusy(PORT);

  console.log(`🚀 Iniciando servidor...`);
  run(`set PORT=${PORT} && node server.js`);
  await sleep(2000);

  console.log(`🌐 Iniciando túnel com o LocalTunnel...`);
  await startTunnel();
}

main();
