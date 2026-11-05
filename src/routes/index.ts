import { Router } from 'express'
import healthRoutes from './health.routes.js'
import merchantRoutes from './merchant.routes.js'

const apiRouter = Router()

apiRouter.use('/health', healthRoutes)
apiRouter.use('/merchants', merchantRoutes)

export default apiRouter
