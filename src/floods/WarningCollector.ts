import { Client } from "basic-ftp";
import fs from "fs";
import { readWarningData } from "../parser/ReadWarningData";
import { createLogger } from "../main/log";

const log = createLogger("WarningCollector");

export class WarningColletor {
  async downloadWarning(amocRegion:string) {
    const client = new Client();
    client.ftp.verbose = true;
    
    await client.access({
      host: "ftp.bom.gov.au",
      secure: false,
    });

    await client.cd("/anon/gen/fwo/");

    const files = await client.list();

    for (let file=0; file<files.length; file++) {
      if (files[file].name.endsWith(".amoc.xml") && `${amocRegion}.amoc.xml` == files[file].name) {
        let fileData = files[file];
        if(fileData.isSymbolicLink === false && fileData.isDirectory == false) {
          await client.download(`./${amocRegion}.xml`, files[file].name);
        }
      }
    }

    client.close();
    const data = readWarningData(amocRegion);
    
    return data;
  }
}

export class WarningTextCollector extends WarningColletor {
  async downloadWarning(key: string) {
    const client = new Client();
    client.ftp.verbose = true;
    let warningText = "";
    try {
      await client.access({
        host: "ftp.bom.gov.au",
        secure: false,
      });

      await client.cd("/anon/gen/fwo/");

      await client.download(`./${key}.txt`, key + ".txt");

      warningText = fs.readFileSync(`./${key}.txt`, {
        encoding: "utf-8",
      });
    } catch (err) {
      log.warn({ key }, "Warning text file not found");
      return "";
    }

    client.close();

    return warningText;
  }
}