import { Request, Response, NextFunction } from 'express'
import { config } from '../config/env.js'

export function errorHandler(
  err: Error & { status?: number },
  _req: Request,
  res: Response,
  _next: NextFunction
) {
  const status = err.status || 500
  const message = err.message || 'Internal Server Error'

  console.error(`[Error] ${status} - ${message}`)
  if (config.env === 'development') {
    console.error(err.stack)
  }

  res.status(status).json({
    success: false,
    status,
    message,
    ...(config.env === 'development' && { stack: err.stack }),
  })
}
