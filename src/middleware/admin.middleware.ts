import { Request, Response, NextFunction } from 'express'
import { config } from '../config/env.js'
import { verifyToken } from '../utils/jwt.js'

export interface AdminRequest extends Request {
  admin?: {
    id?: string
    email: string
    role: 'admin' | 'super_admin'
    resellerId?: string
  }
}

export function adminProtect(req: AdminRequest, res: Response, next: NextFunction) {
  // 1. Check for x-admin-key header
  const adminKey = req.headers['x-admin-key']
  if (adminKey && adminKey === config.admin.secretKey) {
    req.admin = {
      id: 'admin_root',
      email: config.admin.email,
      role: 'admin',
      resellerId: 'admin_root',
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
    const isSuperAdmin = decoded.role === 'super_admin' || decoded.email.toLowerCase() === config.superAdmin.email.toLowerCase()
    const isAdmin = decoded.role === 'admin' || decoded.email.toLowerCase() === config.admin.email.toLowerCase()

    if (!isSuperAdmin && !isAdmin) {
      return res.status(403).json({
        success: false,
        message: 'Forbidden. Insufficient administrative privileges.',
      })
    }

    req.admin = {
      id: decoded.id,
      email: decoded.email,
      role: isSuperAdmin ? 'super_admin' : 'admin',
      resellerId: decoded.resellerId || (isSuperAdmin ? 'super_admin_root' : 'admin_root'),
    }
    next()
  } catch {
    return res.status(401).json({
      success: false,
      message: 'Invalid or expired admin token.',
    })
  }
}

// Super Admin Only Guard
export function superAdminOnly(req: AdminRequest, res: Response, next: NextFunction) {
  if (!req.admin || req.admin.role !== 'super_admin') {
    return res.status(403).json({
      success: false,
      message: 'Access Denied. This administrative operation requires Super Admin root privileges.',
    })
  }
  next()
}
