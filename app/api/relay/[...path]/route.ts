import { endpoint, readBody } from '@/lib/trading/http'
import { relayGateway } from '@/lib/trading/market'
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
async function handle(request: Request) {
  return endpoint(request, async () => {
    const url = new URL(request.url)
    const path = url.pathname.slice('/api/relay'.length) + url.search
    return relayGateway(path, request.method, request.method === 'POST' ? await readBody(request) : undefined, request.headers.get('x-execution-token'))
  })
}
export const GET = handle
export const POST = handle
