export class Input {
  constructor() {
    this.pendingAction = null;
  this.classChoiceOpen = false; // deprecated
  this.currentClass = null; // deprecated
    this.knownSpells = new Set();
    this.casting = null; // {spell:'fireball', mode:'direction'|'target', target?:{x,y}, radius?, range?}
    window.addEventListener('keydown', (e) => {
      const map = { ArrowUp:[0,-1], ArrowDown:[0,1], ArrowLeft:[-1,0], ArrowRight:[1,0], w:[0,-1], s:[0,1], a:[-1,0], d:[1,0] };
      if (map[e.key]) {
        const [dx, dy] = map[e.key];
        // If we're awaiting a direction for fireball, convert this key into a directional cast
        if (this.casting && this.casting.spell === 'fireball') {
          const dir = dy < 0 ? 'up' : dy > 0 ? 'down' : dx < 0 ? 'left' : 'right';
          this.pendingAction = { type: 'cast', payload: { spell: 'fireball', dir } };
          this.casting = null;
        } else if (!this.casting) {
          this.pendingAction = { type: 'move', payload: { dx, dy } };
        }
      } else if (e.key === ' ') {
        this.pendingAction = { type: 'rest' };
      } else if (e.key === 'g' || e.key === 'G') {
        // Gather resources (trees/rocks) on current/adjacent tile
        this.pendingAction = { type: 'gather' };
      } else if (e.key === 'c' || e.key === 'C') {
        // class panel removed
      } else if (e.key === '1') {
        // Punch: enter targeting mode; user must click an adjacent target
        if (this.knownSpells.has('punch')) {
          this.casting = { spell: 'punch', mode: 'adjacent', target: null };
        }
      } else if (e.key === '2') {
        // Fireball: toggle casting mode for directional selection
        if (this.knownSpells.has('fireball')) {
          if (this.casting && this.casting.spell === 'fireball') {
            this.casting = null;
          } else {
            this.casting = { spell: 'fireball', mode: 'direction', target: null, radius: 0, range: 3 };
          }
        }
      }
    });
  }
  setClass(clazz) { this.currentClass = clazz; }
  setKnownSpells(spells) {
    // spells: iterable of ids
    this.knownSpells = new Set(spells || []);
    // Cancel casting if spell no longer known
    if (this.casting && !this.knownSpells.has(this.casting.spell)) {
      this.casting = null;
    }
  }
  consumeAction() {
    const a = this.pendingAction;
    this.pendingAction = null;
    return a;
  }
}
