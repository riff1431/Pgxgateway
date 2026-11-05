import { Request, Response, NextFunction } from 'express'
import { config } from '../config/env.js'
import { verifyToken } from '../utils/jwt.js'

export interface AdminRequest extends Request {
  admin?: {
    email: string
    role: 'admin'
  }
}

export function adminProtect(req: AdminRequest, res: Response, next: NextFunction) {
  // 1. Check for x-admin-key header
  const adminKey = req.headers['x-admin-key']
  if (adminKey && adminKey === config.admin.secretKey) {
    req.admin = {
      email: config.admin.email,
      role: 'admin',
    }
    return next()
  }

  // 2. Check for Bearer token
  const authHeader = req.headers.authorization
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({
      success: false,
      message: 'Admin authorization required. Please provide a valid admin token or x-admin-key.',
    })
  }

  const token = authHeader.split(' ')[1]

  try {
    const decoded = verifyToken(token)
    if (decoded.role !== 'admin' && decoded.email !== config.admin.email) {
      return res.status(403).json({
        success: false,
        message: 'Forbidden. Insufficient administrative privileges.',
      })
    }

    req.admin = {
      email: decoded.email,
      role: 'admin',
    }
    next()
  } catch {
    return res.status(401).json({
      success: false,
      message: 'Invalid or expired admin token.',
    })
  }
}
