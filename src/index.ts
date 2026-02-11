import express from "express";
import { convertStateIdsToAmoc } from "./main/convertStateIdsToAmoc";
import { FloodWarningParser } from "./parser/FloodWarningParser";
import { WarningCollector, WarningTextCollector } from "./floods/WarningCollector";
import { getAllWarns } from "./floods/amocWarnings";
import { logger, createLogger } from "./main/log";
import { closeFtpPool, getPoolStats } from "./services/ftpPool";
import {
  getCachedWarning,
  setCachedWarning,
  getCacheStats,
  closeCache,
  CachedWarning,
  getRedisClient,
} from "./services/cache";

const log = createLogger("server");

// Initialize Redis connection early
getRedisClient();

const app = express();
const port = process.env.PORT || 3000;

const ERRORMESSAGE = "Something went wrong";

app.get("/", async (req, res) => {
  try {
    const data = await getAllWarns();

    const state = convertStateIdsToAmoc(req.query.state?.toString() || "");

    let results = [];
    for (let key of data) {
      if (key.startsWith(state)) {
        results.push(key.replace(/\.amoc\.xml/, ""));
      }
    }

    res.send(results);
  } catch (error) {
    res.send(ERRORMESSAGE);
  }
});

app.get("/warning/:id", async (req, res) => {
  const xmlid = req.params.id;
  try {
    // Check cache first
    const cached = await getCachedWarning(xmlid);
    if (cached) {
      log.info({ xmlid, cached: true }, "Serving cached warning");
      res.send(cached);
      return;
    }

    // Cache miss - fetch from FTP
    const downloader = new WarningCollector();
    const warning = await downloader.downloadWarning(xmlid);
    if (!warning) {
      res.status(404).send({ error: "Warning not found" });
      return;
    }

    const warningParser = new FloodWarningParser(warning);
    const textDownloader = new WarningTextCollector();
    const text = await textDownloader.downloadWarning(xmlid);

    const warningData = await warningParser.getWarning();
    const response: CachedWarning = {
      ...warningData,
      text: text || "",
      cachedAt: new Date().toISOString(),
    };

    // Cache the response using expiry time as TTL
    await setCachedWarning(xmlid, response);

    log.info({ xmlid, cached: false }, "Serving fresh warning");
    res.send(response);
  } catch (error) {
    res.send(ERRORMESSAGE);
    log.error({ error, xmlid }, "Failed to fetch warning");
  }
});

// Health check endpoint
app.get("/health", async (req, res) => {
  const poolStats = getPoolStats();
  const cacheStats = await getCacheStats();
  res.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    ftpPool: poolStats,
    cache: cacheStats,
  });
});

const server = app.listen(port, () => {
  log.info({ port }, "Server started");
});

// Graceful shutdown
async function shutdown(signal: string) {
  log.info({ signal }, "Received shutdown signal");
  
  server.close(async () => {
    log.info("HTTP server closed");
    
    await Promise.all([
      closeFtpPool(),
      closeCache(),
    ]);
    
    log.info("Graceful shutdown complete");
    process.exit(0);
  });

  // Force exit after timeout
  setTimeout(() => {
    log.error("Forced shutdown after timeout");
    process.exit(1);
  }, 10000);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
