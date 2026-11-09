import { Router } from 'express'
import { register, login, getMe, updateProfile, changePassword } from '../controllers/auth.controller.js'
import { protect } from '../middleware/auth.middleware.js'
import { authLimiter } from '../middleware/rateLimiter.js'

const router = Router()

router.post('/register', authLimiter, register)
router.post('/login', authLimiter, login)
router.get('/me', protect, getMe)
router.patch('/profile', protect, updateProfile)
router.patch('/change-password', authLimiter, protect, changePassword)

export default router
