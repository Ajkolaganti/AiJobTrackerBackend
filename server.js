const express = require('express');
const cors = require('cors');
const { WebSocketServer } = require('ws');
const routes = require('./routes/auth');
const { setupWebSocketHandlers } = require('./webSockets/handlers');
require('dotenv').config();

const app = express();

// Middleware
app.use(cors({
  origin: 'http://54.197.40.157:5173',
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json());

// API Routes
app.use('/api', routes);

// Create HTTP server
const server = require('http').createServer(app);

// Setup WebSocket
const wss = new WebSocketServer({ server });
setupWebSocketHandlers(wss);

// Start server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});