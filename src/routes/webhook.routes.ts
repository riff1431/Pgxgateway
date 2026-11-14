import { Router, raw, json } from 'express'
import {
  handleStripeWebhook,
  handleGatewaySettlementWebhook,
} from '../controllers/webhook.controller.js'

const router = Router()

// Internal settlement webhook forwarded from PGX Digital E-Commerce platform
router.post('/gateway-settle', json(), handleGatewaySettlementWebhook)

// Use express.raw parser specifically for Stripe webhook payload signature verification
router.post('/stripe', raw({ type: 'application/json' }), handleStripeWebhook)
router.post('/super-admin/stripe', raw({ type: 'application/json' }), handleStripeWebhook)
router.post('/stripe/:resellerId', raw({ type: 'application/json' }), handleStripeWebhook)

export default router
