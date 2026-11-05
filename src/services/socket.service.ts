import { Server as HttpServer } from 'node:http'
import { Server, Socket } from 'socket.io'
import { config } from '../config/env.js'
import { verifyToken } from '../utils/jwt.js'

let io: Server | null = null

export interface AuthenticatedSocket extends Socket {
  merchantId?: string
  merchantEmail?: string
}

export function initSocket(httpServer: HttpServer): Server {
  const allowedOrigins = [
    'https://pgxgateway.com',
    'https://www.pgxgateway.com',
    'http://localhost:5173',
    'http://127.0.0.1:5173',
  ]

  io = new Server(httpServer, {
    cors: {
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
      methods: ['GET', 'POST'],
      credentials: true,
    },
    pingTimeout: 60000,
  })

  // Socket.IO JWT Authentication Middleware
  io.use((socket: AuthenticatedSocket, next) => {
    const token =
      socket.handshake.auth?.token ||
      socket.handshake.headers?.authorization?.replace('Bearer ', '') ||
      (socket.handshake.query?.token as string | undefined)

    if (token) {
      try {
        const decoded = verifyToken(token)
        socket.merchantId = decoded.id
        socket.merchantEmail = decoded.email
      } catch {
        console.warn(`[WebSocket] Invalid token from client ${socket.id}, proceeding as guest.`)
      }
    }

    next()
  })

  io.on('connection', (socket: AuthenticatedSocket) => {
    if (socket.merchantId) {
      const room = `merchant:${socket.merchantId}`
      socket.join(room)
      console.log(`[WebSocket] Merchant authenticated: ${socket.merchantEmail} joined ${room}`)
    } else {
      console.log(`[WebSocket] Guest client connected: ${socket.id}`)
    }

    // Ping / Pong test
    socket.on('ping', () => {
      socket.emit('pong', { timestamp: new Date().toISOString() })
    })

    socket.on('disconnect', (reason) => {
      console.log(`[WebSocket] Client disconnected: ${socket.id} (${reason})`)
    })
  })

  console.log('[WebSocket] Socket.IO server initialized.')
  return io
}

export function getIO(): Server {
  if (!io) {
    throw new Error('Socket.IO has not been initialized. Call initSocket first.')
  }
  return io
}

// Real-time helper: Emit event to a specific merchant's private room
export function emitToMerchant<T = unknown>(merchantId: string, event: string, data: T): void {
  if (!io) return
  io.to(`merchant:${merchantId}`).emit(event, data)
}

// Real-time helper: Broadcast event to all connected clients
export function broadcast<T = unknown>(event: string, data: T): void {
  if (!io) return
  io.emit(event, data)
}

// Predefined WebSocket Event constants
export const WS_EVENTS = {
  APPLICATION_UPDATED: 'application:updated',
  OFFER_UPDATED: 'offer:updated',
  NEW_NOTIFICATION: 'notification:new',
  TRANSACTION_STATUS: 'transaction:status',
} as const
