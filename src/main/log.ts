import pino from "pino";

const isProduction = process.env.NODE_ENV === "production";

// Create logger with appropriate configuration
export const logger = pino({
  level: process.env.LOG_LEVEL || (isProduction ? "info" : "debug"),
  
  // Pretty print in development, JSON in production
  transport: isProduction
    ? undefined
    : {
        target: "pino/file",
        options: { destination: 1 }, // stdout
      },

  // Add service metadata
  base: {
    service: "bom-warnings-api",
    env: process.env.NODE_ENV || "development",
  },

  // ISO timestamps for production, human-readable for dev
  timestamp: pino.stdTimeFunctions.isoTime,

  // Redact sensitive fields if needed
  redact: ["req.headers.authorization", "password"],
});

// Create child loggers for different modules
export const createLogger = (module: string) => logger.child({ module });

// Export default logger
export default logger;
