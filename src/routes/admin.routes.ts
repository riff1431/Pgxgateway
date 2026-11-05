import { Router } from 'express'
import {
  adminLogin,
  getApplications,
  getApplicationById,
  reviewApplication,
  getAdminStats,
} from '../controllers/admin.controller.js'
import { adminProtect } from '../middleware/admin.middleware.js'

const router = Router()

// Public admin login
router.post('/login', adminLogin)

// Protected Underwriting Endpoints
router.use(adminProtect)

router.get('/stats', getAdminStats)
router.get('/applications', getApplications)
router.get('/applications/:id', getApplicationById)
router.patch('/applications/:id/review', reviewApplication)

export default router
