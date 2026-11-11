/**
 * Helper that safely wraps `@hono/node-server`'s `serve()` while keeping
 * Gateway (WebSocket) support intact.
 */

import { serve } from '@hono/node-server'
import type { IncomingMessage } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Duplex } from 'node:stream'
import type { Hono } from 'hono'
import type { WebSocketServer } from 'ws'

/** Options passed to {@link serveWithGateway} */
export interface ServeWithGatewayOptions {
  /** The Hono app's fetch handler */
  fetch: Hono['fetch']
  /** The port to listen on */
  port: number
  /** The hostname to bind to */
  hostname: string
  /** The `ws` server instance for the Gateway (WebSocket) */
  wss: WebSocketServer
}

/** Header names related to `Connection`/`Upgrade` negotiation (case-insensitive) */
const UPGRADE_RELATED_HEADER_NAMES = new Set([
  'upgrade',
  'connection',
  'http2-settings',
])

/**
 * Decide whether Node's HTTP server should treat a request as an upgrade.
 *
 * Only `Upgrade: websocket` is accepted (matching `@hono/node-server`'s own
 * `upgrade` listener); every other value (such as the `Upgrade: h2c` that
 * Java's `HttpClient` sends by default) is declined.
 * @param req - the incoming request carrying an `Upgrade` header
 * @returns true when the request is a WebSocket upgrade
 */
function isWebSocketUpgrade(req: IncomingMessage): boolean {
  return req.headers.upgrade?.toLowerCase() === 'websocket'
}

/**
 * When the `websocket` option is passed to `serve()`, `@hono/node-server`
 * registers its own `upgrade` listener on the `http.Server`, but that listener
 * silently ignores (returns without doing anything for) any request other than
 * `Upgrade: websocket`. Once even a single `upgrade` listener is registered on
 * Node's `http.Server`, it stops firing the `request` event for any request
 * carrying an `Upgrade` header (unless `shouldUpgradeCallback` says otherwise).
 * As a result, requests such as the `Upgrade: h2c` (an opportunistic probe for
 * a cleartext HTTP/2 upgrade) that Java's `HttpClient` sends by default hang
 * forever, never getting a response or being closed.
 *
 * Two layers handle this:
 *
 * 1. Primary: Node's `shouldUpgradeCallback` server option (Node 22.21+ /
 *    24.9+) makes only `Upgrade: websocket` requests emit an `upgrade` event.
 *    Every other request is served through the regular `request` flow, with
 *    its body parsed by Node's HTTP parser as usual. This is the only approach
 *    that works on Node 26: v26.0.0 changed the `upgrade` event so that
 *    "Request bodies are no longer exposed raw (unparsed) on the socket
 *    argument" (the `head` buffer is empty and the body is delivered through
 *    `req` instead), which breaks the replay fallback below.
 * 2. Fallback: on older Node versions that ignore `shouldUpgradeCallback` (the
 *    README supports Node 22 or later), a second `upgrade` listener is added
 *    after `@hono/node-server`'s own. Naively handing the existing `req`
 *    straight to the normal request handler does not work: by the time the
 *    `upgrade` event fires, Node's HTTP parser has already been detached from
 *    `req`, so no more request body flows into `req` (e.g. a POST with a JSON
 *    body would be treated as having an empty body). Instead we strip the
 *    upgrade-related headers, reconstruct the request as raw HTTP bytes, and
 *    re-emit the `connection` event on the same socket so that Node's own HTTP
 *    parser parses it again from scratch (only the real parser can correctly
 *    handle body encodings such as Content-Length / chunked transfer). On
 *    Node versions that honor `shouldUpgradeCallback` this listener never
 *    fires for a non-websocket request.
 * @param options - the options to pass to serve
 * @param listeningListener - callback invoked when listening starts
 * @returns the started http.Server
 */
export function serveWithGateway(
  options: ServeWithGatewayOptions,
  listeningListener?: (info: AddressInfo) => void
): ReturnType<typeof serve> {
  const server = serve(
    {
      fetch: options.fetch,
      port: options.port,
      hostname: options.hostname,
      websocket: { server: options.wss },
      serverOptions: { shouldUpgradeCallback: isWebSocketUpgrade },
    },
    listeningListener
  )

  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    if (isWebSocketUpgrade(req)) {
      return // @hono/node-server's own listener handles this
    }

    // Only reached on Node versions without `shouldUpgradeCallback` support,
    // where `head` still holds the raw (unparsed) bytes following the headers.
    const statusLine = `${req.method ?? 'GET'} ${req.url ?? '/'} HTTP/${req.httpVersion}\r\n`
    const headerLines: string[] = []
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      const name = req.rawHeaders[i]
      if (UPGRADE_RELATED_HEADER_NAMES.has(name.toLowerCase())) {
        continue // Strip these so re-parsing is not treated as an upgrade again, avoiding an infinite loop
      }
      headerLines.push(`${name}: ${req.rawHeaders[i + 1]}`)
    }
    const replayedHeader = Buffer.from(
      statusLine + headerLines.join('\r\n') + '\r\n\r\n',
      'latin1'
    )
    // Unshift what the parser had already consumed (the reconstructed headers
    // plus the leading part of the body) back to the front of the socket, so it
    // is parsed from scratch as a new connection
    socket.unshift(Buffer.concat([replayedHeader, head]))
    server.emit('connection', socket)
  })

  return server
}
