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
    this.damageNumbers = []; // [{x, y, numbers: [{damage, ttl, id, serverTick}]}]
    this.damageNumberHistory = new Set(); // Track IDs of damage numbers we've already shown
    this.lastServerDamageState = null; // Track last server state hash
    this.currentServerTick = 0; // Track server ticks to prevent duplicates
    
    // Code-based explosion animations (60 FPS, Tibia-style)
    this.explosionAnimations = []; // [{x, y, frame, maxFrames, startTime, type}]
    this.animationFrameId = null;
  }
  update(state, myId, serverTick = 0) {
    this.world = state.world;
    this.players = state.players;
    this.monsters = {};
    if (state.monsters) {
      for (const m of state.monsters) {
        this.monsters[m.id] = m;
      }
    }
    this.myId = myId;
    this.currentServerTick = serverTick;
    
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
    
    // Better damage number management - prevent old numbers from reappearing
    if (state.damageNumbers && Array.isArray(state.damageNumbers)) {
      const serverStateHash = JSON.stringify(state.damageNumbers);
      
      // If server state changed, process the new damage numbers
      if (serverStateHash !== this.lastServerDamageState) {
        this.lastServerDamageState = serverStateHash;
        
        // Process new damage numbers from server
        for (const serverGroup of state.damageNumbers) {
          // Clear any existing damage numbers at this position to prevent old numbers from mixing with new
          this.damageNumbers = this.damageNumbers.filter(g => !(g.x === serverGroup.x && g.y === serverGroup.y));
          
          // Create new damage group for this position
          const dmgGroup = { x: serverGroup.x, y: serverGroup.y, numbers: [] };
          
          for (const serverNumber of serverGroup.numbers) {
            // Create unique ID for each damage number based on position, damage, TTL, and server tick
            const numberId = `${serverGroup.x},${serverGroup.y},${serverNumber.damage},${serverNumber.ttl},${this.currentServerTick}`;
            
            // Always add new server damage numbers (they're authoritative)
            this.damageNumberHistory.add(numberId);
            
            // Add the damage number with unique ID and server tick
            dmgGroup.numbers.push({
              damage: serverNumber.damage,
              ttl: serverNumber.ttl,
              id: numberId,
              serverTick: this.currentServerTick
            });
          }
          
          if (dmgGroup.numbers.length > 0) {
            this.damageNumbers.push(dmgGroup);
          }
        }
      }
    } else if (state.damageNumbers === undefined || (Array.isArray(state.damageNumbers) && state.damageNumbers.length === 0)) {
      // Server cleared damage numbers - but keep client-side ones until they expire naturally
      this.lastServerDamageState = null;
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

    // draw grid
    for (let y=0;y<this.world.h;y++) {
      for (let x=0;x<this.world.w;x++) {
        const sx = x*this.tile - this.camera.x;
        const sy = y*this.tile - this.camera.y;
        c.strokeStyle = '#222';
        c.strokeRect(sx, sy, this.tile, this.tile);
      }
    }

    // draw players
    for (const [pid, p] of Object.entries(this.players)) {
      const sx = p.x*this.tile - this.camera.x;
      const sy = p.y*this.tile - this.camera.y;
      c.fillStyle = String(pid) === String(this.myId) ? '#4b8df8' : '#9ade00';
      c.fillRect(sx+4, sy+4, this.tile-8, this.tile-8);
      // class tag
      if (p.class) {
        c.fillStyle = '#fff';
        c.font = '10px Segoe UI';
        c.fillText(p.class[0].toUpperCase(), sx + this.tile-10, sy + 10);
      }
    }

    // draw monsters
    if (this.monsters) {
      for (const m of Object.values(this.monsters)) {
        const sx = m.x*this.tile - this.camera.x;
        const sy = m.y*this.tile - this.camera.y;
        
        // Monster body - different colors based on aggro state
        c.fillStyle = m.aggro ? '#d35c5c' : '#7bd36d';
        c.fillRect(sx+6, sy+6, this.tile-12, this.tile-12);
        
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

    // draw pending spells (warning indicators - these are about to hit!)
    for (const spell of this.pendingSpells) {
      // Draw the spell area with orange/warning coloring and pulsing effect
      const now = Date.now();
      const pulse = 0.2 + 0.15 * (0.5 + 0.5 * Math.sin(now / 150)); // Faster pulse for urgency
      
      for (let dx = -spell.radius; dx <= spell.radius; dx++) {
        for (let dy = -spell.radius; dy <= spell.radius; dy++) {
          if (Math.abs(dx) + Math.abs(dy) <= spell.radius) {
            const ex = spell.x + dx;
            const ey = spell.y + dy;
            const sx = ex * this.tile - this.camera.x;
            const sy = ey * this.tile - this.camera.y;
            
            // Orange warning color with pulsing alpha
            c.fillStyle = `rgba(255,165,0,${pulse})`;
            c.fillRect(sx+3, sy+3, this.tile-6, this.tile-6);
            c.strokeStyle = `rgba(255,140,0,${pulse + 0.3})`;
            c.strokeRect(sx+2, sy+2, this.tile-4, this.tile-4);
          }
        }
      }
      
      // Draw countdown text at spell center
      const sx = spell.x * this.tile - this.camera.x;
      const sy = spell.y * this.tile - this.camera.y;
      c.save();
      c.fillStyle = '#ffaa00';
      c.font = 'bold 10px Segoe UI';
      c.textAlign = 'center';
      c.strokeStyle = '#000';
      c.lineWidth = 1;
      c.strokeText(`${spell.ticksRemaining}`, sx + this.tile/2, sy + this.tile/2 + 3);
      c.fillText(`${spell.ticksRemaining}`, sx + this.tile/2, sy + this.tile/2 + 3);
      c.restore();
    }

    // draw targeting preview
    if (this.targetPreview && this.targetPreview.cells) {
      // If locked for the remainder of the tick, always show solid green
      const now = Date.now();
      let baseColor;
      if (typeof this.targetPreview.lockTick === 'number') {
        baseColor = 'rgba(60,220,120,0.45)';
      } else if (this.targetPreview.confirmUntil && now < this.targetPreview.confirmUntil) {
        baseColor = 'rgba(60,220,120,0.45)'; // confirm flash green
      } else {
        // Pulse alpha for attention when prompting to cast
        const pulse = 0.18 + 0.10 * (0.5 + 0.5 * Math.sin(now / 180));
        baseColor = this.targetPreview.inRange
          ? `rgba(255,220,80,${pulse})`
          : `rgba(255,80,80,${pulse})`;
      }
      c.fillStyle = baseColor;
      for (const cell of this.targetPreview.cells) {
        const sx = cell.x*this.tile - this.camera.x;
        const sy = cell.y*this.tile - this.camera.y;
        c.fillRect(sx+2, sy+2, this.tile-4, this.tile-4);
      }
    }
  }

  updateDamageNumbers() {
    // Client-side TTL management for smooth 60 FPS animations
    for (let i = this.damageNumbers.length - 1; i >= 0; i--) {
      const dmgGroup = this.damageNumbers[i];
      
      // Update TTL for each number in the group
      for (let j = dmgGroup.numbers.length - 1; j >= 0; j--) {
        const num = dmgGroup.numbers[j];
        num.ttl--;
        
        // Remove expired numbers and their history
        if (num.ttl <= 0) {
          if (num.id) {
            this.damageNumberHistory.delete(num.id);
          }
          dmgGroup.numbers.splice(j, 1);
        }
      }
      
      // Remove empty groups
      if (dmgGroup.numbers.length === 0) {
        this.damageNumbers.splice(i, 1);
      }
    }
    
    // Clean up old history entries aggressively to prevent memory issues and reappearing numbers
    if (this.currentServerTick > 0 && this.damageNumberHistory.size > 50) {
      // Clear history of damage numbers older than 10 server ticks
      const currentTick = this.currentServerTick;
      const toDelete = [];
      
      this.damageNumberHistory.forEach(id => {
        const parts = id.split(',');
        if (parts.length >= 5) {
          const tickFromId = parseInt(parts[4]);
          if (!isNaN(tickFromId) && (currentTick - tickFromId) > 10) {
            toDelete.push(id);
          }
        }
      });
      
      toDelete.forEach(id => this.damageNumberHistory.delete(id));
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
      
      const sx = anim.x * this.tile - this.camera.x;
      const sy = anim.y * this.tile - this.camera.y;
      
      // Tibia-style fire explosion: single rectangle with animated colors and effects
      const progress = anim.frame / anim.maxFrames; // 0 to 1
      
      // Create animated fire effect using code instead of image
      this.drawTibiaStyleExplosion(c, sx, sy, this.tile, progress);
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
}
