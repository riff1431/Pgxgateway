import { Router } from 'express'
import healthRoutes from './health.routes.js'
import authRoutes from './auth.routes.js'
import merchantRoutes from './merchant.routes.js'
import dashboardRoutes from './dashboard.routes.js'
import adminRoutes from './admin.routes.js'
import checkoutRoutes from './checkout.routes.js'
import webhookRoutes from './webhook.routes.js'
import setupRoutes from './setup.routes.js'
import invoiceRoutes from './invoice.routes.js'
import resellerRoutes from './reseller.routes.js'
import reviewRoutes from './review.routes.js'
import paymentLinkRoutes from './paymentLink.routes.js'

const apiRouter = Router()

// Public Webhooks (Mounted with raw body parser for signature integrity)
apiRouter.use('/webhooks', webhookRoutes)

apiRouter.use('/health', healthRoutes)
apiRouter.use('/auth', authRoutes)
apiRouter.use('/merchants', merchantRoutes)
apiRouter.use('/dashboard', dashboardRoutes)
apiRouter.use('/admin', adminRoutes)
apiRouter.use('/checkout', checkoutRoutes)
apiRouter.use('/payment-links', paymentLinkRoutes)
apiRouter.use('/setup', setupRoutes)
apiRouter.use('/invoices', invoiceRoutes)
apiRouter.use('/reseller', resellerRoutes)
apiRouter.use('/reviews', reviewRoutes)

export default apiRouter
