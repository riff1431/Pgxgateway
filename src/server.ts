import http from 'node:http'
import { createApp } from './app.js'
import { connectDB, disconnectDB } from './config/db.js'
import { config } from './config/env.js'
import { initSocket } from './services/socket.service.js'
import { initCronJobs } from './services/cron.service.js'

async function bootstrap() {
  // Connect to MongoDB
  await connectDB()

  // Initialize Background Cron Schedulers
  initCronJobs()

  const app = createApp()
  const httpServer = http.createServer(app)

  // Initialize WebSockets (Socket.IO)
  initSocket(httpServer)

  const server = httpServer.listen(config.port, () => {
    console.log(`[PGX Backend] Server is running on port ${config.port} (${config.env})`)
    console.log(`[PGX Backend] HTTP Health check: http://localhost:${config.port}/api/v1/health`)
    console.log(`[PGX Backend] Real-time WebSocket: ws://localhost:${config.port}`)
  })

  // Graceful shutdown
  const gracefulShutdown = async (signal: string) => {
    console.log(`\n[PGX Backend] Received ${signal}. Shutting down gracefully...`)
    server.close(async () => {
      console.log('[PGX Backend] HTTP and WebSocket server closed.')
      await disconnectDB()
      process.exit(0)
    })

    // Force close if graceful shutdown hangs
    setTimeout(() => {
      console.error('[PGX Backend] Could not close connections in time, forcefully shutting down.')
      process.exit(1)
    }, 10000)
  }

  process.on('SIGINT', () => gracefulShutdown('SIGINT'))
  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'))
}

bootstrap().catch((err) => {
  console.error('[PGX Backend] Bootstrap fatal error:', err)
  process.exit(1)
})
