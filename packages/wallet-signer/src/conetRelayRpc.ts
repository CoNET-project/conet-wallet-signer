import { FetchRequest, JsonRpcProvider, Network } from 'ethers'

export const CONET_RELAY_CHAIN_ID = 224422

const MAX_HEAD_AGE_SECONDS = 120
const MAX_HEAD_AHEAD_SECONDS = 30

export type ConetRelayRpcConfig = { localUrl: string; publicUrl: string }
export type ConetRelayRpcLane = 'local' | 'public'
export type ConetRelayRpcEndpoints = Record<ConetRelayRpcLane, JsonRpcProvider>

export class ConetRelayRpcUnavailable extends Error {}

export function normalizeConetRelayRpc(raw: unknown): ConetRelayRpcConfig | undefined {
	if (raw === undefined) return undefined
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('config: conetRelayRpc must be an object')
	const config = raw as Record<string, unknown>
	if (Object.keys(config).some((key) => key !== 'localUrl' && key !== 'publicUrl')) {
		throw new Error('config: conetRelayRpc accepts only localUrl and publicUrl')
	}
	const local = checkedUrl(config.localUrl)
	const fallback = checkedUrl(config.publicUrl)
	if (local.protocol !== 'http:' || (local.hostname !== '127.0.0.1' && local.hostname !== '[::1]') || !local.port) {
		throw new Error('config: conetRelayRpc.localUrl must be an HTTP loopback URL with a port')
	}
	if (fallback.protocol !== 'https:' || fallback.hostname !== 'publicrpc.conet.network' || fallback.port) {
		throw new Error('config: conetRelayRpc.publicUrl must use the CoNET public HTTPS RPC')
	}
	return { localUrl: local.href, publicUrl: fallback.href }
}

function checkedUrl(value: unknown): URL {
	if (typeof value !== 'string') throw new Error('config: conetRelayRpc URL must be a string')
	let url: URL
	try { url = new URL(value) } catch { throw new Error('config: invalid conetRelayRpc URL') }
	if (url.username || url.password || url.search || url.hash) {
		throw new Error('config: conetRelayRpc URL must not contain credentials, a query or a fragment')
	}
	return url
}

export function makeConetRelayRpcEndpoints(config: ConetRelayRpcConfig): ConetRelayRpcEndpoints {
	return { local: makeProvider(config.localUrl), public: makeProvider(config.publicUrl) }
}

function makeProvider(url: string): JsonRpcProvider {
	const request = new FetchRequest(url)
	request.timeout = 10_000
	request.retryFunc = async () => false
	const getUrl = request.getUrlFunc
	request.getUrlFunc = async (req, signal) => {
		if (req.url !== url) throw new ConetRelayRpcUnavailable('CoNET relay RPC redirects are not allowed')
		const reply = await getUrl(req, signal)
		// Ethers creates a new request when redirecting and drops instance hooks.
		if (reply.statusCode >= 300 && reply.statusCode < 400) {
			throw new ConetRelayRpcUnavailable('CoNET relay RPC redirects are not allowed')
		}
		return reply
	}
	return new JsonRpcProvider(request, CONET_RELAY_CHAIN_ID, {
		staticNetwork: Network.from(CONET_RELAY_CHAIN_ID),
		batchMaxCount: 1,
		cacheTimeout: -1,
	})
}

/** Probe the actual network even though the transaction provider is static. */
export async function checkConetRelayRpc(provider: JsonRpcProvider): Promise<void> {
	try {
		const chain: unknown = await provider.send('eth_chainId', [])
		if (quantity(chain) !== BigInt(CONET_RELAY_CHAIN_ID)) throw new Error('unexpected chain')
		const syncing: unknown = await provider.send('eth_syncing', [])
		if (syncing !== false) throw new Error('node not ready')
		const head: unknown = await provider.send('eth_getBlockByNumber', ['latest', false])
		if (!head || typeof head !== 'object') throw new Error('latest block unavailable')
		const block = head as Record<string, unknown>
		const blockNumber = quantity(block.number)
		const timestamp = quantity(block.timestamp)
		const now = BigInt(Math.floor(Date.now() / 1000))
		if (blockNumber === undefined || blockNumber <= 0n || timestamp === undefined ||
			timestamp < now - BigInt(MAX_HEAD_AGE_SECONDS) || timestamp > now + BigInt(MAX_HEAD_AHEAD_SECONDS) ||
			typeof block.hash !== 'string' || !/^0x[0-9a-f]{64}$/i.test(block.hash)) {
			throw new Error('invalid or stale latest block')
		}
	} catch {
		throw new ConetRelayRpcUnavailable('CoNET relay RPC health check failed')
	}
}

function quantity(value: unknown): bigint | undefined {
	return typeof value === 'string' && /^0x(?:0|[1-9a-f][0-9a-f]*)$/i.test(value)
		? BigInt(value) : undefined
}

/** Classifies unavailable nodes during CoNET relay reads; business refusals remain unchanged. */
export async function conetRelayRpcRead<T>(lane: ConetRelayRpcLane | undefined, read: () => Promise<T>): Promise<T> {
	try {
		return await read()
	} catch (err) {
		if (lane !== undefined && isConetRelayRpcUnavailable(err)) throw new ConetRelayRpcUnavailable('CoNET relay RPC read failed')
		throw err
	}
}

export function isConetRelayRpcUnavailable(err: unknown): boolean {
	if (err instanceof ConetRelayRpcUnavailable) return true
	if (err === null || typeof err !== 'object') return false
	const e = err as { code?: string; message?: string; argument?: string; info?: { error?: { message?: string } } }
	const message = `${e.message ?? ''} ${e.info?.error?.message ?? ''}`
	if (e.code === 'CALL_EXCEPTION' || /execution reverted|insufficient funds/i.test(message)) return false
	return (e.code === 'INVALID_ARGUMENT' && e.argument === '%response') || e.code === 'NETWORK_ERROR' || e.code === 'SERVER_ERROR' || e.code === 'TIMEOUT' ||
		e.code === 'BAD_DATA' || e.code === 'ECONNREFUSED' || e.code === 'ECONNRESET' ||
		e.code === 'ENOTFOUND' || e.code === 'ETIMEDOUT' ||
		(e.code === 'UNKNOWN_ERROR' && /timeout|connection|unavailable|gateway|too many requests/i.test(message))
}
