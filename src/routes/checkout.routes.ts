import { Router } from 'express'
import {
  getMerchantPublicProfile,
  initiateCheckout,
  getCheckoutSessionStatus,
} from '../controllers/checkout.controller.js'

const router = Router()

// Public checkout endpoints (accessible by shoppers / merchant stores)
router.get('/public-merchant/:refId', getMerchantPublicProfile)
router.post('/session', initiateCheckout)
router.get('/session/:sessionId', getCheckoutSessionStatus)

export default router
