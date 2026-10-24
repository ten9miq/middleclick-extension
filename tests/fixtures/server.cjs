// Disposable loopback fixture. Stop with Ctrl+C when browser verification ends.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const html = fs.readFileSync(path.join(__dirname, 'navigation.html'));
const server = http.createServer((request, response) => {
  response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(html);
});
server.listen(0, '127.0.0.1', () => console.log(`Fixture: http://127.0.0.1:${server.address().port}/`));
