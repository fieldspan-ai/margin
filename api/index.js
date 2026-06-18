// Vercel serverless entry point.
//
// vercel.json rewrites every request to this function; the original URL is
// preserved in req.url, so the shared handler routes it exactly as the local
// server does. Vercel's Node request/response objects implement the same
// IncomingMessage/ServerResponse contract handle() expects.
import { handle } from '../server/app.js';

export default function handler(req, res) {
  return handle(req, res);
}
