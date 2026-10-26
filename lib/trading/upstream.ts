import { config } from './config.ts'
import { TradingError } from './core.ts'
import type { Json } from './core.ts'

export const ORIGINS = { relay: 'https://api.relay.link', kyber: 'https://api.kyberswap.com/swap', limit: 'https://limit-order.kyberswap.com' }
export type Service = keyof typeof ORIGINS

export function redact(message: string) {
  const c = config()
  for (const secret of [c.relayKey, c.kyberKey, c.signingSecret]) if (secret) message = message.split(secret).join('[redacted]')
  return message.slice(0, 250)
}

export async function upstream(service: Service, path: string, method = 'GET', body?: Json): Promise<any> {
  if (!path.startsWith('/') || path.startsWith('//') || path.includes('://') || /[\\\r\n]/.test(path)) throw new TradingError('Invalid provider path')
  const c = config()
  const headers: Record<string, string> = { accept: 'application/json', 'content-type': 'application/json' }
  if (service === 'relay' && c.relayKey) headers['x-api-key'] = c.relayKey
  if (service !== 'relay') headers['x-client-id'] = c.clientId
  if (service === 'kyber' && c.kyberKey) headers['X-Api-Key'] = c.kyberKey
  if (service === 'limit') headers.Origin = process.env.APP_ORIGIN || 'https://pro.dexdna.app'
  let response
  try {
    response = await fetch(ORIGINS[service] + path, { method, headers, body: body ? JSON.stringify(body) : undefined,
      redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(15000) })
  } catch { throw new TradingError('Provider is unavailable; please retry shortly', 502) }
  let json
  try { json = await response.json() } catch { throw new TradingError('Provider returned an invalid response', 502) }
  if (!response.ok || (service !== 'relay' && json.code !== undefined && json.code !== 0)) {
    throw new TradingError(redact(String(json.message || json.error || 'Provider rejected the request')), response.status === 429 ? 429 : 502)
  }
  return service === 'relay' ? json : json.data
}
