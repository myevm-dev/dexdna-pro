import { capabilities } from '@/lib/trading/config'
import { endpoint } from '@/lib/trading/http'
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export async function GET(request: Request) { return endpoint(request, capabilities) }
