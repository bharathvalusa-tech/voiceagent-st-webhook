const app = require('./app');
const config = require('./config/environment');

const server = app.listen(config.port, () => {
    console.log(`Server is running on port ${config.port}`);
    console.log(`Environment: ${config.nodeEnv}`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('SIGTERM received. Shutting down gracefully...');
    server.close(() => {
        console.log('Process terminated');
    });
});

process.on('SIGINT', () => {
    console.log('SIGINT received. Shutting down gracefully...');
    server.close(() => {
        console.log('Process terminated');
    });
});

module.exports = server;
