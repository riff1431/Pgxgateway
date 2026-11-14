import { Router } from 'express'
import {
  authenticateResellerKey,
  onboardArxoMerchant,
  getArxoOverview,
} from '../controllers/reseller.controller.js'

const router = Router()

// All reseller routes require valid x-reseller-key
router.use(authenticateResellerKey)

// ARXO Pay specific endpoints
router.post('/arxo/onboard', onboardArxoMerchant)
router.get('/arxo/overview', getArxoOverview)

export default router
