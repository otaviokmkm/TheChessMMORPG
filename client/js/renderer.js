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
  this.targetPreview = null; // {cells: [{x,y}], type: 'fireball'}
  }
  update(state, myId) {
    this.world = state.world;
    this.players = state.players;
    this.myId = myId;
  this.effects = state.effects || [];
    const me = this.players[myId];
    if (me) {
      this.camera.x = me.x * this.tile - this.canvas.width / 2 + this.tile / 2;
      this.camera.y = me.y * this.tile - this.canvas.height / 2 + this.tile / 2;
    }
    this.draw();
  }
  draw() {
    const c = this.ctx;
    c.fillStyle = '#0b0b0b';
    c.fillRect(0,0,this.canvas.width,this.canvas.height);

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

    // draw effects (fireball aoe)
    for (const e of this.effects) {
      const sx = e.x*this.tile - this.camera.x;
      const sy = e.y*this.tile - this.camera.y;
      c.fillStyle = 'rgba(255,100,40,0.35)';
      c.fillRect(sx+2, sy+2, this.tile-4, this.tile-4);
      c.strokeStyle = 'rgba(255,140,60,0.7)';
      c.strokeRect(sx+1, sy+1, this.tile-2, this.tile-2);
    }

    // draw targeting preview
    if (this.targetPreview && this.targetPreview.cells) {
      c.fillStyle = 'rgba(255,220,80,0.25)';
      for (const cell of this.targetPreview.cells) {
        const sx = cell.x*this.tile - this.camera.x;
        const sy = cell.y*this.tile - this.camera.y;
        c.fillRect(sx+2, sy+2, this.tile-4, this.tile-4);
      }
    }
  }
}
