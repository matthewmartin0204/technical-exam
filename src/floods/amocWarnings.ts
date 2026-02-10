import { createLogger } from "../main/log";
import { withFtpClient } from "../services/ftpPool";

const log = createLogger("amocWarnings");

export async function getAllWarns() {
  try {
    const warns = await withFtpClient(async ({ client }) => {
      const files = await client.list();
      return getNames(files);
    });

    return warns;
  } catch (err) {
    log.error({ err }, "Failed to fetch warnings from FTP");
    throw err;
  }
}

export const getNames = async (warnings: any) => {
  let warns: any = [];
  
  for (var file in warnings) {
    if (warnings[file].name.endsWith(".amoc.xml")) {
      warns.push(warnings[file].name)
    }
  }

  return warns
}