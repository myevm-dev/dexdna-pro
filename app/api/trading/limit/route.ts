import { endpoint, readBody } from '@/lib/trading/http'
import { makerOrders, orderBook, prepareCancel, prepareFill, prepareOrder, submitCancel, submitOrder } from '@/lib/trading/limit'
import { TradingError } from '@/lib/trading/core'
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export async function GET(request: Request) {
  return endpoint(request, async () => {
    const input = Object.fromEntries(new URL(request.url).searchParams)
    return input.action === 'mine' ? makerOrders(input) : orderBook(input)
  })
}
export async function POST(request: Request) {
  return endpoint(request, async () => {
    const input = await readBody(request)
    const actions = { prepare: prepareOrder, submit: submitOrder, 'prepare-cancel': prepareCancel, cancel: submitCancel, fill: prepareFill }
    if (!Object.hasOwn(actions, input.action)) throw new TradingError('Unknown limit-order action')
    return actions[input.action as keyof typeof actions](input)
  })
}
