import { createHash, timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'
import { Readable } from 'node:stream'

const accountId = process.env.CLOUDFLARE_ACCOUNT_ID
const apiToken = process.env.CLOUDFLARE_API_TOKEN
const passphrase = process.env.PROXY_PASSPHRASE
const allowedOrigin = process.env.ALLOWED_ORIGIN || '*'
const port = Number(process.env.PORT) || 8787

if (!accountId || !apiToken || !passphrase) {
  console.error('Set CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN and PROXY_PASSPHRASE.')
  process.exit(1)
}

const upstreamUrl = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/ai/v1/chat/completions`
const maxBodyBytes = 1024 * 1024

const models = [
  ['@cf/meta/llama-3.3-70b-instruct-fp8-fast', 'meta'],
  ['@cf/meta/llama-3.1-8b-instruct', 'meta'],
  ['@cf/meta/llama-4-scout-17b-16e-instruct', 'meta'],
  ['@cf/mistralai/mistral-small-3.1-24b-instruct', 'mistralai'],
  ['@cf/google/gemma-3-12b-it', 'google'],
  ['@cf/openai/gpt-oss-120b', 'openai'],
  ['@cf/openai/gpt-oss-20b', 'openai'],
].map(([id, owned_by]) => ({ id, object: 'model', owned_by }))

function sha256(value) {
  return createHash('sha256').update(value).digest()
}

function isAuthorized(request) {
  const header = request.headers.authorization ?? ''
  const given = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : ''
  return timingSafeEqual(sha256(given), sha256(passphrase))
}

function setCorsHeaders(response) {
  response.setHeader('Access-Control-Allow-Origin', allowedOrigin)
  response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  response.setHeader('Access-Control-Allow-Headers', 'authorization, content-type')
  response.setHeader('Access-Control-Max-Age', '86400')
  response.setHeader('Vary', 'Origin')
}

function sendJson(response, status, body) {
  response.writeHead(status, { 'Content-Type': 'application/json' })
  response.end(JSON.stringify(body))
}

function sendError(response, status, message) {
  sendJson(response, status, { error: { message, type: 'stella_proxy_error' } })
}

async function readBody(request) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > maxBodyBytes)
      throw new Error('Request body is too large.')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}

async function handleChat(request, response) {
  let payload
  try {
    payload = JSON.parse(await readBody(request))
  }
  catch {
    return sendError(response, 400, 'The request body must be JSON under 1 MB.')
  }

  // Only Workers AI models. Other model names can bill other providers through the account.
  if (typeof payload.model !== 'string' || !payload.model.startsWith('@cf/'))
    return sendError(response, 400, 'The model must be a Workers AI model, for example @cf/meta/llama-3.3-70b-instruct-fp8-fast.')

  let upstream
  try {
    upstream = await fetch(upstreamUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    })
  }
  catch {
    return sendError(response, 502, 'Cloudflare did not answer.')
  }

  response.writeHead(upstream.status, {
    'Content-Type': upstream.headers.get('content-type') ?? 'application/json',
    'Cache-Control': 'no-store',
  })
  if (!upstream.body)
    return response.end()

  const stream = Readable.fromWeb(upstream.body)
  stream.on('error', () => response.destroy())
  response.on('close', () => stream.destroy())
  stream.pipe(response)
}

const server = createServer(async (request, response) => {
  setCorsHeaders(response)
  const { pathname } = new URL(request.url ?? '/', 'http://localhost')

  if (request.method === 'OPTIONS') {
    response.writeHead(204)
    return response.end()
  }

  // Render calls this path to check the service. A browser can call it to wake the service.
  if (request.method === 'GET' && pathname === '/healthz')
    return sendJson(response, 200, { ok: true })

  if (!isAuthorized(request))
    return sendError(response, 401, 'The passphrase is wrong.')

  if (request.method === 'GET' && pathname === '/v1/models')
    return sendJson(response, 200, { object: 'list', data: models })

  if (request.method === 'POST' && pathname === '/v1/chat/completions')
    return handleChat(request, response)

  return sendError(response, 404, 'Not found.')
})

server.listen(port, () => console.log(`Stella proxy listens on port ${port}.`))
