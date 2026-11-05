import jwt from 'jsonwebtoken'
import { config } from '../config/env.js'

export interface JWTPayload {
  id: string
  email: string
}

export function signToken(payload: JWTPayload): string {
  return jwt.sign(payload, config.jwtSecret, {
    expiresIn: config.jwtExpiresIn,
  } as jwt.SignOptions)
}

export function verifyToken(token: string): JWTPayload {
  return jwt.verify(token, config.jwtSecret) as JWTPayload
}
