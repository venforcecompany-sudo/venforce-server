const http = require("http"), fs = require("fs"), path = require("path");
const DIR = path.resolve(__dirname, "../../Portal");
module.exports = () => new Promise((res) => {
  const s = http.createServer((req, rsp) => {
    const u = new URL(req.url, "http://x");
    let t = path.resolve(DIR, decodeURIComponent(u.pathname).replace(/^\/+/, ""));
    fs.readFile(t, (e, c) => {
      if (e) { rsp.writeHead(404).end(); return; }
      const ty = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png" };
      rsp.writeHead(200, { "Content-Type": ty[path.extname(t)] || "application/octet-stream" }); rsp.end(c);
    });
  });
  s.keepAliveTimeout = 120000;
  s.listen(0, "127.0.0.1", () => res(s));
});
