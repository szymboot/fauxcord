import { afterEach, describe, expect, it } from 'vitest'
import { loadConfig } from './config'

describe('loadConfig GATEWAY_HEARTBEAT_INTERVAL_MS', () => {
  const original = process.env.GATEWAY_HEARTBEAT_INTERVAL_MS

  afterEach(() => {
    if (original === undefined) delete process.env.GATEWAY_HEARTBEAT_INTERVAL_MS
    else process.env.GATEWAY_HEARTBEAT_INTERVAL_MS = original
  })

  it("defaults to Discord's 41250 ms", () => {
    delete process.env.GATEWAY_HEARTBEAT_INTERVAL_MS
    expect(loadConfig().gatewayHeartbeatIntervalMs).toBe(41_250)
  })

  it('accepts an integer between 100 and 600000', () => {
    for (const value of ['100', '1000', '600000']) {
      process.env.GATEWAY_HEARTBEAT_INTERVAL_MS = value
      expect(loadConfig().gatewayHeartbeatIntervalMs).toBe(Number(value))
    }
  })

  it('falls back to the default for invalid or out-of-range values', () => {
    for (const value of ['', 'abc', '1.5', '-1', '99', '600001', '1e3']) {
      process.env.GATEWAY_HEARTBEAT_INTERVAL_MS = value
      expect(loadConfig().gatewayHeartbeatIntervalMs).toBe(41_250)
    }
  })
})
