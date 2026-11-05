import { createApp } from './app.js'
import { connectDB, disconnectDB } from './config/db.js'
import { config } from './config/env.js'

async function bootstrap() {
  // Connect to MongoDB
  await connectDB()

  const app = createApp()

  const server = app.listen(config.port, () => {
    console.log(`[PGX Backend] Server is running on port ${config.port} (${config.env})`)
    console.log(`[PGX Backend] Health check: http://localhost:${config.port}/api/v1/health`)
  })

  // Graceful shutdown
  const gracefulShutdown = async (signal: string) => {
    console.log(`\n[PGX Backend] Received ${signal}. Shutting down gracefully...`)
    server.close(async () => {
      console.log('[PGX Backend] HTTP server closed.')
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
