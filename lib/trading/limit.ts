import { address, approval, ceilDiv, chain, dataHex, decodeFee, minimumOutput, object, signature, slippage, TradingError, uint, ZERO } from './core.ts'
import type { Json } from './core.ts'
import { config, feePolicy } from './config.ts'
import { seal, unseal } from './tickets.ts'
import { upstream } from './upstream.ts'

function enabled() {
  const c = feePolicy()
  if (!c.limitEnabled) throw new TradingError('Kyber limit trading is awaiting the operator’s partner fee setup', 503)
  return c
}

export function verifyLimitFee(feeConfig: unknown) {
  const c = feePolicy()
  const fee = decodeFee(feeConfig)
  if (fee.recipient !== c.recipient || fee.rate !== c.bps * 10) {
    throw new TradingError('This order does not pay the configured DexDNA developer fee', 422)
  }
  return fee
}

async function contracts(chainId: number) {
  const result = await upstream('limit', `/read-ks/api/v1/configs/contract-address?chainId=${chainId}`)
  address(result?.latest, 'Kyber limit contract')
  return result
}
function knownContract(result: Json, contract: string) {
  const known = [result.latest, ...Object.keys(result.features || {})].map(v => String(v).toLowerCase())
  if (!known.includes(contract)) throw new TradingError('Unrecognized Kyber limit-order contract', 502)
}

export async function orderBook(input: Json) {
  const chainId = chain(input.chainId)
  const makerAsset = address(input.makerAsset, 'maker token')
  const takerAsset = address(input.takerAsset, 'taker token')
  const query = new URLSearchParams({ chainId: String(chainId), makerAsset, takerAsset })
  const data = await upstream('limit', `/read-partner/api/v1/orders?${query}`)
  const orders = Array.isArray(data?.orders) ? data.orders : []
  return { orders: orders.slice(0, 100).map((order: Json) => {
    let feeEligible = false
    try { enabled(); verifyLimitFee(order.feeConfig); feeEligible = true } catch {}
    return { ...order, feeEligible }
  }) }
}

export async function prepareOrder(input: Json) {
  const c = enabled()
  const chainId = chain(input.chainId)
  const maker = address(input.maker, 'maker wallet')
  const makerAsset = address(input.makerAsset, 'sell token (use WETH for ETH)')
  const takerAsset = address(input.takerAsset, 'receive token (use wrapped native tokens)')
  if (makerAsset === takerAsset) throw new TradingError('Choose different tokens')
  const makingAmount = uint(input.makingAmount)
  const takingAmount = uint(input.takingAmount, 'minimum receipt')
  const expiredAt = Number(input.expiredAt)
  const now = Math.floor(Date.now() / 1000)
  if (!Number.isInteger(expiredAt) || expiredAt < now + 300 || expiredAt > now + 30 * 86400) throw new TradingError('Choose an expiry between 5 minutes and 30 days')
  const body: Json = { chainId: String(chainId), maker, receiver: maker, makerAsset, takerAsset, makingAmount, takingAmount, expiredAt,
    referral: c.referral, nativeOutput: false }
  const registry = await contracts(chainId)
  const typed = await upstream('limit', '/write/api/v1/orders/sign-message', 'POST', body)
  const message = object(typed?.message)
  const contract = address(typed.domain?.verifyingContract, 'signing contract')
  knownContract(registry, contract)
  if (Number(typed.domain.chainId) !== chainId || typed.primaryType !== 'Order' ||
    address(message.maker) !== maker || address(message.receiver) !== maker ||
    address(message.makerAsset) !== makerAsset || address(message.takerAsset) !== takerAsset ||
    String(message.makingAmount) !== makingAmount || String(message.takingAmount) !== takingAmount ||
    address(message.allowedSender, 'allowed sender', true) !== ZERO) throw new TradingError('Kyber signing message changed the requested order', 502)
  const fee = verifyLimitFee(message.feeConfig)
  const active = await upstream('limit', '/read-ks/api/v1/orders/active-making-amount?' + new URLSearchParams({ chainId: String(chainId), makerAsset, maker }))
  const activeAmount = uint(String(active.activeMakingAmount), 'active making amount', false)
  const allowanceAmount = uint((BigInt(activeAmount) + BigInt(makingAmount)).toString(), 'required allowance')
  const submit = { ...body, salt: uint(String(message.salt), 'salt', false) }
  return { typedData: typed, contract, allowanceAmount,
    summary: { chainId, makerAsset, takerAsset, makingAmount, takingAmount, expiredAt, feeBps: c.bps, feeRecipient: fee.recipient },
    ticket: seal('kyber-create', { submit, feeConfig: message.feeConfig, clientId: c.clientId, referral: c.referral }, 300) }
}

export async function submitOrder(input: Json) {
  const c = enabled()
  const payload = unseal(input.ticket, 'kyber-create')
  verifyLimitFee(payload.feeConfig)
  if (payload.clientId !== c.clientId || payload.referral !== c.referral) throw new TradingError('Partner configuration changed; prepare the order again')
  if (payload.submit.expiredAt <= Date.now() / 1000) throw new TradingError('Order has expired')
  return upstream('limit', '/write/api/v1/orders', 'POST', { ...payload.submit, signature: signature(input.signature) })
}

export async function makerOrders(input: Json) {
  const maker = address(input.maker, 'maker wallet')
  const status = String(input.status || 'active')
  if (!['active', 'closed', 'filled', 'cancelled', 'expired'].includes(status)) throw new TradingError('Invalid order status')
  const query = new URLSearchParams({ maker, status, pageSize: '50' })
  if (input.chainId) query.set('chainId', String(chain(input.chainId)))
  return upstream('limit', `/read-ks/api/v1/orders?${query}`)
}

export async function prepareCancel(input: Json) {
  const body = { chainId: String(chain(input.chainId)), maker: address(input.maker, 'maker wallet'), orderIds: [orderId(input.orderId)] }
  const typedData = await upstream('limit', '/write/api/v1/orders/cancel-sign', 'POST', body)
  if (Number(typedData.domain?.chainId) !== Number(body.chainId) || typedData.primaryType !== 'CancelOrder') throw new TradingError('Invalid cancellation message', 502)
  return { typedData, ticket: seal('kyber-cancel', { submit: body }, 300) }
}

export async function submitCancel(input: Json) {
  const payload = unseal(input.ticket, 'kyber-cancel')
  return upstream('limit', '/write/api/v1/orders/cancel', 'POST', { ...payload.submit, signature: signature(input.signature) })
}

function orderId(value: unknown) {
  const id = Number(value)
  if (!Number.isSafeInteger(id) || id <= 0) throw new TradingError('Invalid order ID')
  return id
}

export function fillAmounts(order: Json, requested: string) {
  const taking = BigInt(uint(requested, 'fill amount'))
  const making = BigInt(uint(String(order.makingAmount), 'maker amount'))
  const totalTaking = BigInt(uint(String(order.takingAmount), 'taker amount'))
  const filled = BigInt(uint(String(order.filledMakingAmount || '0'), 'filled amount', false))
  const remaining = making - filled
  const available = order.availableMakingAmount === undefined ? remaining : BigInt(uint(String(order.availableMakingAmount), 'available amount', false))
  const gross = taking * making / totalTaking
  if (remaining <= 0n || gross <= 0n || gross > remaining || gross > available) throw new TradingError('Fill amount exceeds currently available liquidity')
  const fee = verifyLimitFee(order.feeConfig)
  const bps = BigInt(config().bps)
  const output = fee.onTakerAsset ? gross : gross - ceilDiv(gross * bps, 10000n)
  const maxInput = fee.onTakerAsset ? taking + ceilDiv(taking * bps, 10000n) : taking
  if (output <= 0n) throw new TradingError('Fill amount is too small after fees')
  return { output: output.toString(), maxInput: maxInput.toString() }
}

export async function prepareFill(input: Json) {
  const c = enabled()
  const chainId = chain(input.chainId)
  const user = address(input.user, 'taker wallet')
  const id = orderId(input.orderId)
  const book = await orderBook(input)
  const order = book.orders.find((v: Json) => Number(v.id) === id)
  if (!order) throw new TradingError('This order is no longer open', 409)
  verifyLimitFee(order.feeConfig)
  if (Number(order.chainId) !== chainId || address(order.makerAsset) !== address(input.makerAsset) || address(order.takerAsset) !== address(input.takerAsset)) throw new TradingError('Order no longer matches the selected pair', 409)
  const contract = address(order.contractAddress, 'limit-order contract')
  knownContract(await contracts(chainId), contract)
  const takingAmount = uint(input.takingAmount, 'fill amount')
  const amounts = fillAmounts(order, takingAmount)
  const thresholdAmount = minimumOutput(amounts.output, slippage(input.slippageTolerance))
  if (BigInt(thresholdAmount) === 0n) throw new TradingError('Fill amount is too small')
  const signatures = await upstream('limit', `/read-partner/api/v1/orders/operator-signature?chainId=${chainId}&orderIds=${id}`)
  const operator = signatures.orders?.find((v: Json) => Number(v.id) === id)
  if (!operator || Number(operator.operatorSignatureExpiredAt) < Date.now() / 1000 + 20) throw new TradingError('Order authorization expired; refresh the order book', 409)
  const encoded = await upstream('limit', '/read-ks/api/v1/encode/fill-order-to', 'POST', {
    orderId: id, takingAmount, thresholdAmount, target: user, operatorSignature: operator.operatorSignature,
  })
  return { chainId, user, inputToken: order.takerAsset, outputToken: order.makerAsset, inputAmount: amounts.maxInput,
    expectedOutput: amounts.output, minimumOutput: thresholdAmount, orderId: id,
    expiresAt: Math.min(Number(operator.operatorSignatureExpiredAt) * 1000, Date.now() + 60000),
    fee: { bps: c.bps, recipient: c.recipient },
    steps: [approval(order.takerAsset, contract, amounts.maxInput, chainId, user),
      { id: 'fill', kind: 'transaction', items: [{ data: { chainId, from: user, to: contract, value: '0', data: dataHex(encoded.encodedData) } }] }] }
}
