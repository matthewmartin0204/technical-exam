import { Client } from "basic-ftp";
import { createPool, Pool } from "generic-pool";
import { createLogger } from "../main/log";

const log = createLogger("ftpPool");

const FTP_HOST = process.env.FTP_HOST || "ftp.bom.gov.au";
const FTP_PATH = process.env.FTP_PATH || "/anon/gen/fwo/";

// Pool configuration
const POOL_MIN = parseInt(process.env.FTP_POOL_MIN || "2", 10);
const POOL_MAX = parseInt(process.env.FTP_POOL_MAX || "10", 10);
const ACQUIRE_TIMEOUT_MS = parseInt(process.env.FTP_ACQUIRE_TIMEOUT || "30000", 10);
const IDLE_TIMEOUT_MS = parseInt(process.env.FTP_IDLE_TIMEOUT || "30000", 10);

export interface FtpPoolClient {
  client: Client;
  /** Re-navigate to the warnings directory (in case it was changed) */
  ensureWorkingDirectory: () => Promise<void>;
}

const factory = {
  async create(): Promise<FtpPoolClient> {
    const client = new Client();
    client.ftp.verbose = process.env.FTP_VERBOSE === "true";

    log.debug("Creating new FTP connection");

    await client.access({
      host: FTP_HOST,
      secure: false,
    });

    await client.cd(FTP_PATH);

    log.info({ host: FTP_HOST, path: FTP_PATH }, "FTP connection established");

    return {
      client,
      ensureWorkingDirectory: async () => {
        await client.cd(FTP_PATH);
      },
    };
  },

  async destroy(poolClient: FtpPoolClient): Promise<void> {
    log.debug("Destroying FTP connection");
    poolClient.client.close();
  },

  async validate(poolClient: FtpPoolClient): Promise<boolean> {
    try {
      // Simple validation - try to get current working directory
      await poolClient.client.pwd();
      return true;
    } catch {
      log.warn("FTP connection validation failed");
      return false;
    }
  },
};

const poolOptions = {
  min: POOL_MIN,
  max: POOL_MAX,
  acquireTimeoutMillis: ACQUIRE_TIMEOUT_MS,
  idleTimeoutMillis: IDLE_TIMEOUT_MS,
  testOnBorrow: true, // Validate connections before lending
  autostart: true,
};

// Singleton pool instance
let pool: Pool<FtpPoolClient> | null = null;

export function getFtpPool(): Pool<FtpPoolClient> {
  if (!pool) {
    pool = createPool(factory, poolOptions);

    pool.on("factoryCreateError", (err) => {
      log.error({ err }, "FTP pool factory create error");
    });

    pool.on("factoryDestroyError", (err) => {
      log.error({ err }, "FTP pool factory destroy error");
    });

    log.info(
      { min: POOL_MIN, max: POOL_MAX },
      "FTP connection pool initialized"
    );
  }
  return pool;
}

/**
 * Execute a function with a pooled FTP client.
 * The connection is automatically returned to the pool after use.
 */
export async function withFtpClient<T>(
  fn: (poolClient: FtpPoolClient) => Promise<T>
): Promise<T> {
  const ftpPool = getFtpPool();
  const poolClient = await ftpPool.acquire();

  try {
    // Ensure we're in the correct directory
    await poolClient.ensureWorkingDirectory();
    return await fn(poolClient);
  } finally {
    await ftpPool.release(poolClient);
  }
}

/**
 * Gracefully shutdown the pool - call this on application shutdown
 */
export async function closeFtpPool(): Promise<void> {
  if (pool) {
    log.info("Shutting down FTP connection pool");
    await pool.drain();
    await pool.clear();
    pool = null;
    log.info("FTP connection pool closed");
  }
}

/**
 * Get pool statistics for monitoring
 */
export function getPoolStats() {
  if (!pool) {
    return null;
  }
  return {
    size: pool.size,
    available: pool.available,
    borrowed: pool.borrowed,
    pending: pool.pending,
    min: pool.min,
    max: pool.max,
  };
}
