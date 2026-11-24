import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { connect as tcpConnect, type Socket } from 'node:net'
import { connect as tlsConnect, type TLSSocket } from 'node:tls'
import { test } from 'node:test'
import type { Server } from 'node:http'
import { startRpcServers } from '../src/rpcServer'
import type { SignerService } from '../src/service'

type Target = {
	name: string
	via: 'tls' | 'proxied' | 'unix'
	server: Server
	port?: number
	socketPath?: string
	tls?: { ca: Buffer; cert: Buffer; key: Buffer }
	invalidTls?: { ca: Buffer; cert: Buffer; key: Buffer }
	identityHeaders?: string[]
	invalidIdentityHeaders?: string[]
}

function makeTestPki(dir: string): { ca: Buffer; serverCert: string; serverKey: string; clientCert: Buffer; clientKey: Buffer; unknownClientCert: Buffer; unknownClientKey: Buffer } {
	const run = (...args: string[]) => execFileSync('openssl', args, { stdio: 'ignore' })
	run('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-keyout', join(dir, 'ca.key'), '-out', join(dir, 'ca.crt'), '-days', '2', '-subj', '/CN=synthetic-rpc-test-ca')
	for (const name of ['server', 'client', 'unknown-client']) {
		run('req', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-keyout', join(dir, `${name}.key`), '-out', join(dir, `${name}.csr`), '-subj', `/CN=synthetic-${name}`)
		const extension = name === 'server'
			? 'subjectAltName=DNS:localhost,IP:127.0.0.1\nextendedKeyUsage=serverAuth\n'
			: 'extendedKeyUsage=clientAuth\n'
		writeFileSync(join(dir, `${name}.ext`), extension)
		run('x509', '-req', '-in', join(dir, `${name}.csr`), '-CA', join(dir, 'ca.crt'), '-CAkey', join(dir, 'ca.key'), '-CAcreateserial', '-sha256', '-out', join(dir, `${name}.crt`), '-days', '2', '-extfile', join(dir, `${name}.ext`))
	}
	return {
		ca: readFileSync(join(dir, 'ca.crt')),
		serverCert: join(dir, 'server.crt'),
		serverKey: join(dir, 'server.key'),
		clientCert: readFileSync(join(dir, 'client.crt')),
		clientKey: readFileSync(join(dir, 'client.key')),
		unknownClientCert: readFileSync(join(dir, 'unknown-client.crt')),
		unknownClientKey: readFileSync(join(dir, 'unknown-client.key')),
	}
}

function waitListening(server: Server): Promise<void> {
	if (server.listening) return Promise.resolve()
	return new Promise((resolve, reject) => {
		server.once('listening', resolve)
		server.once('error', reject)
	})
}

function serverPort(server: Server): number {
	const address = server.address()
	assert.ok(address && typeof address === 'object')
	return address.port
}

function requestRaw(target: Target, extraHeaders: string[] = [], invalidIdentity = false, rpcBody?: string): Promise<{ status: number; headers: Map<string, string>; body: string }> {
	return new Promise((resolve, reject) => {
		let socket: Socket | TLSSocket
		if (target.tls) {
			const credentials = invalidIdentity ? (target.invalidTls ?? target.tls) : target.tls
			socket = tlsConnect({
				host: '127.0.0.1',
				port: target.port!,
				ca: credentials.ca,
				cert: credentials.cert,
				key: credentials.key,
				servername: 'localhost',
				rejectUnauthorized: true,
			})
		} else if (target.socketPath) {
			socket = tcpConnect({ path: target.socketPath })
		} else {
			socket = tcpConnect({ host: '127.0.0.1', port: target.port! })
		}
		const chunks: Buffer[] = []
		let settled = false
		const timeout = setTimeout(() => socket.destroy(new Error('synthetic HTTP test timed out')), 3000)
		const finish = (error?: Error) => {
			if (settled) return
			settled = true
			clearTimeout(timeout)
			if (error) return reject(error)
			const response = Buffer.concat(chunks).toString('latin1')
			const separator = response.indexOf('\r\n\r\n')
			assert.ok(separator >= 0, `complete HTTP response required: ${response}`)
			const [statusLine, ...headerLines] = response.slice(0, separator).split('\r\n')
			const match = /^HTTP\/1\.[01] (\d{3})\b/.exec(statusLine ?? '')
			assert.ok(match, `valid HTTP status line required: ${statusLine}`)
			const headers = new Map<string, string>()
			for (const line of headerLines) {
				const colon = line.indexOf(':')
				if (colon > 0) headers.set(line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim())
			}
			resolve({ status: Number(match[1]), headers, body: response.slice(separator + 4) })
		}
		const ready = () => {
			const identity = invalidIdentity ? (target.invalidIdentityHeaders ?? []) : (target.identityHeaders ?? [])
			const bodyHeaders = rpcBody === undefined ? [] : ['Content-Type: application/json', `Content-Length: ${Buffer.byteLength(rpcBody)}`]
			const lines = [
				rpcBody === undefined ? 'GET /healthz HTTP/1.1' : 'POST / HTTP/1.1',
				target.port ? `Host: 127.0.0.1:${target.port}` : 'Host: synthetic-unix',
				'Connection: close',
				...bodyHeaders,
				...identity,
				...extraHeaders,
				'', rpcBody ?? '',
			]
			socket.write(lines.join('\r\n'), (error) => { if (error) finish(error) })
		}
		if (target.tls) socket.once('secureConnect', ready)
		else socket.once('connect', ready)
		socket.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
		socket.once('end', () => finish())
		socket.once('close', () => finish())
		socket.once('error', (error) => finish(error))
	})
}

test('TLS, proxied, and Unix RPC listeners reject Upgrade headers before identity/auth and preserve ordinary HTTP', { timeout: 30_000 }, async () => {
	const dir = mkdtempSync(join(tmpdir(), 'rpc-upgrade-headers-'))
	let servers: Server[] = []
	try {
		const pki = makeTestPki(dir)
		const token = 'synthetic-proxy-test-token'
		const tokenSha256 = createHash('sha256').update(token).digest('hex')
		const events: Record<string, unknown>[] = []
		const calls = { authorize: 0, policyClient: 0, dispatch: 0 }
		const svc = {
			state: 'locked',
			audit: { write: (event: Record<string, unknown>) => events.push(event) },
			policy: {
				client: () => { calls.policyClient++; return undefined },
				arraysOf: () => [],
			},
			authorizeClient: (client: string) => {
				calls.authorize++
				if (client === 'synthetic-unknown-client') throw new Error('synthetic unauthorized client')
			},
			deniedList: () => { calls.dispatch++; return [] },
			status: () => { calls.dispatch++; return { version: 'synthetic-test' } },
		} as unknown as SignerService
		const socketPath = join(dir, 'rpc.sock')
		servers = startRpcServers(svc, {
			tls: { host: '127.0.0.1', port: 0, cert: pki.serverCert, key: pki.serverKey, ca: join(dir, 'ca.crt') },
			proxied: { host: '127.0.0.1', port: 0, secretSha256: tokenSha256 },
			unix: [{ path: socketPath, client: 'synthetic-unix-client' }],
		})
		await Promise.all(servers.map(waitListening))
		const [tlsServer, proxiedServer, unixServer] = servers
		assert.ok(tlsServer && proxiedServer && unixServer)
		const targets: Target[] = [
			{
				name: 'tls', via: 'tls', server: tlsServer, port: serverPort(tlsServer),
				tls: { ca: pki.ca, cert: pki.clientCert, key: pki.clientKey },
				invalidTls: { ca: pki.ca, cert: pki.unknownClientCert, key: pki.unknownClientKey },
			},
			{
				name: 'proxied', via: 'proxied', server: proxiedServer, port: serverPort(proxiedServer),
				identityHeaders: ['X-WS-Client-CN: synthetic-proxy-client', 'X-WS-Client-Verify: SUCCESS', `X-WS-Proxy-Auth: ${token}`],
				invalidIdentityHeaders: ['X-WS-Client-CN: synthetic-proxy-client', 'X-WS-Client-Verify: FAIL', 'X-WS-Proxy-Auth: deliberately-wrong'],
			},
			{
				name: 'unix', via: 'unix', server: unixServer, socketPath,
			},
		]

		for (const target of targets) {
			const before = { ...calls }
			const normal = await requestRaw(target)
			assert.equal(normal.status, 200, `${target.name} normal HTTP status`)
			assert.deepEqual(JSON.parse(normal.body), { state: 'locked' }, `${target.name} ordinary health response`)
			assert.equal(calls.authorize, before.authorize + 1, `${target.name} ordinary request reaches authorization`)
			assert.equal(calls.policyClient, before.policyClient + 1, `${target.name} ordinary request reaches policy lookup`)

			const beforeRpc = { ...calls }
			const rpc = await requestRaw(target, [], false, JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'signer_status', params: [] }))
			assert.equal(rpc.status, 200, `${target.name} ordinary JSON-RPC status`)
			assert.deepEqual(JSON.parse(rpc.body), {
				jsonrpc: '2.0',
				id: 2,
				result: { state: 'locked', version: 'synthetic-test', arrays: [], denied: [], compromised: [] },
			}, `${target.name} ordinary signer_status dispatch`)
			assert.equal(calls.authorize, beforeRpc.authorize + 1, `${target.name} normal RPC reaches authorization`)
			assert.equal(calls.policyClient, beforeRpc.policyClient + 1, `${target.name} normal RPC reaches policy lookup`)
			assert.equal(calls.dispatch, beforeRpc.dispatch + 2, `${target.name} normal RPC reaches service dispatch`)
		}

		const triggers = [
			{
				name: 'duplicate Upgrade values',
				headers: ['Upgrade: h2c', 'uPgRaDe: websocket'],
			},
			{
				name: 'duplicate Connection headers with case-insensitive token',
				headers: ['Connection: keep-alive', 'cOnNeCtIoN: keep-alive, UpGrAdE'],
			},
			{
				name: 'duplicate Sec-WebSocket headers',
				headers: ['Sec-WebSocket-Key: synthetic-one', 'sEc-WeBsOcKeT-PrOtOcOl: synthetic', 'Sec-WebSocket-Protocol: duplicate'],
			},
		]
		for (const target of targets) {
			for (const trigger of triggers) {
				const beforeCalls = { ...calls }
				const beforeEvents = events.length
				const response = await requestRaw(target, trigger.headers, target.via === 'proxied')
				assert.equal(response.status, 400, `${target.name}: ${trigger.name}`)
				assert.equal(response.headers.get('connection')?.toLowerCase(), 'close', `${target.name}: response closes the connection`)
				assert.deepEqual(JSON.parse(response.body), { error: 'HTTP Upgrade is disabled' })
				assert.equal(response.body.includes('synthetic-one'), false, 'diagnostic does not echo request headers')
				assert.deepEqual(calls, beforeCalls, `${target.name}: identity/auth and policy callbacks were not reached`)
				assert.equal(events.length, beforeEvents + 1, `${target.name}: one denial audit event`)
				assert.deepEqual(events.at(-1), { event: 'deny', via: target.via, reason: 'websocket_upgrade' })
			}
		}

		const rpcBody = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'signer_status', params: [] })
		for (const target of targets) {
			const beforeCalls = { ...calls }
			const beforeEvents = events.length
			const response = await requestRaw(target, ['Upgrade: websocket'], false, rpcBody)
			assert.equal(response.status, 400, `${target.name}: valid-identity RPC Upgrade is rejected`)
			assert.equal(response.headers.get('connection')?.toLowerCase(), 'close')
			assert.deepEqual(calls, beforeCalls, `${target.name}: authorization and RPC dispatch are skipped`)
			assert.equal(events.length, beforeEvents + 1)
			assert.deepEqual(events.at(-1), { event: 'deny', via: target.via, reason: 'websocket_upgrade' })
		}
	} finally {
		await Promise.all(servers.map((server) => new Promise<void>((resolve, reject) => {
			if (!server.listening) return resolve()
			server.close((error) => error ? reject(error) : resolve())
		})))
		rmSync(dir, { recursive: true, force: true })
	}
})
