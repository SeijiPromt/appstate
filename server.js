const express = require("express");
const http = require("http");
const { WebSocketServer } = require("ws");
const { chromium } = require("playwright");
const path = require("path");
const fs = require("fs");

const PORT = process.env.PORT || 8000;
const ACCESS_TOKEN = (process.env.ACCESS_TOKEN || "").trim();
const DATA_DIR = process.env.DATA_DIR || "/data";
const PROFILE = path.join(DATA_DIR, "profile");

fs.mkdirSync(PROFILE, { recursive: true });

const app = express();
app.use(express.static(path.join(__dirname, "public")));

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

let context = null;
let page = null;
let cdp = null;
let browserReady = false;
let lastFrameTime = 0;

server.on("upgrade", (request, socket, head) => {
  const url = new URL(request.url, `http://${request.headers.host}`);
  if (url.pathname === "/ws") {
    const token = url.searchParams.get("token") || "";
    if (ACCESS_TOKEN && token !== ACCESS_TOKEN) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit("connection", ws, request);
    });
  } else {
    socket.destroy();
  }
});

function broadcast(msg) {
  wss.clients.forEach((client) => {
    if (client.readyState === 1) {
      client.send(JSON.stringify(msg));
    }
  });
}

wss.on("connection", async (ws) => {
  ws.send(JSON.stringify({ type: "log", text: "WebSocket connected to server." }));

  if (browserReady) {
    ws.send(JSON.stringify({ type: "log", text: "Browser already running." }));
  } else {
    ws.send(JSON.stringify({ type: "log", text: "Starting Chromium... (wait 10s)" }));
    await startBrowser();
  }

  ws.on("message", async (msg) => {
    if (!page) return;
    try {
      const data = JSON.parse(msg);
      if (data.type === "click") {
        await page.mouse.click(data.x, data.y);
      } else if (data.type === "type") {
        await page.keyboard.type(data.text, { delay: 50 });
      } else if (data.type === "press") {
        await page.keyboard.press(data.key);
      } else if (data.type === "login") {
        await page.goto("https://www.facebook.com/login");
        await page.waitForSelector('input[name="email"]', { timeout: 15000 });
        await page.fill('input[name="email"]', data.email);
        await page.fill('input[name="pass"]', data.password);
        page.click('button[name="login"]').catch(() => {});
      } else if (data.type === "generate") {
        const cookies = await context.cookies();
        const appstate = cookies
          .filter(c => c.domain.includes("facebook.com"))
          .map(c => ({
            key: c.name, value: c.value, domain: c.domain, path: c.path,
            hostOnly: !c.domain.startsWith("."),
            creation: new Date().toISOString(),
            lastAccessed: new Date().toISOString(),
          }));
        const cuser = appstate.find(c => c.key === "c_user");
        
        if (cuser) {
          const json = JSON.stringify(appstate, null, 2);
          const cookieString = appstate.map(c => `${c.key}=${c.value}`).join('; ');
          ws.send(JSON.stringify({ type: "appstate", json, cookieString }));
        } else {
          ws.send(JSON.stringify({ type: "error", message: "Not logged in (no c_user)" }));
        }
      }
    } catch (e) {
      console.error("WS error", e);
      ws.send(JSON.stringify({ type: "error", message: "Action failed: " + e.message }));
    }
  });
});

async function startBrowser() {
  if (page) return;
  try {
    broadcast({ type: "log", text: "Launching Playwright..." });
    context = await chromium.launchPersistentContext(PROFILE, {
      headless: true,
      viewport: { width: 1280, height: 900 },
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
      args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-blink-features=AutomationControlled"]
    });
    page = context.pages()[0] || (await context.newPage());
    
    broadcast({ type: "log", text: "Navigating to Facebook..." });
    await page.goto("https://www.facebook.com/login", { waitUntil: "domcontentloaded" });

    cdp = await context.newCDPSession(page);
    await cdp.send("Page.startScreencast", {
      format: "jpeg",
      quality: 60,
      maxWidth: 1280,
      maxHeight: 900,
    });

    cdp.on("Page.screencastFrame", async ({ data, metadata, sessionId }) => {
      const now = Date.now();
      if (now - lastFrameTime > 50) { // ~20 FPS max
        broadcast({ type: "frame", data });
        lastFrameTime = now;
      }
      await cdp.send("Page.screencastFrameAck", { sessionId }).catch(() => {});
    });

    browserReady = true;
    broadcast({ type: "log", text: "Browser ready." });
  } catch (e) {
    console.error("Launch error", e);
    broadcast({ type: "error", message: "Chromium failed to start: " + e.message });
  }
}

server.listen(PORT, () => console.log(`Listening on ${PORT}`));
