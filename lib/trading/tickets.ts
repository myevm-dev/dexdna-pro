import { createHmac, timingSafeEqual } from 'node:crypto'
import { config } from './config.ts'
import { TradingError } from './core.ts'
import type { Json } from './core.ts'

function secret() {
  const c = config()
  if (!c.signingReady) throw new TradingError('Server order signing is not configured', 503)
  return c.signingSecret
}

export function seal(kind: string, data: Json, seconds = 120, now = Date.now()) {
  const payload = Buffer.from(JSON.stringify({ kind, data, expires: now + seconds * 1000 })).toString('base64url')
  return payload + '.' + createHmac('sha256', secret()).update(payload).digest('base64url')
}

export function unseal(ticket: unknown, kind: string, now = Date.now()): Json {
  if (typeof ticket !== 'string' || ticket.length > 60000) throw new TradingError('Missing or invalid execution ticket')
  const [payload, mac, extra] = ticket.split('.')
  if (!payload || !mac || extra) throw new TradingError('Invalid execution ticket')
  const expected = createHmac('sha256', secret()).update(payload).digest()
  const actual = Buffer.from(mac, 'base64url')
  if (actual.length !== expected.length || !timingSafeEqual(expected, actual)) throw new TradingError('Execution ticket was changed')
  let decoded
  try { decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) } catch { throw new TradingError('Invalid execution ticket') }
  if (decoded.kind !== kind || !Number.isFinite(decoded.expires) || decoded.expires <= now) throw new TradingError('Execution ticket expired; refresh and try again')
  return decoded.data
}
