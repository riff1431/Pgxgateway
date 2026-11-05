import { Router } from 'express'
import {
  submitRegistration,
  getMerchantByEmail,
  getLatestApplication,
} from '../controllers/merchant.controller.js'

const router = Router()

router.post('/register', submitRegistration)
router.get('/latest', getLatestApplication)
router.get('/:email', getMerchantByEmail)

export default router
