const path = require('path');
const express = require('express');
const WebSocket = require('ws');
const http = require('http');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

let currentText = '';
const clients = new Set();

app.use(express.static(path.join(__dirname, 'public')));

wss.on('connection', ws => {
  clients.add(ws);
  console.log('Cliente conectado');

  ws.send(JSON.stringify({ type: 'init', text: currentText }));

  ws.on('message', message => {
    const data = JSON.parse(message);
    if (data.type === 'update') {
      currentText = data.text;
      for (const client of clients) {
        if (client !== ws && client.readyState === WebSocket.OPEN) {
          client.send(JSON.stringify({ type: 'update', text: data.text }));
        }
      }
    }
  });

  ws.on('close', () => {
    clients.delete(ws);
    console.log('Cliente desconectado');
  });
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
  console.log(`Servidor rodando em http://localhost:${PORT}`);
});
