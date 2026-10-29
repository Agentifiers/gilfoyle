import { afterAll, expect, test } from 'bun:test'
import http from 'node:http'
import net from 'node:net'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

process.env.GILFOYLE_DATA = mkdtempSync(join(tmpdir(), 'gilfoyle-'))
// Imported after GILFOYLE_DATA is set: config.ts reads it when it loads.
const { allowedAddress, startEgress } = await import('./browser.ts')

test.each([
  ['93.184.215.14', true],
  ['2606:4700::6810:85e5', true],
  ['127.0.0.1', true], // the container's own dev servers
  ['::1', true],
  ['169.254.169.254', false], // EC2 metadata
  ['169.254.170.23', false], // EKS Pod Identity
  ['fd00:ec2::254', false], // EC2 metadata over IPv6
  ['10.0.0.1', false],
  ['172.17.0.1', false], // Docker bridge gateway
  ['192.168.1.1', false],
  ['100.64.0.1', false],
  ['0.250.250.254', false], // OrbStack's host.docker.internal
  ['0.0.0.0', false],
  ['::ffff:10.0.0.1', false], // IPv4-mapped private
  ['::ffff:127.0.0.1', true],
  ['64:ff9b::a9fe:a9fe', false], // NAT64 of the metadata address
  ['fe80::1', false],
  ['not-an-ip', false],
])('allowedAddress(%p) is %p', (ip, allowed) => {
  expect(allowedAddress(ip)).toBe(allowed)
})

const denied: string[] = []
const proxyPort = await startEgress((host, port) => denied.push(`${host}:${port}`))
const site = http.createServer((req, res) => res.end(`site saw ${req.headers.host}${req.url}`))
const listening = Promise.withResolvers<void>()
site.listen(0, '127.0.0.1', () => listening.resolve())
await listening.promise
const address = site.address()
if (!address || typeof address === 'string') throw new Error('test site has no port')
const sitePort = address.port
afterAll(() => site.close())

/** Sends a CONNECT for `authority` through the guard and returns its status line. */
async function connect(authority: string): Promise<string> {
  const { promise, resolve } = Promise.withResolvers<string>()
  const socket = net.connect(proxyPort, '127.0.0.1', () => socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`))
  socket.once('data', d => { resolve(d.toString().split('\r\n')[0]); socket.destroy() })
  return promise
}

/** Fetches `url` through the guard the way a browser does over plain HTTP. */
async function get(url: string): Promise<{ status: number; body: string }> {
  const { promise, resolve } = Promise.withResolvers<{ status: number; body: string }>()
  http.get({ host: '127.0.0.1', port: proxyPort, path: url, headers: { host: new URL(url).host } }, res => {
    let body = ''
    res.on('data', d => (body += d))
    res.on('end', () => resolve({ status: res.statusCode ?? 0, body }))
  })
  return promise
}

test('tunnels to an allowed address', async () => {
  expect(await connect(`127.0.0.1:${sitePort}`)).toBe('HTTP/1.1 200 Connection Established')
})

test('refuses tunnels to metadata, private and host addresses without connecting', async () => {
  expect(await connect('169.254.169.254:80')).toBe('HTTP/1.1 403 Forbidden')
  expect(await connect('[fd00:ec2::254]:80')).toBe('HTTP/1.1 403 Forbidden')
  expect(await connect('0.250.250.254:8319')).toBe('HTTP/1.1 403 Forbidden')
  expect(denied).toContain('169.254.169.254:80')
  expect(denied).toContain('fd00:ec2::254:80')
})

test('refuses a tunnel back into the guard itself', async () => {
  expect(await connect(`127.0.0.1:${proxyPort}`)).toBe('HTTP/1.1 403 Forbidden')
})

test('forwards plain HTTP to an allowed host, keeping its Host header', async () => {
  const res = await get(`http://localhost:${sitePort}/page?q=1`)
  expect(res).toEqual({ status: 200, body: `site saw localhost:${sitePort}/page?q=1` })
})

test('refuses plain HTTP to a private address', async () => {
  expect((await get('http://10.0.0.1/latest/meta-data/')).status).toBe(403)
})
