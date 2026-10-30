import { createServer } from 'node:http';

export function createHTTPServer(app) {
  return createServer({
    maxHeaderSize:16*1024,
    headersTimeout:15000,
    requestTimeout:30000,
    connectionsCheckingInterval:1000,
    // Keep Node's short idle keep-alive policy explicit. Upload deadlines do not
    // impose a response deadline on a fully received request doing upstream work.
    keepAliveTimeout:5000,
  },app);
}
