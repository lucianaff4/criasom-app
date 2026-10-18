const resourceId = /^[a-zA-Z0-9_-]{1,80}$/;
const stateAreas = ['study', 'repertoire', 'preferences'];
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const isStateData = value => value !== null && typeof value === 'object';
const validEmail = value => typeof value === 'string' && value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
const jsonBytes = value => new TextEncoder().encode(JSON.stringify(value)).length;

export class PlatformClient {
  // Browser fetch needs its Window receiver; assigning the native function to this.fetch loses it.
  constructor({ fetchImpl = (input, options) => globalThis.fetch(input, options), onClear = () => {} } = {}) {
    this.fetch = fetchImpl;
    this.onClear = onClear;
    this.user = null;
    this.csrf = null;
    this.capabilities = [];
    this.epoch = 0;
    this.controller = new AbortController();
  }
  clear() {
    this.epoch++;
    this.controller.abort();
    this.controller = new AbortController();
    this.user = null;
    this.csrf = null;
    this.capabilities = [];
    this.onClear(); // Shell must revoke media URLs and discard all personal view state.
  }
  async request(path, { method = 'GET', body, binary = false, expectedStatus = 200 } = {}) {
    if (!/^\/[a-zA-Z0-9/_-]+$/.test(path) || path.includes('//') || path.startsWith('/webhooks/')) throw new Error('Invalid API path');
    if (!['GET', 'POST'].includes(method)) throw new Error('Invalid API method');
    if (body !== undefined && jsonBytes(body) > 131072) throw new Error('Request body too large');
    const epoch = this.epoch;
    const headers = { Accept: binary ? '*/*' : 'application/json' };
    if (method !== 'GET') {
      if (!this.csrf) throw new Error('Session context required');
      headers['X-CSRF-Token'] = this.csrf;
      headers['Content-Type'] = 'application/json';
    }
    const response = await this.fetch('/api/v1' + path, {
      method, headers, credentials: 'same-origin', cache: 'no-store', redirect: 'error',
      signal: this.controller.signal, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (epoch !== this.epoch) throw new Error('Session changed');
    if (response.status === 401) { this.clear(); throw new Error('Sign-in required'); }
    if (response.status === 403) throw new Error('Access denied');
    if (response.status === 409) throw new Error('State changed; reload before saving');
    if (!response.ok) throw new Error('Operation unavailable');
    if (response.status !== expectedStatus) throw new Error('Invalid server response');
    if (!binary && !response.headers.get('content-type')?.includes('application/json')) throw new Error('Invalid server response');
    const value = binary ? await response.blob() : await response.json();
    if (epoch !== this.epoch) throw new Error('Session changed');
    return value;
  }
  async refreshSession() {
    let data;
    try { data = await this.request('/session'); }
    catch (error) {
      if (error instanceof SyntaxError || error.message === 'Invalid server response') this.clear();
      throw error;
    }
    if (!isRecord(data) || !/^[a-fA-F0-9]{64}$/.test(data.csrf ?? '') || typeof data.authenticated !== 'boolean'
      || !Array.isArray(data.capabilities) || data.capabilities.some(scope => typeof scope !== 'string' || !/^[a-zA-Z0-9:_-]{1,160}$/.test(scope))
      || (data.authenticated && (!isRecord(data.user) || typeof data.user.id !== 'string' || !resourceId.test(data.user.id) || !validEmail(data.user.email)))
      || (!data.authenticated && (data.user != null || data.capabilities.length !== 0))) {
      this.clear(); throw new Error('Invalid session response');
    }
    const nextCapabilities = [...new Set(data.capabilities)].sort();
    if ((this.user?.id ?? null) !== (data.user?.id ?? null)
      || JSON.stringify(this.capabilities) !== JSON.stringify(nextCapabilities)) this.clear();
    this.user = data.authenticated ? {id: data.user.id, email: data.user.email} : null;
    this.csrf = data.csrf;
    this.capabilities = nextCapabilities;
    return { authenticated: data.authenticated, user: this.user, capabilities: [...this.capabilities] };
  }
  async requestCode(email) {
    if (!validEmail(email)) throw new Error('Invalid email');
    const data = await this.request('/auth/request-code', { method: 'POST', body: { email }, expectedStatus: 202 });
    if (!isRecord(data) || data.accepted !== true || !/^[a-fA-F0-9]{32}$/.test(data.challenge_id ?? '') || data.expires_in !== 600
      || Object.keys(data).some(key => !['accepted', 'challenge_id', 'expires_in'].includes(key))) throw new Error('Invalid code request response');
    return data;
  }
  async confirmCode(challengeId, code) {
    if (typeof challengeId !== 'string' || !/^[a-fA-F0-9]{32}$/.test(challengeId) || typeof code !== 'string' || !/^\d{8}$/.test(code)) throw new Error('Invalid code confirmation');
    const data = await this.request('/auth/confirm-code', { method: 'POST', body: { challenge_id: challengeId, code } });
    if (!isRecord(data) || data.authenticated !== true || Object.keys(data).some(key => key !== 'authenticated')) throw new Error('Invalid code confirmation response');
    return this.refreshSession();
  }
  async logout() {
    try {
      const data = await this.request('/auth/logout', { method: 'POST', body: {} });
      if (!isRecord(data) || data.signed_out !== true) throw new Error('Invalid logout response');
      return data;
    }
    finally { this.clear(); } // A network failure is still reported, never called a server logout.
  }
  resource(id) {
    if (typeof id !== 'string' || !resourceId.test(id)) throw new Error('Invalid resource');
    return this.request('/resources/' + id, { binary: true });
  }
  validateState(value) {
    if (!isRecord(value) || !Number.isSafeInteger(value.revision) || value.revision < 0 || !isStateData(value.data) || jsonBytes(value.data) > 65536) throw new Error('Invalid state response');
    return value;
  }
  async loadState(area) {
    if (!stateAreas.includes(area)) throw new Error('Invalid state reference');
    return this.validateState(await this.request('/state/' + area));
  }
  async saveState(area, revision, data) {
    if (!stateAreas.includes(area) || !Number.isSafeInteger(revision) || revision < 0) throw new Error('Invalid state reference');
    if (!isStateData(data) || jsonBytes(data) > 65536) throw new Error('Invalid state data');
    return this.validateState(await this.request('/state/' + area, { method: 'POST', body: { expected_revision: revision, data } }));
  }
}
