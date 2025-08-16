const API_BASE = '';
let ws;
export const Net = {
  token: null,
  playerId: null,
  tick: 0,
  connect() {
    return new Promise((resolve, reject) => {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws`);
      ws.onopen = () => {
        ws.send(JSON.stringify({ token: this.token, client: 'web' }));
      };
      ws.onerror = reject;
      ws.onmessage = (ev) => {
        const msg = JSON.parse(ev.data);
        if (msg.type === 'connected') {
          this.playerId = msg.playerId;
          this.tick = msg.tick;
          resolve();
        } else if (msg.type === 'state') {
          this.tick = msg.tick;
          this.onState && this.onState(msg.state);
        }
      };
      ws.onclose = () => {};
    });
  },
  sendAction(a) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(a));
    }
  },
  async register(username, password) {
    const res = await fetch(`${API_BASE}/auth/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });
    if (!res.ok) throw new Error('register failed');
    const data = await res.json();
    this.token = data.access_token;
  },
  async login(username, password) {
    const res = await fetch(`${API_BASE}/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });
    if (!res.ok) throw new Error('login failed');
    const data = await res.json();
    this.token = data.access_token;
  },
  onState: null,
};
