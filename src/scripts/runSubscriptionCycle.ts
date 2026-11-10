import { connectDB, disconnectDB } from '../config/db.js'
import { runDailySubscriptionCycle } from '../services/subscription.service.js'

async function main() {
  console.log(`[Subscription Standalone Runner] Starting run at ${new Date().toISOString()}...`)
  try {
    await connectDB()
    const report = await runDailySubscriptionCycle()
    console.log('[Subscription Standalone Runner] Execution report:', JSON.stringify(report, null, 2))
    await disconnectDB()
    console.log('[Subscription Standalone Runner] Finished successfully.')
    process.exit(0)
  } catch (error) {
    console.error('[Subscription Standalone Runner] Fatal error:', error)
    await disconnectDB().catch(() => {})
    process.exit(1)
  }
}

main()
