import { Router } from 'express'
import healthRoutes from './health.routes.js'
import authRoutes from './auth.routes.js'
import merchantRoutes from './merchant.routes.js'
import dashboardRoutes from './dashboard.routes.js'
import adminRoutes from './admin.routes.js'
import checkoutRoutes from './checkout.routes.js'
import webhookRoutes from './webhook.routes.js'

const apiRouter = Router()

// Public Webhooks (Mounted with raw body parser for signature integrity)
apiRouter.use('/webhooks', webhookRoutes)

apiRouter.use('/health', healthRoutes)
apiRouter.use('/auth', authRoutes)
apiRouter.use('/merchants', merchantRoutes)
apiRouter.use('/dashboard', dashboardRoutes)
apiRouter.use('/admin', adminRoutes)
apiRouter.use('/checkout', checkoutRoutes)

export default apiRouter
