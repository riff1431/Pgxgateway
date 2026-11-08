import { Router, raw } from 'express'
import { handleStripeWebhook } from '../controllers/webhook.controller.js'

const router = Router()

// Use express.raw parser specifically for Stripe webhook payload signature verification
router.post('/stripe', raw({ type: 'application/json' }), handleStripeWebhook)
router.post('/stripe/:resellerId', raw({ type: 'application/json' }), handleStripeWebhook)

export default router
