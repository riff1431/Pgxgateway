import express from 'express'
import cors from 'cors'
import helmet from 'helmet'
import morgan from 'morgan'
import path from 'node:path'
import { config } from './config/env.js'
import apiRouter from './routes/index.js'
import { errorHandler } from './middleware/errorHandler.js'
import { notFound } from './middleware/notFound.js'

export function createApp() {
  const app = express()

  // Security headers (configured to allow static asset serving)
  app.use(
    helmet({
      crossOriginResourcePolicy: { policy: 'cross-origin' },
    })
  )

  // CORS configuration
  const allowedOrigins = [
    'https://pgxgateway.com',
    'https://www.pgxgateway.com',
    'http://localhost:5173',
    'http://127.0.0.1:5173',
  ]

  app.use(
    cors({
      origin: (origin, callback) => {
        if (!origin || config.corsOrigin === '*') {
          return callback(null, true)
        }
        const configured = config.corsOrigin.split(',').map((o) => o.trim())
        const allAllowed = [...allowedOrigins, ...configured]
        if (allAllowed.includes(origin)) {
          return callback(null, true)
        }
        return callback(null, false)
      },
      credentials: true,
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization'],
    })
  )

  // HTTP Request Logger
  if (config.env !== 'test') {
    app.use(morgan(config.env === 'production' ? 'combined' : 'dev'))
  }

  // Body parsers (safe 1MB limit for DoS protection, with raw buffer capture for Stripe webhooks)
  app.use(
    express.json({
      limit: '1mb',
      verify: (req: any, _res, buf) => {
        if (req.originalUrl && req.originalUrl.includes('/webhooks')) {
          req.rawBody = buf
        }
      },
    })
  )
  app.use(express.urlencoded({ extended: true, limit: '1mb' }))

  // Serve uploaded files statically
  const uploadsPath = path.resolve(process.cwd(), 'uploads')
  app.use('/uploads', express.static(uploadsPath))

  // Root endpoint
  app.get('/', (_req, res) => {
    res.status(200).json({
      name: 'PGX Gateway API',
      version: '1.0.0',
      status: 'active',
      endpoints: {
        health: '/api/v1/health',
        auth: '/api/v1/auth',
        merchants: '/api/v1/merchants',
        dashboard: '/api/v1/dashboard',
      },
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
