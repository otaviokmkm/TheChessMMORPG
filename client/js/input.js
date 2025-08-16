export class Input {
  constructor() {
    this.pendingAction = null;
    this.classChoiceOpen = false;
    this.currentClass = null;
    this.casting = null; // {spell:'fireball', target:{x,y}, radius, range}
    window.addEventListener('keydown', (e) => {
      const map = { ArrowUp:[0,-1], ArrowDown:[0,1], ArrowLeft:[-1,0], ArrowRight:[1,0], w:[0,-1], s:[0,1], a:[-1,0], d:[1,0] };
      if (map[e.key] && !this.casting) {
        const [dx, dy] = map[e.key];
        this.pendingAction = { type: 'move', payload: { dx, dy } };
      } else if (e.key === ' ') {
        this.pendingAction = { type: 'rest' };
      } else if (e.key === 'g' || e.key === 'G') {
        // Gather resources (trees/rocks) on current/adjacent tile
        this.pendingAction = { type: 'gather' };
      } else if (e.key === 'c' || e.key === 'C') {
        this.classChoiceOpen = true;
      } else if (e.key === '1') {
        // Toggle fireball targeting if mage
        if (this.currentClass === 'mage') {
          if (this.casting && this.casting.spell === 'fireball') {
            this.casting = null;
          } else {
            // Start targeting; target chosen with click
            this.casting = { spell: 'fireball', target: null, radius: 1, range: 4 };
          }
        }
      }
    });
  }
  setClass(clazz) { this.currentClass = clazz; }
  consumeAction() {
    const a = this.pendingAction;
    this.pendingAction = null;
    return a;
  }
}
