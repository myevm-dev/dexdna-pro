import { marketQuote } from '@/lib/trading/market'
import { endpoint, readBody } from '@/lib/trading/http'
export const runtime = 'nodejs'
export async function POST(request: Request) { return endpoint(request, async () => marketQuote(await readBody(request))) }
