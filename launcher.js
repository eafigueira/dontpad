const { exec } = require('child_process');
const { promisify } = require('util');
const localtunnel = require('localtunnel');

const run = promisify(exec);

const SUBDOMAIN = process.argv[2]
const PORT = process.argv[3]
if (!SUBDOMAIN) {
  console.error('⚠️ Subdomínio não fornecido. Forneca <subdomínio> [porta]');
  process.exit(1);
}
if (!PORT) {
  console.error('⚠️ Porta não fornecida. Forneca <subdomínio> [porta]');
  process.exit(2);
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function killPortIfBusy(port) {
  const { stdout } = await run(`netstat -aon | findstr :${port} | findstr LISTENING`).catch(() => ({ stdout: '' }));
  if (stdout) {
    const match = stdout.match(/LISTENING\s+(\d+)/);
    if (match) {
      const pid = match[1];
      console.log(`⚠️ Porta ${port} em uso. Finalizando PID ${pid}...`);
      await run(`taskkill /PID ${pid} /F`);
    }
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

  const tunnel = await localtunnel({ port: PORT, subdomain: SUBDOMAIN });

  console.log(`🔗 Tunnel ativo em: ${tunnel.url}`);

  const { stdout: pwd } = await run(`curl -s https://loca.lt/mytunnelpassword`);
  const password = pwd.trim();

  console.log(`🔐 Tunnel Password: ${password}`);

  tunnel.on('close', () => {
    console.log('⛔ Tunnel fechado.');
  });
}

main();
