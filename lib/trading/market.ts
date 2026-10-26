import { address, approval, chain, dataHex, minimumOutput, quoteRequest, TradingError, uint, ZERO } from './core.ts'
import type { Json } from './core.ts'
import { feePolicy } from './config.ts'
import { seal, unseal } from './tickets.ts'
import { upstream } from './upstream.ts'

export const KYBER_CHAINS: Record<number, string> = { 1: 'ethereum', 10: 'optimism', 137: 'polygon', 130: 'unichain', 5042: 'arc', 8453: 'base', 42161: 'arbitrum', 43114: 'avalanche' }
const NATIVE = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'
const kyberToken = (token: string) => token === ZERO ? NATIVE : token

export function relayPath(value: string) {
  const url = new URL(value, 'https://api.relay.link')
  if (url.origin !== 'https://api.relay.link' || url.username || url.password || url.hash) throw new TradingError('Invalid Relay execution endpoint', 502)
  return url.pathname + url.search
}

export async function relayQuote(input: Json) {
  const c = feePolicy()
  if (!c.relayKey) throw new TradingError('The operator has not configured the Relay API key', 503)
  const body = { ...quoteRequest(input), referrer: c.relayReferrer,
    appFees: [{ recipient: c.recipient, fee: String(c.bps) }] }
  const quote = await upstream('relay', '/quote/v2', 'POST', body)
  if (!Array.isArray(quote.steps) || !quote.steps.length || !quote.details?.currencyOut) throw new TradingError('Relay returned an incomplete quote', 502)
  if (String(quote.details.currencyIn?.amount) !== body.amount ||
    address(quote.details.currencyIn?.currency?.address, 'quoted input', true) !== body.originCurrency ||
    address(quote.details.currencyOut.currency?.address, 'quoted output', true) !== body.destinationCurrency ||
    Number(quote.details.currencyIn.currency.chainId) !== body.originChainId ||
    Number(quote.details.currencyOut.currency.chainId) !== body.destinationChainId) throw new TradingError('Relay quote did not match the requested trade', 502)
  uint(quote.details.currencyOut.minimumAmount, 'minimum received')
  if (!quote.fees?.app?.amount || !/^\d+$/.test(quote.fees.app.amount) || BigInt(quote.fees.app.amount) === 0n) {
    throw new TradingError('This Relay route does not collect the required developer fee', 422)
  }
  const posts = quote.steps.flatMap((s: Json) => (s.items || []).flatMap((item: Json) => {
    const post = item.data?.post
    if (!post) return []
    const path = relayPath(post.endpoint)
    if (new URL(path, 'https://api.relay.link').pathname !== '/execute/permits') throw new TradingError('Unsupported Relay signature submission endpoint', 502)
    return [{ path, method: post.method || 'POST', body: post.body || {} }]
  }))
  return { ...quote, _provider: 'relay', _appFee: { bps: c.bps, recipient: c.recipient, settlement: 'Relay app balance' },
    _executionToken: seal('relay-execute', { posts }), _expiresAt: Date.now() + 90000 }
}

export async function relayGateway(path: string, method: string, body?: Json, executionToken?: string | null) {
  const parsed = new URL(relayPath(path), 'https://api.relay.link')
  const name = parsed.pathname
  const allowedRead = method === 'GET' && ['/chains', '/currencies/token/price', '/requests/v3', '/intents/status/v3', '/intents/status'].includes(name)
  if (allowedRead) {
    const queryAllow: Record<string, string[]> = {
      '/chains': [], '/currencies/token/price': ['address', 'chainId'],
      '/requests/v3': ['limit', 'sortBy', 'user', 'currencyInChainId', 'currencyInAddress', 'currencyOutChainId', 'currencyOutAddress'],
      '/intents/status/v3': ['requestId'], '/intents/status': ['requestId'],
    }
    for (const k of parsed.searchParams.keys()) if (!queryAllow[name].includes(k)) throw new TradingError('Unsupported Relay query parameter')
    if (name === '/requests/v3') {
      if (!process.env.RELAY_API_KEY) throw new TradingError('Trade history is awaiting the operator’s Relay API key', 503)
      parsed.searchParams.set('limit', '25')
    }
    return upstream('relay', name + parsed.search)
  }
  if (method === 'POST' && name === '/currencies/v2') {
    const ids = body?.chainIds
    if (!Array.isArray(ids) || ids.length !== 1) throw new TradingError('Choose one network')
    const payload: Json = { chainIds: [chain(ids[0])], limit: 100 }
    if (body?.address) payload.address = address(body.address, 'token address', true)
    if (body?.term) payload.term = String(body.term).slice(0, 80)
    if (body?.defaultList === true) payload.defaultList = true
    if (body?.verified === true) payload.verified = true
    if (body?.useExternalSearch === true) payload.useExternalSearch = true
    return upstream('relay', name, 'POST', payload)
  }
  if (method === 'POST' && name === '/execute/permits') {
    const ticket = unseal(executionToken, 'relay-execute')
    const signatureValue = parsed.searchParams.get('signature')
    if (!signatureValue || !/^0x[\da-f]+$/i.test(signatureValue)) throw new TradingError('Missing wallet signature')
    const base = new URL(parsed); base.searchParams.delete('signature')
    const match = ticket.posts.some((p: Json) => p.method === method && p.path === base.pathname + base.search && JSON.stringify(p.body) === JSON.stringify(body || {}))
    if (!match) throw new TradingError('Signature submission does not match a server-issued quote', 403)
    return upstream('relay', parsed.pathname + parsed.search, method, body)
  }
  throw new TradingError('Unsupported Relay operation', 404)
}

function formatted(raw: string, decimals: unknown) {
  const n = Number(decimals)
  if (!Number.isInteger(n) || n < 0 || n > 36) throw new TradingError('Invalid token decimals')
  if (n === 0) return raw
  const str = raw.padStart(n + 1, '0')
  return str.slice(0, -n) + '.' + str.slice(-n)
}

export async function kyberQuote(input: Json) {
  const c = feePolicy()
  if (!c.kyberKey) throw new TradingError('The operator has not configured the Kyber swap API key', 503)
  const q = quoteRequest(input)
  if (q.originChainId !== q.destinationChainId) throw new TradingError('Kyber market swaps require both tokens on the same network')
  const chainName = KYBER_CHAINS[q.originChainId]
  const query = new URLSearchParams({ tokenIn: kyberToken(q.originCurrency), tokenOut: kyberToken(q.destinationCurrency), amountIn: q.amount,
    feeAmount: String(c.bps), feeReceiver: c.recipient, isInBps: 'true', chargeFeeBy: 'currency_out' })
  const route = await upstream('kyber', `/${chainName}/api/v1/routes?${query}`)
  const summary = route.routeSummary
  const fee = summary?.extraFee
  if (!summary || String(summary.amountIn) !== q.amount || String(summary.tokenIn).toLowerCase() !== kyberToken(q.originCurrency) ||
    String(summary.tokenOut).toLowerCase() !== kyberToken(q.destinationCurrency) ||
    String(fee?.feeAmount) !== String(c.bps) || String(fee?.feeReceiver).toLowerCase() !== c.recipient || fee?.isInBps !== true || fee.chargeFeeBy !== 'currency_out') {
    throw new TradingError('Kyber route does not contain the required developer fee', 502)
  }
  const router = address(route.routerAddress, 'Kyber router')
  const built = await upstream('kyber', `/${chainName}/api/v1/route/build`, 'POST', {
    routeSummary: summary, sender: q.user, recipient: q.user, origin: q.user,
    slippageTolerance: Number(q.slippageTolerance), deadline: Math.floor(Date.now() / 1000) + 300, source: c.clientId,
  })
  if (address(built.routerAddress, 'Kyber router') !== router) throw new TradingError('Kyber router changed while building the route', 502)
  if (String(built.amountIn) !== q.amount || String(built.transactionValue) !== (q.originCurrency === ZERO ? q.amount : '0')) {
    throw new TradingError('Kyber transaction does not match the requested input amount', 502)
  }
  const amountOut = uint(built.amountOut, 'quoted output')
  const minimumAmount = minimumOutput(amountOut, Number(q.slippageTolerance))
  const steps: Json[] = []
  if (q.originCurrency !== ZERO) steps.push(approval(q.originCurrency, router, q.amount, q.originChainId, q.user))
  steps.push({ id: 'swap', kind: 'transaction', items: [{ data: { chainId: q.originChainId, from: q.user, to: router,
    value: q.originCurrency === ZERO ? q.amount : '0', data: dataHex(built.data) } }] })
  return { steps, details: {
    currencyIn: { currency: { address: q.originCurrency, chainId: q.originChainId }, amount: q.amount, amountFormatted: formatted(q.amount, input.originDecimals), amountUsd: summary.amountInUsd },
    currencyOut: { currency: { address: q.destinationCurrency, chainId: q.destinationChainId }, amount: amountOut, minimumAmount,
      amountFormatted: formatted(amountOut, input.destinationDecimals), amountUsd: summary.amountOutUsd },
  }, fees: { gas: { amountUsd: built.gasUsd || summary.gasUsd } }, _provider: 'kyber', _expiresAt: Date.now() + 90000,
    _appFee: { bps: c.bps, recipient: c.recipient, settlement: 'Output-token fee' } }
}

export const marketProviders = { relay: relayQuote, kyber: kyberQuote }
export async function marketQuote(input: Json) {
  const id = input.provider || 'relay'
  if (id !== 'relay' && id !== 'kyber') throw new TradingError('Unknown market provider')
  return marketProviders[id as keyof typeof marketProviders](input)
}
