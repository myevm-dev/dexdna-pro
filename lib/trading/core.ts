export class TradingError extends Error {
  status: number
  constructor(message: string, status = 400) { super(message); this.status = status }
}

export const ZERO = '0x0000000000000000000000000000000000000000'
export const CHAINS = [1, 10, 137, 130, 5042, 8453, 42161, 43114]
export type Json = Record<string, any>

export function address(value: unknown, name = 'address', allowNative = false): string {
  if (typeof value !== 'string' || !/^0x[\da-f]{40}$/i.test(value) || (!allowNative && value.toLowerCase() === ZERO)) {
    throw new TradingError(`Invalid ${name}`)
  }
  return value.toLowerCase()
}

export function uint(value: unknown, name = 'amount', positive = true): string {
  if (typeof value !== 'string' || !/^\d{1,78}$/.test(value)) throw new TradingError(`Invalid ${name}`)
  const n = BigInt(value)
  if (n >= 2n ** 256n || (positive && n === 0n)) throw new TradingError(`Invalid ${name}`)
  return n.toString()
}

export function chain(value: unknown): number {
  const n = Number(value)
  if (!Number.isSafeInteger(n) || !CHAINS.includes(n)) throw new TradingError('Unsupported network')
  return n
}

export function object(value: unknown): Json {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TradingError('Expected a JSON object')
  return value as Json
}

export function slippage(value: unknown): number {
  const n = value === undefined || value === 'auto' ? 50 : Number(value)
  if (!Number.isInteger(n) || n < 0 || n > 500) throw new TradingError('Slippage must be between 0 and 5%')
  return n
}

export function ceilDiv(n: bigint, d: bigint): bigint { return (n + d - 1n) / d }
export function minimumOutput(amount: string, bps: number): string {
  return (BigInt(uint(amount)) * BigInt(10000 - slippage(bps)) / 10000n).toString()
}

export function meetsTarget(quote: Json, target: string): boolean {
  const min = quote?.details?.currencyOut?.minimumAmount
  return typeof min === 'string' && /^\d+$/.test(min) && BigInt(min) >= BigInt(uint(target))
}

export function quoteRequest(input: Json) {
  const user = address(input.user, 'wallet')
  const originChainId = chain(input.originChainId)
  const destinationChainId = chain(input.destinationChainId)
  const originCurrency = address(input.originCurrency, 'input token', true)
  const destinationCurrency = address(input.destinationCurrency, 'output token', true)
  if (originCurrency === destinationCurrency && originChainId === destinationChainId) throw new TradingError('Choose different tokens')
  // Deliberately construct the provider request. Client fees, calldata, recipients,
  // provider URLs and arbitrary upstream flags are never forwarded.
  return { user, recipient: user, originChainId, destinationChainId, originCurrency, destinationCurrency,
    amount: uint(input.amount), tradeType: 'EXACT_INPUT', slippageTolerance: String(slippage(input.slippageTolerance)) }
}

export function decodeFee(config: unknown) {
  const packed = BigInt(uint(config, 'fee configuration', false))
  if (packed >> 193n) throw new TradingError('Unrecognized Kyber fee configuration', 502)
  return { recipient: '0x' + (packed & ((1n << 160n) - 1n)).toString(16).padStart(40, '0'),
    rate: Number((packed >> 160n) & ((1n << 32n) - 1n)), onTakerAsset: Boolean(packed & (1n << 192n)) }
}

export function signature(value: unknown): string {
  if (typeof value !== 'string' || !/^0x[\da-f]{2,16384}$/i.test(value) || value.length % 2) throw new TradingError('Invalid wallet signature')
  return value
}

export function dataHex(value: unknown): string {
  if (typeof value !== 'string') throw new TradingError('Missing transaction data', 502)
  const hex = value.startsWith('0x') ? value : '0x' + value
  if (!/^0x[\da-f]{8,}$/i.test(hex) || hex.length % 2) throw new TradingError('Invalid transaction data', 502)
  return hex
}

export function approval(token: string, spender: string, amount: string, chainId: number, user: string) {
  return { id: 'approve', kind: 'transaction', items: [{ data: { chainId, from: user, to: token, value: '0',
    data: '0x095ea7b3' + spender.slice(2).padStart(64, '0') + BigInt(amount).toString(16).padStart(64, '0') },
    approval: { token, spender, amount } }] }
}
