import { Router } from 'express'
import healthRoutes from './health.routes.js'
import authRoutes from './auth.routes.js'
import merchantRoutes from './merchant.routes.js'
import dashboardRoutes from './dashboard.routes.js'

const apiRouter = Router()

apiRouter.use('/health', healthRoutes)
apiRouter.use('/auth', authRoutes)
apiRouter.use('/merchants', merchantRoutes)
apiRouter.use('/dashboard', dashboardRoutes)

export default apiRouter
