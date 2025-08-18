export class Renderer {
  constructor(canvas) {
    this.ctx = canvas.getContext('2d');
    this.canvas = canvas;
    this.tile = 24;
    this.camera = { x: 0, y: 0 };
    this.world = { w: 20, h: 20 };
    this.players = {};
    this.myId = null;
    this.effects = [];
    this.pendingSpells = []; // Spells that are about to resolve (for dodge mechanics)
    this.targetPreview = null; // {cells: [{x,y}], type: 'fireball'}
    this.damageNumbers = []; // [{x, y, numbers: [{damage, ttl, clientStartTTL}]}]
    // Dedupe damage numbers so they only appear when damage happens (not every server snapshot)
    // Map key: "x,y,damage" -> expiresAt (performance.now() timestamp)
    this.seenDamageNumbers = new Map();
    
    // Code-based explosion animations (60 FPS, Tibia-style)
    this.explosionAnimations = []; // [{x, y, frame, maxFrames, startTime, type}]
    this.animationFrameId = null;
    this.tiles = [];
    this.resources = [];
  this.npcs = [];
  this.projectiles = [];
  // Interpolated projectile store: id -> {id, x, y, prevX, prevY, dx, dy, lastUpdate}
  this._projectileStore = new Map();
  this._lastStateAt = performance.now();
  this._tickMs = 250; // expected server tick length (ms)
    
    // Settings
    this.showGrid = false;
  // Visual scale for spell tiles (0-1). Adjusts the on-screen size of fireball and previews.
  this.spellGfxScale = 0.7;
  }
  update(state, myId, serverTick = 0) {
  // record when this snapshot arrived for interpolation
  this._lastStateAt = performance.now();
    this.world = state.world;
  this.tiles = state.tiles || [];
  this.resources = state.resources || [];
  this.npcs = state.npcs || [];
    this.players = state.players;
    this.monsters = {};
    if (state.monsters) {
      for (const m of state.monsters) {
        this.monsters[m.id] = m;
      }
    }
  // Projectiles from server with interpolation support
  const incoming = state.projectiles || [];
  const seen = new Set();
  for (const pr of incoming) {
    seen.add(pr.id);
    const existing = this._projectileStore.get(pr.id);
    if (existing) {
      // shift current to prev for smooth lerp to new position
      existing.prevX = existing.x;
      existing.prevY = existing.y;
      existing.x = pr.x;
      existing.y = pr.y;
      existing.dx = pr.dx;
      existing.dy = pr.dy;
      existing.lastUpdate = this._lastStateAt;
    } else {
      // first sighting: start a bit behind along -dir so it appears to emerge from the caster side
      const bdx = pr.dx || 0;
      const bdy = pr.dy || 0;
      const back = 0.45; // fraction of a tile behind
      this._projectileStore.set(pr.id, {
        id: pr.id,
        x: pr.x,
        y: pr.y,
        prevX: pr.x - bdx * back,
        prevY: pr.y - bdy * back,
        dx: bdx,
        dy: bdy,
        lastUpdate: this._lastStateAt,
      });
    }
  }
  // prune projectiles that disappeared from server, and spawn a small impact flash at last known position
  const removed = [];
  for (const id of Array.from(this._projectileStore.keys())) {
    if (!seen.has(id)) {
      const pr = this._projectileStore.get(id);
      if (pr) removed.push(pr);
      this._projectileStore.delete(id);
    }
  }
  // Add an impact animation where projectiles vanished (client-side flair)
  for (const pr of removed) {
    this.explosionAnimations.push({
      x: Math.round(pr.x),
      y: Math.round(pr.y),
      frame: 0,
      maxFrames: 14, // short
      startTime: performance.now(),
      type: 'impact',
      active: true
    });
  }
  // flatten for drawing
  this.projectiles = Array.from(this._projectileStore.values());
    this.myId = myId;
    
    // Check for new fire effects and trigger explosion animations
    const newEffects = state.effects || [];
    for (const effect of newEffects) {
      const effectKey = `${effect.x},${effect.y}`;
      // Check if this is a new effect (not already animated)
      const existingAnim = this.explosionAnimations.find(anim => 
        anim.x === effect.x && anim.y === effect.y && anim.active
      );
      
      if (!existingAnim) {
        // Start a new explosion animation
        this.explosionAnimations.push({
          x: effect.x,
          y: effect.y,
          frame: 0,
          maxFrames: 30, // 30 frames for smooth 60 FPS animation (0.5 seconds)
          startTime: performance.now(),
          type: 'fire',
          active: true
        });
      }
    }
    
    this.effects = newEffects;
    this.pendingSpells = state.pendingSpells || [];
    
    // Handle damage numbers - only show once at impact, ignore repeated server snapshots
    if (state.damageNumbers && Array.isArray(state.damageNumbers)) {
      // Server creates new damage numbers with ttl ~60 and decrements once per server tick.
      // Treat entries as "new" only when ttl is near the initial value to avoid repeats.
      const NEW_TTL_THRESHOLD = 59; // server default is 60 in add_damage_number
      for (const serverGroup of state.damageNumbers) {
        for (const serverNumber of serverGroup.numbers) {
          if (serverNumber.ttl >= NEW_TTL_THRESHOLD) {
            // Freshly created this server tick -> show it once on the client
            // (No need to track keys across time; later snapshots will have lower TTL and be ignored.)

            // Find or create damage group for this position
            let dmgGroup = this.damageNumbers.find(g => g.x === serverGroup.x && g.y === serverGroup.y);
            if (!dmgGroup) {
              dmgGroup = { x: serverGroup.x, y: serverGroup.y, numbers: [] };
              this.damageNumbers.push(dmgGroup);
            }

            // Use the server-provided ttl if present, but clamp to a sensible animation length
            const clientTTL = Math.min(60, serverNumber.ttl || 60); // ~1s at 60 FPS
            dmgGroup.numbers.push({
              damage: serverNumber.damage,
              ttl: clientTTL,
              clientStartTTL: clientTTL
            });
          }
        }
      }
    }
    
    const me = this.players[myId];
    if (me) {
      this.camera.x = me.x * this.tile - this.canvas.width / 2 + this.tile / 2;
      this.camera.y = me.y * this.tile - this.canvas.height / 2 + this.tile / 2;
    }
  }
  draw() {
    const c = this.ctx;
    c.fillStyle = '#0b0b0b';
    c.fillRect(0,0,this.canvas.width,this.canvas.height);

    // Update damage numbers on every frame (60fps) - client-side TTL management
    this.updateDamageNumbers();
    
    // Update explosion animations (60 FPS)
    this.updateExplosionAnimations();

    // draw terrain (tiles and grid)
    for (let y=0;y<this.world.h;y++) {
      for (let x=0;x<this.world.w;x++) {
        const sx = x*this.tile - this.camera.x;
        const sy = y*this.tile - this.camera.y;
        const ch = (this.tiles[y] && this.tiles[y][x]) || 'G';
        if (ch === 'W') {
          // water tile
          c.fillStyle = '#1e3a5f';
          c.fillRect(sx, sy, this.tile, this.tile);
          // subtle waves
          c.fillStyle = 'rgba(255,255,255,0.04)';
          c.fillRect(sx+2, sy+2, this.tile-4, this.tile-4);
        } else if (ch === 'C') {
          // cave entrance/doorway
          c.fillStyle = '#1f4820';
          c.fillRect(sx, sy, this.tile, this.tile);
          c.fillStyle = '#7d6a4a';
          c.fillRect(sx+4, sy+4, this.tile-8, this.tile-8);
          c.fillStyle = '#111';
          c.fillRect(sx+6, sy+6, this.tile-12, this.tile-12);
        } else if (ch === 'M') {
          // mine entrance/doorway - darker, more rocky appearance
          c.fillStyle = '#2a2a2a';
          c.fillRect(sx, sy, this.tile, this.tile);
          c.fillStyle = '#444';
          c.fillRect(sx+3, sy+3, this.tile-6, this.tile-6);
          c.fillStyle = '#000';
          c.fillRect(sx+6, sy+6, this.tile-12, this.tile-12);
          // Add some rocky texture
          c.fillStyle = '#666';
          c.fillRect(sx+2, sy+2, 3, 3);
          c.fillRect(sx+this.tile-5, sy+3, 2, 2);
          c.fillRect(sx+4, sy+this.tile-5, 2, 3);
        } else {
          // grass tile (default for any unknown tiles including legacy 'R')
          c.fillStyle = '#173018';
          c.fillRect(sx, sy, this.tile, this.tile);
          c.fillStyle = '#1f4820';
          c.fillRect(sx+1, sy+1, this.tile-2, this.tile-2);
        }
        
        // Draw grid lines if enabled
        if (this.showGrid) {
          c.strokeStyle = 'rgba(255,255,255,0.1)';
          c.lineWidth = 1;
          c.strokeRect(sx, sy, this.tile, this.tile);
        }
      }
    }

    // draw resources (trees, rocks)
    for (const r of this.resources) {
      const sx = r.x*this.tile - this.camera.x;
      const sy = r.y*this.tile - this.camera.y;
      if (r.type === 'tree') {
        this.drawTree(c, sx, sy, this.tile, r);
      } else if (r.type === 'rock') {
        this.drawRock(c, sx, sy, this.tile, r);
      }
    }

    // draw NPCs (simple sprites with nameplates)
    for (const n of this.npcs) {
      const sx = n.x*this.tile - this.camera.x;
      const sy = n.y*this.tile - this.camera.y;
      // Body
      this.drawNpc(this.ctx, sx, sy, this.tile, n);
      // Nameplate
      const name = n.name || 'NPC';
      this.ctx.fillStyle = '#ffd24d';
      this.ctx.font = '10px Segoe UI';
      this.ctx.textAlign = 'center';
      this.ctx.fillText(name, sx + this.tile/2, sy - 10);
      this.ctx.textAlign = 'start';
    }
    // draw players
    for (const [pid, p] of Object.entries(this.players)) {
      const sx = p.x*this.tile - this.camera.x;
      const sy = p.y*this.tile - this.camera.y;
      const isMe = String(pid) === String(this.myId);
      // Simple body: blue for me, green for others
      c.fillStyle = isMe ? '#4b8df8' : '#9ade00';
      c.fillRect(sx+4, sy+4, this.tile-8, this.tile-8);
      // No class badge
    }

    // draw monsters
    if (this.monsters) {
      for (const m of Object.values(this.monsters)) {
        const sx = m.x*this.tile - this.camera.x;
        const sy = m.y*this.tile - this.camera.y;

        // Monster body
        if (m.type === 'slime' || (m.name && m.name.toLowerCase() === 'slime')) {
          this.drawSlime(c, sx, sy, this.tile, m);
        } else if (m.type === 'bat' || (m.name && m.name.toLowerCase() === 'bat')) {
          this.drawBat(c, sx, sy, this.tile, m);
        } else {
          c.fillStyle = m.aggro ? '#d35c5c' : '#7bd36d';
          c.fillRect(sx+6, sy+6, this.tile-12, this.tile-12);
        }

        // Health bar above monster
        if (m.hpMax > 0) {
          const barWidth = this.tile - 4;
          const barHeight = 3;
          const barX = sx + 2;
          const barY = sy - 6;

          // Background (red)
          c.fillStyle = '#8b1a1a';
          c.fillRect(barX, barY, barWidth, barHeight);

          // Foreground (health)
          const pct = Math.max(0, Math.min(1, m.hp / m.hpMax));
          c.fillStyle = pct > 0.5 ? '#2faa24' : (pct > 0.2 ? '#aa8224' : '#aa2424');
          c.fillRect(barX, barY, barWidth * pct, barHeight);

          // Border
          c.strokeStyle = '#333';
          c.lineWidth = 1;
          c.strokeRect(barX, barY, barWidth, barHeight);
        }

        // Monster name
        if (m.name) {
          c.fillStyle = '#fff';
          c.font = '9px Segoe UI';
          c.textAlign = 'center';
          c.fillText(m.name, sx + this.tile/2, sy - 10);
          c.textAlign = 'start';
        }
      }
    }

    // draw NPCs (simple sprites with nameplates)
    for (const n of this.npcs) {
      const sx = n.x*this.tile - this.camera.x;
      const sy = n.y*this.tile - this.camera.y;
      // Body
      this.drawNpc(this.ctx, sx, sy, this.tile, n);
      // Nameplate
      const name = n.name || 'NPC';
      this.ctx.fillStyle = '#ffd24d';
      this.ctx.font = '10px Segoe UI';
      this.ctx.textAlign = 'center';
      this.ctx.fillText(name, sx + this.tile/2, sy - 10);
      this.ctx.textAlign = 'start';
    }

    // draw projectiles (simple glowing fire bolts) with interpolation
    const now = performance.now();
    const phase = Math.max(0, Math.min(1, (now - this._lastStateAt) / this._tickMs));
    for (const pr of this.projectiles) {
      const ix = pr.prevX + (pr.x - pr.prevX) * phase;
      const iy = pr.prevY + (pr.y - pr.prevY) * phase;
      const sx = ix * this.tile - this.camera.x + this.tile/2;
      const sy = iy * this.tile - this.camera.y + this.tile/2;
      const r = Math.max(4, Math.floor(this.tile * 0.26));
      c.save();
      // Additive blending for vivid glow
      const prevComp = c.globalCompositeOperation;
      c.globalCompositeOperation = 'lighter';
      // Outer soft glow
      const grad = c.createRadialGradient(sx, sy, 1, sx, sy, r * 1.6);
      grad.addColorStop(0, 'rgba(255,200,80,0.9)');
      grad.addColorStop(0.6, 'rgba(255,110,0,0.55)');
      grad.addColorStop(1, 'rgba(180,40,0,0.15)');
      c.fillStyle = grad;
      c.beginPath(); c.arc(sx, sy, r * 1.6, 0, Math.PI * 2); c.fill();
      // Core
      c.fillStyle = '#ffd27a';
      c.beginPath(); c.arc(sx, sy, Math.max(3, r * 0.55), 0, Math.PI * 2); c.fill();
      // Multi-segment tail for motion emphasis
      const segs = 5;
      const step = Math.max(6, Math.floor(this.tile * 0.28));
      for (let i = 1; i <= segs; i++) {
        const fade = (segs - i + 1) / (segs + 1);
        const tx = sx - (pr.dx || 0) * step * i;
        const ty = sy - (pr.dy || 0) * step * i;
        const tr = Math.max(2, Math.floor(r * 0.45 * fade));
        c.fillStyle = `rgba(255,140,20,${0.28 * fade})`;
        c.beginPath(); c.arc(tx, ty, tr, 0, Math.PI * 2); c.fill();
      }
      // Restore compositing
      c.globalCompositeOperation = prevComp;
      c.restore();
    }

    // draw floating damage numbers (Ragnarok-style: fade out as they rise)
    for (const dmgGroup of this.damageNumbers) {
      const sx = dmgGroup.x * this.tile - this.camera.x;
      const sy = dmgGroup.y * this.tile - this.camera.y;
      
      let offset = 0;
      for (const num of dmgGroup.numbers) {
        const progress = 1 - (num.ttl / 60); // 0 to 1 as time progresses
        
        // Smooth fade out (like Ragnarok): starts at full alpha, then fades quickly in the last 30% of lifetime
        let alpha;
        if (progress < 0.7) {
          alpha = 1.0; // Full visibility for first 70% of lifetime
        } else {
          // Fade out smoothly in the last 30%
          const fadeProgress = (progress - 0.7) / 0.3;
          alpha = 1.0 - (fadeProgress * fadeProgress); // Quadratic fade for smoothness
        }
        alpha = Math.max(0, Math.min(1, alpha));
        
        // Float upward with slight deceleration (like Ragnarok)
        const baseSpeed = 0.8;
        const deceleration = progress * 0.3; // Slow down over time
        const yOffset = (60 - num.ttl) * (baseSpeed - deceleration);
        
        // Scale gets slightly larger initially, then smaller as it fades (Ragnarok effect)
        let scale = 1.0;
        if (progress < 0.2) {
          scale = 1.0 + (progress * 0.5); // Grow slightly in first 20%
        } else if (progress > 0.7) {
          const shrinkProgress = (progress - 0.7) / 0.3;
          scale = 1.1 - (shrinkProgress * 0.3); // Shrink in last 30%
        } else {
          scale = 1.1; // Stay at max size in middle
        }
        
        c.save();
        c.globalAlpha = alpha;
        c.fillStyle = '#ff4444';
        c.font = `bold ${Math.round(12 * scale)}px Segoe UI`;
        c.textAlign = 'center';
        c.strokeStyle = '#000';
        c.lineWidth = 2;
        const textY = sy - yOffset + offset;
        c.strokeText(`-${num.damage}`, sx + this.tile/2, textY);
        c.fillText(`-${num.damage}`, sx + this.tile/2, textY);
        c.restore();
        
        offset -= 14; // Stack multiple numbers vertically
      }
    }

  // draw code-based explosion animations (Tibia-style, 60 FPS)
  this.drawExplosionAnimations();
  // No pending spell tile indicators
  }

  drawNpc(ctx, x, y, size, npc) {
    const pad = 4;
    const w = size - pad * 2;
    const h = size - pad * 2;
    const cx = x + size / 2;
    const baseY = y + size - pad;
    ctx.save();
    // Cloak color per type
    const coat = npc.type === 'quest_giver' ? '#3a3a7a' : '#555';
    ctx.fillStyle = coat;
    ctx.fillRect(cx - w*0.35, y + pad + 6, w*0.7, h - 8);
    // Head
    ctx.beginPath();
    ctx.arc(cx, y + pad + 6, w*0.18, 0, Math.PI*2);
    ctx.fillStyle = '#f1d7c5';
    ctx.fill();
    // Accent
    ctx.strokeStyle = '#ffd24d';
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(cx - w*0.25, baseY - 8); ctx.lineTo(cx + w*0.25, baseY - 8); ctx.stroke();
    ctx.restore();
  }

  updateDamageNumbers() {
    // Client-side TTL management for smooth 60 FPS animations
    for (let i = this.damageNumbers.length - 1; i >= 0; i--) {
      const dmgGroup = this.damageNumbers[i];
      
      // Update TTL for each number in the group
      for (let j = dmgGroup.numbers.length - 1; j >= 0; j--) {
        const num = dmgGroup.numbers[j];
        num.ttl--;
        
        // Remove expired numbers and clean up tracking
        if (num.ttl <= 0) {
          dmgGroup.numbers.splice(j, 1);
        }
      }
      
      // Remove empty groups
      if (dmgGroup.numbers.length === 0) {
        this.damageNumbers.splice(i, 1);
      }
    }
  }
  
  updateExplosionAnimations() {
    const currentTime = performance.now();
    
    // Update all explosion animations at 60 FPS
    for (let i = this.explosionAnimations.length - 1; i >= 0; i--) {
      const anim = this.explosionAnimations[i];
      
      if (!anim.active) continue;
      
      const elapsed = currentTime - anim.startTime;
      const animationDuration = 500; // 0.5 seconds total
      const frameTime = animationDuration / anim.maxFrames; // Time per frame
      
      anim.frame = Math.floor(elapsed / frameTime);
      
      // Remove completed animations
      if (anim.frame >= anim.maxFrames || elapsed >= animationDuration) {
        anim.active = false;
        this.explosionAnimations.splice(i, 1);
      }
    }
  }
  
  drawExplosionAnimations() {
    const c = this.ctx;
    
    for (const anim of this.explosionAnimations) {
      if (!anim.active) continue;
      
  // Center the smaller explosion within the tile using the same scale
  const scale = this.spellGfxScale;
  const scaled = Math.floor(this.tile * scale);
  const offset = Math.floor((this.tile - scaled) / 2);
  const sx = anim.x * this.tile - this.camera.x + offset;
  const sy = anim.y * this.tile - this.camera.y + offset;
      
      // Tibia-style fire explosion (AoE) vs. tiny projectile impact
      const progress = anim.frame / anim.maxFrames; // 0 to 1
      if (anim.type === 'impact') {
        this.drawImpactFlash(c, sx + Math.floor(scaled/2) - 6, sy + Math.floor(scaled/2) - 6, 12, progress);
      } else {
        // Create animated fire effect using code instead of image, scaled down
        this.drawTibiaStyleExplosion(c, sx, sy, scaled, progress);
      }
    }
  }
  
  drawTibiaStyleExplosion(ctx, x, y, size, progress) {
    // Tibia-style explosion: bright flashing colors, single rectangle area
    const centerX = x + size / 2;
    const centerY = y + size / 2;
    
    // Phase 1: Initial bright flash (0-0.2)
    // Phase 2: Fire colors (0.2-0.8)  
    // Phase 3: Fade out (0.8-1.0)
    
    if (progress < 0.2) {
      // Initial white/yellow flash
      const flashIntensity = 1 - (progress / 0.2);
      const alpha = 0.9 * flashIntensity;
      
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(x, y, size, size);
      
      // Bright yellow center
      ctx.fillStyle = '#ffff00';
      ctx.fillRect(x + 2, y + 2, size - 4, size - 4);
      ctx.restore();
      
    } else if (progress < 0.8) {
      // Fire phase with animated colors
      const fireProgress = (progress - 0.2) / 0.6; // 0 to 1 within fire phase
      
      // Oscillating fire colors (like Tibia)
      const oscillation = Math.sin(progress * 30) * 0.3 + 0.7; // Fast oscillation
      
      // Base fire colors
      const red = Math.floor(255 * oscillation);
      const green = Math.floor(100 * oscillation);
      const orange = Math.floor(200 * oscillation);
      
      ctx.save();
      ctx.globalAlpha = 0.8 - (fireProgress * 0.3);
      
      // Outer fire (darker red/orange)
      ctx.fillStyle = `rgb(${red}, ${green}, 0)`;
      ctx.fillRect(x, y, size, size);
      
      // Inner fire (brighter orange/yellow)
      ctx.fillStyle = `rgb(${Math.min(255, red + 50)}, ${orange}, 50)`;
      ctx.fillRect(x + 2, y + 2, size - 4, size - 4);
      
      // Hot center (yellow/white flicker)
      if (oscillation > 0.8) {
        ctx.fillStyle = `rgb(255, 255, ${Math.floor(150 * oscillation)})`;
        ctx.fillRect(x + 4, y + 4, size - 8, size - 8);
      }
      
      ctx.restore();
      
    } else {
      // Fade out phase
      const fadeProgress = (progress - 0.8) / 0.2; // 0 to 1 within fade phase
      const alpha = 0.5 * (1 - fadeProgress);
      
      ctx.save();
      ctx.globalAlpha = alpha;
      
      // Dim red glow
      ctx.fillStyle = '#cc3300';
      ctx.fillRect(x + 1, y + 1, size - 2, size - 2);
      
      // Small hot center
      ctx.fillStyle = '#ff6600';
      ctx.fillRect(x + 4, y + 4, size - 8, size - 8);
      
      ctx.restore();
    }
  }

  drawImpactFlash(ctx, x, y, size, progress) {
    // Small radial flash for projectile hit (quick fade)
    const cx = x + size / 2;
    const cy = y + size / 2;
    const r = size * (0.5 + 0.5 * (1 - progress));
    const alpha = 0.9 * (1 - progress);
    ctx.save();
    ctx.globalAlpha = Math.max(0, alpha);
    // Additive glow
    const prev = ctx.globalCompositeOperation;
    ctx.globalCompositeOperation = 'lighter';
    const g = ctx.createRadialGradient(cx, cy, 1, cx, cy, r);
    g.addColorStop(0, 'rgba(255,230,160,1)');
    g.addColorStop(0.5, 'rgba(255,160,60,0.7)');
    g.addColorStop(1, 'rgba(150,40,0,0.1)');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill();
    ctx.globalCompositeOperation = prev;
    ctx.restore();
  }

  // --- Slime rendering ---
  drawSlime(ctx, x, y, size, m) {
    const t = performance.now() / 1000;
    const wobble = Math.sin(t * 6 + (m.id || 0)) * 0.06; // gentle wobble
    const squish = 1 - Math.abs(wobble) * 0.2;

    // Body bounds inside tile
    const pad = 3;
    const w = size - pad * 2;
    const h = size - pad * 2;
    const cx = x + size / 2;
    const cy = y + size / 2 + 2; // slightly lower for cute look

    ctx.save();
    ctx.translate(cx, cy);
    ctx.scale(1 + wobble, squish);

    // Base blob shape
    const rw = w / 2; // radius width
    const rh = h / 2; // radius height

    // Gradient fill (green -> teal); red tint if aggro
    const g = ctx.createRadialGradient(0, -rh * 0.2, rw * 0.2, 0, 0, rw);
    if (m.aggro) {
      g.addColorStop(0, 'rgba(255,120,120,0.95)');
      g.addColorStop(1, 'rgba(200,60,60,0.9)');
    } else {
      g.addColorStop(0, 'rgba(130, 255, 180, 0.95)');
      g.addColorStop(1, 'rgba(60, 190, 140, 0.9)');
    }

    ctx.beginPath();
    this.roundedBlobPath(ctx, 0, 0, rw, rh);
    ctx.fillStyle = g;
    ctx.fill();

    // Border
    ctx.lineWidth = 2;
    ctx.strokeStyle = m.aggro ? '#7a2222' : '#1b5e3e';
    ctx.stroke();

    // Slimy shine
    ctx.save();
    ctx.globalAlpha = 0.35;
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.ellipse(-rw * 0.25, -rh * 0.35, rw * 0.35, rh * 0.18, -0.3, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    // Eyes
    const eyeY = -rh * 0.1;
    this.drawEye(ctx, -rw * 0.25, eyeY, rw * 0.12);
    this.drawEye(ctx,  rw * 0.25, eyeY, rw * 0.12);

    // Mouth (small smile or flat if aggro)
    ctx.beginPath();
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#0a0a0a';
    if (!m.aggro) {
      ctx.arc(0, rh * 0.18, rw * 0.25, 0.15*Math.PI, 0.85*Math.PI);
    } else {
      ctx.moveTo(-rw * 0.2, rh * 0.2);
      ctx.lineTo(rw * 0.2, rh * 0.2);
    }
    ctx.stroke();

    ctx.restore();
  }

  // --- Bat rendering ---
  drawBat(ctx, x, y, size, m) {
    const t = performance.now() / 1000;
    const flap = Math.sin(t * 12 + (m.id || 0)) * 0.5 + 0.5; // 0..1
    const pad = 3;
    const w = size - pad * 2;
    const h = size - pad * 2;
    const cx = x + size / 2;
    const cy = y + size / 2;
    ctx.save();
    // Body
    ctx.fillStyle = '#3a3a3a';
    ctx.beginPath();
    ctx.ellipse(cx, cy, w*0.22, h*0.18, 0, 0, Math.PI*2);
    ctx.fill();
    // Head
    ctx.beginPath();
    ctx.ellipse(cx, cy - h*0.18, w*0.16, h*0.14, 0, 0, Math.PI*2);
    ctx.fillStyle = '#2b2b2b';
    ctx.fill();
    // Ears
    ctx.fillStyle = '#444';
    ctx.beginPath(); ctx.moveTo(cx - w*0.1, cy - h*0.28); ctx.lineTo(cx - w*0.04, cy - h*0.18); ctx.lineTo(cx - w*0.16, cy - h*0.18); ctx.closePath(); ctx.fill();
    ctx.beginPath(); ctx.moveTo(cx + w*0.1, cy - h*0.28); ctx.lineTo(cx + w*0.04, cy - h*0.18); ctx.lineTo(cx + w*0.16, cy - h*0.18); ctx.closePath(); ctx.fill();
    // Eyes
    ctx.fillStyle = m.aggro ? '#ff5555' : '#dddddd';
    ctx.beginPath(); ctx.arc(cx - w*0.05, cy - h*0.2, 2, 0, Math.PI*2); ctx.fill();
    ctx.beginPath(); ctx.arc(cx + w*0.05, cy - h*0.2, 2, 0, Math.PI*2); ctx.fill();
    // Wings
    const wingSpan = w * 0.46 + flap * 6;
    ctx.strokeStyle = '#454545';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.quadraticCurveTo(cx - wingSpan * 0.6, cy - 6 - flap*3, cx - wingSpan, cy + 4);
    ctx.moveTo(cx, cy);
    ctx.quadraticCurveTo(cx + wingSpan * 0.6, cy - 6 - flap*3, cx + wingSpan, cy + 4);
    ctx.stroke();
    ctx.restore();
  }

  roundedBlobPath(ctx, cx, cy, rw, rh) {
    // Slightly bumpy blob outline
    const k = 0.552284749831; // circle approximation factor
    ctx.moveTo(cx, cy - rh);
    ctx.bezierCurveTo(
      cx + k*rw*0.6, cy - rh,
      cx + rw, cy - k*rh*0.6,
      cx + rw, cy
    );
    ctx.bezierCurveTo(
      cx + rw, cy + k*rh,
      cx + k*rw*0.6, cy + rh,
      cx, cy + rh
    );
    ctx.bezierCurveTo(
      cx - k*rw, cy + rh,
      cx - rw, cy + k*rh,
      cx - rw, cy
    );
    ctx.bezierCurveTo(
      cx - rw, cy - k*rh*0.6,
      cx - k*rw*0.6, cy - rh,
      cx, cy - rh
    );
    ctx.closePath();
  }

  drawEye(ctx, ex, ey, r) {
    ctx.save();
    // White
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.ellipse(ex, ey, r, r*1.05, 0, 0, Math.PI*2);
    ctx.fill();
    // Pupil tracks wobble slightly
    const t = performance.now() / 1000;
    const px = ex + Math.sin(t*2 + ex*3) * r*0.25;
    const py = ey + Math.cos(t*2 + ex*2) * r*0.18;
    ctx.fillStyle = '#0a0a0a';
    ctx.beginPath();
    ctx.arc(px, py, r*0.45, 0, Math.PI*2);
    ctx.fill();
    // Tiny highlight
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(px - r*0.15, py - r*0.15, r*0.12, 0, Math.PI*2);
    ctx.fill();
    ctx.restore();
  }

  // --- Mage rendering ---
  drawMage(ctx, x, y, size, isMe) {
    const pad = 3;
    const w = size - pad * 2;
    const h = size - pad * 2;
    const cx = x + size / 2;
    const baseY = y + size - pad; // ground contact

    // Optional self highlight ring
    if (isMe) {
      ctx.save();
      ctx.strokeStyle = 'rgba(75,141,248,0.9)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.ellipse(cx, baseY - 3, w*0.35, h*0.15, 0, 0, Math.PI*2);
      ctx.stroke();
      ctx.restore();
    }

    // Idle bob
    const t = performance.now() / 1000;
    const bob = Math.sin(t * 4 + cx) * 1.2;

    ctx.save();
    ctx.translate(0, bob);

    // Robe (red)
    const robeTopY = y + pad + 5;
    const robeBottomY = baseY - 4;
    ctx.beginPath();
    ctx.moveTo(cx - w*0.22, robeTopY);
    ctx.lineTo(cx + w*0.22, robeTopY);
    ctx.lineTo(cx + w*0.32, robeBottomY);
    ctx.lineTo(cx - w*0.32, robeBottomY);
    ctx.closePath();
    const rg = ctx.createLinearGradient(cx, robeTopY, cx, robeBottomY);
    rg.addColorStop(0, '#cc2b2b');
    rg.addColorStop(1, '#7d1414');
    ctx.fillStyle = rg;
    ctx.fill();
    ctx.strokeStyle = '#3a0d0d';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // Collar/belt
    ctx.fillStyle = '#f4d94a';
    ctx.fillRect(cx - w*0.18, robeTopY + 2, w*0.36, 2);
    ctx.fillRect(cx - w*0.16, (robeTopY + robeBottomY)/2, w*0.32, 2);

    // Head
    const headR = w * 0.16;
    const headCx = cx;
    const headCy = robeTopY - headR + 2;
    ctx.beginPath();
    ctx.arc(headCx, headCy, headR, 0, Math.PI*2);
    ctx.fillStyle = '#f1d7c5';
    ctx.fill();
    ctx.strokeStyle = '#634e45';
    ctx.lineWidth = 1;
    ctx.stroke();

    // Simple hood trim
    ctx.beginPath();
    ctx.moveTo(cx - w*0.22, robeTopY);
    ctx.quadraticCurveTo(cx, robeTopY - 6, cx + w*0.22, robeTopY);
    ctx.strokeStyle = '#5e0f0f';
    ctx.lineWidth = 1.2;
    ctx.stroke();

    // Eyes
    ctx.fillStyle = '#222';
    ctx.beginPath();
    ctx.arc(headCx - headR*0.45, headCy, headR*0.18, 0, Math.PI*2);
    ctx.arc(headCx + headR*0.45, headCy, headR*0.18, 0, Math.PI*2);
    ctx.fill();

    // Staff (right side)
    ctx.strokeStyle = '#6b4b2a';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(cx + w*0.28, robeTopY);
    ctx.lineTo(cx + w*0.28, robeBottomY);
    ctx.stroke();
    // Staff head gem
    ctx.fillStyle = '#ffcc66';
    ctx.beginPath();
    ctx.arc(cx + w*0.28, robeTopY - 3, 3, 0, Math.PI*2);
    ctx.fill();
    ctx.strokeStyle = '#a37b3c';
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.restore();
  }

  // --- Resource rendering ---
  drawTree(ctx, x, y, size, r) {
    const trunkW = Math.max(3, Math.floor(size * 0.18));
    const trunkH = Math.max(6, Math.floor(size * 0.32));
    const cx = x + size/2;
    const baseY = y + size - 3;
    // trunk
    ctx.fillStyle = '#6b4f2a';
    ctx.fillRect(cx - trunkW/2, baseY - trunkH, trunkW, trunkH);
    // foliage (two circles)
    const r1 = size*0.35, r2 = size*0.28;
    ctx.fillStyle = '#2f6d2f';
    ctx.beginPath();
    ctx.arc(cx - r2*0.4, baseY - trunkH - r2*0.2, r2, 0, Math.PI*2);
    ctx.arc(cx + r2*0.4, baseY - trunkH - r2*0.4, r1, 0, Math.PI*2);
    ctx.fill();
    // hp pips
    const hp = r.hp ?? 1; const maxPips = 4;
    const pips = Math.min(maxPips, Math.max(0, hp));
    for (let i=0;i<pips;i++) {
      ctx.fillStyle = '#7cff7c';
      ctx.fillRect(x + 3 + i*4, y + 3, 3, 3);
    }
  }

  drawRock(ctx, x, y, size, r) {
    ctx.fillStyle = '#7d7f87';
    ctx.strokeStyle = '#3d3f44';
    const pad = 4;
    ctx.beginPath();
    ctx.moveTo(x+pad, y+size-pad);
    ctx.lineTo(x+size*0.35, y+pad);
    ctx.lineTo(x+size-pad, y+size*0.4);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    // hp pips
    const hp = r.hp ?? 1; const maxPips = 4;
    const pips = Math.min(maxPips, Math.max(0, hp));
    for (let i=0;i<pips;i++) {
      ctx.fillStyle = '#d0d3da';
      ctx.fillRect(x + 3 + i*4, y + 3, 3, 3);
    }
  }
}
