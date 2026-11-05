# Pgxgateway

Production-ready, scalable Express.js backend API written in **TypeScript** with **MongoDB (Mongoose)** ODM, structured for clean scalability and high performance.

---

## Architecture Overview

```text
pgxgateway_be/
├── src/
│   ├── config/
│   │   ├── db.ts           # Mongoose connection with error handling & graceful shutdown
│   │   └── env.ts          # Validated environment configuration
│   ├── controllers/
│   │   ├── health.controller.ts   # System uptime & MongoDB cluster check
│   │   └── merchant.controller.ts # Registration (Steps 1-3), status, and offers
│   ├── models/
│   │   └── Merchant.ts     # Schema supporting full registration flow & offers
│   ├── routes/
│   │   ├── health.routes.ts       # /api/v1/health
│   │   ├── merchant.routes.ts     # /api/v1/merchants
│   │   └── index.ts               # Root /api/v1 router
│   ├── middleware/
│   │   ├── errorHandler.ts        # Global centralized error handler
│   │   └── notFound.ts            # 404 handler for invalid routes
│   ├── app.ts              # Express application setup (Helmet, CORS, Morgan, JSON)
│   └── server.ts           # Server bootstrap & process lifecycle management
├── .env                    # Environment variables (MongoDB URI, Port)
├── .env.example            # Environment template
├── .gitignore
├── package.json
└── tsconfig.json
```

---

## Database Configuration

* **Engine:** MongoDB Atlas Cluster (`cluster0.flqb6iy.mongodb.net`)
* **Database Name:** `pgxdb`
* **User:** `huippertechnology_db_user`
* **Connection Status:** Verified & Active

---

## Available Endpoints

### 1. System Health
* `GET /api/v1/health`
  - Returns service status, uptime, and live MongoDB connection state.

### 2. Merchant Registration & Dashboard
* `POST /api/v1/merchants/register`
  - Submits or updates merchant application data across Steps 1, 2, and 3.
* `GET /api/v1/merchants/latest`
  - Fetches latest merchant application and processing offer details.
* `GET /api/v1/merchants/:email`
  - Retrieves merchant details and review status by business email.

---

### 3. Real-Time WebSockets (Socket.IO)
* **Connection URL:** `ws://localhost:5000`
* **Authentication:** Pass JWT via `auth: { token: '<jwt_token>' }`
* **Private Room:** Each merchant joins `merchant:<merchantId>` automatically.
* **Events:**
  - `application:updated`: Real-time application status changes (e.g. from `under_review` to `approved`).
  - `offer:updated`: Live processing offer term updates.
  - `notification:new`: Real-time alerts and messages (updates unread count).
  - `transaction:status`: Live payment checkout state changes.

---

## Getting Started

```bash
# Install dependencies (already installed)
npm install

# Start development server with Nodemon (live reload)
npm run dev

# Build for production
npm run build

# Start production server
npm start
```
