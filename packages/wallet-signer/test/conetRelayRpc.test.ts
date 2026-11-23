import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { FetchRequest, keccak256, toQuantity, Wallet, ZeroAddress, type GetUrlResponse, type Transaction } from 'ethers'
import { AuditLog } from '../src/audit'
import type { Keyring } from '../src/keyring'
import { normalizeConetRelayRpc } from '../src/conetRelayRpc'
import { TxManager, type SendRequest, type TxRecord } from '../src/txManager'

const HASH = '0x' + 'a1'.repeat(32)
const CHAIN = 224422
const oracleAddress = '0x77CB8358c5a37aB7190b0A2C7EaA7fEeDCF11008'

type RpcInput = { id: number; method: string; params: unknown[] }
type RpcAction = 'ok' | 'bad-chain' | 'syncing' | 'stale' | 'bad-head' | 'balance-fault' | 'rate-limit' | 'nonce-fault' | 'malformed-balance' | 'zero-balance' | 'revert' | 'uncertain-broadcast' | 'receipt-offline' | 'receipt-mined' | 'nonce-used'
type RpcRedirect = { url: string; status: number; method: string }

function answer({ method, params }: RpcInput, scenario: RpcAction): unknown {
	switch (method) {
	case 'eth_chainId': return scenario === 'bad-chain' ? '0x1' : toQuantity(CHAIN)
	case 'eth_syncing': return scenario === 'syncing' ? { currentBlock: '0x10' } : false
	case 'eth_blockNumber': return '0x10'
	case 'eth_gasPrice': return '0x1'
	case 'eth_maxPriorityFeePerGas': return '0x1'
	case 'eth_getBalance':
		return scenario === 'zero-balance' ? '0x0' : scenario === 'malformed-balance' ? null : '0x1000000000000000'
	case 'eth_getTransactionCount': return scenario === 'nonce-used' ? '0x1' : '0x0'
	case 'eth_call': return '0x'
	case 'eth_estimateGas': return '0x10000'
	case 'eth_getBlockByNumber': return {
		hash: scenario === 'bad-head' ? 'bad' : HASH,
		parentHash: HASH,
		number: '0x10',
		timestamp: toQuantity(Math.floor(Date.now() / 1000) - (scenario === 'stale' ? 121 : 0)),
		nonce: '0x0000000000000000', difficulty: '0x0', gasLimit: '0x1c9c380', gasUsed: '0x0',
		miner: ZeroAddress, extraData: '0x', baseFeePerGas: '0x1', transactions: [],
	}
	case 'eth_sendRawTransaction': return keccak256(String(params[0]))
	case 'eth_getTransactionReceipt':
		return scenario !== 'receipt-mined' ? null : {
			transactionHash: params[0], blockHash: HASH, blockNumber: '0x10',
			to: oracleAddress, from: ZeroAddress, transactionIndex: '0x0',
			gasUsed: '0x5600', cumulativeGasUsed: '0x5600', effectiveGasPrice: '0x1', logs: [], status: '0x1',
		}
	default: return null
	}
}

// Override ethers' HTTP transport for this test process. Even the public endpoint
// name is handled in-memory; no external connection can escape this fixture.
const endpoints = new Map<string, { calls: RpcInput[]; scenario: RpcAction; redirect?: RpcRedirect }>()
let nextPort = 31000
FetchRequest.registerGetUrl(async (request): Promise<GetUrlResponse> => {
	const endpoint = endpoints.get(request.url)
	assert.ok(endpoint, `unexpected egress to ${request.url}`)
	const input = JSON.parse(Buffer.from(request.body!).toString()) as RpcInput
	endpoint.calls.push(input)
	if (endpoint.redirect?.method === input.method) {
		return { statusCode: endpoint.redirect.status, statusMessage: 'Redirect', headers: { location: endpoint.redirect.url }, body: null }
	}
	const scenario = endpoint.scenario
	const outage = (scenario === 'balance-fault' && input.method === 'eth_getBalance') ||
		(scenario === 'nonce-fault' && input.method === 'eth_getTransactionCount') ||
		(scenario === 'receipt-offline' && input.method === 'eth_getTransactionReceipt') ||
		(scenario === 'uncertain-broadcast' && input.method === 'eth_sendRawTransaction')
	if (scenario === 'rate-limit' && input.method === 'eth_getBalance') {
		return { statusCode: 429, statusMessage: 'Too Many Requests', headers: { 'content-type': 'application/json' }, body: null }
	}
	if (outage) return { statusCode: 503, statusMessage: 'Unavailable', headers: { 'content-type': 'application/json' }, body: null }
	const reply = scenario === 'revert' && input.method === 'eth_call'
		? { error: { code: 3, message: 'execution reverted', data: '0x' } }
		: { result: answer(input, scenario) }
	return { statusCode: 200, statusMessage: 'OK', headers: { 'content-type': 'application/json' },
		body: Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: input.id, ...reply })) }
})

function rpcMock(t: TestContext, scenario: RpcAction) {
	const url = `http://127.0.0.1:${nextPort++}/`
	const endpoint: { calls: RpcInput[]; scenario: RpcAction; redirect?: RpcRedirect } = { calls: [], scenario }
	endpoints.set(url, endpoint)
	t.after(() => { endpoints.delete(url) })
	return {
		url,
		calls: endpoint.calls,
		setScenario: (value: RpcAction) => { endpoint.scenario = value },
		redirectTo: (target: string, status: number, method: string) => { endpoint.redirect = { url: target, status, method } },
	}
}

async function setup(t: TestContext, local: RpcAction, fallback: RpcAction = 'ok', enabled = true) {
	const [main, publicRpc, shared] = [rpcMock(t, local), rpcMock(t, fallback), rpcMock(t, 'ok')]
	const dir = mkdtempSync(join(tmpdir(), 'oracle-route-'))
	t.after(() => rmSync(dir, { recursive: true, force: true }))
	const wallet = Wallet.createRandom()
	let signatures = 0
	const makeManager = (relayEnabled = enabled) => new TxManager(
		{ [CHAIN]: { rpcUrls: [shared.url], resendAfterMs: 0 }, 8453: { rpcUrls: [shared.url] } },
		{ unlocked: true, signTransaction: (_from: string, transaction: Transaction) => {
			signatures++
			transaction.signature = wallet.signingKey.sign(transaction.unsignedHash)
			return transaction.serialized
		} } as unknown as Keyring,
		new AuditLog(join(dir, 'audit.jsonl')), { send() {} },
		join(dir, 'txjournal.jsonl'), 10,
		relayEnabled ? { localUrl: main.url, publicUrl: publicRpc.url } : undefined,
	)
	const req: SendRequest = {
		client: 'oracle-daemon', array: 'beamio_oracle_owner', chainId: CHAIN, candidates: [wallet.address],
		to: oracleAddress, data: '0x0936c703', value: 0n, conetRelay: true, maxInflightPerKey: 1,
	}
	return { main, publicRpc, shared, txm: makeManager(), restart: makeManager, req, signatures: () => signatures }
}

test('operator config permits loopback and the CoNET HTTPS RPC only', () => {
	const localUrl = 'http://127.0.0.1:8889/'
	const publicUrl = 'https://publicrpc.conet.network/'
	assert.deepEqual(normalizeConetRelayRpc({ localUrl, publicUrl }), { localUrl, publicUrl })
	for (const bad of ['ftp://127.0.0.1:8889', 'http://192.0.2.8:8889', 'http://127.0.0.1.evil.com:8889', 'http://user@127.0.0.1:8889']) {
		assert.throws(() => normalizeConetRelayRpc({ localUrl: bad, publicUrl }))
	}
	assert.throws(() => normalizeConetRelayRpc({ localUrl, publicUrl: 'https://other.example/' }))
})

test('healthy local CoNET handles relay while the external provider and other chains are unchanged', async (t) => {
	const f = await setup(t, 'ok')
	await f.txm.send(f.req)
	const methods = f.main.calls.map(({ method }) => method)
	for (const method of ['eth_chainId', 'eth_syncing', 'eth_call', 'eth_estimateGas', 'eth_getBalance', 'eth_getTransactionCount', 'eth_getBlockByNumber', 'eth_sendRawTransaction']) {
		assert.ok(methods.includes(method), method)
	}
	assert.equal(f.publicRpc.calls.length, 0)
	assert.equal(f.shared.calls.length, 0)
	const wallet = Wallet.createRandom()
	assert.equal(await f.txm.provider(CHAIN).getBalance(wallet.address), 0x1000000000000000n)
	const req = { ...f.req, chainId: 8453, candidates: [wallet.address] }
	await f.txm.send(req)
	assert.ok(f.shared.calls.some(({ method }) => method === 'eth_sendRawTransaction'))
	assert.equal(f.main.calls.filter(({ method }) => method === 'eth_sendRawTransaction').length, 1)
})

for (const scenario of ['bad-chain', 'syncing', 'stale', 'bad-head', 'balance-fault', 'rate-limit', 'nonce-fault', 'malformed-balance'] as const) {
	test(`${scenario} on local switches to public before the first signature`, async (t) => {
		const f = await setup(t, scenario)
		await f.txm.send(f.req)
		assert.equal(f.signatures(), 1)
		assert.equal(f.main.calls.some(({ method }) => method === 'eth_sendRawTransaction'), false)
		assert.equal(f.publicRpc.calls.filter(({ method }) => method === 'eth_sendRawTransaction').length, 1)
		assert.equal(f.shared.calls.length, 0)
	})
}

for (const scenario of ['zero-balance', 'revert'] as const) {
	test(`${scenario} is definitive and does not trigger public fallback`, async (t) => {
		const f = await setup(t, scenario)
		await assert.rejects(f.txm.send(f.req), /below worst-case gas|simulation reverted/)
		assert.equal(f.signatures(), 0)
		assert.equal(f.publicRpc.calls.length, 0)
	})
}

test('both RPCs unavailable fails before signing', async (t) => {
	const f = await setup(t, 'bad-chain', 'stale')
	await assert.rejects(f.txm.send(f.req), /both CoNET relay RPC endpoints unavailable/)
	assert.equal(f.signatures(), 0)
	assert.equal(f.shared.calls.length, 0)
})

test('ambiguous local submission with an unusable fallback preserves the original journal after restart', async (t) => {
	const f = await setup(t, 'uncertain-broadcast', 'stale')
	await assert.rejects(f.txm.send(f.req), /broadcast uncertain/)
	const sent = f.main.calls.filter(({ method }) => method === 'eth_sendRawTransaction')
	assert.equal(f.signatures(), 1)
	assert.equal(sent.length, 1)
	assert.equal(f.publicRpc.calls.some(({ method }) => method === 'eth_sendRawTransaction'), false)
	const record = f.txm.recent(1)[0]!
	assert.equal(record.conetRelayRpcLane, 'local')
	assert.equal(record.conetRelayBroadcastAccepted, false)
	assert.equal(record.status, 'sent')
	// Execute one actual receipt/watchdog pass without timer-related nondeterminism.
	const restarted = f.restart()
	await runTrack(restarted, restarted.recent(1)[0]!)
	assert.equal(f.signatures(), 1)
	const replay = f.main.calls.filter(({ method }) => method === 'eth_sendRawTransaction').at(-1)
	assert.deepEqual(replay?.params, sent[0]?.params)
	assert.equal(f.main.calls.filter(({ method }) => method === 'eth_sendRawTransaction').length, 2)
	assert.equal(f.publicRpc.calls.some(({ method }) => method === 'eth_sendRawTransaction'), false)
	assert.equal(restarted.recent(1)[0]?.conetRelayBroadcastAccepted, false)
})

test('each new CoNET relay operation rechecks local without relying on a dead fallback', async (t) => {
	const f = await setup(t, 'syncing')
	await f.txm.send(f.req)
	f.main.setScenario('ok')
	f.publicRpc.setScenario('stale')
	const wallet = Wallet.createRandom()
	await f.txm.send({ ...f.req, client: 'another-conet-relay-client', candidates: [wallet.address] })
	assert.equal(f.publicRpc.calls.filter(({ method }) => method === 'eth_sendRawTransaction').length, 1)
	assert.equal(f.main.calls.filter(({ method }) => method === 'eth_sendRawTransaction').length, 1)
	assert.equal(f.signatures(), 2)
})

test('public fallback reconciles the exact receipt after the original node stops serving receipts', async (t) => {
	const f = await setup(t, 'ok')
	await f.txm.send(f.req)
	f.main.setScenario('receipt-offline')
	f.publicRpc.setScenario('receipt-mined')
	await runTrack(f.txm, f.txm.recent(1)[0]!)
	assert.equal(f.txm.recent(1)[0]?.status, 'mined')
	assert.equal(f.signatures(), 1)
	assert.equal(f.publicRpc.calls.some(({ method }) => method === 'eth_sendRawTransaction'), false)
})

test('omitting conetRelayRpc preserves the single shared chain route', async (t) => {
	const f = await setup(t, 'ok', 'ok', false)
	await f.txm.send(f.req)
	assert.ok(f.shared.calls.some(({ method }) => method === 'eth_sendRawTransaction'))
	assert.equal(f.main.calls.length, 0)
	assert.equal(f.publicRpc.calls.length, 0)
	assert.equal(f.txm.recent(1)[0]?.conetRelayRpcLane, undefined)
})

function runTrack(manager: TxManager, record: TxRecord): Promise<void> {
	return (manager as unknown as { track(record: TxRecord): Promise<void> }).track(record)
}

test('local broadcast failure sends the same durable raw through a healthy, clear public view', async (t) => {
	const f = await setup(t, 'uncertain-broadcast')
	await f.txm.send(f.req)
	const local = f.main.calls.find(({ method }) => method === 'eth_sendRawTransaction')!
	const alternate = f.publicRpc.calls.find(({ method }) => method === 'eth_sendRawTransaction')!
	assert.deepEqual(alternate.params, local.params)
	assert.equal(f.signatures(), 1)
	assert.ok(f.publicRpc.calls.findIndex(({ method }) => method === 'eth_getTransactionReceipt') < f.publicRpc.calls.indexOf(alternate))
	assert.ok(f.publicRpc.calls.findIndex(({ method }) => method === 'eth_getTransactionCount') < f.publicRpc.calls.indexOf(alternate))
	assert.equal(f.txm.recent(1)[0]?.conetRelayRpcLane, 'public')
	assert.equal(f.txm.recent(1)[0]?.conetRelayBroadcastAccepted, true)
})

test('local signed HTTP redirect never forwards to its target', async (t) => {
	const f = await setup(t, 'ok')
	f.main.redirectTo(f.shared.url, 307, 'eth_sendRawTransaction')
	await f.txm.send(f.req)
	const local = f.main.calls.find(({ method }) => method === 'eth_sendRawTransaction')!
	const alternate = f.publicRpc.calls.find(({ method }) => method === 'eth_sendRawTransaction')!
	assert.deepEqual(alternate.params, local.params)
	assert.equal(f.shared.calls.length, 0)
	assert.equal(f.signatures(), 1)
})

test('a newer alternate nonce with no matching receipt prevents resubmission', async (t) => {
	const f = await setup(t, 'uncertain-broadcast', 'nonce-used')
	await assert.rejects(f.txm.send(f.req), /broadcast uncertain/)
	assert.equal(f.signatures(), 1)
	assert.equal(f.publicRpc.calls.some(({ method }) => method === 'eth_sendRawTransaction'), false)
	assert.equal(f.txm.recent(1)[0]?.status, 'sent')
})

test('disabling failover on restart checks the same pending receipt via the old provider without resigning', async (t) => {
	const f = await setup(t, 'uncertain-broadcast', 'stale')
	await assert.rejects(f.txm.send(f.req), /broadcast uncertain/)
	const restarted = f.restart(false)
	const record = restarted.recent(1)[0]!
	await runTrack(restarted, record)
	const reads = f.shared.calls.filter(({ method }) => method === 'eth_getTransactionReceipt')
	assert.deepEqual(reads.map(({ params }) => params[0]), [record.hash])
	assert.equal(restarted.recent(1)[0]?.status, 'sent')
	assert.equal(restarted.inflightCount(CHAIN, record.from), 1)
	assert.equal(f.shared.calls.some(({ method }) => method === 'eth_sendRawTransaction'), false)
	assert.equal(f.signatures(), 1)
	f.shared.setScenario('receipt-mined')
	const refreshed = f.restart(false)
	await runTrack(refreshed, refreshed.recent(1)[0]!)
	assert.equal(refreshed.recent(1)[0]?.status, 'mined')
	assert.equal(refreshed.inflightCount(CHAIN, record.from), 0)
})

test('internal CoNET sends remain on the existing provider even when relay routing is enabled', async (t) => {
	const f = await setup(t, 'bad-chain', 'stale')
	await f.txm.send({ ...f.req, conetRelay: undefined, client: 'pm-lab-initial-gas' })
	assert.equal(f.main.calls.length, 0)
	assert.equal(f.publicRpc.calls.length, 0)
	assert.ok(f.shared.calls.some(({ method }) => method === 'eth_sendRawTransaction'))
})
