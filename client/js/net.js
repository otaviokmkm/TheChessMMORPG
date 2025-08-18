const API_BASE = '';
let ws;
export const Net = {
  token: null,
  playerId: null,
  tick: 0,
  isAdmin: false,
  connect() {
    return new Promise((resolve, reject) => {
      console.log('Establishing WebSocket connection...');
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      const wsUrl = `${proto}://${location.host}/ws`;
      console.log('WebSocket URL:', wsUrl);
      
      ws = new WebSocket(wsUrl);
      
      ws.onopen = () => {
        console.log('WebSocket opened, sending authentication...');
        ws.send(JSON.stringify({ token: this.token, client: 'web' }));
      };
      
      ws.onerror = (error) => {
        console.error('WebSocket error:', error);
        reject(new Error('WebSocket connection failed'));
      };
      
      ws.onmessage = (ev) => {
        const msg = JSON.parse(ev.data);
        console.log('WebSocket message received:', msg);
        
        if (msg.type === 'connected') {
          console.log('WebSocket connected successfully');
          this.playerId = msg.playerId;
          this.tick = msg.tick;
          resolve();
        } else if (msg.type === 'state') {
          this.tick = msg.tick;
          this.onState && this.onState(msg.state);
        } else if (msg.type === 'error') {
          console.error('Server error:', msg.message);
          reject(new Error(msg.message));
        }
      };
      
      ws.onclose = (event) => {
        console.log('WebSocket closed:', event.code, event.reason);
        if (event.code !== 1000) {  // Not a normal closure
          console.error('WebSocket closed unexpectedly');
        }
      };
    });
  },
  async fetchMe() {
    if (!this.token) return null;
    const res = await fetch(`${API_BASE}/auth/me`, { headers: { 'Authorization': `Bearer ${this.token}` } });
    if (!res.ok) return null;
    const me = await res.json();
  // record admin flag locally for UI logic
  this.isAdmin = !!me.is_admin;
    return me;
  },
  sendAction(a) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(a));
    }
  },
  async register(username, password) {
    console.log('Registering user:', username);
    const res = await fetch(`${API_BASE}/auth/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });
    if (!res.ok) {
      const errorData = await res.json().catch(() => null);
      const errorMsg = errorData?.detail || `Register failed: ${res.status} ${res.statusText}`;
      console.error('Register failed:', errorMsg);
      throw new Error(errorMsg);
    }
    const data = await res.json();
    console.log('Registration successful, received token');
    this.token = data.access_token;
  },
  async login(username, password) {
    console.log('Logging in user:', username);
    const res = await fetch(`${API_BASE}/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });
    if (!res.ok) {
      const errorData = await res.json().catch(() => null);
      const errorMsg = errorData?.detail || `Login failed: ${res.status} ${res.statusText}`;
      console.error('Login failed:', errorMsg);
      throw new Error(errorMsg);
    }
    const data = await res.json();
    console.log('Login successful, received token');
    this.token = data.access_token;
  },
  async wipeServer() {
    if (!this.token) throw new Error('not authed');
    const res = await fetch(`${API_BASE}/admin/wipe`, { method: 'POST', headers: { 'Authorization': `Bearer ${this.token}` } });
    if (!res.ok) throw new Error('wipe failed');
    return await res.json();
  },
  onState: null,
};
