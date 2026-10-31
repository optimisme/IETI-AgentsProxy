(() => {
  const COLS = 10, ROWS = 20, CELL = 30;
  const boardCv = document.getElementById('board');
  const bctx = boardCv.getContext('2d');
  const nextCv = document.getElementById('next');
  const nctx = nextCv.getContext('2d');
  const overlay = document.getElementById('overlay');
  const scoreEl = document.getElementById('score');
  const linesEl = document.getElementById('lines');
  const levelEl = document.getElementById('level');

  const COLORS = {
    I: '#4fd1c5', O: '#f6e05e', T: '#b794f4', S: '#68d391',
    Z: '#fc8181', J: '#63b3ed', L: '#f6ad55'
  };

  const SHAPES = {
    I: [[0,0,0,0],[1,1,1,1],[0,0,0,0],[0,0,0,0]],
    O: [[1,1],[1,1]],
    T: [[0,1,0],[1,1,1],[0,0,0]],
    S: [[0,1,1],[1,1,0],[0,0,0]],
    Z: [[1,1,0],[0,1,1],[0,0,0]],
    J: [[1,0,0],[1,1,1],[0,0,0]],
    L: [[0,0,1],[1,1,1],[0,0,0]]
  };

  let board, piece, nextPiece, score, lines, level, paused, gameOver;
  let dropTimer, dropInterval, animatingRows, animFrame;

  function newPiece() {
    const types = Object.keys(SHAPES);
    const type = types[Math.floor(Math.random() * types.length)];
    const shape = SHAPES[type].map(r => r.slice());
    return {
      shape: shape,
      color: COLORS[type],
      x: Math.floor((COLS - shape[0].length) / 2),
      y: 0
    };
  }

  function reset() {
    board = Array.from({ length: ROWS }, () => Array(COLS).fill(null));
    piece = newPiece();
    nextPiece = newPiece();
    score = 0; lines = 0; level = 1;
    paused = false; gameOver = false;
    dropInterval = Math.max(120, 800 - (level - 1) * 70);
    updateHud();
    overlay.style.display = 'none';
    cancelAnimationFrame(animFrame);
    animatingRows = null;
    dropTimer = performance.now();
    requestAnimationFrame(loop);
  }

  function updateHud() {
    scoreEl.textContent = score;
    linesEl.textContent = lines;
    levelEl.textContent = level;
  }

  function collides(shape, px, py) {
    for (let y = 0; y < shape.length; y++) {
      for (let x = 0; x < shape[y].length; x++) {
        if (!shape[y][x]) continue;
        const nx = px + x, ny = py + y;
        if (nx < 0 || nx >= COLS || ny >= ROWS) return true;
        if (ny >= 0 && board[ny][nx]) return true;
      }
    }
    return false;
  }

  function merge() {
    piece.shape.forEach((row, y) => row.forEach((v, x) => {
      if (v && piece.y + y >= 0) board[piece.y + y][piece.x + x] = piece.color;
    }));
  }

  function rotate(shape) {
    const n = shape.length;
    const out = Array.from({ length: n }, () => Array(n).fill(0));
    for (let y = 0; y < n; y++)
      for (let x = 0; x < n; x++)
        out[x][n - 1 - y] = shape[y][x];
    return out;
  }

  function fullRows() {
    const rows = [];
    for (let y = 0; y < ROWS; y++)
      if (board[y].every(c => c)) rows.push(y);
    return rows;
  }

  function lockPiece() {
    merge();
    const rows = fullRows();
    if (rows.length) {
      // blink twice (on/off/on/off) before removing the rows
      animatingRows = { rows, step: 0, until: performance.now() + 180 };
    } else {
      spawnNext();
    }
  }

  function spawnNext() {
    piece = nextPiece;
    nextPiece = newPiece();
    if (collides(piece.shape, piece.x, piece.y)) {
      gameOver = true;
      overlay.innerHTML = 'GAME OVER<br><span style="font-size:12px">press R to restart</span>';
      overlay.style.display = 'block';
    }
    drawNext();
  }

  function drop() {
    if (collides(piece.shape, piece.x, piece.y + 1)) {
      lockPiece();
    } else {
      piece.y++;
    }
  }

  function hardDrop() {
    while (!collides(piece.shape, piece.x, piece.y + 1)) piece.y++;
    lockPiece();
  }

  function drawCell(ctx, x, y, size, color) {
    ctx.fillStyle = color;
    ctx.fillRect(x * size, y * size, size - 1, size - 1);
    ctx.fillStyle = 'rgba(255,255,255,.25)';
    ctx.fillRect(x * size, y * size, size - 1, 3);
  }

  function drawBoard(flashRows, flashOn) {
    bctx.clearRect(0, 0, boardCv.width, boardCv.height);
    for (let y = 0; y < ROWS; y++) {
      for (let x = 0; x < COLS; x++) {
        const c = board[y][x];
        if (c) {
          const flashing = flashRows && flashRows.includes(y) && flashOn;
          drawCell(bctx, x, y, CELL, flashing ? '#ffffff' : c);
        }
      }
    }
    if (piece && !gameOver) {
      piece.shape.forEach((row, y) => row.forEach((v, x) => {
        if (v && piece.y + y >= 0) drawCell(bctx, piece.x + x, piece.y + y, CELL, piece.color);
      }));
    }
  }

  function drawNext() {
    nctx.clearRect(0, 0, nextCv.width, nextCv.height);
    const s = nextPiece.shape;
    const size = 24;
    const w = s[0].length * size, h = s.length * size;
    const ox = (nextCv.width - w) / 2 / size, oy = (nextCv.height - h) / 2 / size;
    s.forEach((row, y) => row.forEach((v, x) => {
      if (v) drawCell(nctx, ox + x, oy + y, size, nextPiece.color);
    }));
  }

  let last = performance.now();
  function loop(now) {
    if (gameOver) return;
    animFrame = requestAnimationFrame(loop);
    if (paused) return;

    // line-clear blink animation: 4 blink steps then remove rows
    if (animatingRows) {
      if (now >= animatingRows.until) {
        animatingRows.step++;
        animatingRows.until = now + 180;
        if (animatingRows.step >= 4) {
          animatingRows.rows.sort((a, b) => a - b).forEach(y => {
            board.splice(y, 1);
            board.unshift(Array(COLS).fill(null));
          });
          const n = animatingRows.rows.length;
          lines += n;
          score += [0, 100, 300, 500, 800][n] * level;
          const newLevel = Math.floor(lines / 10) + 1;
          if (newLevel !== level) {
            level = newLevel;
            dropInterval = Math.max(120, 800 - (level - 1) * 70);
          }
          updateHud();
          animatingRows = null;
          spawnNext();
        }
      }
      const on = animatingRows && animatingRows.step % 2 === 0;
      drawBoard(animatingRows && animatingRows.rows, on);
      return;
    }

    if (now - dropTimer > dropInterval) {
      drop();
      dropTimer = now;
    }
    drawBoard(null, false);
  }

  document.addEventListener('keydown', e => {
    if (e.key === 'r' || e.key === 'R') { reset(); return; }
    if (gameOver || paused && e.key !== 'p' && e.key !== 'P') return;
    if (animatingRows) return;

    switch (e.key) {
      case 'ArrowLeft':
        if (!collides(piece.shape, piece.x - 1, piece.y)) piece.x--;
        break;
      case 'ArrowRight':
        if (!collides(piece.shape, piece.x + 1, piece.y)) piece.x++;
        break;
      case 'ArrowDown':
        drop();
        dropTimer = performance.now();
        break;
      case 'ArrowUp': {
        const r = rotate(piece.shape);
        if (!collides(r, piece.x, piece.y)) piece.shape = r;
        else if (!collides(r, piece.x - 1, piece.y)) { piece.x--; piece.shape = r; }
        else if (!collides(r, piece.x + 1, piece.y)) { piece.x++; piece.shape = r; }
        break;
      }
      case ' ':
        hardDrop();
        break;
      case 'p': case 'P':
        paused = !paused;
        overlay.style.display = paused ? 'block' : 'none';
        break;
    }
    drawBoard(null, false);
  });

  reset();
})();
