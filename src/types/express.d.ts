import type { IMerchant } from '../models/Merchant.js'

export interface AdminUserContext {
  id?: string
  email: string
  role: 'admin' | 'super_admin'
  resellerId?: string
}

declare global {
  namespace Express {
    interface Request {
      merchant?: IMerchant
      user?: IMerchant
      admin?: AdminUserContext
      rawBody?: Buffer
    }
  }
}

export {}
