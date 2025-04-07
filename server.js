const http = require('http');
const express = require('express');
const WebSocket = require('ws');
const path = require('path');

const app = express();
const PORT = process.env.PORT

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const interval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) {
      console.log('⚠️ Cliente desconectado por inatividade');
      return ws.terminate();
    }

    ws.isAlive = false;
    ws.ping(); // Envia um ping
  });
}, 30000); // a cada 30 segundos



let currentText = '';
const clients = new Set();

app.use(express.static(path.join(__dirname, 'public')));

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => {
    ws.isAlive = true;
  });

  clients.add(ws);
  console.log('Cliente conectado via WS');


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
    console.log('Cliente desconectado');
  });
});

process.on('SIGINT', () => {
  console.log("Encerrando servidor...");
  clearInterval(interval);
  server.close(() => process.exit(0));
});

server.listen(PORT, () => {
  console.log(`Servidor rodando em http://localhost:${PORT}`);
});
