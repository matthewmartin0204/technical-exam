import { Writable } from "stream";
import { createLogger } from "../main/log";
import { withFtpClient } from "../services/ftpPool";

const log = createLogger("WarningCollector");

/**
 * Collects data by streaming to a buffer in memory
 */
class MemoryWritable extends Writable {
  private chunks: Buffer[] = [];

  _write(chunk: Buffer, _encoding: string, callback: (error?: Error | null) => void): void {
    this.chunks.push(chunk);
    callback();
  }

  getBuffer(): Buffer {
    return Buffer.concat(this.chunks);
  }

  getString(encoding: BufferEncoding = "utf-8"): string {
    return this.getBuffer().toString(encoding);
  }
}

export class WarningCollector {
  async downloadWarning(amocRegion: string): Promise<string | null> {
    return withFtpClient(async ({ client }) => {
      const files = await client.list();
      const targetFile = `${amocRegion}.amoc.xml`;

      const fileData = files.find(
        (f) => f.name === targetFile && !f.isSymbolicLink && !f.isDirectory
      );

      if (!fileData) {
        log.warn({ amocRegion }, "Warning file not found");
        return null;
      }

      // Stream directly to memory instead of disk
      const memoryStream = new MemoryWritable();
      await client.downloadTo(memoryStream, targetFile);

      return memoryStream.getString();
    });
  }
}

export class WarningTextCollector {
  async downloadWarning(key: string): Promise<string> {
    try {
      return await withFtpClient(async ({ client }) => {
        const memoryStream = new MemoryWritable();
        await client.downloadTo(memoryStream, `${key}.txt`);
        return memoryStream.getString();
      });
    } catch (err) {
      log.warn({ key, err }, "Warning text file not found");
      return "";
    }
  }
}
