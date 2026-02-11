import { WarningTextCollector } from "../floods/WarningCollector";
import { parseXmlString } from "./parseXmlString";

export class FloodWarningParser {
  private parsedObj: any = null;

  constructor(private xmlString: string) {}

  /**
   * Parse XML once and cache the result
   */
  private async getParsedObject(): Promise<any> {
    if (!this.parsedObj) {
      this.parsedObj = await new Promise((resolve) => {
        parseXmlString(this.xmlString, (data) => {
          resolve(data);
        });
      });
    }
    return this.parsedObj;
  }

  async getWarning() {
    const obj = await this.getParsedObject();

    const productType = parseProductType(obj);
    const service = getService(obj);

    return {
      productType,
      service,
      start: this.getIssueTime(obj),
      expiry: this.getEndTime(obj),
    };
  }

  private getIssueTime(obj: any): string | undefined {
    return (obj.amoc["issue-time-utc"] || [])[0];
  }

  private getEndTime(obj: any): string | undefined {
    return (obj.amoc["expiry-time"] || [])[0];
  }

  async downloadwarningText(): Promise<string> {
    const obj = await this.getParsedObject();
    const downloader = new WarningTextCollector();
    const warningText = await downloader.downloadWarning(obj.amoc.identifier[0]);
    return warningText;
  }
}

function getService(obj: any): string {
  let service = (obj.amoc["service"] || [])[0];

  switch (service) {
    case "COM":
      return "Commercial Services";
    case "HFW":
      return "Flood Warning Service";
    case "TWS":
      return "Tsunami Warning Services";
    case "WAP":
      return "Analysis and Prediction";
    case "WSA":
      return "Aviation Weather Services";
    case "WSD":
      return "Defence Weather Services";
    case "WSF":
      return "Fire Weather Services";
    case "WSM":
      return "Marine Weather Services";
    case "WSP":
      return "Public Weather Services";
    case "WSS":
      return "Cost Recovery Services";
    case "WSW":
      return "Disaster Mitigation";
    default:
      return service;
  }
}

function parseProductType(obj: any): string | undefined {
  const productType = obj?.amoc?.["product-type"]?.[0];

  switch (productType) {
    case "A":
      return "Advice";
    case "B":
      return "Bundle";
    case "C":
      return "Climate";
    case "D":
      return "Metadata";
    case "E":
      return "Analysis";
    case "F":
      return "Forecast";
    case "M":
      return "Numerical Weather Prediction";
    case "O":
      return "Observation";
    case "Q":
      return "Reference";
    case "R":
      return "Radar";
    case "S":
      return "Special";
    case "T":
      return "Satellite";
    case "W":
      return "Warning";
    case "X":
      return "Mixed";
    default:
      return productType;
  }
}

