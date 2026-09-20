import { audit, errors } from '../../lib.js'
import { readClientUpdateManifest, updateClientUpdateManifest } from '../../services/clientUpdateManifest.js'

/** Platform-admin endpoint for the mutable policy on the static desktop update manifest. */
export async function handleClientUpdate(ctx, part, method) {
  if (part !== '/client-update') return null
  if (method === 'GET') return readClientUpdateManifest()
  if (method === 'PUT') {
    try {
      const before = readClientUpdateManifest()
      const after = updateClientUpdateManifest(ctx.body)
      audit(ctx, 'CLIENT_UPDATE_CONFIG', 'PLATFORM_SETTING', 'client-update', before, after)
      return after
    } catch (error) {
      throw errors.badRequest(error instanceof Error ? error.message : String(error), 'CLIENT_UPDATE_CONFIG_INVALID')
    }
  }
  return null
}