import { Net } from './net.js';
import { Renderer } from './renderer.js';
import { Input } from './input.js';
import { AudioEngine } from './audio.js';

const auth = document.getElementById('auth');
const game = document.getElementById('game');
const canvas = document.getElementById('canvas');
const hud = document.getElementById('hud');
const tickInfo = document.getElementById('tickInfo');
const musicToggle = document.getElementById('musicToggle');
const classPanel = document.getElementById('classPanel');
const spellsPanel = document.getElementById('spellsPanel');
const spellsList = document.getElementById('spellsList');
const ren = new Renderer(canvas);
const input = new Input();

async function doAuth(isRegister) {
  const u = document.getElementById('username').value;
  const p = document.getElementById('password').value;
  try {
    if (isRegister) await Net.register(u,p); else await Net.login(u,p);
    document.getElementById('authMsg').textContent = 'ok';
    await Net.connect();
    auth.classList.add('hidden');
    game.classList.remove('hidden');
    // Music toggle (user gesture required by browsers); can be used any time
    musicToggle.addEventListener('change', () => {
      if (musicToggle.checked) {
        AudioEngine.start();
      } else {
        AudioEngine.stop();
      }
    });
  } catch (e) {
    document.getElementById('authMsg').textContent = e.message;
  }
}

document.getElementById('btnRegister').onclick = () => doAuth(true);

document.getElementById('btnLogin').onclick = () => doAuth(false);

Net.onState = (state) => {
  ren.update(state, Net.playerId);
  tickInfo.textContent = ` Tick: ${Net.tick}`;
  // Update spells panel from my player
  const me = state.players[Net.playerId];
  if (me) {
    input.setClass(me.class || null);
    renderSpells(me);
  }
};

// Send any chosen action before tick ends
setInterval(() => {
  // Casting takes priority over movement; if targeting and a target is set, send cast
  if (input.casting && input.casting.target) {
    Net.sendAction({ type: 'cast', payload: { spell: input.casting.spell, tx: input.casting.target.x, ty: input.casting.target.y } });
    input.casting = null;
    ren.targetPreview = null;
  } else {
    const a = input.consumeAction();
    if (a) Net.sendAction(a);
  }
}, 200);

// Class selection UI (simple prompt for now)
window.addEventListener('keydown', (e) => {
  if ((e.key === 'c' || e.key === 'C')) {
    classPanel.classList.toggle('hidden');
  }
});

// Mouse targeting for fireball
canvas.addEventListener('mousemove', (e) => {
  if (!input.casting) return;
  const rect = canvas.getBoundingClientRect();
  const mx = e.clientX - rect.left + ren.camera.x;
  const my = e.clientY - rect.top + ren.camera.y;
  const gx = Math.floor(mx / ren.tile);
  const gy = Math.floor(my / ren.tile);
  // Build preview cells in diamond (Manhattan radius)
  const cells = [];
  const r = input.casting.radius || 1;
  for (let dx=-r; dx<=r; dx++) {
    for (let dy=-r; dy<=r; dy++) {
      if (Math.abs(dx)+Math.abs(dy) <= r) cells.push({ x: gx+dx, y: gy+dy });
    }
  }
  ren.targetPreview = { cells, type: 'fireball' };
});

canvas.addEventListener('click', (e) => {
  if (!input.casting) return;
  const rect = canvas.getBoundingClientRect();
  const mx = e.clientX - rect.left + ren.camera.x;
  const my = e.clientY - rect.top + ren.camera.y;
  const gx = Math.floor(mx / ren.tile);
  const gy = Math.floor(my / ren.tile);
  // Accept target within range from current player position
  const me = ren.players[Net.playerId];
  const range = input.casting.range || 4;
  if (me && Math.abs(gx - me.x) + Math.abs(gy - me.y) <= range) {
    input.casting.target = { x: gx, y: gy };
  }
});

// Class selection buttons
classPanel.addEventListener('click', (e) => {
  const btn = e.target.closest('.class-btn');
  if (!btn) return;
  const clazz = btn.getAttribute('data-class');
  if (clazz) {
    input.setClass(clazz);
    Net.sendAction({ type: 'choose_class', payload: { class: clazz } });
    // keep panel open for now
  }
});

function renderSpells(me) {
  spellsList.innerHTML = '';
  // expects server snapshot to not include spell list; use client-known starter kits
  const spells = [];
  if (me.class === 'mage') spells.push({ id: 'fireball', name: 'Fireball', hotkey: '1', range: 4, radius: 1 });
  for (const s of spells) {
    const el = document.createElement('button');
    el.className = 'spell-btn';
    el.innerHTML = `<span>${s.name}</span><span class="badge">${s.hotkey}</span>`;
    el.onclick = () => {
      input.casting = { spell: s.id, target: null, radius: s.radius, range: s.range };
    };
    spellsList.appendChild(el);
  }
}

// Draggable panels (generic)
function makeDraggable(panel) {
  const head = panel.querySelector('[data-drag-handle]');
  if (!head) return;
  let startX=0, startY=0, origLeft=0, origTop=0;
  const onMouseMove = (e) => {
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    panel.style.left = (origLeft + dx) + 'px';
    panel.style.top = (origTop + dy) + 'px';
  };
  const onMouseUp = () => {
    window.removeEventListener('mousemove', onMouseMove);
    window.removeEventListener('mouseup', onMouseUp);
  };
  head.addEventListener('mousedown', (e) => {
    startX = e.clientX; startY = e.clientY;
    const rect = panel.getBoundingClientRect();
    // Ensure positioned from left when using right style
    if (panel.style.right) { panel.style.left = (rect.left) + 'px'; panel.style.right = ''; }
    origLeft = rect.left; origTop = rect.top;
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
  });
}

makeDraggable(classPanel);
makeDraggable(spellsPanel);
