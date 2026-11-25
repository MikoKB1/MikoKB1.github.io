# stella-proxy

A small proxy for a browser app. It gives the app Cloudflare Workers AI for chat and Microsoft Edge voices for speech.

## What it does

Cloudflare blocks direct calls to its AI API from a web page. This proxy runs on a server instead.
It holds the Cloudflare token, checks a passphrase, and passes chat requests to Cloudflare.
A browser also cannot open the Edge voice service, so the proxy makes the speech audio and returns it.

## Use it

Run `npm install` once, then `node server.mjs` with these environment variables:

| Name | Meaning |
| --- | --- |
| `CLOUDFLARE_ACCOUNT_ID` | The Cloudflare account ID. |
| `CLOUDFLARE_API_TOKEN` | A Cloudflare API token with Workers AI access. |
| `PROXY_PASSPHRASE` | The passphrase that the app sends as its API key. |
| `ALLOWED_ORIGIN` | The address of the site that calls the proxy. The default is any site. |
| `EDGE_VOICE` | The Edge voice. The default is `en-US-AnaNeural`. |
| `PORT` | The port. The default is 8787. |

In the app, use the OpenAI Compatible provider. Set the base URL to the proxy address with `/v1` at the end.
Set the API key to the passphrase. Use a model ID that starts with `@cf/`.

For speech, use the OpenAI Compatible speech provider. Set the base URL to the proxy address with `/v1/` at the end.
Set the API key to the passphrase and the model to `edge-tts`. A voice name that is not an Edge voice uses `EDGE_VOICE`.

## Routes

- `GET /healthz` returns `{"ok":true}` and needs no passphrase.
- `GET /v1/models` lists the Workers AI chat models.
- `POST /v1/chat/completions` sends a chat request to Cloudflare. It supports streaming.
- `POST /v1/audio/speech` returns an MP3 for the `input` text. It reads `voice` and `speed`.

## When not to use it

The proxy has no rate limit. Anyone with the passphrase can use your Cloudflare quota.
Use a long passphrase and do not share it.
