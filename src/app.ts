import express from 'express'
import cors from 'cors'
import helmet from 'helmet'
import morgan from 'morgan'
import { config } from './config/env.js'
import apiRouter from './routes/index.js'
import { errorHandler } from './middleware/errorHandler.js'
import { notFound } from './middleware/notFound.js'

export function createApp() {
  const app = express()

  // Security headers
  app.use(helmet())

  // CORS configuration
  app.use(
    cors({
      origin: config.corsOrigin === '*' ? true : [config.corsOrigin, 'http://localhost:5173', 'http://127.0.0.1:5173'],
      credentials: true,
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization'],
    })
  )

  // HTTP Request Logger
  if (config.env !== 'test') {
    app.use(morgan(config.env === 'production' ? 'combined' : 'dev'))
  }

  // Body parsers
  app.use(express.json({ limit: '10mb' }))
  app.use(express.urlencoded({ extended: true, limit: '10mb' }))

  // Root endpoint
  app.get('/', (_req, res) => {
    res.status(200).json({
      name: 'PGX Gateway API',
      version: '1.0.0',
      status: 'active',
      docs: '/api/v1/health',
    })
  })

  // Mount API Router
  app.use('/api/v1', apiRouter)

  // Catch-all 404 handler
  app.use(notFound)

  // Central error handler
  app.use(errorHandler)

  return app
}
