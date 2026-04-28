import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

export const config = {
  api: { bodyParser: false },
  supportsResponseStreaming: true,
  maxDuration: 60,
};

const UPSTREAM_HOST = (process.env.UPSTREAM_HOST || "").replace(/\/$/, "");

const FILTERED_HEADERS = new Set([
  "host",
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "forwarded",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-forwarded-port",
]);

export default async function handler(req, res) {
  if (!UPSTREAM_HOST) {
    res.statusCode = 500;
    return res.end("Server misconfiguration");
  }

  try {
    const destinationUrl = UPSTREAM_HOST + req.url;

    const cleanHeaders = {};
    let clientAddress = null;
    
    for (const headerKey of Object.keys(req.headers)) {
      const normalized = headerKey.toLowerCase();
      const value = req.headers[headerKey];
      
      if (FILTERED_HEADERS.has(normalized)) continue;
      if (normalized.startsWith("x-vercel-")) continue;
      if (normalized === "x-real-ip") { clientAddress = value; continue; }
      if (normalized === "x-forwarded-for") { 
        if (!clientAddress) clientAddress = value; 
        continue; 
      }
      
      cleanHeaders[normalized] = Array.isArray(value) 
        ? value.join(", ") 
        : value;
    }
    
    if (clientAddress) cleanHeaders["x-forwarded-for"] = clientAddress;

    const httpMethod = req.method;
    const hasPayload = httpMethod !== "GET" && httpMethod !== "HEAD";

    const fetchConfig = { 
      method: httpMethod, 
      headers: cleanHeaders, 
      redirect: "manual" 
    };
    
    if (hasPayload) {
      fetchConfig.body = Readable.toWeb(req);
      fetchConfig.duplex = "half";
    }

    const upstreamRes = await fetch(destinationUrl, fetchConfig);

    res.statusCode = upstreamRes.status;
    
    for (const [name, val] of upstreamRes.headers) {
      if (name.toLowerCase() === "transfer-encoding") continue;
      try { 
        res.setHeader(name, val); 
      } catch {}
    }

    if (upstreamRes.body) {
      await pipeline(Readable.fromWeb(upstreamRes.body), res);
    } else {
      res.end();
    }
  } catch (err) {
    console.error("request handling error:", err);
    if (!res.headersSent) {
      res.statusCode = 502;
      res.end("Service unavailable");
    }
  }
}
