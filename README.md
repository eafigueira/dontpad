# Code Mirror

Editor compartilhado em tempo real (estilo dontpad): o que você digita ou envia por upload aparece em todas as abas/dispositivos conectados via WebSocket.

## Uso

```bash
node launcher.js <subdominio> <porta> [modo-tunel]
```

> **loca.lt:** reserva o subdomínio pedido quando está livre (`https://eafigueira.loca.lt`). Se já estiver em uso (outra instância sua ou de outra pessoa), o servidor devolve um nome aleatório — o launcher **rejeita** isso e fica tentando até liberar.

| Modo | Descrição |
|------|-----------|
| `lt` (padrão) | Expõe via [loca.lt](https://loca.lt) — mesmo fluxo de antes, com reconexão melhorada |
| `cloudflare` | Usa `cloudflared tunnel` (URL `*.trycloudflare.com`) — **recomendado se loca.lt cair muito** |
| `none` | Só `localhost` / rede local (sem túnel público) |

Exemplos:

```bash
node launcher.js meu-pad 3000
node launcher.js meu-pad 3000 cloudflare
node launcher.js meu-pad 3000 none
```

Variáveis de ambiente opcionais:

- `TUNNEL_MODE` — mesmo que o 3º argumento (`lt`, `cloudflare`, `none`)
- `TUNNEL_HOST` — servidor localtunnel (padrão: `https://loca.lt`)
- `TUNNEL_RELEASE_TOKEN` — token opcional para `DELETE /api/tunnels/{subdominio}` ao encerrar (não documentado publicamente pelo loca.lt)

### API do loca.lt usada pelo launcher

| Momento | Chamada | Interpretação |
|---------|---------|----------------|
| Antes de conectar | `GET /api/tunnels/{nome}/status` | `404` = livre · `200` = em uso |
| Ao encerrar (Ctrl+C) | `tunnel.close()` + nova verificação de status | confirma se liberou |
| Opcional ao encerrar | `DELETE /api/tunnels/{nome}` + `Authorization: Bearer …` | só se `TUNNEL_RELEASE_TOKEN` estiver definido |

## Cloudflare (mais estável)

1. Instale o [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/install-and-setup/installation/) e deixe no `PATH`.
2. Inicie com modo `cloudflare`:

```bash
node launcher.js meu-pad 3000 cloudflare
```

A URL pública aparece no console (muda a cada execução no quick tunnel).

## O que mudou na estabilidade

- **Servidor:** backoff exponencial na reconexão do túnel, evita várias reconexões ao mesmo tempo, health check a cada 45s e reconexão proativa se o túnel parar de responder.
- **Cliente:** WebSocket reconecta sem recarregar a página; indicador Online/Offline na barra superior; debounce de 200ms nas digitações.
- **Estado:** texto salvo em `state.json` (restaurado ao reiniciar o servidor).

## Build executável

```bash
npx pkg .
```

Gera `editor.exe` conforme `package.json`.
