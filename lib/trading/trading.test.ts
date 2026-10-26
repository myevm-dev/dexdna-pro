import test, { beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { capabilities } from './config.ts'
import { decodeFee, meetsTarget, minimumOutput, quoteRequest, uint, ZERO } from './core.ts'
import { seal, unseal } from './tickets.ts'
import { kyberQuote, relayGateway, relayQuote } from './market.ts'
import { fillAmounts, prepareFill, prepareOrder, submitOrder, verifyLimitFee } from './limit.ts'
import { endpoint, readBody } from './http.ts'

const user = '0x1111111111111111111111111111111111111111'
const recipient = '0x2222222222222222222222222222222222222222'
const other = '0x3333333333333333333333333333333333333333'
const tokenIn = '0x4444444444444444444444444444444444444444'
const tokenOut = '0x5555555555555555555555555555555555555555'
const contract = '0x6666666666666666666666666666666666666666'
const feeConfig = (BigInt(recipient) | (250n << 160n)).toString()
const input = { user, originChainId: 1, destinationChainId: 1, originCurrency: tokenIn, destinationCurrency: tokenOut,
  amount: '1000000000000000000', originDecimals: 18, destinationDecimals: 6, slippageTolerance: '50' }
const originalFetch = globalThis.fetch
const originalEnv = { ...process.env }
const reply = (data: unknown, kyber = false) => Response.json(kyber ? { code: 0, data } : data)

beforeEach(() => {
  process.env.APP_FEE_RECIPIENT = recipient
  process.env.APP_FEE_BPS = '25'
  process.env.ORDER_SIGNING_SECRET = 'test-only-order-signing-secret-over-32-characters'
  process.env.RELAY_API_KEY = 'test-only-relay-key'
  process.env.KYBER_SWAP_API_KEY = 'test-only-kyber-key'
  process.env.KYBER_CLIENT_ID = 'dexdna-pro-test'
  process.env.KYBER_REFERRAL = 'partner-test'
  process.env.KYBER_LIMIT_ENABLED = 'true'
})
afterEach(() => { globalThis.fetch = originalFetch; process.env = { ...originalEnv } })

function relayResult() {
  return { fees: { app: { amount: '6750000' } }, steps: [{ id: 'swap', kind: 'transaction', items: [{ data: { chainId: 1, from: user, to: contract, value: '0', data: '0x12345678' } }] }], details: { currencyIn: { amount: input.amount, currency: { address: tokenIn, chainId: 1 } },
    currencyOut: { amount: '2800000000', minimumAmount: '2786000000', currency: { address: tokenOut, chainId: 1 } } } }
}
function limitInput() {
  return { chainId: 1, maker: user, makerAsset: tokenIn, takerAsset: tokenOut,
    makingAmount: input.amount, takingAmount: '2700000000', expiredAt: Math.floor(Date.now() / 1000) + 86400 }
}
function typedOrder(body: Record<string, any>, fee = feeConfig) {
  return { domain: { name: 'Kyber', version: '1', chainId: 1, verifyingContract: contract }, primaryType: 'Order', types: { Order: [] },
    message: { ...body, allowedSender: ZERO, feeConfig: fee, salt: '123' } }
}

test('configuration exposes only availability and the public fee policy', () => {
  const c = capabilities()
  assert.equal(c.providers[0].market, true)
  const serialized = JSON.stringify(c)
  assert(!serialized.includes(process.env.RELAY_API_KEY!))
  assert(!serialized.includes(process.env.KYBER_SWAP_API_KEY!))
  assert(!serialized.includes(process.env.ORDER_SIGNING_SECRET!))
  assert.equal(c.trigger.execution, 'wallet-confirmed')
})
test('trading fails closed when the fee policy or signing secret is absent', async () => {
  delete process.env.APP_FEE_BPS
  assert.equal(capabilities().providers[0].market, false)
  await assert.rejects(relayQuote(input), /developer wallet and fee/)
  process.env.APP_FEE_BPS = '25'; process.env.ORDER_SIGNING_SECRET = 'too-short'
  await assert.rejects(relayQuote(input), /signing configuration/)
})
test('amounts retain uint256 precision and reject invalid values', () => {
  assert.equal(uint('1000000000000000001'), '1000000000000000001')
  for (const value of ['-1', '1.2', '1e18', '0', (2n ** 256n).toString()]) assert.throws(() => uint(value))
  assert.throws(() => quoteRequest({ ...input, originChainId: 999999 }))
  assert.throws(() => quoteRequest({ ...input, user: ZERO }))
})
test('Relay requests force the operator fee, wallet recipient and referrer', async () => {
  globalThis.fetch = async (url, init) => {
    assert.equal(String(url), 'https://api.relay.link/quote/v2')
    const body = JSON.parse(init?.body as string)
    assert.deepEqual(body.appFees, [{ recipient, fee: '25' }])
    assert.equal(body.recipient, user)
    assert.notEqual(body.referrer, 'attacker')
    assert.equal(body.txs, undefined)
    assert.equal((init?.headers as Record<string, string>)['x-api-key'], 'test-only-relay-key')
    return reply(relayResult())
  }
  const result = await relayQuote({ ...input, recipient: other, referrer: 'attacker', txs: [{ to: other }], appFees: [] })
  assert.equal(result._appFee.recipient, recipient)
  assert.equal(result._provider, 'relay')
})
test('a mismatched Relay token or amount is rejected', async () => {
  const result = relayResult(); result.details.currencyIn.amount = '1'
  globalThis.fetch = async () => reply(result)
  await assert.rejects(relayQuote(input), /did not match/)
})
test('Relay routes which omit or zero the app fee cannot execute', async () => {
  const result = relayResult(); result.fees.app.amount = '0'
  globalThis.fetch = async () => reply(result)
  await assert.rejects(relayQuote(input), /does not collect/)
})
test('the Relay proxy blocks arbitrary endpoints and external hosts', async () => {
  let called = false
  globalThis.fetch = async () => { called = true; return reply({}) }
  await assert.rejects(relayGateway('/app-fees/anything/claim', 'POST', {}), /Unsupported/)
  await assert.rejects(relayGateway('https://attacker.example/steal', 'GET'), /Invalid Relay/)
  await assert.rejects(relayGateway('/requests/v3?apiKey=leak', 'GET'), /Unsupported Relay query/)
  assert.equal(called, false)
})
test('Relay permit submission must match a server-issued quote', async () => {
  const post = { path: '/execute/permits', method: 'POST', body: { requestId: 'test-request', kind: 'permit2' } }
  const ticket = seal('relay-execute', { posts: [post] })
  globalThis.fetch = async () => reply({ success: true })
  assert.deepEqual(await relayGateway('/execute/permits?signature=0x1234', 'POST', post.body, ticket), { success: true })
  await assert.rejects(relayGateway('/execute/permits?signature=0x1234', 'POST', { ...post.body, requestId: 'changed' }, ticket), /does not match/)
  await assert.rejects(relayGateway('/execute/permits?signature=0x1234', 'POST', post.body), /invalid execution ticket/i)
})
test('execution tickets reject tampering, expiry and cross-action reuse', () => {
  const ticket = seal('create', { amount: '7' }, 10, 1000)
  assert.equal(unseal(ticket, 'create', 1001).amount, '7')
  assert.throws(() => unseal(ticket.slice(0, -2) + 'xx', 'create', 1001), /changed/)
  assert.throws(() => unseal(ticket, 'fill', 1001), /expired/)
  assert.throws(() => unseal(ticket, 'create', 11001), /expired/)
})
test('Kyber market fees are requested and verified before calldata is returned', async () => {
  let count = 0
  globalThis.fetch = async (url, init) => {
    count++
    if (count === 1) {
      const parsed = new URL(String(url))
      assert.equal(parsed.origin, 'https://api.kyberswap.com')
      assert.equal(parsed.searchParams.get('feeReceiver'), recipient)
      assert.equal(parsed.searchParams.get('feeAmount'), '25')
      assert.equal((init?.headers as Record<string, string>)['X-Api-Key'], 'test-only-kyber-key')
      return reply({ routerAddress: contract, routeSummary: { tokenIn, tokenOut, amountIn: input.amount, amountOut: '2800000000',
        extraFee: { feeReceiver: recipient, feeAmount: '25', isInBps: true, chargeFeeBy: 'currency_out' } } }, true)
    }
    const body = JSON.parse(init?.body as string)
    assert.equal(body.recipient, user)
    assert.equal(body.slippageTolerance, 50)
    return reply({ routerAddress: contract, data: '0x12345678', amountIn: input.amount, transactionValue: '0', amountOut: '2793000000' }, true)
  }
  const quote = await kyberQuote(input)
  assert.equal(quote.steps.length, 2)
  assert.equal(quote.details.currencyOut.minimumAmount, '2779035000')
  assert.equal(quote._appFee.recipient, recipient)
})
test('Kyber market route without the developer fee is refused', async () => {
  globalThis.fetch = async () => reply({ routerAddress: contract, routeSummary: { tokenIn, tokenOut, amountIn: input.amount, extraFee: {} } }, true)
  await assert.rejects(kyberQuote(input), /required developer fee/)
})
test('Kyber market rejects cross-chain requests', async () => {
  await assert.rejects(kyberQuote({ ...input, destinationChainId: 8453 }), /same network/)
})
test('limit fees are decoded from the signed configuration and must match', () => {
  assert.deepEqual(decodeFee(feeConfig), { recipient, rate: 250, onTakerAsset: false })
  assert.equal(verifyLimitFee(feeConfig).recipient, recipient)
  assert.throws(() => verifyLimitFee((BigInt(other) | (250n << 160n)).toString()), /does not pay/)
  assert.throws(() => verifyLimitFee((BigInt(recipient) | (100n << 160n)).toString()), /does not pay/)
})
test('maker preparation binds partner settings and cumulative allowance', async () => {
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('contract-address')) return reply({ latest: contract, features: {} }, true)
    if (String(url).includes('sign-message')) return reply(typedOrder(JSON.parse(init?.body as string)), true)
    if (String(url).includes('active-making-amount')) return reply({ activeMakingAmount: '1000000000000000000' }, true)
    if (String(url).endsWith('/write/api/v1/orders')) {
      const body = JSON.parse(init?.body as string)
      assert.equal(body.receiver, user); assert.equal(body.referral, 'partner-test'); assert.equal(body.salt, '123')
      assert.equal(body.feeRecipient, undefined)
      return reply({ id: 1234 }, true)
    }
    throw new Error('Unexpected upstream request')
  }
  const prepared = await prepareOrder({ ...limitInput(), feeRecipient: other })
  assert.equal(prepared.allowanceAmount, '2000000000000000000')
  assert.deepEqual(await submitOrder({ ticket: prepared.ticket, signature: '0x1234' }), { id: 1234 })
  process.env.KYBER_REFERRAL = 'changed'
  await assert.rejects(submitOrder({ ticket: prepared.ticket, signature: '0x1234' }), /configuration changed/)
})
test('maker preparation refuses native assets and invalid expiry', async () => {
  await assert.rejects(prepareOrder({ ...limitInput(), makerAsset: ZERO }), /WETH/)
  await assert.rejects(prepareOrder({ ...limitInput(), expiredAt: 1 }), /expiry/)
})
test('maker preparation refuses wrong partner fees before any signing', async () => {
  globalThis.fetch = async (url, init) => String(url).includes('contract-address')
    ? reply({ latest: contract, features: {} }, true)
    : reply(typedOrder(JSON.parse(init?.body as string), (BigInt(other) | (250n << 160n)).toString()), true)
  await assert.rejects(prepareOrder(limitInput()), /does not pay/)
})
test('partial fills enforce available liquidity and account for both fee sides', () => {
  const order = { makingAmount: '1000000000000000000', takingAmount: '2700000000', filledMakingAmount: '0', feeConfig }
  assert.deepEqual(fillAmounts(order, '1350000000'), { output: '498750000000000000', maxInput: '1350000000' })
  assert.deepEqual(fillAmounts({ ...order, feeConfig: (BigInt(feeConfig) | (1n << 192n)).toString() }, '1350000000'),
    { output: '500000000000000000', maxInput: '1353375000' })
  assert.throws(() => fillAmounts({ ...order, availableMakingAmount: '1' }, '1350000000'), /available liquidity/)
})
test('taking an order uses current availability, contract registry and short-lived authorization', async () => {
  let expired = false, unknownContract = false, encoded = false
  globalThis.fetch = async (url, init) => {
    const path = new URL(String(url)).pathname
    if (path === '/read-partner/api/v1/orders') return reply({ orders: [{ id: 7, chainId: 1, makerAsset: tokenIn, takerAsset: tokenOut,
      contractAddress: unknownContract ? other : contract, makingAmount: input.amount, takingAmount: '2700000000', availableMakingAmount: input.amount, feeConfig }] }, true)
    if (path.includes('contract-address')) return reply({ latest: contract, features: {} }, true)
    if (path.includes('operator-signature')) return reply({ orders: [{ id: 7, operatorSignature: '0x1234', operatorSignatureExpiredAt: Math.floor(Date.now() / 1000) + (expired ? 1 : 180) }] }, true)
    if (path.includes('fill-order-to')) {
      const body = JSON.parse(init?.body as string)
      assert.equal(body.target, user); assert.equal(body.takingAmount, '1350000000')
      assert.equal(body.thresholdAmount, '496256250000000000')
      encoded = true
      return reply({ encodedData: '0x12345678' }, true)
    }
    throw new Error('Unexpected upstream request')
  }
  const fill = { chainId: 1, user, makerAsset: tokenIn, takerAsset: tokenOut, orderId: 7, takingAmount: '1350000000', slippageTolerance: '50' }
  const result = await prepareFill(fill)
  assert.equal(result.inputAmount, '1350000000')
  assert.equal(result.steps[1].items[0].data.to, contract)
  assert(result.expiresAt <= Date.now() + 60000)
  assert(encoded)
  expired = true; encoded = false
  await assert.rejects(prepareFill(fill), /authorization expired/)
  assert(!encoded)
  unknownContract = true
  await assert.rejects(prepareFill(fill), /Unrecognized/)
})
test('trigger compares minimum net output, never a headline price or expected output', () => {
  const quote = relayResult()
  assert.equal(meetsTarget(quote, '2790000000'), false)
  assert.equal(meetsTarget(quote, '2786000000'), true)
  assert.equal(meetsTarget({ details: { currencyOut: { amount: '9999999999' } } }, '1'), false)
  assert.equal(minimumOutput('1000000000000000001', 50), '995000000000000000')
})
test('HTTP boundary rejects cross-origin requests and redacts provider secrets', async () => {
  const rejected = await endpoint(new Request('https://pro.dexdna.app/api/trading/quote', { method: 'POST', headers: { origin: 'https://attacker.example' } }), () => ({}))
  assert.equal(rejected.status, 403)
  globalThis.fetch = async () => Response.json({ message: 'Bad credential test-only-relay-key' }, { status: 401 })
  const response = await endpoint(new Request('https://pro.dexdna.app/api/trading/quote'), () => relayQuote(input))
  assert(!JSON.stringify(await response.json()).includes('test-only-relay-key'))
})
test('HTTP boundary rejects oversized JSON bodies', async () => {
  await assert.rejects(readBody(new Request('https://pro.dexdna.app/api/trading/quote', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ data: 'x'.repeat(66000) }) })), /too large/)
})
test('static client contains no provider key setting or editable operator fee', () => {
  const html = readFileSync(new URL('../../public/routeforge.html', import.meta.url), 'utf8')
  const client = readFileSync(new URL('../../public/trading.js', import.meta.url), 'utf8')
  assert(!/RELAY_API_KEY|setKey|setFeeTo|setFeeBps|S\.settings/.test(html + client))
  assert(html.includes('localStorage.removeItem("ns:settings")'))
  assert(client.includes('no unattended execution'))
})
test('external links leave the embedded terminal frame', () => {
  const html = readFileSync(new URL('../../public/routeforge.html', import.meta.url), 'utf8')
  const external = html.match(/<a\b[^>]*href="https?:[^"]*"[^>]*>/g) ?? []
  assert(external.length > 0)
  for (const tag of external) assert(/target="_(top|blank)"/.test(tag), `link opens inside the iframe: ${tag}`)
})
