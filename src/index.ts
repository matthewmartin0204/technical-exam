import express from "express";
import { convertStateIdsToAmoc } from "./main/convertStateIdsToAmoc";
import { FloodWarningParser } from "./parser/FloodWarningParser";
import { WarningColletor, WarningTextCollector } from "./floods/WarningCollector";
import { getAllWarns } from "./floods/amocWarnings";
import { logger, createLogger } from "./main/log";

const log = createLogger("server");

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
    const downloader = new WarningColletor();

    const warning = await downloader.downloadWarning(xmlid);
    const warningParser = new FloodWarningParser(warning);

    const textDownloader = new WarningTextCollector()
    const text = await textDownloader.downloadWarning(xmlid);

    res.send({ ...(await warningParser.getWarning()), text: text || "" });
  } catch (error) {
    res.send(ERRORMESSAGE);
    log.error({ error, xmlid }, "Failed to fetch warning");
  }
});

app.listen(port, () => {
  log.info({ port }, "Server started");
});
