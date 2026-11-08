import { Request, Response, NextFunction } from 'express'
import { verifyToken } from '../utils/jwt.js'
import { Merchant, IMerchant } from '../models/Merchant.js'

export interface AuthRequest extends Request {
  user?: IMerchant
  merchant?: IMerchant
}

export async function protect(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    let token: string | undefined

    if (req.headers.authorization && req.headers.authorization.startsWith('Bearer ')) {
      token = req.headers.authorization.split(' ')[1]
    }

    if (!token) {
      return res.status(401).json({
        success: false,
        message: 'Access denied. Authentication token is missing.',
      })
    }

    // Verify token
    const decoded = verifyToken(token)

    // Check if merchant still exists
    const currentMerchant = await Merchant.findById(decoded.id)
    if (!currentMerchant) {
      return res.status(401).json({
        success: false,
        message: 'The merchant account belonging to this token no longer exists.',
      })
    }

    // Grant access & attach to request
    req.user = currentMerchant
    req.merchant = currentMerchant
    next()
  } catch (error) {
    return res.status(401).json({
      success: false,
      message: 'Invalid or expired authentication token.',
      error: error instanceof Error ? error.message : undefined,
    })
  }
}
