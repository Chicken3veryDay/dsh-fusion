/** Sentinel credential provider: no environment or host store access is available. */
import CredentialProvider from '../../../packages/credentials/credentials/lib/index.js'
export default class SnapshotCredentials extends CredentialProvider {
  async resolve() { throw new Error('Preflight with no providers must not resolve fusion-sentinel-key') }
  async describe() { return { configured: false, writable: false } }
  async set() { throw new Error('read-only snapshot') }
  async unset() { throw new Error('read-only snapshot') }
  async list() { return [] }
  async listRecords() { return [] }
  async readRecord() { return undefined }
  async describeRecord() { return { configured: false, writable: false } }
  async modifyRecord() { throw new Error('read-only snapshot') }
  async deleteRecord() { throw new Error('read-only snapshot') }
}
