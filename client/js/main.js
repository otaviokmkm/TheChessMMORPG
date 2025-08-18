import { Net } from './net.js?v=20250818_2';
import { Renderer } from './renderer.js?v=20250818_2';
import { Input } from './input.js?v=20250818_2';
import { AudioEngine } from './audio.js?v=20250818_2';

const auth = document.getElementById('auth');
const game = document.getElementById('game');
const canvas = document.getElementById('canvas');
const hud = document.getElementById('hud');
const tickInfo = document.getElementById('tickInfo');
const adminWipeBtn = document.getElementById('adminWipeBtn');
const bottomHud = document.getElementById('bottomHud');
const classLabel = document.getElementById('classLabel');
const hpFill = document.getElementById('hpFill');
const mpFill = document.getElementById('mpFill');
const xpFill = document.getElementById('xpFill');
const hpText = document.getElementById('hpText');
const mpText = document.getElementById('mpText');
const xpText = document.getElementById('xpText');
const musicToggle = document.getElementById('musicToggle');
const classPanel = document.getElementById('classPanel');
const spellsPanel = document.getElementById('spellsPanel');
const spellsList = document.getElementById('spellsList');
const settingsBtn = document.getElementById('settingsBtn');
const settingsPanel = document.getElementById('settingsPanel');
const gridToggle = document.getElementById('gridToggle');
const inventoryPanel = document.getElementById('inventoryPanel');
const equipmentPanel = document.getElementById('equipmentPanel');
const skillTreePanel = document.getElementById('skillTreePanel');
const characterPanel = document.getElementById('characterPanel');
const achievementPanel = document.getElementById('achievementPanel');
// Chat UI
const chatPanel = document.getElementById('chatPanel');
const chatTabSystem = document.getElementById('chatTabSystem');
const chatTabGlobal = document.getElementById('chatTabGlobal');
const chatViewSystem = document.getElementById('chatViewSystem');
const chatViewGlobal = document.getElementById('chatViewGlobal');
const chatInput = document.getElementById('chatInput');
const chatSendBtn = document.getElementById('chatSendBtn');
const helpOverlay = document.getElementById('helpOverlay');
const helpClose = document.getElementById('helpClose');
const helpGotIt = document.getElementById('helpGotIt');
const neverShowHelp = document.getElementById('neverShowHelp');
const changelogOverlay = document.getElementById('changelogOverlay');
const changelogBtn = document.getElementById('changelogBtn');
const changelogClose = document.getElementById('changelogClose');
const changelogGotIt = document.getElementById('changelogGotIt');
// Minigame elements
const minigameOverlay = document.getElementById('minigameOverlay');
const minigameCanvas = document.getElementById('minigameCanvas');
const minigameClose = document.getElementById('minigameClose');
const minigameStartBtn = document.getElementById('minigameStartBtn');
const miningTypeEl = document.getElementById('miningType');
const miningRoundEl = document.getElementById('miningRound');
const miningRoundsEl = document.getElementById('miningRounds');
const miningSuccessEl = document.getElementById('miningSuccess');
const miningTriesEl = document.getElementById('miningTries');
const miningLevelEl = document.getElementById('miningLevel');
const ren = new Renderer(canvas);
const input = new Input();
let currentMinigame = null; // 'stone' | 'wood'
let dragState = null; // { from: { type:'inv', idx }, item }

// Chat state & helpers
const Chat = {
  activeTab: 'system',
  // Dedup across multiple ticks: remember a message for a while so
  // server TTL-based repeats don't spam the chat. We keep entries
  // for ~25 ticks (server default notification TTL is ~20).
  seen: new Map(), // key -> expiresAtTick
  _dedupeTicks: 25,
  addSystem(text) {
    if (!text) return;
    const key = text;
    const until = Chat.seen.get(key) || 0;
    if (until > Net.tick) return; // still suppressed
    Chat.seen.set(key, Net.tick + Chat._dedupeTicks);
    const line = document.createElement('div');
    line.className = 'chat-msg system';
    line.textContent = text;
    chatViewSystem.appendChild(line);
    chatViewSystem.scrollTop = chatViewSystem.scrollHeight;
  },
  addPlayer(name, text) {
    const line = document.createElement('div');
    line.className = 'chat-msg';
    line.innerHTML = `<span class="name">${escapeHtml(name)}:</span> ${escapeHtml(text)}`;
    chatViewGlobal.appendChild(line);
    chatViewGlobal.scrollTop = chatViewGlobal.scrollHeight;
  }
};

function escapeHtml(s){
  return String(s).replace(/[&<>"]|'/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;','\'':'&#39;'}[m]));
}

// Item database with icons and MMORPG-like descriptions
const ITEMS = {
  wood: { icon: '🌲', name: 'Timber of the Greenwood', desc: 'A bundle of resin-scented firewood. Favored by campfires and novice carpenters.', rarity: 'common' },
  stone: { icon: '🪨', name: 'Riverbed Cobble', desc: 'A stubborn chunk of rock. Good for blunt tools and rough foundations.', rarity: 'common' },
  ore: { icon: '⛏️', name: 'Veinstone Ore', desc: 'Raw ore flecked with metallic veins. Smelts into useful bars—if you have a recipe.', rarity: 'uncommon' },
  gold: { icon: '🪙', name: 'Tarnished Coin', desc: 'Old coinage with a dull gleam. Merchants still recognize the weight.', rarity: 'common' },
  slime: { icon: '🟢', name: 'Slime Lubricant', desc: 'A viscous, alchemical-grade lubricant harvested from slimes. Smells faintly of cucumber.', rarity: 'uncommon' },
  notebook: { icon: '📖', name: 'Field Notebook', desc: 'A battered notebook. Write down quests and clues. Opens the Journal panel.', rarity: 'common', use: () => toggleJournal(true) },
  ring: { icon: '💍', name: 'Lost Marriage Ring', desc: 'A delicate ring, cold to the touch. Someone in the cave is missing this.', rarity: 'rare' },
  recipe_fire_staff: { icon: '📜', name: 'Recipe: Ember Staff', desc: 'Unlocks the crafting recipe for an Ember Staff. Requires fire-touched materials.', rarity: 'uncommon' },
};

// Crafting system: recipes unlock by drops
const CRAFTING = {
  known: new Set(['campfire']),
  all: {
    campfire: { icon: '🔥', name: 'Campfire', req: { wood: 3, stone: 1 }, out: { item: 'campfire', qty: 1 } },
    fire_staff: { icon: '🪄', name: 'Ember Staff', req: { wood: 2, ore: 2, slime: 1 }, out: { item: 'weapon_fire_staff', qty: 1 }, locked: true },
  }
};
function unlockRecipe(key) { CRAFTING.known.add(key); renderCraftingPanel(); }

// Quest System
let questPanel; let questBody;
let playerQuests = new Map(); // Map of quest_id -> {name, description, status, objectives}

function ensureQuestPanel() {
  if (questPanel) return;
  questPanel = document.createElement('div');
  questPanel.id = 'questPanel';
  questPanel.className = 'panel hidden';
  questPanel.style.left = '380px';
  questPanel.style.top = '280px';
  questPanel.innerHTML = `
    <div class="panel-head" data-drag-handle>📋 Quests</div>
    <div class="panel-body">
      <div id="questBody" style="max-height:300px;overflow:auto;">
        <div class="quest-empty">No active quests</div>
      </div>
    </div>
    <div class="panel-foot">Press Q to toggle</div>
  `;
  document.getElementById('game').appendChild(questPanel);
  enhanceDraggable(questPanel);
  questBody = document.getElementById('questBody');
}

function toggleQuestPanel(forceOpen) {
  ensureQuestPanel();
  if (forceOpen === true) questPanel.classList.remove('hidden');
  else questPanel.classList.toggle('hidden');
}

function addQuest(questId, name, description, objectives = []) {
  playerQuests.set(questId, {
    name,
    description,
    status: 'active',
    objectives,
    completed: false,
    progress: {}
  });
  updateQuestDisplay();
}

function updateQuestProgress(questId, objectiveId, progress) {
  const quest = playerQuests.get(questId);
  if (!quest) return;
  quest.progress[objectiveId] = progress;
  updateQuestDisplay();
}

function completeQuest(questId) {
  const quest = playerQuests.get(questId);
  if (!quest) return;
  quest.status = 'completed';
  quest.completed = true;
  updateQuestDisplay();
}

function updateQuestDisplay() {
  ensureQuestPanel();
  if (!questBody) return;
  
  questBody.innerHTML = '';
  
  if (playerQuests.size === 0) {
    questBody.innerHTML = '<div class="quest-empty">No active quests</div>';
    return;
  }
  
  playerQuests.forEach((quest, questId) => {
    const questDiv = document.createElement('div');
    questDiv.className = `quest-item ${quest.completed ? 'completed' : 'active'}`;
    
    const questHeader = document.createElement('div');
    questHeader.className = 'quest-header';
    questHeader.innerHTML = `
      <div class="quest-title">${quest.name}</div>
      <div class="quest-status ${quest.status}">${quest.status.toUpperCase()}</div>
    `;
    
    const questDesc = document.createElement('div');
    questDesc.className = 'quest-description';
    questDesc.textContent = quest.description;
    
    const questObjectives = document.createElement('div');
    questObjectives.className = 'quest-objectives';
    
    quest.objectives.forEach((objective, idx) => {
      const objDiv = document.createElement('div');
      objDiv.className = 'quest-objective';
      const progress = quest.progress[idx] || 0;
      const isComplete = progress >= (objective.target || 1);
      objDiv.innerHTML = `
        <span class="${isComplete ? 'complete' : 'incomplete'}">${isComplete ? '✓' : '○'}</span>
        ${objective.text} ${objective.target ? `(${progress}/${objective.target})` : ''}
      `;
      questObjectives.appendChild(objDiv);
    });
    
    questDiv.appendChild(questHeader);
    questDiv.appendChild(questDesc);
    questDiv.appendChild(questObjectives);
    questBody.appendChild(questDiv);
  });
}

// Journal panel (for notebook functionality)
let journalPanel; let journalBody;
function ensureJournal() {
  if (journalPanel) return;
  journalPanel = document.createElement('div'); journalPanel.id = 'journalPanel'; journalPanel.className = 'panel hidden';
  journalPanel.style.left = '700px'; journalPanel.style.top = '120px';
  journalPanel.innerHTML = `
    <div class="panel-head" data-drag-handle>Journal</div>
    <div class="panel-body"><div id="journalBody" style="max-height:180px;overflow:auto;font-size:12px;color:#ddd"></div></div>
    <div class="panel-foot">Use the Notebook to open</div>
  `;
  document.getElementById('game').appendChild(journalPanel);
  enhanceDraggable(journalPanel);
  journalBody = document.getElementById('journalBody');
}
function toggleJournal(forceOpen) { ensureJournal(); if (forceOpen === true) journalPanel.classList.remove('hidden'); else journalPanel.classList.toggle('hidden'); }
function journalAdd(text) { ensureJournal(); const p = document.createElement('div'); p.textContent = text; journalBody.appendChild(p); }

async function doAuth(isRegister) {
  const u = document.getElementById('username').value.trim();
  const p = document.getElementById('password').value.trim();
  
  if (!u || !p) {
    document.getElementById('authMsg').textContent = 'Please enter both username and password';
    return;
  }
  
  try {
    console.log('Starting authentication...', { isRegister, username: u });
    document.getElementById('authMsg').textContent = 'Authenticating...';
    
    if (isRegister) await Net.register(u,p); else await Net.login(u,p);
    console.log('Authentication successful, token received');
    document.getElementById('authMsg').textContent = 'Connected! Joining game...';
    
    // Check admin status immediately after login/register (don't depend on WS connect)
    try {
      const me = await Net.fetchMe();
      console.log('User profile fetched:', me);
      if (me && me.is_admin) {
        adminWipeBtn.classList.remove('hidden');
      }
    } catch (e) {
      console.warn('Failed to fetch user profile:', e);
      // swallow - fetchMe may fail if token missing/invalid
    }
    
    console.log('Attempting WebSocket connection...');
    await Net.connect();
    console.log('WebSocket connected, switching to game UI');
    
    auth.classList.add('hidden');
    game.classList.remove('hidden');
    
    // Restore panel positions and show help for new users
    restorePanelPositions();
    showHelp();
    
    // Initialize displays
    updateInventoryDisplay();
    updateXpDisplay();
    
    // Always show inventory panel on login so player can see it's accessible
    inventoryPanel.classList.remove('hidden');
    
    // Music toggle (user gesture required by browsers); can be used any time
    musicToggle.addEventListener('change', () => {
      if (musicToggle.checked) {
        AudioEngine.start();
      } else {
        AudioEngine.stop();
      }
    });
    
    console.log('Login process completed successfully');
  } catch (e) {
    console.error('Authentication failed:', e);
    document.getElementById('authMsg').textContent = e.message || 'Authentication failed';
  }
}
adminWipeBtn.addEventListener('click', async () => {
  if (!confirm('Wipe world state for all players? This cannot be undone.')) return;
  if (!confirm('Are you absolutely sure?')) return;
  adminWipeBtn.disabled = true;
  adminWipeBtn.textContent = 'Wiping...';
  try {
    await Net.wipeServer();
  } catch (e) {
    alert('Wipe failed: ' + (e.message || e));
  } finally {
    adminWipeBtn.disabled = false;
    adminWipeBtn.textContent = 'Wipe World';
  }
});

document.getElementById('btnRegister').onclick = (e) => {
  e.preventDefault();
  doAuth(true);
};

document.getElementById('btnLogin').onclick = (e) => {
  e.preventDefault();
  doAuth(false);
};

// Also handle form submission with Enter key
document.getElementById('authForm').addEventListener('submit', (e) => {
  e.preventDefault();
  doAuth(false); // Default to login on Enter
});

Net.onState = (state) => {
  if (Net.isAdmin) adminWipeBtn.classList.remove('hidden');
  // cache resources for quick client-side checks (e.g., mining)
  window.lastStateResources = state.resources || [];
  
  // Track resource changes for floating numbers
  const me = state.players[Net.playerId];
  if (me && ren.players[Net.playerId]) {
    const oldMe = ren.players[Net.playerId];
    const rect = canvas.getBoundingClientRect();
    const playerScreenX = rect.left + (me.x * ren.tile) - ren.camera.x + ren.tile/2;
    const playerScreenY = rect.top + (me.y * ren.tile) - ren.camera.y + ren.tile/2;
    
    // Check for resource gathering (compare with previous state)
    if (window.lastResourceCount !== undefined) {
      const currentResourceCount = state.resources ? state.resources.length : 0;
      if (currentResourceCount < window.lastResourceCount) {
        // A resource was gathered - show appropriate floating text
        const nearbyResources = state.resources || [];
        const playerAdjacentTiles = [
          {x: me.x, y: me.y},
          {x: me.x-1, y: me.y}, {x: me.x+1, y: me.y},
          {x: me.x, y: me.y-1}, {x: me.x, y: me.y+1}
        ];
        
        // Simple heuristic: assume player gathered the closest resource type
        let gatheredType = 'wood'; // default
        for (let tile of playerAdjacentTiles) {
          const hasTree = nearbyResources.some(r => r.x === tile.x && r.y === tile.y && r.type === 'tree');
          const hasRock = nearbyResources.some(r => r.x === tile.x && r.y === tile.y && r.type === 'rock');
          if (!hasTree && !hasRock) {
            // This tile used to have a resource but now doesn't
            gatheredType = Math.random() > 0.5 ? 'wood' : 'stone';
            break;
          }
        }
        
        if (gatheredType === 'wood') {
          const added = addItem('wood', 1);
          if (added > 0) {
            showFloatingNumber(playerScreenX + (Math.random()-0.5)*20, playerScreenY - 10, '+1 Wood');
            playSound('wood');
          }
        } else {
          const added = addItem('stone', 1);
          if (added > 0) {
            showFloatingNumber(playerScreenX + (Math.random()-0.5)*20, playerScreenY - 10, '+1 Stone');
            playSound('stone');
          }
        }
      }
    }
    window.lastResourceCount = state.resources ? state.resources.length : 0;
    
    // Check for monster kills (XP gain)
    if (window.lastMonsterCount !== undefined) {
      const currentMonsterCount = state.monsters ? Object.keys(state.monsters).length : 0;
      if (currentMonsterCount < window.lastMonsterCount) {
        // A monster was killed
        const xpGained = 50; // Base XP per monster
        gainXp(xpGained);
        const goldAmt = Math.floor(Math.random() * 10) + 5;
        const goldAdded = addItem('gold', goldAmt);
        playSound('gold');
  onMonsterKilled('slime');
        showFloatingNumber(playerScreenX + (Math.random()-0.5)*40, playerScreenY - 50, `+${xpGained} XP`, true);
        if (goldAdded > 0) {
          showFloatingNumber(playerScreenX + (Math.random()-0.5)*40, playerScreenY - 70, `+${goldAmt} Gold`, true);
        }
      }
    }
    window.lastMonsterCount = state.monsters ? Object.keys(state.monsters).length : 0;
  }
  
  ren.update(state, Net.playerId, Net.tick);
  tickInfo.textContent = ` Tick: ${Net.tick}`;
  // Clear locked preview when the next tick arrives
  if (ren.targetPreview && typeof ren.targetPreview.lockTick === 'number' && Net.tick > ren.targetPreview.lockTick) {
    ren.targetPreview = null;
  }
  // Update spells panel from my player
  if (me) {
    input.setClass(null);
    input.setKnownSpells(me.spellsKnown || []);
    renderSpells(me);
    // Auto-show spells panel for classes that have spells
  // Always show the spells panel; it will say if you have no spells yet
  spellsPanel.classList.remove('hidden');
    // Update bottom HUD
    bottomHud.classList.remove('hidden');
  classLabel.textContent = 'Spells & Stats';
    if (me.hpMax > 0) {
      const hpPct = Math.max(0, Math.min(100, Math.round((me.hp / me.hpMax) * 100)));
      hpFill.style.width = hpPct + '%';
      hpText.textContent = `HP ${me.hp}/${me.hpMax}`;
    }
    if (me.mpMax >= 0) {
      const mpPct = me.mpMax ? Math.max(0, Math.min(100, Math.round((me.mp / me.mpMax) * 100))) : 0;
      mpFill.style.width = mpPct + '%';
      mpText.textContent = `MP ${me.mp}/${me.mpMax}`;
    }
    // XP is now handled by our custom system
    updateXpDisplay();
    
    // Sync inventory from server snapshot (simple one-way for key items like the orb)
    try {
      if (me.inventory && typeof me.inventory === 'object') {
        // Rebuild local inventory (keep max slots, weights)
        const totals = me.inventory;
        const flat = [];
        for (const [id, qty] of Object.entries(totals)) {
          if (!qty) continue;
          let left = qty;
          while (left > 0) {
            const take = Math.min(left, INVENTORY.maxStack);
            flat.push({ id, qty: take });
            left -= take;
          }
        }
        INVENTORY.slotsData = Array.from({ length: INVENTORY.slots }, () => null);
        for (let i = 0; i < Math.min(INVENTORY.slots, flat.length); i++) {
          INVENTORY.slotsData[i] = flat[i];
        }
        updateInventoryDisplay();
      }
    } catch {}

    // Update quest system from server data
    if (me.quests) {
      syncQuestsFromServer(me.quests);
    }
    
    // Process server notifications with lifetime dedupe: only show when a notification first appears.
    if (!window._prevServerNotifs) window._prevServerNotifs = new Set();
    const prevNotifs = window._prevServerNotifs;
    const currList = Array.isArray(me.notifications) ? me.notifications : [];
    const currSet = new Set(currList);
    if (currList.length) {
      const rect = canvas.getBoundingClientRect();
      for (const text of currSet) {
        if (!prevNotifs.has(text)) {
          // First appearance -> show once
          Chat.addSystem(text);
          showFloatingNumber(rect.left + rect.width/2, rect.top + rect.height - 80, text, true);
          // Parse quest-related notifications to auto-add quests (only on first appearance)
          if (text.includes('Classes are spell families')) {
            addQuest('help_sergeant', 'Help the Sergeant', 'Learn about magic and prove your combat skills', [
              {text: 'Collect 5 pieces of Firewood', target: 5},
              {text: 'Defeat a Slime', target: 1}
            ]);
          } else if (text.includes('Good. Now defeat a slime')) {
            updateQuestProgress('help_sergeant', 0, 5); // Mark firewood as complete
          } else if (text.includes('gave you a Firestarter Orb')) {
            completeQuest('help_sergeant');
          }
        }
      }
    }
    // Replace previous set with current
    window._prevServerNotifs = currSet;
  }
};

// Sync quests from server state
function syncQuestsFromServer(serverQuests) {
  for (const [questId, questData] of Object.entries(serverQuests)) {
    if (questId === 'help_sergeant') {
      if (!playerQuests.has(questId)) {
        addQuest(questId, 'Help the Sergeant', 'Learn about magic and prove your combat skills', [
          {text: 'Collect 5 pieces of Firewood', target: 5},
          {text: 'Defeat a Slime', target: 1}
        ]);
      }
      
      // Update progress from server data
      const quest = playerQuests.get(questId);
      if (quest && questData.data) {
        const woodCount = questData.data.wood || 0;
        const slimeKill = questData.data.slimeKilled || false;
        
        updateQuestProgress(questId, 0, Math.min(woodCount, 5));
        if (slimeKill) {
          updateQuestProgress(questId, 1, 1);
        }
        
        if (questData.status === 'completed') {
          completeQuest(questId);
        }
      }
    }
  }
}

// Continuous render loop (~60 FPS) so targeting previews update smoothly between server ticks
function animate() {
  ren.draw();
  requestAnimationFrame(animate);
}
requestAnimationFrame(animate);

// Send any chosen action before tick ends
setInterval(() => {
  // If a cast was queued via Input (directional or targeted), it will be in pendingAction
  const a = input.consumeAction();
  if (a) {
    Net.sendAction(a);
    return;
  }
}, 200);

// Class selection removed (spells gated by requirements); 'C' no longer opens class panel
window.addEventListener('keydown', (e) => {
  if (e.key === 'c' || e.key === 'C') {
    // no-op
  }
});

// Mouse targeting for fireball
// Mouse move preview removed per request

canvas.addEventListener('click', (e) => {
  const rect = canvas.getBoundingClientRect();
  const mx = e.clientX - rect.left + ren.camera.x;
  const my = e.clientY - rect.top + ren.camera.y;
  const gx = Math.floor(mx / ren.tile);
  const gy = Math.floor(my / ren.tile);
  
  // First, check if we clicked on an NPC for talking
  if (handleNPCClick(gx, gy)) {
    return; // NPC interaction handled, don't proceed with spell casting
  }
  
  // Handle spell casting
  if (!input.casting) return;
  const meClick = ren.players[Net.playerId];
  // If punch is selected, allow clicking an adjacent tile containing an enemy
  if (input.casting.spell === 'punch' && meClick) {
    const isAdjacent = Math.abs(gx - meClick.x) + Math.abs(gy - meClick.y) <= 1 || (Math.abs(gx - meClick.x) <= 1 && Math.abs(gy - meClick.y) <= 1);
    if (!isAdjacent) return; // must target adjacent tile
    // Send punch with target tile; server will pick target there
    Net.sendAction({ type: 'cast', payload: { spell: 'punch', tx: gx, ty: gy } });
    input.casting = null;
    return;
  }
  // If fireball is selected, infer direction and cast immediately
  if (input.casting.spell === 'fireball' && meClick) {
    const dx = gx - meClick.x;
    const dy = gy - meClick.y;
    // Pick dominant axis to match server cardinal directions
    let dir = 'right';
    if (Math.abs(dx) >= Math.abs(dy)) dir = dx >= 0 ? 'right' : 'left';
    else dir = dy >= 0 ? 'down' : 'up';
    // Send cast action now
    Net.sendAction({ type: 'cast', payload: { spell: 'fireball', dir } });
  // No visual target indicator
    // Clear casting locally (server will reflect state soon)
    input.casting = null;
    return;
  }
  // Ignore other click targeting; only directional fireball is supported
});

// Right-click to gather (context menu suppressed) - no longer starts minigame
canvas.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  if (!input.casting) {
    Net.sendAction({ type: 'gather' });
  }
});

// Class selection removed: no buttons/requests

function renderSpells(me) {
  spellsList.innerHTML = '';
  // Use server-known spells list
  const spells = [];
  const known = new Set(me.spellsKnown || []);
  if (known.has('punch')) spells.push({ id: 'punch', name: 'Punch', hotkey: '1', range: 1, radius: 0, cost: 0 });
  if (known.has('fireball')) spells.push({ id: 'fireball', name: 'Fireball', hotkey: '2', range: 3, radius: 0, cost: 5 });
  const cds = (me.cooldowns) || {};
  const canAfford = (cost) => (me.mpMax ? me.mp >= (cost || 0) : true);
  if (spells.length === 0) {
    const msg = document.createElement('div');
    msg.style.color = '#aaa';
    msg.style.fontSize = '12px';
    msg.textContent = 'No spells known. Learn spells by meeting requirements.';
    spellsList.appendChild(msg);
  }
  for (const s of spells) {
    const cdLeft = Math.max(0, Math.ceil(cds[s.id] || 0));
    const ready = cdLeft <= 0 && canAfford(s.cost);
    const el = document.createElement('button');
    el.className = 'spell-btn';
  if (input.casting && input.casting.spell === s.id) {
      el.classList.add('active');
    }
    el.disabled = !ready;
    el.title = ready ? '' : (cdLeft > 0 ? `Cooldown: ${cdLeft.toFixed(0)}s` : `Need MP: ${s.cost}`);
    const badge = `<span class="badge">${s.hotkey}</span>`;
    const meta = ready ? '<span class="spell-ready">Ready</span>' : (cdLeft > 0 ? `<span class="spell-cd">${cdLeft}s</span>` : `<span class="spell-mp">MP ${s.cost}</span>`);
    el.innerHTML = `<span>${s.name}</span>${badge}${meta}`;
    el.onclick = () => {
      if (!ready) return;
      if (s.id === 'punch') {
        // Enter targeting mode for adjacent selection
        input.casting = { spell: 'punch', mode: 'adjacent', target: null };
      } else if (s.id === 'fireball') {
        input.casting = { spell: s.id, target: null, radius: s.radius, range: s.range };
      }
    };
    spellsList.appendChild(el);
  }
}

// Settings menu functionality
settingsBtn.addEventListener('click', () => {
  settingsPanel.classList.toggle('hidden');
});

// Grid toggle functionality  
gridToggle.addEventListener('change', () => {
  ren.showGrid = gridToggle.checked;
});

// Draggable panels (generic)
function makeDraggable(panel) {
  // Gracefully handle missing panels (e.g., classPanel removed from DOM)
  if (!panel) return;
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
makeDraggable(settingsPanel);
enhanceDraggable(inventoryPanel);
enhanceDraggable(equipmentPanel);
enhanceDraggable(skillTreePanel);
enhanceDraggable(characterPanel);
enhanceDraggable(achievementPanel);
enhanceDraggable(chatPanel);

// Panel toggle functionality
function togglePanel(panel) {
    panel.classList.toggle('hidden');
    if (!panel.classList.contains('hidden')) {
        // Bring to front when opening
        panel.style.zIndex = '1001';
        setTimeout(() => { panel.style.zIndex = ''; }, 100);
        clampPanelToViewport(panel);
    }
}

function clampPanelToViewport(panel){
  const rect = panel.getBoundingClientRect();
  const vw = window.innerWidth, vh = window.innerHeight;
  let left = rect.left, top = rect.top;
  if (left + rect.width > vw) left = Math.max(0, vw - rect.width - 8);
  if (top + rect.height > vh) top = Math.max(0, vh - rect.height - 8);
  if (left < 0) left = 8;
  if (top < 0) top = 8;
  panel.style.left = left + 'px';
  panel.style.top = top + 'px';
}

// Click-to-talk functionality for NPCs
function handleNPCClick(x, y) {
    const me = ren.players[Net.playerId];
    if (!me) return;
    
    // Check if there's an NPC at the clicked position and if we're adjacent
    const npc = ren.npcs && ren.npcs.find(n => n.x === x && n.y === y);
    if (npc && Math.abs(me.x - x) + Math.abs(me.y - y) <= 1) {
        // Send talk action to server
        Net.sendAction({ type: 'talk', payload: { x: x, y: y } });
        
        // Play audio based on NPC type
        if (npc.name === 'Sergeant') {
            playSergeantAudio();
        }
        // Add other NPC audio here as needed
        
        return true; // Indicate we handled an NPC click
    }
    return false;
}

// Keyboard shortcuts for panels
document.addEventListener('keydown', (event) => {
    // Don't trigger shortcuts if typing in an input field or if a panel is being typed in
    if (event.target.tagName === 'INPUT' || event.target.tagName === 'TEXTAREA') {
        return;
    }
    
    // Don't interfere with existing game controls
    if (event.target === canvas || event.target === document.body) {
        switch(event.key.toLowerCase()) {
            case 'i':
                if (!event.ctrlKey && !event.altKey) {
                    event.preventDefault();
                    togglePanel(inventoryPanel);
                }
                break;
            case 'q':
                if (!event.ctrlKey && !event.altKey) {
                    event.preventDefault();
                    toggleQuestPanel();
                }
                break;
            case 'e':
                if (!event.ctrlKey && !event.altKey) {
                    event.preventDefault();
                    togglePanel(equipmentPanel);
                }
                break;
            case 'k':
                if (!event.ctrlKey && !event.altKey) {
                    event.preventDefault();
                    togglePanel(skillTreePanel);
                }
                break;
            case 'p':
                if (!event.ctrlKey && !event.altKey) {
                    event.preventDefault();
                    togglePanel(characterPanel);
                }
                break;
            case 'j':
                if (!event.ctrlKey && !event.altKey) {
                    event.preventDefault();
                    togglePanel(achievementPanel);
                }
                break;
            case 't':
                if (!event.ctrlKey && !event.altKey) {
                    event.preventDefault();
                    const me = ren.players[Net.playerId];
                    if (me && ren.npcs) {
                      const tiles = [ {x: me.x, y: me.y}, {x: me.x+1,y: me.y}, {x: me.x-1,y: me.y}, {x: me.x, y: me.y+1}, {x: me.x, y: me.y-1} ];
                      for (const t of tiles) {
                        const npc = ren.npcs.find(n => n.x === t.x && n.y === t.y);
                        if (npc) { 
                          Net.sendAction({ type: 'talk', payload: { x: t.x, y: t.y } });
                          // Play audio for the NPC
                          if (npc.name === 'Sergeant') {
                            playSergeantAudio();
                          }
                          break; 
                        }
                      }
                    }
                }
                break;
            // Removed 'U' binding for Firestarter Orb to avoid confusion with inventory
      case 'g':
        if (!event.ctrlKey && !event.altKey) {
          event.preventDefault();
          // Start minigame if adjacent to rock (stone) or tree (wood); otherwise send gather
          const me = ren.players[Net.playerId];
          const resources = window.lastStateResources || [];
          let adjacentRock = false;
          let adjacentTree = false;
          if (me) {
            const adj = [
              {x: me.x, y: me.y},
              {x: me.x+1, y: me.y}, {x: me.x-1, y: me.y},
              {x: me.x, y: me.y+1}, {x: me.x, y: me.y-1}
            ];
            adjacentRock = adj.some(t => resources.some(r => r.x === t.x && r.y === t.y && r.type === 'rock'));
            adjacentTree = adj.some(t => resources.some(r => r.x === t.x && r.y === t.y && r.type === 'tree'));
          }
          if (adjacentRock) {
            openMiningMinigame('stone');
          } else if (adjacentTree) {
            openWoodMinigame();
          } else {
            Net.sendAction({ type: 'gather' });
          }
        }
        break;
            case 'escape':
                // Close all panels on Escape
                settingsPanel.classList.add('hidden');
                inventoryPanel.classList.add('hidden');
                equipmentPanel.classList.add('hidden');
                skillTreePanel.classList.add('hidden');
                characterPanel.classList.add('hidden');
                achievementPanel.classList.add('hidden');
                chatPanel.classList.add('hidden');
                changelogOverlay.classList.add('hidden');
                helpOverlay.classList.add('hidden');
                if (questPanel) questPanel.classList.add('hidden');
                break;
        }
    }
});

// Panel close buttons functionality
document.querySelectorAll('.panel-close').forEach(closeBtn => {
    closeBtn.addEventListener('click', (event) => {
        event.stopPropagation();
        const panel = closeBtn.closest('.panel');
        if (panel) {
            panel.classList.add('hidden');
        }
    });
});

// Help system
function showHelp() {
    if (localStorage.getItem('tickwars_never_show_help') === 'true') {
        return;
    }
    helpOverlay.classList.remove('hidden');
}

function hideHelp() {
    helpOverlay.classList.add('hidden');
    if (neverShowHelp.checked) {
        localStorage.setItem('tickwars_never_show_help', 'true');
    }
}

helpClose.addEventListener('click', hideHelp);
helpGotIt.addEventListener('click', hideHelp);

// Changelog functionality
changelogBtn.addEventListener('click', () => {
  changelogOverlay.classList.remove('hidden');
});

changelogClose.addEventListener('click', () => {
  changelogOverlay.classList.add('hidden');
});

changelogGotIt.addEventListener('click', () => {
  changelogOverlay.classList.add('hidden');
});

// Save and restore panel positions
function savePanelPositions() {
    const panels = [settingsPanel, inventoryPanel, equipmentPanel, skillTreePanel, characterPanel, achievementPanel];
    const positions = {};
    
    panels.forEach(panel => {
        if (panel && panel.id) {
            const rect = panel.getBoundingClientRect();
            positions[panel.id] = {
                left: panel.style.left || rect.left + 'px',
                top: panel.style.top || rect.top + 'px'
            };
        }
    });
    
    localStorage.setItem('tickwars_panel_positions', JSON.stringify(positions));
}

function restorePanelPositions() {
    const saved = localStorage.getItem('tickwars_panel_positions');
    if (!saved) return;
    
    try {
        const positions = JSON.parse(saved);
        Object.keys(positions).forEach(panelId => {
            const panel = document.getElementById(panelId);
            if (panel && positions[panelId]) {
                panel.style.left = positions[panelId].left;
                panel.style.top = positions[panelId].top;
            }
        });
    } catch (e) {
        console.warn('Failed to restore panel positions:', e);
    }
}

// Save positions when panels are dragged
function enhanceDraggable(panel) {
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
        savePanelPositions(); // Save position after dragging
        window.removeEventListener('mousemove', onMouseMove);
        window.removeEventListener('mouseup', onMouseUp);
  clampPanelToViewport(panel);
    };
    head.addEventListener('mousedown', (e) => {
        startX = e.clientX; startY = e.clientY;
        const rect = panel.getBoundingClientRect();
        if (panel.style.right) { panel.style.left = (rect.left) + 'px'; panel.style.right = ''; }
        origLeft = rect.left; origTop = rect.top;
        window.addEventListener('mousemove', onMouseMove);
        window.addEventListener('mouseup', onMouseUp);
    });
}

// Simple sound effects
function playSound(type) {
    if (!musicToggle.checked) return; // Respect music setting
    
    // Create audio context if needed
    if (!window.audioContext) {
        try {
            window.audioContext = new (window.AudioContext || window.webkitAudioContext)();
        } catch (e) {
            return; // Audio not supported
        }
    }
    
    const ctx = window.audioContext;
    const oscillator = ctx.createOscillator();
    const gain = ctx.createGain();
    
    oscillator.connect(gain);
    gain.connect(ctx.destination);
    
    // Different sounds for different actions
  switch(type) {
        case 'wood':
            oscillator.frequency.setValueAtTime(200, ctx.currentTime);
            oscillator.frequency.exponentialRampToValueAtTime(150, ctx.currentTime + 0.1);
            break;
        case 'stone':
            oscillator.frequency.setValueAtTime(120, ctx.currentTime);
            oscillator.frequency.exponentialRampToValueAtTime(100, ctx.currentTime + 0.15);
            break;
        case 'gold':
            oscillator.frequency.setValueAtTime(400, ctx.currentTime);
            oscillator.frequency.exponentialRampToValueAtTime(600, ctx.currentTime + 0.1);
            oscillator.frequency.exponentialRampToValueAtTime(400, ctx.currentTime + 0.2);
            break;
        case 'levelup':
            // Ascending tones for level up
            oscillator.frequency.setValueAtTime(300, ctx.currentTime);
            oscillator.frequency.exponentialRampToValueAtTime(450, ctx.currentTime + 0.2);
            oscillator.frequency.exponentialRampToValueAtTime(600, ctx.currentTime + 0.4);
            break;
    case 'perfect':
      // Distinct two-tone chime
      oscillator.type = 'square';
      oscillator.frequency.setValueAtTime(660, ctx.currentTime);
      oscillator.frequency.setValueAtTime(990, ctx.currentTime + 0.1);
      break;
    }
    
    gain.gain.setValueAtTime(0.3, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.3);
    
    oscillator.start(ctx.currentTime);
    oscillator.stop(ctx.currentTime + 0.3);
}

// Floating numbers system
function showFloatingNumber(x, y, text, isGold = false) {
    const floatingDiv = document.createElement('div');
    floatingDiv.className = `floating-number ${isGold ? 'gold' : 'positive'}`;
    floatingDiv.textContent = text;
    floatingDiv.style.left = x + 'px';
    floatingDiv.style.top = y + 'px';
    document.body.appendChild(floatingDiv);
    
    // Remove after animation
    setTimeout(() => {
        if (floatingDiv.parentNode) {
            floatingDiv.parentNode.removeChild(floatingDiv);
        }
    }, 1500);
}

// Player inventory and XP system
// Weight-limited, slot-based inventory with simple stacking
const INVENTORY = {
  maxWeight: 100,      // total weight capacity
  slots: 20,          // number of visible slots
  maxStack: 99,       // max items per stack for same item
  weights: {          // per-item weight
    wood: 1,
    stone: 2,
    gold: 0,
    slime: 0.5,
  ore: 2.5,
  },
  slotsData: []       // array of { id: 'wood'|'stone'|'gold'|'slime', qty: number }
};

// initialize empty slots
INVENTORY.slotsData = Array.from({ length: INVENTORY.slots }, () => null);

function getInventoryWeight() {
  let w = 0;
  for (const slot of INVENTORY.slotsData) {
    if (!slot) continue;
    const unit = INVENTORY.weights[slot.id] || 1;
    w += unit * slot.qty;
  }
  return Math.round(w * 100) / 100;
}

function findStackOrEmptySlot(itemId) {
  // Prefer stacking if possible
  for (let i = 0; i < INVENTORY.slotsData.length; i++) {
    const s = INVENTORY.slotsData[i];
    if (s && s.id === itemId && s.qty < INVENTORY.maxStack) return i;
  }
  // Else find empty
  for (let i = 0; i < INVENTORY.slotsData.length; i++) {
    if (!INVENTORY.slotsData[i]) return i;
  }
  return -1;
}

function addItem(itemId, qty = 1) {
  const unit = INVENTORY.weights[itemId] ?? 1;
  // Add items one by one to respect stack & weight limits
  let added = 0;
  for (let n = 0; n < qty; n++) {
    const newWeight = getInventoryWeight() + unit;
    if (newWeight > INVENTORY.maxWeight) {
      // cannot add more; show message once
      if (added === 0) {
        const rect = canvas.getBoundingClientRect();
        showFloatingNumber(rect.left + rect.width/2, rect.top + rect.height/2, 'Inventory Full', true);
      }
      break;
    }
    const idx = findStackOrEmptySlot(itemId);
    if (idx === -1) {
      if (added === 0) {
        const rect = canvas.getBoundingClientRect();
        showFloatingNumber(rect.left + rect.width/2, rect.top + rect.height/2, 'No Free Slots', true);
      }
      break;
    }
    if (!INVENTORY.slotsData[idx]) INVENTORY.slotsData[idx] = { id: itemId, qty: 0 };
    INVENTORY.slotsData[idx].qty += 1;
    added++;
  }
  if (added > 0) updateInventoryDisplay();
  return added;
}

let playerStats = {
    level: 1,
    xp: 0,
    xpToNext: 300
};

function getXpRequirement(level) {
    return Math.floor(300 * Math.pow(1.5, level - 1));
}

function updateXpDisplay() {
    playerStats.xpToNext = getXpRequirement(playerStats.level);
    const xpPct = Math.max(0, Math.min(100, Math.round((playerStats.xp / playerStats.xpToNext) * 100)));
    xpFill.style.width = xpPct + '%';
    xpText.textContent = `XP ${playerStats.xp}/${playerStats.xpToNext} (Lv.${playerStats.level})`;
}

function gainXp(amount) {
    playerStats.xp += amount;
    while (playerStats.xp >= playerStats.xpToNext) {
        playerStats.xp -= playerStats.xpToNext;
        playerStats.level++;
        const rect = canvas.getBoundingClientRect();
        showFloatingNumber(rect.left + rect.width/2, rect.top + rect.height/2, `LEVEL UP! ${playerStats.level}`, true);
        playSound('levelup');
    }
    updateXpDisplay();
}

function updateInventoryDisplay() {
  const inventoryGrid = document.getElementById('inventoryGrid');
  if (!inventoryGrid) return;
  inventoryGrid.innerHTML = '';
  // Render slots
  for (let i = 0; i < INVENTORY.slotsData.length; i++) {
    const slotEl = document.createElement('div');
    slotEl.className = 'inventory-slot';
    slotEl.setAttribute('data-idx', String(i));
    const s = INVENTORY.slotsData[i];
  if (s) {
      slotEl.classList.add('has-item');
      const meta = ITEMS[s.id] || { icon: '❓', name: s.id, desc: 'Unknown item' };
      slotEl.innerHTML = `<div class="item-icon" style="font-size:16px;line-height:16px">${meta.icon}</div><div class="stack">${s.qty}</div>`;
      // Rich tooltip on hover
      attachInvTooltip(slotEl, meta, s.qty);
    }
    // Drag & Drop
    slotEl.draggable = true;
    slotEl.addEventListener('dragstart', (e) => startDragFromInv(e, i));
    slotEl.addEventListener('dragend', clearDragGhost);
    slotEl.addEventListener('dragover', (e) => e.preventDefault());
    slotEl.addEventListener('drop', (e) => dropOnInv(e, i));
    // Click to use (e.g., Notebook)
    slotEl.addEventListener('click', () => {
      const it = INVENTORY.slotsData[i];
      if (!it) return;
      const meta = ITEMS[it.id];
      if (meta?.use) {
        meta.use();
      }
      // Bridge server-side items: allow using Firestarter Orb to unlock fireball
      if (it.id === 'Firestarter Orb') {
        Net.sendAction({ type: 'cast', payload: { spell: 'use_item', item: 'Firestarter Orb' } });
      }
    });
    inventoryGrid.appendChild(slotEl);
  }
  // Update stats footer with weight and usage
  const stats = document.querySelector('#inventoryPanel .inventory-stats');
  if (stats) {
    const usedSlots = INVENTORY.slotsData.filter(Boolean).length;
    const wt = getInventoryWeight();
    const totals = aggregateInventory();
    const summary = Object.entries(totals)
      .filter(([id, n]) => n > 0)
      .map(([id, n]) => `${ITEMS[id]?.icon || ''} ${ITEMS[id]?.name || id}: ${n}`)
      .join(' • ');
    stats.innerHTML = `<small>Weight: ${wt}/${INVENTORY.maxWeight} • Slots: ${usedSlots}/${INVENTORY.slots}</small>` + (summary ? `<div class="inv-summary">${summary}</div>` : '');
  }
}

function ensureNotebook() {
  if (!INVENTORY.slotsData.some(s => s && s.id === 'notebook')) {
    addItem('notebook', 1);
  }
}

function formatTooltip(meta, qty) {
  const rarity = meta.rarity ? `\n${meta.rarity.toUpperCase()}` : '';
  return `${meta.name}${rarity}\n${meta.desc}\nQty: ${qty}`;
}

function startDragFromInv(ev, idx) {
  const item = INVENTORY.slotsData[idx];
  dragState = item ? { from: { type: 'inv', idx }, item: { ...item } } : null;
  if (ev.dataTransfer) {
    ev.dataTransfer.setData('text/plain', 'inv');
    ev.dataTransfer.effectAllowed = 'move';
    // Use a small custom drag image so the whole UI doesn't appear to drag
    const meta = item ? (ITEMS[item.id] || { icon: '❓' }) : null;
    if (meta) {
      ensureDragGhost(meta.icon, item.qty);
      if (window._dragGhostEl) {
        ev.dataTransfer.setDragImage(window._dragGhostEl, 10, 10);
      }
    }
  }
}
function dropOnInv(ev, idx) {
  ev.preventDefault();
  ev.stopPropagation();
  if (!dragState) return;
  if (dragState.from.type === 'inv') {
    const src = dragState.from.idx;
    if (src === idx) return;
    const a = INVENTORY.slotsData[src];
    const b = INVENTORY.slotsData[idx];
    if (!a) return;
    if (!b) { INVENTORY.slotsData[idx] = a; INVENTORY.slotsData[src] = null; }
    else if (b.id === a.id && b.qty < INVENTORY.maxStack) {
      const space = INVENTORY.maxStack - b.qty;
      const moved = Math.min(space, a.qty);
      b.qty += moved; a.qty -= moved;
      if (a.qty <= 0) INVENTORY.slotsData[src] = null;
    } else {
      INVENTORY.slotsData[src] = b; INVENTORY.slotsData[idx] = a;
    }
    updateInventoryDisplay();
  }
  dragState = null;
}

// Build totals by item id for accurate counts regardless of stacks
function aggregateInventory() {
  const totals = {};
  for (const s of INVENTORY.slotsData) {
    if (!s) continue;
    totals[s.id] = (totals[s.id] || 0) + s.qty;
  }
  return totals;
}

// ---------- Inventory Tooltip ----------
let _invTooltip;
function ensureInvTooltip() {
  if (_invTooltip) return _invTooltip;
  const el = document.createElement('div');
  el.className = 'inv-tooltip';
  el.style.position = 'fixed';
  el.style.zIndex = '2000';
  el.style.pointerEvents = 'none';
  el.style.padding = '8px 10px';
  el.style.borderRadius = '6px';
  el.style.background = 'rgba(20,20,22,0.96)';
  el.style.border = '1px solid rgba(255,255,255,0.12)';
  el.style.color = '#ddd';
  el.style.font = '12px Segoe UI, Arial';
  el.style.boxShadow = '0 6px 16px rgba(0,0,0,0.35)';
  el.style.display = 'none';
  document.body.appendChild(el);
  _invTooltip = el; return el;
}
function attachInvTooltip(slotEl, meta, qty) {
  const tip = ensureInvTooltip();
  const rarity = meta.rarity ? String(meta.rarity).toLowerCase() : '';
  const color = rarity === 'rare' ? '#4eb3ff' : (rarity === 'uncommon' ? '#6fc36f' : '#ddd');
  const name = meta.name || 'Unknown';
  slotEl.addEventListener('mouseenter', () => {
    tip.innerHTML = `<div style="color:${color};font-weight:600;margin-bottom:4px;">${meta.icon || ''} ${name}</div>`+
      (meta.desc ? `<div style="opacity:0.9;max-width:240px;line-height:1.35;">${escapeHtml(meta.desc)}</div>` : '')+
      `<div style="margin-top:6px;color:#aaa;">Qty: ${qty}</div>`;
    tip.style.display = 'block';
  });
  slotEl.addEventListener('mousemove', (e) => {
    const pad = 14;
    const x = Math.min(window.innerWidth - 260, e.clientX + pad);
    const y = Math.min(window.innerHeight - 80, e.clientY + pad);
    tip.style.left = x + 'px';
    tip.style.top = y + 'px';
  });
  const hide = () => { tip.style.display = 'none'; };
  slotEl.addEventListener('mouseleave', hide);
  slotEl.addEventListener('dragstart', hide);
}

// ---------- Custom drag ghost to avoid dragging whole UI ----------
function ensureDragGhost(icon='❓', qty=1) {
  let el = window._dragGhostEl;
  if (!el) {
    el = document.createElement('div');
    el.style.position = 'fixed';
    el.style.top = '-9999px';
    el.style.left = '-9999px';
    el.style.padding = '4px 6px';
    el.style.borderRadius = '6px';
    el.style.background = 'rgba(32,32,36,0.9)';
    el.style.color = '#fff';
    el.style.font = '13px Segoe UI';
    el.style.border = '1px solid rgba(255,255,255,0.15)';
    el.style.boxShadow = '0 2px 8px rgba(0,0,0,0.35)';
    document.body.appendChild(el);
    window._dragGhostEl = el;
  }
  el.textContent = `${icon} x${qty}`;
}
function clearDragGhost() {
  const el = window._dragGhostEl;
  if (el && el.parentNode) {
    // Keep element for reuse but ensure it's off-screen
    el.style.top = '-9999px';
    el.style.left = '-9999px';
  }
}

// Crafting UI
let craftingPanel;
function ensureCrafting() {
  if (craftingPanel) return;
  craftingPanel = document.createElement('div'); craftingPanel.id = 'craftingPanel'; craftingPanel.className = 'panel hidden';
  craftingPanel.style.right = '24px'; craftingPanel.style.top = '220px';
  craftingPanel.innerHTML = `
    <div class="panel-head" data-drag-handle>Crafting</div>
    <div class="panel-body"><div id="craftList" style="display:grid;grid-template-columns:1fr;gap:6px"></div></div>
    <div class="panel-foot">Recipes drop from enemies</div>
  `;
  document.getElementById('game').appendChild(craftingPanel);
  enhanceDraggable(craftingPanel);
  renderCraftingPanel();
}
function renderCraftingPanel() {
  const list = craftingPanel && craftingPanel.querySelector('#craftList'); if (!list) return; list.innerHTML = '';
  Object.entries(CRAFTING.all).forEach(([key, r]) => {
    const locked = r.locked && !CRAFTING.known.has(key);
    const el = document.createElement('button'); el.className = 'grid-item';
    el.innerHTML = `${r.icon||'🛠️'} ${locked ? 'Unknown Recipe' : r.name}`;
    el.title = locked ? 'Defeat monsters to discover this recipe.' : `Requires: ${Object.entries(r.req).map(([k,v])=>`${v} ${ITEMS[k]?.name||k}`).join(', ')}`;
    el.disabled = !!locked; if (!locked) { el.onclick = () => tryCraft(key); }
    list.appendChild(el);
  });
}
function tryCraft(key) {
  const r = CRAFTING.all[key]; if (!r) return;
  for (const [id, need] of Object.entries(r.req)) if (countItem(id) < need) { toast(`Missing ${need}x ${ITEMS[id]?.name||id}`); return; }
  for (const [id, need] of Object.entries(r.req)) removeItems(id, need);
  addItem(r.out.item || key, r.out.qty || 1);
  updateInventoryDisplay(); toast(`${r.name} crafted!`);
}
function countItem(id) { let n=0; for (const s of INVENTORY.slotsData) if (s?.id===id) n+=s.qty; return n; }
function removeItems(id, qty) { for (let i=0;i<INVENTORY.slotsData.length && qty>0;i++){ const s = INVENTORY.slotsData[i]; if (!s||s.id!==id) continue; const take = Math.min(qty, s.qty); s.qty -= take; qty -= take; if (s.qty<=0) INVENTORY.slotsData[i]=null; } }
function toast(text) { const rect = canvas.getBoundingClientRect(); showFloatingNumber(rect.left + rect.width/2, rect.top + 60, text, true); }

function onMonsterKilled(kind) {
  if (Math.random() < 0.2) { addItem('recipe_fire_staff', 1); toast('Found a Recipe Scroll!'); }
  if (kind === 'slime') { addItem('slime', 1); }
  updateInventoryDisplay(); ensureCrafting();
}

function playSergeantAudio() { const a = new Audio('/media/sergeant'); a.play().catch(()=>{}); }

// Initialize auxiliary panels
ensureCrafting(); ensureJournal(); ensureQuestPanel();

// Chat UI wiring
function setChatTab(tab){
  Chat.activeTab = tab;
  chatTabSystem.classList.toggle('active', tab==='system');
  chatTabGlobal.classList.toggle('active', tab==='global');
  chatViewSystem.classList.toggle('active', tab==='system');
  chatViewGlobal.classList.toggle('active', tab==='global');
}
chatTabSystem && (chatTabSystem.onclick = () => setChatTab('system'));
chatTabGlobal && (chatTabGlobal.onclick = () => setChatTab('global'));

function sendChat(){
  const text = (chatInput?.value || '').trim();
  if (!text) return;
  Net.sendAction({ type:'chat', payload:{ text } });
  chatInput.value = '';
}
chatSendBtn && (chatSendBtn.onclick = sendChat);
chatInput && chatInput.addEventListener('keydown', (e) => { if (e.key==='Enter'){ e.preventDefault(); sendChat(); }});

// Receive player chat via state meta (we'll piggyback on notifications array on server for now if needed)
// Note: actual server chat support added server-side. This client listens for a synthetic state.chat array if provided.
// IMPORTANT: Properly decorate the existing Net.onState; the previous version accidentally overwrote it with a HOF.
{
  const originalOnState = Net.onState || (() => {});
  Net.onState = (state) => {
    // invoke original onState logic first
    try { originalOnState(state); } catch (e) { console.error(e); }
    // Handle chat broadcast if present
    if (Array.isArray(state.chat)) {
      for (const m of state.chat) {
        if (!m || !m.text) continue;
        Chat.addPlayer(m.name || 'Player', m.text);
      }
    }
  };
}

// Mining Minigame Implementation
const Mining = {
  // simple per-type skill tracking
  skills: {
    stone: { level: 1, xp: 0 },
  },
  ctx: null,
  running: false,
  type: 'stone',
  rounds: 3,
  round: 0,
  successes: 0,
  tries: 3,
  targetRadius: 70,
  ringRadius: 110,
  startTs: 0,
  duration: 1400, // ms to shrink
  hitTolerance: 6,
};

function getMiningSkill(t) {
  if (!Mining.skills[t]) Mining.skills[t] = { level: 1, xp: 0 };
  return Mining.skills[t];
}

function calcTriesForType(t) {
  const s = getMiningSkill(t);
  // Base tries + bonus per 5 levels
  return 3 + Math.floor((s.level || 1) / 5);
}

function openMiningMinigame(type = 'stone') {
  Mining.type = type;
  currentMinigame = 'stone';
  Mining.rounds = 3;
  Mining.round = 0;
  Mining.successes = 0;
  Mining.tries = calcTriesForType(type);
  Mining.ringRadius = 110;
  // Base values; will be adjusted per-round in startMiningRound
  Mining.targetRadius = 70; // base hit window
  Mining.duration = 1400 - Math.min(600, (getMiningSkill(type).level - 1) * 20); // faster with level
  Mining.hitTolerance = 6; // base tolerance, will tighten per round
  miningTypeEl && (miningTypeEl.textContent = type === 'stone' ? 'Rock' : type);
  miningRoundsEl && (miningRoundsEl.textContent = String(Mining.rounds));
  miningRoundEl && (miningRoundEl.textContent = '0');
  miningSuccessEl && (miningSuccessEl.textContent = '0');
  miningTriesEl && (miningTriesEl.textContent = String(Mining.tries));
  miningLevelEl && (miningLevelEl.textContent = String(getMiningSkill(type).level));
  minigameOverlay && minigameOverlay.classList.remove('hidden');
}

function closeMiningMinigame() {
  Mining.running = false;
  // Also stop wood game if active
  if (typeof WoodGame !== 'undefined') {
    WoodGame.running = false;
  }
  minigameOverlay && minigameOverlay.classList.add('hidden');
}

minigameClose && minigameClose.addEventListener('click', closeMiningMinigame);
// Start button routes to the active minigame
minigameStartBtn && minigameStartBtn.addEventListener('click', () => {
  if (currentMinigame === 'wood') startWoodRound();
  else startMiningRound();
});

function startMiningRound() {
  if (Mining.running) return;
  if (!minigameCanvas) return;
  Mining.round++;
  if (miningRoundEl) miningRoundEl.textContent = String(Mining.round);
  if (Mining.round > Mining.rounds) {
    finalizeMining();
    return;
  }
  // Increase difficulty each round: smaller target, faster shrink, tighter tolerance
  const roundFactor = 1 + (Mining.round - 1) * 0.18; // 1.00, 1.18, 1.36
  Mining.targetRadius = Math.max(40, Math.floor(70 / roundFactor));
  Mining.duration = Math.max(600, Math.floor(Mining.duration / roundFactor));
  Mining.hitTolerance = Math.max(3, Math.floor(6 / roundFactor));
  const ctx = minigameCanvas.getContext('2d');
  Mining.ctx = ctx;
  Mining.running = true;
  Mining.startTs = performance.now();
  Mining.ringRadius = 120; // start bigger than target
  drawMiningFrame();
}

function drawMiningFrame() {
  if (!Mining.running || !Mining.ctx) return;
  const ctx = Mining.ctx;
  const t = Math.min(1, (performance.now() - Mining.startTs) / Mining.duration);
  const W = minigameCanvas.width, H = minigameCanvas.height;
  const cx = W/2, cy = H/2;
  // shrink ring
  const currentR = 120 - (120 - 40) * t;
  // clear
  ctx.clearRect(0,0,W,H);
  // draw target window
  ctx.beginPath();
  ctx.arc(cx, cy, Mining.targetRadius, 0, Math.PI*2);
  ctx.strokeStyle = '#6fc36f';
  ctx.lineWidth = 6;
  ctx.setLineDash([6,6]);
  ctx.stroke();
  ctx.setLineDash([]);
  // draw current ring
  ctx.beginPath();
  ctx.arc(cx, cy, currentR, 0, Math.PI*2);
  ctx.strokeStyle = '#ffd24d';
  ctx.lineWidth = 8;
  ctx.stroke();
  // text
  ctx.fillStyle = '#ddd';
  ctx.font = '16px Segoe UI, Arial';
  ctx.textAlign = 'center';
  ctx.fillText('Click when yellow ring meets green circle', cx, cy + 130);

  Mining.ringRadius = currentR;
  if (t >= 1) {
    // time up auto-miss
    handleMiningClick(true);
  } else {
    requestAnimationFrame(drawMiningFrame);
  }
}

minigameCanvas && minigameCanvas.addEventListener('click', () => handleMiningClick(false));
// Prevent context menu so right-click can be used in wood minigame
minigameCanvas && minigameCanvas.addEventListener('contextmenu', (e) => e.preventDefault());

function handleMiningClick(timeoutMiss) {
  if (!Mining.running) return;
  const hit = Math.abs(Mining.ringRadius - Mining.targetRadius) <= (Mining.hitTolerance || 6); // tolerance
  const s = getMiningSkill(Mining.type);
  if (!timeoutMiss) {
    // small XP for attempt
    s.xp += hit ? 5 : 1;
  }
  if (hit) {
    Mining.successes++;
    miningSuccessEl && (miningSuccessEl.textContent = String(Mining.successes));
    const b = minigameCanvas.getBoundingClientRect();
    showFloatingNumber(b.left + 150, b.top + 60, 'Great!', false);
    // Diminish ore durability by requesting a gather (server will reduce rock HP if adjacent)
    Net.sendAction({ type: 'gather' });
  } else {
    Mining.tries--;
    miningTriesEl && (miningTriesEl.textContent = String(Math.max(0, Mining.tries)));
    const b = minigameCanvas.getBoundingClientRect();
    showFloatingNumber(b.left + 150, b.top + 60, 'Miss', false);
  }
  Mining.running = false;

  // Level up mining every 25xp
  while (s.xp >= 25) {
    s.xp -= 25;
    s.level = (s.level || 1) + 1;
    miningLevelEl && (miningLevelEl.textContent = String(s.level));
    playSound('levelup');
  }

  if (Mining.successes >= Mining.rounds || Mining.tries <= 0) {
    finalizeMining();
  } else {
    // next round after a short delay
    setTimeout(startMiningRound, 450);
  }
}

function finalizeMining() {
  // Determine rewards: base stone, chance for better material if perfect
  const perfect = Mining.successes >= Mining.rounds;
  const s = getMiningSkill(Mining.type);
  const rect = canvas.getBoundingClientRect();
  if (perfect) {
    playSound('perfect');
    const lvlBonus = Math.min(0.3, (s.level - 1) * 0.01); // up to +30%
    const oreChance = 0.4 + lvlBonus; // higher chance on perfect
    if (Math.random() < oreChance) {
      const oreCount = Math.random() < 0.25 ? 2 : 1;
      const added = addItem('ore', oreCount);
      if (added > 0) showFloatingNumber(rect.left + rect.width/2, rect.top + rect.height/2, `+${added} Ore`, true);
    } else {
      const added = addItem('stone', 3);
      if (added > 0) showFloatingNumber(rect.left + rect.width/2, rect.top + rect.height/2, `+${added} Stone`, false);
    }
    const b = minigameCanvas.getBoundingClientRect();
    showFloatingNumber(b.left + b.width/2, b.top + 40, 'PERFECT!', true);
  } else {
    const amount = 1 + Math.floor(Mining.successes / 2);
    const added = addItem('stone', amount);
    if (added > 0) showFloatingNumber(rect.left + rect.width/2, rect.top + rect.height/2, `+${added} Stone`, false);
  }
  // Ensure at least one durability reduction if any success happened
  if (Mining.successes > 0) {
    Net.sendAction({ type: 'gather' });
  }
  closeMiningMinigame();
}

// --- Woodcutting Minigame ---
const WoodGame = {
  ctx: null,
  running: false,
  rounds: 3,
  round: 0,
  successes: 0,
  tries: 3,
  direction: 'left', // 'left' | 'right'
  startTs: 0,
  duration: 1300,
  hitStart: 0.82,
  hitEnd: 0.97,
};

function calcWoodTries() {
  const s = getMiningSkill('stone'); // reuse mining skill for now
  return 3 + Math.floor((s.level || 1) / 6);
}

function openWoodMinigame() {
  currentMinigame = 'wood';
  WoodGame.rounds = 3;
  WoodGame.round = 0;
  WoodGame.successes = 0;
  WoodGame.tries = calcWoodTries();
  WoodGame.duration = 1300;
  WoodGame.hitStart = 0.82;
  WoodGame.hitEnd = 0.97;
  miningTypeEl && (miningTypeEl.textContent = 'Wood');
  miningRoundsEl && (miningRoundsEl.textContent = String(WoodGame.rounds));
  miningRoundEl && (miningRoundEl.textContent = '0');
  miningSuccessEl && (miningSuccessEl.textContent = '0');
  miningTriesEl && (miningTriesEl.textContent = String(WoodGame.tries));
  miningLevelEl && (miningLevelEl.textContent = String(getMiningSkill('stone').level));
  minigameOverlay && minigameOverlay.classList.remove('hidden');
}

function startWoodRound() {
  if (WoodGame.running) return;
  if (!minigameCanvas) return;
  WoodGame.round++;
  if (miningRoundEl) miningRoundEl.textContent = String(WoodGame.round);
  if (WoodGame.round > WoodGame.rounds) {
    finalizeWood();
    return;
  }
  WoodGame.direction = Math.random() < 0.5 ? 'left' : 'right';
  const roundFactor = 1 + (WoodGame.round - 1) * 0.15;
  WoodGame.duration = Math.max(700, Math.floor(1300 / roundFactor));
  WoodGame.hitStart = Math.max(0.75, 0.82 - (WoodGame.round - 1) * 0.02);
  WoodGame.hitEnd = Math.min(0.985, 0.97 + (WoodGame.round - 1) * 0.004);
  WoodGame.ctx = minigameCanvas.getContext('2d');
  WoodGame.running = true;
  WoodGame.startTs = performance.now();
  drawWoodFrame();
}

function drawAvatarInMini(ctx, x, y, scale = 1) {
  const me = ren.players[Net.playerId] || {};
  const cls = me.class;
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(scale, scale);
  if (cls === 'mage') {
    ctx.fillStyle = '#b82e2e';
    ctx.fillRect(-8, -22, 16, 24);
    ctx.fillStyle = '#f1d7c5';
    ctx.beginPath(); ctx.arc(0, -28, 6, 0, Math.PI*2); ctx.fill();
    ctx.strokeStyle = '#6b4b2a'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(7, -22); ctx.lineTo(7, 2); ctx.stroke();
    ctx.fillStyle = '#ffcc66'; ctx.beginPath(); ctx.arc(7, -26, 3, 0, Math.PI*2); ctx.fill();
  } else {
    ctx.fillStyle = '#4b8df8';
    ctx.fillRect(-8, -22, 16, 24);
    ctx.fillStyle = '#f1d7c5';
    ctx.beginPath(); ctx.arc(0, -28, 6, 0, Math.PI*2); ctx.fill();
  }
  ctx.restore();
}

function drawWoodFrame() {
  if (!WoodGame.running || !WoodGame.ctx) return;
  const ctx = WoodGame.ctx;
  const t = Math.min(1, (performance.now() - WoodGame.startTs) / WoodGame.duration);
  const W = minigameCanvas.width, H = minigameCanvas.height;
  ctx.clearRect(0,0,W,H);
  ctx.fillStyle = '#0b0b0b';
  ctx.fillRect(0,0,W,H);
  ctx.fillStyle = '#ddd';
  ctx.font = '16px Segoe UI';
  ctx.textAlign = 'center';
  ctx.fillText('Press A/D or Click Left/Right when the stick is fully out', W/2, H - 18);

  const trunkX = W/2, trunkY = H/2 + 30;
  ctx.fillStyle = '#6b4f2a';
  ctx.fillRect(trunkX - 20, trunkY - 80, 40, 160);

  drawAvatarInMini(ctx, trunkX - 70, trunkY + 10, 1.3);

  const maxLen = 70;
  const len = Math.floor(maxLen * t);
  const isLeft = WoodGame.direction === 'left';
  const sx = isLeft ? trunkX - 20 : trunkX + 20;
  const sy = trunkY - 40;
  ctx.strokeStyle = '#caa271';
  ctx.lineWidth = 8;
  ctx.beginPath();
  if (isLeft) { ctx.moveTo(sx, sy); ctx.lineTo(sx - len, sy); }
  else { ctx.moveTo(sx, sy); ctx.lineTo(sx + len, sy); }
  ctx.stroke();

  const startPx = maxLen * WoodGame.hitStart;
  const endPx = maxLen * WoodGame.hitEnd;
  ctx.strokeStyle = 'rgba(111,195,111,0.9)';
  ctx.lineWidth = 10;
  ctx.beginPath();
  if (isLeft) { ctx.moveTo(sx - startPx, sy); ctx.lineTo(sx - endPx, sy); }
  else { ctx.moveTo(sx + startPx, sy); ctx.lineTo(sx + endPx, sy); }
  ctx.stroke();

  ctx.fillStyle = '#ffd24d';
  const px = isLeft ? (sx - len) : (sx + len);
  ctx.beginPath(); ctx.arc(px, sy, 6, 0, Math.PI*2); ctx.fill();

  if (t >= 1) {
    handleWoodInput(null, true);
  } else {
    requestAnimationFrame(drawWoodFrame);
  }
}

function handleWoodInput(dir, timeoutMiss = false) {
  if (!WoodGame.running) return;
  const maxLen = 70;
  const t = Math.min(1, (performance.now() - WoodGame.startTs) / WoodGame.duration);
  const len = maxLen * t;
  const inWindow = len >= maxLen * WoodGame.hitStart && len <= maxLen * WoodGame.hitEnd;
  const correctDir = dir === WoodGame.direction;
  if (!timeoutMiss && inWindow && correctDir) {
    WoodGame.successes++;
    miningSuccessEl && (miningSuccessEl.textContent = String(WoodGame.successes));
    const b = minigameCanvas.getBoundingClientRect();
    showFloatingNumber(b.left + b.width/2, b.top + 60, 'Cut!', false);
    playSound('wood');
    Net.sendAction({ type: 'gather' });
  } else if (timeoutMiss || dir) {
    WoodGame.tries--;
    miningTriesEl && (miningTriesEl.textContent = String(Math.max(0, WoodGame.tries)));
    const b = minigameCanvas.getBoundingClientRect();
    showFloatingNumber(b.left + b.width/2, b.top + 60, 'Miss', false);
  }
  WoodGame.running = false;
  if (WoodGame.successes >= WoodGame.rounds || WoodGame.tries <= 0) {
    finalizeWood();
  } else {
    setTimeout(startWoodRound, 450);
  }
}

function finalizeWood() {
  const rect = canvas.getBoundingClientRect();
  const perfect = WoodGame.successes >= WoodGame.rounds;
  let amount = 1 + Math.floor(WoodGame.successes / 2);
  if (perfect) {
    amount = Math.max(amount, 3);
    playSound('perfect');
    const b = minigameCanvas.getBoundingClientRect();
    showFloatingNumber(b.left + b.width/2, b.top + 40, 'PERFECT!', true);
  }
  const added = addItem('wood', amount);
  if (added > 0) showFloatingNumber(rect.left + rect.width/2, rect.top + rect.height/2, `+${added} Wood`, false);
  if (WoodGame.successes > 0) Net.sendAction({ type: 'gather' });
  closeMiningMinigame();
}

// Mouse inputs for wood: left/right click
minigameCanvas && minigameCanvas.addEventListener('mousedown', (e) => {
  if (currentMinigame !== 'wood' || !WoodGame.running) return;
  if (e.button === 0) handleWoodInput('left');
  if (e.button === 2) handleWoodInput('right');
});

// Keyboard inputs for wood: A/D
document.addEventListener('keydown', (e) => {
  if (!minigameOverlay || minigameOverlay.classList.contains('hidden')) return;
  if (currentMinigame !== 'wood' || !WoodGame.running) return;
  const k = e.key.toLowerCase();
  if (k === 'a') { e.preventDefault(); handleWoodInput('left'); }
  if (k === 'd') { e.preventDefault(); handleWoodInput('right'); }
});

// Initialize some sample data for the new panels
function initializePanelData() {
    // Inventory is now handled by updateInventoryDisplay()
    
    // Sample equipment slots
    const equipmentGrid = document.querySelector('#equipmentPanel .equipment-grid');
    if (equipmentGrid) {
        const slots = ['Helmet', 'Chest', 'Legs', 'Boots', 'Weapon', 'Shield', 'Ring', 'Amulet'];
        slots.forEach(slotName => {
            const slot = document.createElement('div');
            slot.className = 'equipment-slot';
            slot.innerHTML = `<div class="slot-label">${slotName}</div>`;
            equipmentGrid.appendChild(slot);
        });
    }

    // Sample skill tree
    const skillsContent = document.querySelector('#skillTreePanel .skills-content');
    if (skillsContent) {
        const categories = ['Combat', 'Magic', 'Survival'];
        categories.forEach(category => {
            const catDiv = document.createElement('div');
            catDiv.className = 'skill-category';
            catDiv.innerHTML = `<h4>${category}</h4>`;
            
            for (let i = 1; i <= 5; i++) {
                const skill = document.createElement('div');
                skill.className = 'skill-node';
                skill.innerHTML = `${category} Skill ${i}<div class="skill-level">0/5</div>`;
                catDiv.appendChild(skill);
            }
            skillsContent.appendChild(catDiv);
        });
    }

    // Sample achievements
    const achievementsList = document.querySelector('#achievementPanel .achievements-list');
    if (achievementsList) {
        const achievements = [
            { name: 'First Steps', desc: 'Move for the first time', unlocked: true },
            { name: 'Explorer', desc: 'Visit 10 different areas', unlocked: false },
            { name: 'Monster Slayer', desc: 'Defeat 100 monsters', unlocked: false },
            { name: 'Class Master', desc: 'Choose a character class', unlocked: true }
        ];
        
        achievements.forEach(ach => {
            const achDiv = document.createElement('div');
            achDiv.className = `achievement ${ach.unlocked ? 'unlocked' : 'locked'}`;
            achDiv.innerHTML = `
                <div class="achievement-name">${ach.name}</div>
                <div class="achievement-desc">${ach.desc}</div>
            `;
            achievementsList.appendChild(achDiv);
        });
    }
}

// Initialize panel data when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initializePanelData);
} else {
    initializePanelData();
}
