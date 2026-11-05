import { Request, Response } from 'express'
import mongoose from 'mongoose'
import { config } from '../config/env.js'

export function getHealth(_req: Request, res: Response) {
  const dbState = mongoose.connection.readyState
  const dbStatusMap: Record<number, string> = {
    0: 'disconnected',
    1: 'connected',
    2: 'connecting',
    3: 'disconnecting',
  }

  res.status(200).json({
    success: true,
    service: 'pgxgateway-be',
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptimeSeconds: Math.floor(process.uptime()),
    environment: config.env,
    database: {
      status: dbStatusMap[dbState] || 'unknown',
      name: mongoose.connection.name || 'pgxdb',
      host: mongoose.connection.host || 'cluster0',
    },
  })
}
