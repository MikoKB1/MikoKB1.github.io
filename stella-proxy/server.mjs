import { createHash, timingSafeEqual } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'

const accountId = process.env.CLOUDFLARE_ACCOUNT_ID
const apiToken = process.env.CLOUDFLARE_API_TOKEN
const passphrase = process.env.PROXY_PASSPHRASE
const allowedOrigin = process.env.ALLOWED_ORIGIN || '*'
const port = Number(process.env.PORT) || 8787
const defaultVoice = process.env.EDGE_VOICE || 'en-US-AnaNeural'
// The Python edge-tts command is tried first. Set EDGE_TTS_COMMAND to its full path if it is not on the PATH.
const edgeTtsCommand = process.env.EDGE_TTS_COMMAND || 'edge-tts'

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
  // The speech model. AIRI lists speech models by looking for "tts" in the model ID.
  ['edge-tts', 'microsoft'],
].map(([id, owned_by]) => ({ id, object: 'model', owned_by }))

const edgeVoicePattern = /^[a-z]{2,3}-[A-Z]{2}-\w+Neural$/
const maxSpeechChars = 5000
const speechAttempts = 3
const speechTimeoutMs = Number(process.env.VOICE_TIMEOUT_MS) || 15000

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

function speedToRate(speed) {
  const value = Number(speed)
  if (!Number.isFinite(value) || value <= 0)
    return '+0%'
  const percent = Math.round((Math.min(Math.max(value, 0.5), 2) - 1) * 100)
  return `${percent >= 0 ? '+' : ''}${percent}%`
}

async function synthesizeOnce(EdgeTTS, text, voice, rate) {
  const tts = new EdgeTTS(text, voice, { rate, volume: '+0%', pitch: '+0Hz' })
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('The voice service did not answer in time.')), speechTimeoutMs)
  })
  try {
    const result = await Promise.race([tts.synthesize(), timeout])
    return Buffer.from(await result.audio.arrayBuffer())
  }
  finally {
    clearTimeout(timer)
  }
}

// Run the Python edge-tts command. Returns undefined when the command is not installed.
async function synthesizeWithCommand(text, voice, rate) {
  const dir = await mkdtemp(join(tmpdir(), 'stella-voice-'))
  const textFile = join(dir, 'input.txt')
  const audioFile = join(dir, 'output.mp3')
  try {
    await writeFile(textFile, text, 'utf8')
    // The = form keeps a negative rate such as -20% from reading as an option.
    const args = ['--voice', voice, `--rate=${rate}`, '--file', textFile, '--write-media', audioFile]
    await new Promise((resolve, reject) => {
      execFile(edgeTtsCommand, args, { timeout: speechTimeoutMs }, (error, _stdout, stderr) => {
        if (error)
          reject(Object.assign(new Error(error.code === 'ENOENT' ? 'not installed' : (stderr.trim().split('\n').pop() || error.message)), { code: error.code }))
        else
          resolve()
      })
    })
    return await readFile(audioFile)
  }
  catch (error) {
    if (error.code === 'ENOENT')
      return undefined
    throw error
  }
  finally {
    await rm(dir, { recursive: true, force: true })
  }
}

// Same request shape as the OpenAI speech API. Any voice that is not an Edge voice name uses the default voice.
async function handleSpeech(request, response) {
  let payload
  try {
    payload = JSON.parse(await readBody(request))
  }
  catch {
    return sendError(response, 400, 'The request body must be JSON under 1 MB.')
  }

  const text = typeof payload.input === 'string' ? payload.input.trim() : ''
  if (!text || text.length > maxSpeechChars)
    return sendError(response, 400, `The input must be text with 1 to ${maxSpeechChars} characters.`)

  const voice = typeof payload.voice === 'string' && edgeVoicePattern.test(payload.voice) ? payload.voice : defaultVoice
  const rate = speedToRate(payload.speed)

  // Try the Python command first. If it is not installed, use the Node package.
  let EdgeTTS
  let commandInstalled = true

  // Microsoft's voice service drops a request now and then. Try again a few times, as old Stella did.
  for (let attempt = 1; attempt <= speechAttempts; attempt++) {
    try {
      let audio = commandInstalled ? await synthesizeWithCommand(text, voice, rate) : undefined
      if (audio === undefined) {
        commandInstalled = false
        if (!EdgeTTS) {
          try {
            ({ EdgeTTS } = await import('edge-tts-universal'))
          }
          catch {
            return sendError(response, 500, 'No voice found. Install the Python edge-tts command, or run npm install in the stella-proxy folder.')
          }
        }
        audio = await synthesizeOnce(EdgeTTS, text, voice, rate)
      }
      if (audio.length > 0) {
        response.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Content-Length': audio.length, 'Cache-Control': 'no-store' })
        return response.end(audio)
      }
    }
    catch (error) {
      console.error(`Voice attempt ${attempt} failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (attempt < speechAttempts)
      await new Promise(resolve => setTimeout(resolve, 300))
  }
  return sendError(response, 502, 'The voice service did not answer.')
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

  if (request.method === 'POST' && pathname === '/v1/audio/speech')
    return handleSpeech(request, response)

  return sendError(response, 404, 'Not found.')
})

server.listen(port, () => console.log(`Stella proxy listens on port ${port}.`))
