import { address, TradingError } from './core.ts'

export function config() {
  const bps = Number(process.env.APP_FEE_BPS)
  let recipient = ''
  try { recipient = address(process.env.APP_FEE_RECIPIENT) } catch {}
  const feeReady = Boolean(recipient && process.env.APP_FEE_BPS && Number.isInteger(bps) && bps > 0 && bps <= 1000)
  const signingSecret = process.env.ORDER_SIGNING_SECRET || ''
  return {
    recipient, bps, feeReady, signingSecret,
    signingReady: signingSecret.length >= 32,
    relayKey: process.env.RELAY_API_KEY || '',
    kyberKey: process.env.KYBER_SWAP_API_KEY || '',
    clientId: process.env.KYBER_CLIENT_ID || 'dexdna-pro',
    referral: process.env.KYBER_REFERRAL || '',
    relayReferrer: process.env.RELAY_REFERRER || 'dexdna-pro',
    limitEnabled: process.env.KYBER_LIMIT_ENABLED === 'true',
  }
}

export function feePolicy() {
  const c = config()
  if (!c.feeReady) throw new TradingError('Trading is awaiting the operator’s developer wallet and fee configuration.', 503)
  if (!c.signingReady) throw new TradingError('Trading is awaiting the server order-signing configuration.', 503)
  return c
}

export function capabilities() {
  const c = config()
  const base = c.feeReady && c.signingReady
  return {
    fee: { bps: c.feeReady ? c.bps : null, recipient: c.recipient || null },
    providers: [
      { id: 'relay', label: 'Relay', market: Boolean(base && c.relayKey), trigger: Boolean(base && c.relayKey), limit: false,
        reason: !base ? 'Operator configuration required' : !c.relayKey ? 'Relay API key is not configured' : null },
      { id: 'kyber', label: 'KyberSwap', market: Boolean(base && c.kyberKey), trigger: false, limit: Boolean(base && c.limitEnabled),
        reason: !base ? 'Operator configuration required' : !c.kyberKey ? 'Kyber swap API key is not configured' : null },
    ],
    limit: { enabled: Boolean(base && c.limitEnabled), feeVerification: 'every-order',
      reason: !base ? 'Operator configuration required' : !c.limitEnabled ? 'Kyber partner fee configuration is not enabled' : null },
    trigger: { execution: 'wallet-confirmed', monitoring: 'while-page-open' },
  }
}
