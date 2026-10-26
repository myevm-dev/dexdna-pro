import { TradingError, object } from './core.ts'
import { redact } from './upstream.ts'

const buckets = new Map<string, { reset: number, count: number }>()
export function guard(request: Request) {
  const origin = request.headers.get('origin')
  const ownOrigin = new URL(request.url).origin
  if ((origin && origin !== ownOrigin && origin !== process.env.APP_ORIGIN) || request.headers.get('sec-fetch-site') === 'cross-site') {
    throw new TradingError('Cross-origin trading requests are not allowed', 403)
  }
  const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'local'
  const key = ip + ':' + (request.method === 'GET' ? 'read' : 'write')
  const now = Date.now()
  if (buckets.size > 5000) for (const [k, v] of buckets) if (v.reset < now) buckets.delete(k)
  if (buckets.size > 5000 && !buckets.has(key)) throw new TradingError('Server is busy; retry shortly', 429)
  let bucket = buckets.get(key)
  if (!bucket || bucket.reset < now) { bucket = { reset: now + 60000, count: 0 }; buckets.set(key, bucket) }
  if (++bucket.count > (request.method === 'GET' ? 180 : 60)) throw new TradingError('Too many requests; retry shortly', 429)
}

export async function readBody(request: Request) {
  if (!request.headers.get('content-type')?.includes('application/json')) throw new TradingError('JSON content type required', 415)
  const reader = request.body?.getReader()
  if (!reader) throw new TradingError('Missing JSON body')
  const chunks: Uint8Array[] = []; let size = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.length
    if (size > 65536) { await reader.cancel(); throw new TradingError('Request is too large', 413) }
    chunks.push(value)
  }
  try { return object(JSON.parse(Buffer.concat(chunks).toString('utf8'))) }
  catch (error) { if (error instanceof TradingError) throw error; throw new TradingError('Invalid JSON') }
}

export function json(value: unknown, status = 200) {
  return Response.json(value, { status, headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } })
}
export async function endpoint(request: Request, run: () => Promise<unknown> | unknown) {
  try { guard(request); return json(await run()) }
  catch (error) {
    return json({ error: error instanceof TradingError ? redact(error.message) : 'Trading request failed; please retry' }, error instanceof TradingError ? error.status : 500)
  }
}
