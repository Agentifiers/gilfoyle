/**
 * The agent's browser: Playwright MCP driving headless Chromium, with guardrails
 * Playwright doesn't provide (its origin lists are "not a security boundary"):
 *
 * - Egress guard. Every browser request goes through a forward proxy here that
 *   resolves the host once, refuses private, link-local, metadata and other
 *   non-public addresses, and connects to the address it checked. A page can't
 *   reach the cloud metadata service, the cluster or Docker network, or the
 *   machine running the container. The container's own localhost stays open, for
 *   dev servers the agent starts in a world.
 * - No secrets. The MCP server and Chromium start from an empty environment, so
 *   GH_TOKEN, the Slack tokens and model keys never enter them.
 * - Fewer tools. Running code in the Playwright process (RCE by design) and
 *   handing local files to a page are removed from the agent's tool list. Pages
 *   can't register tools of their own (WebMCP) or install service workers.
 * - A fresh in-memory profile per session: no cookies or logins carry over.
 */

import http from 'node:http'
import net from 'node:net'
import { lookup } from 'node:dns/promises'
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { STATE_DIR } from './config.ts'

/** Browser tools the agent never gets. */
export const DISALLOWED_TOOLS = [
  'mcp__browser__browser_run_code_unsafe', // runs arbitrary JavaScript in the MCP server process
  'mcp__browser__browser_file_upload', // hands local files to a page
  'mcp__browser__browser_drop', // same, by drag and drop
]

const BLOCKED = new net.BlockList()
for (const [prefix, bits] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24],
  ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) BLOCKED.addSubnet(prefix, bits, 'ipv4')
// IPv4-mapped addresses are checked against the IPv4 ranges by BlockList itself. NAT64, 6to4 and
// Teredo embed an IPv4 address, so they're refused whole rather than unpacked.
for (const [prefix, bits] of [
  ['::', 128], ['64:ff9b::', 96], ['64:ff9b:1::', 48], ['100::', 64], ['2001::', 32], ['2001:db8::', 32], ['2002::', 16],
  ['fc00::', 7], ['fe80::', 10], ['ff00::', 8],
] as const) BLOCKED.addSubnet(prefix, bits, 'ipv6')
const LOOPBACK = new net.BlockList()
LOOPBACK.addSubnet('127.0.0.0', 8, 'ipv4')
LOOPBACK.addAddress('::1', 'ipv6')

/** Whether the browser may connect to `ip`: a public address, or this container's own loopback. */
export function allowedAddress(ip: string): boolean {
  const version = net.isIP(ip)
  if (!version) return false
  const family = version === 6 ? 'ipv6' : 'ipv4'
  return LOOPBACK.check(ip, family) || !BLOCKED.check(ip, family)
}

/** `host:port` or `[v6]:port` from a CONNECT line. */
function parseConnect(authority: string): { host: string; port: number } | undefined {
  const m = /^(?:\[([^\]]+)\]|([^:[\]]+)):(\d{1,5})$/.exec(authority)
  const port = Number(m?.[3])
  return m && port > 0 && port < 65536 ? { host: m[1] ?? m[2], port } : undefined
}

/** Connects to the first address that answers, the way a browser falls back from ::1 to 127.0.0.1. */
async function connectAny(addresses: string[], port: number): Promise<net.Socket | undefined> {
  for (const ip of addresses) {
    const socket = net.connect(port, ip)
    const { promise, resolve } = Promise.withResolvers<boolean>()
    socket.once('connect', () => resolve(true))
    socket.once('error', () => resolve(false))
    if (await promise) return socket
    socket.destroy()
  }
  return undefined
}

const HOP_BY_HOP = ['connection', 'keep-alive', 'proxy-authorization', 'proxy-connection', 'te', 'trailer', 'upgrade']

type Vetted = { kind: 'allowed'; addresses: string[] } | { kind: 'denied' } | { kind: 'unresolved' }

/**
 * Starts the egress guard on a free loopback port and resolves with the port.
 * `onDeny` hears about each refused destination.
 */
export function startEgress(onDeny: (host: string, port: number) => void): Promise<number> {
  const server = http.createServer()
  let self = 0

  /** Resolves `host` once. Allowed only if every answer is; the caller connects to these exact addresses. */
  async function vet(host: string, port: number): Promise<Vetted> {
    const addresses = net.isIP(host) ? [host] : await lookup(host, { all: true }).then(r => r.map(a => a.address), () => [])
    if (!addresses.length) return { kind: 'unresolved' }
    const loopsBack = port === self && addresses.some(a => LOOPBACK.check(a, net.isIP(a) === 6 ? 'ipv6' : 'ipv4'))
    if (loopsBack || !addresses.every(allowedAddress)) {
      onDeny(host, port)
      return { kind: 'denied' }
    }
    return { kind: 'allowed', addresses }
  }

  server.on('connect', async (req: http.IncomingMessage, client: net.Socket, head: Buffer) => {
    client.on('error', () => {})
    const target = parseConnect(req.url ?? '')
    if (!target) return void client.end('HTTP/1.1 400 Bad Request\r\n\r\n')
    const vetted = await vet(target.host, target.port)
    if (vetted.kind !== 'allowed') return void client.end(vetted.kind === 'denied' ? 'HTTP/1.1 403 Forbidden\r\n\r\n' : 'HTTP/1.1 502 Bad Gateway\r\n\r\n')
    const upstream = await connectAny(vetted.addresses, target.port)
    if (!upstream) return void client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n')
    if (client.destroyed) return void upstream.destroy()
    upstream.on('error', () => client.destroy())
    client.on('close', () => upstream.destroy())
    client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
    upstream.write(head)
    upstream.pipe(client)
    client.pipe(upstream)
  })

  server.on('request', async (req, res) => {
    const url = URL.canParse(req.url ?? '') ? new URL(req.url ?? '') : undefined
    if (url?.protocol !== 'http:') return void res.writeHead(400).end()
    const port = Number(url.port || 80)
    const vetted = await vet(url.hostname.replace(/^\[(.*)\]$/, '$1'), port)
    if (vetted.kind === 'denied') return void res.writeHead(403, { 'content-type': 'text/plain' }).end('Blocked by the Gilfoyle egress guard: not a public address.\n')
    const socket = vetted.kind === 'allowed' ? await connectAny(vetted.addresses, port) : undefined
    if (!socket) return void res.writeHead(502).end()
    const headers = { ...req.headers }
    for (const h of HOP_BY_HOP) delete headers[h]
    const upstream = http.request({ createConnection: () => socket, method: req.method, path: url.pathname + url.search, headers }, up => {
      res.writeHead(up.statusCode ?? 502, up.headers)
      up.pipe(res)
    })
    upstream.on('error', () => (res.headersSent ? res.destroy() : res.writeHead(502).end()))
    req.pipe(upstream)
  })

  const { promise, resolve, reject } = Promise.withResolvers<number>()
  server.once('error', reject)
  server.listen(0, '127.0.0.1', () => {
    const address = server.address()
    if (!address || typeof address === 'string') return reject(new Error('egress guard has no port'))
    self = address.port
    resolve(self)
  })
  return promise
}

/** The MCP server entry for the agent's sessions, after starting the egress guard and writing Playwright MCP's config. */
export async function start(options: { outputDir: string; onDeny: (host: string, port: number) => void }) {
  const port = await startEgress(options.onDeny)
  mkdirSync(options.outputDir, { recursive: true })
  const configFile = join(STATE_DIR, 'playwright-mcp.json')
  writeFileSync(configFile, JSON.stringify({
    browser: {
      browserName: 'chromium',
      isolated: true,
      launchOptions: {
        headless: true,
        // Playwright proxies loopback too unless told otherwise, so localhost goes through the guard like everything else.
        proxy: { server: `http://127.0.0.1:${port}` },
        // WebRTC would otherwise send UDP straight past the proxy.
        args: ['--force-webrtc-ip-handling-policy=disable_non_proxied_udp'],
      },
      contextOptions: { serviceWorkers: 'block' },
    },
    webmcp: false,
    outputDir: options.outputDir,
    outputMaxSize: 200 * 1024 * 1024,
    filePaths: 'absolute', // so a screenshot's path can go straight to upload_file
    timeouts: { idle: 10 * 60_000 },
  }, null, 2))
  const env = ['PATH', 'PLAYWRIGHT_BROWSERS_PATH'].flatMap(k => (process.env[k] ? [`${k}=${process.env[k]}`] : []))
  return {
    type: 'stdio' as const,
    command: 'env',
    args: ['-i', ...env, 'HOME=/tmp', 'playwright-mcp', '--config', configFile],
  }
}
