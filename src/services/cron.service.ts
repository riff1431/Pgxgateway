import cron from 'node-cron'
import { runDailySubscriptionCycle } from './subscription.service.js'

let isCronRunning = false

export function initCronJobs() {
  console.log('[Cron Service] Initializing background schedulers...')

  // Schedule daily maintenance fee billing evaluation at 00:00 UTC ('0 0 * * *')
  // For resilience, this runs once every 24 hours.
  cron.schedule('0 0 * * *', async () => {
    if (isCronRunning) {
      console.warn('[Cron Service] Previous subscription billing cycle still running. Skipping iteration.')
      return
    }

    try {
      isCronRunning = true
      console.log(`[Cron Service] [${new Date().toISOString()}] Triggering scheduled daily subscription cycle...`)
      await runDailySubscriptionCycle()
    } catch (error) {
      console.error('[Cron Service] Error running daily subscription cycle:', error)
    } finally {
      isCronRunning = false
    }
  })

  console.log('[Cron Service] Registered Daily Subscription Billing Job (00:00 UTC).')
}

export async function triggerManualSubscriptionCycle() {
  if (isCronRunning) {
    throw new Error('A subscription billing cycle is already in progress.')
  }

  try {
    isCronRunning = true
    return await runDailySubscriptionCycle()
  } finally {
    isCronRunning = false
  }
}
