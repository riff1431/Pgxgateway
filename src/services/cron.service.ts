import cron from 'node-cron'
import { runDailySubscriptionCycle } from './subscription.service.js'
import { Transaction } from '../models/Transaction.js'
import { Merchant } from '../models/Merchant.js'
import { emitToMerchant, WS_EVENTS } from './socket.service.js'

let isCronRunning = false

export async function runDailyReserveAndHoldEvaluation() {
  const now = new Date()
  console.log(`[Cron Service] [${now.toISOString()}] Running settlement hold & rolling reserve evaluation...`)

  // 1. Mature settlement holds (e.g. 14 days or 30 days passed)
  const maturedHolds = await Transaction.updateMany(
    {
      status: 'succeeded',
      settlementStatus: 'on_hold',
      settlementEligibleAt: { $lte: now },
    },
    {
      $set: { settlementStatus: 'available' },
    }
  )

  if (maturedHolds.modifiedCount > 0) {
    console.log(`[Cron Service] Matured ${maturedHolds.modifiedCount} transactions into available settlement.`)
  }

  // 2. Release rolling reserves (e.g. 60 days or 90 days passed)
  const maturedReserves = await Transaction.find({
    status: 'succeeded',
    rollingReserveStatus: 'locked',
    rollingReserveReleaseAt: { $lte: now },
  })

  for (const txn of maturedReserves) {
    txn.rollingReserveStatus = 'released'
    await txn.save()

    if (txn.rollingReserveAmount && txn.rollingReserveAmount > 0) {
      await Merchant.findByIdAndUpdate(txn.merchantId, {
        $inc: { 'balance.netBalance': txn.rollingReserveAmount },
      })

      emitToMerchant(String(txn.merchantId), WS_EVENTS.NEW_NOTIFICATION, {
        title: 'Rolling Reserve Released',
        message: `Your rolling reserve of $${txn.rollingReserveAmount.toFixed(2)} from transaction ${txn.transactionId} has matured and been credited to your available balance.`,
        type: 'system',
      })
    }
  }

  if (maturedReserves.length > 0) {
    console.log(`[Cron Service] Released ${maturedReserves.length} matured rolling reserve tranches.`)
  }
}

export function initCronJobs() {
  console.log('[Cron Service] Initializing background schedulers...')

  // Schedule daily maintenance & settlement evaluation at 00:00 UTC ('0 0 * * *')
  // Runs automatically once every 24 hours.
  cron.schedule('0 0 * * *', async () => {
    if (isCronRunning) {
      console.warn('[Cron Service] Previous cron cycle still running. Skipping iteration.')
      return
    }

    try {
      isCronRunning = true
      console.log(`[Cron Service] [${new Date().toISOString()}] Triggering scheduled daily cycle...`)
      await runDailySubscriptionCycle()
      await runDailyReserveAndHoldEvaluation()
    } catch (error) {
      console.error('[Cron Service] Error running daily cycle:', error)
    } finally {
      isCronRunning = false
    }
  })

  console.log('[Cron Service] Registered Daily Subscription & Settlement Evaluation Job (00:00 UTC).')
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

export async function triggerManualSettlementCycle() {
  return await runDailyReserveAndHoldEvaluation()
}
