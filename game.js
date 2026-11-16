"use strict";

(() => {
  const W = 1280;
  const H = 720;
  const GRAVITY = 650;
  const CRATER_RADIUS = 65;
  const MOVE_LIMIT = 90;
  const $ = (id) => document.getElementById(id);
  const canvas = $("game");
  const ctx = canvas.getContext("2d");
  const earthCanvas = document.createElement("canvas");
  earthCanvas.width = W;
  earthCanvas.height = H;
  const earthCtx = earthCanvas.getContext("2d");
  const solidPixels = new Uint8Array(W * H);
  const surface = new Int16Array(W);
  const ui = {
    fire: $("fire"), power: $("power"), powerValue: $("power-value"),
    angleValue: $("angle-value"), steps: $("steps-label"),
    turn: $("turn-label"), wind: $("wind-label"), round: $("round-label"),
    blue: $("team-blue"), red: $("team-orange"),
    blueHp: $("blue-hp"), redHp: $("orange-hp"), message: $("field-message"),
    result: $("result-panel"), resultTitle: $("result-title"), resultSubtitle: $("result-subtitle")
  };
  let units = [];
  let particles = [];
  let projectile = null;
  let active = null;
  let teamTurn = 0;
  let visits = [0, 0];
  let turnNumber = 0;
  let wind = 0;
  let angle = 55;
  let power = 70;
  let movement = MOVE_LIMIT;
  let phase = "aim";
  let resolutionTimer = 0;
  let cameraShake = 0;
  let lastTime = 0;
  let aimDragging = false;
  let gameOverText = "";
  const rand = (a, b) => a + Math.random() * (b - a);
  const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
  const radians = (deg) => deg * Math.PI / 180;
  const terrainSolid = (x, y) => {
    x = Math.floor(x);
    y = Math.floor(y);
    if (y >= H) return true;
    if (x < 0 || x >= W || y < 0) return false;
    return solidPixels[y * W + x] !== 0;
  };

  function makeTerrain() {
    const image = earthCtx.createImageData(W, H);
    const data = image.data;
    const noise = new Float32Array(W);
    for (let x = 0; x < W; x++) {
      const height = 410
        + 38 * Math.sin(x * 0.0066 + 0.8)
        + 22 * Math.sin(x * 0.017 + 1.3)
        + 8 * Math.sin(x * 0.053 + 0.4)
        + 3 * Math.sin(x * 0.13);
      surface[x] = Math.floor(height);
      noise[x] = 4 * Math.sin(x * 0.095);
    }
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const depth = y - surface[x];
        if (depth < 0) continue;
        const i = (y * W + x) * 4;
        const pattern = Math.sin(x * 0.12 + y * 0.18) * 6 +
          Math.sin(x * 0.046 - y * 0.083) * 7 + noise[x];
        if (depth < 6) {
          data[i] = 103 + pattern;
          data[i + 1] = 127 + pattern;
          data[i + 2] = 77 + pattern / 2;
        } else if (depth < 19) {
          data[i] = 92 + pattern;
          data[i + 1] = 98 + pattern;
          data[i + 2] = 66 + pattern / 2;
        } else {
          const vein = Math.sin(y * .045 + x * .008) * 10;
          data[i] = 89 + pattern + vein;
          data[i + 1] = 74 + pattern * .8 + vein * .4;
          data[i + 2] = 61 + pattern * .65;
        }
        data[i + 3] = 255;
        solidPixels[y * W + x] = 1;
      }
    }
    earthCtx.clearRect(0, 0, W, H);
    earthCtx.putImageData(image, 0, 0);
  }

  function carveCrater(cx, cy, r) {
    const left = clamp(Math.floor(cx - r - 1), 0, W - 1);
    const right = clamp(Math.ceil(cx + r + 1), 0, W - 1);
    const top = clamp(Math.floor(cy - r - 1), 0, H - 1);
    const bottom = clamp(Math.ceil(cy + r + 1), 0, H - 1);
    const rr = r * r;
    for (let y = top; y <= bottom; y++) {
      const dy = y - cy;
      for (let x = left; x <= right; x++) {
        const dx = x - cx;
        if (dx * dx + dy * dy <= rr) solidPixels[y * W + x] = 0;
      }
    }
    earthCtx.save();
    earthCtx.lineWidth = 9;
    earthCtx.strokeStyle = "#b5996c";
    earthCtx.beginPath();
    earthCtx.arc(cx, cy, r + 2, 0, Math.PI * 2);
    earthCtx.stroke();
    earthCtx.globalCompositeOperation = "destination-out";
    earthCtx.beginPath();
    earthCtx.arc(cx, cy, r, 0, Math.PI * 2);
    earthCtx.fill();
    earthCtx.restore();
  }

  function soldier(x, team, index) {
    return {
      x, y: surface[Math.floor(x)] - 1, vx: 0, vy: 0,
      team, index, hp: 100, lastFall: 0
    };
  }

  function reset() {
    makeTerrain();
    units = [
      soldier(165, 0, 1), soldier(305, 0, 2), soldier(428, 0, 3),
      soldier(855, 1, 1), soldier(1000, 1, 2), soldier(1130, 1, 3)
    ];
    particles = [];
    projectile = null;
    visits = [0, 0];
    teamTurn = 0;
    turnNumber = 0;
    cameraShake = 0;
    gameOverText = "";
    ui.result.hidden = true;
    nextTurn(0);
  }

  function nextTurn(side) {
    const remaining = units.filter((u) => u.team === side && u.hp > 0);
    if (!remaining.length) {
      showWinner(1 - side);
      return;
    }
    teamTurn = side;
    active = remaining[visits[side] % remaining.length];
    visits[side] += 1;
    turnNumber += 1;
    phase = "aim";
    movement = MOVE_LIMIT;
    angle = side === 0 ? 55 : 125;
    power = 70;
    wind = Math.round(rand(-9, 9));
    projectile = null;
    resolutionTimer = 0;
    ui.message.textContent = side === 0 ? "СИНИЙ ОТРЯД: ПРИЦЕЛЬСЯ И СТРЕЛЯЙ" : "КРАСНЫЙ ОТРЯД: ПРИЦЕЛЬСЯ И СТРЕЛЯЙ";
    updateUI();
  }

  function updateUI() {
    const blue = units.filter((u) => u.team === 0 && u.hp > 0);
    const red = units.filter((u) => u.team === 1 && u.hp > 0);
    const health = (arr) => arr.reduce((s, u) => s + Math.ceil(u.hp), 0);
    ui.blueHp.textContent = blue.length + " бойца · " + health(blue) + " HP";
    ui.redHp.textContent = red.length + " бойца · " + health(red) + " HP";
    ui.turn.textContent = phase === "over" ? "МАТЧ ЗАВЕРШЁН" : "ХОД " + (teamTurn === 0 ? "СИНЕГО" : "КРАСНОГО") + " ОТРЯДА";
    ui.blue.classList.toggle("active", teamTurn === 0 && phase !== "over");
    ui.red.classList.toggle("active", teamTurn === 1 && phase !== "over");
    ui.wind.textContent = "ВЕТЕР " + (wind < 0 ? "← " : wind > 0 ? "→ " : "· ") + Math.abs(wind) + " м/с";
    ui.round.textContent = "ХОД " + String(turnNumber).padStart(2, "0");
    ui.angleValue.textContent = Math.round(angle) + "°";
    ui.powerValue.textContent = power + "%";
    ui.power.value = String(power);
    ui.steps.textContent = Math.max(0, Math.ceil(movement)) + " М";
    const locked = phase !== "aim";
    for (const id of ["move-left", "move-right", "angle-down", "angle-up"]) $(id).disabled = locked;
    ui.power.disabled = locked;
    ui.fire.disabled = locked;
  }

  function setAngle(next) {
    if (phase !== "aim") return;
    angle = clamp(next, 10, 170);
    updateUI();
  }

  function changePower(next) {
    if (phase !== "aim") return;
    power = clamp(Math.round(next), 25, 100);
    updateUI();
  }

  function moveSoldier(dir) {
    if (phase !== "aim" || !active || movement <= 0) return;
    const step = Math.min(11, movement) * dir;
    const nx = clamp(active.x + step, 22, W - 22);
    const actual = Math.abs(nx - active.x);
    if (actual < 1 || terrainSolid(nx, active.y - 25)) return;
    let nearbyGround = null;
    for (let y = Math.floor(active.y - 15); y < Math.floor(active.y + 22); y++) {
      if (terrainSolid(nx, y)) {
        nearbyGround = y - 1;
        break;
      }
    }
    if (nearbyGround !== null && nearbyGround < active.y - 15) return;
    active.x = nx;
    if (nearbyGround !== null && nearbyGround <= active.y + 12 && active.vy === 0) {
      active.y = nearbyGround;
    }
    movement -= actual;
    updateUI();
  }

  function muzzle(u, radiansAngle) {
    return { x: u.x + Math.cos(radiansAngle) * 29, y: u.y - 22 - Math.sin(radiansAngle) * 29 };
  }

  function shotSpeed() {
    return 370 + power * 5.3;
  }

  function fire() {
    if (phase !== "aim" || !active) return;
    phase = "flight";
    const a = radians(angle);
    const start = muzzle(active, a);
    const speed = shotSpeed();
    projectile = { x: start.x, y: start.y, vx: Math.cos(a) * speed, vy: -Math.sin(a) * speed, trail: [], lifetime: 0 };
    ui.message.textContent = "СНАРЯД В ПОЛЁТЕ...";
    spawnParticles(start.x, start.y, 9, "flash");
    updateUI();
  }

  function spawnParticles(x, y, count, kind) {
    for (let i = 0; i < count; i++) {
      const a = rand(0, Math.PI * 2);
      const speed = rand(kind === "flash" ? 40 : 30, kind === "flash" ? 175 : 340);
      particles.push({
        x, y, vx: Math.cos(a) * speed, vy: Math.sin(a) * speed,
        life: rand(kind === "smoke" ? .6 : .25, kind === "smoke" ? 1.6 : 1.1),
        maxLife: 1, size: rand(1.5, kind === "smoke" ? 16 : 6),
        kind, color: kind === "dirt" ? (Math.random() > .5 ? "#8f775a" : "#b79a70") :
          kind === "smoke" ? "#586765" : Math.random() > .5 ? "#ffe2aa" : "#ee9d5f"
      });
    }
    if (particles.length > 600) particles.splice(0, particles.length - 600);
  }

  function explode(x, y) {
    projectile = null;
    carveCrater(x, y, CRATER_RADIUS);
    spawnParticles(x, y, 45, "dirt");
    spawnParticles(x, y, 30, "flash");
    spawnParticles(x, y, 15, "smoke");
    cameraShake = 12;
    let totalDamage = 0;
    for (const u of units) {
      if (u.hp <= 0) continue;
      const dx = u.x - x;
      const dy = u.y - 21 - y;
      const dist = Math.hypot(dx, dy);
      const intensity = clamp(1 - dist / 105, 0, 1);
      if (intensity <= 0) continue;
      const damage = Math.round(86 * intensity);
      u.hp = Math.max(0, u.hp - damage);
      totalDamage += damage;
      const direction = dx === 0 ? (u.team === 0 ? -1 : 1) : Math.sign(dx);
      u.vx += direction * 270 * intensity;
      u.vy -= 275 * intensity;
    }
    ui.message.textContent = totalDamage ? "ПОПАДАНИЕ! УРОН: " + totalDamage + " HP" : "ВОРОНКА ЕСТЬ. ПОПАДАНИЙ НЕТ.";
    phase = "resolving";
    resolutionTimer = 1.5;
    updateUI();
  }

  function finishShot() {
    projectile = null;
    phase = "resolving";
    resolutionTimer = 0.9;
    ui.message.textContent = "СНАРЯД УШЁЛ ЗА ПРЕДЕЛЫ ПОЛИГОНА";
    updateUI();
  }

  function showWinner(side) {
    phase = "over";
    active = null;
    projectile = null;
    ui.result.hidden = false;
    ui.resultTitle.textContent = "ПОБЕДА " + (side === 0 ? "СИНИХ!" : "КРАСНЫХ!");
    ui.resultSubtitle.textContent = "Отряд противника выведен из строя. Сыграем ещё?";
    ui.message.textContent = "БОЙ ОКОНЧЕН";
    updateUI();
  }

  function checkVictory() {
    const alive = [0, 1].map((team) => units.some((u) => u.team === team && u.hp > 0));
    if (alive[0] && alive[1]) return false;
    if (!alive[0] && !alive[1]) {
      phase = "over";
      ui.result.hidden = false;
      ui.resultTitle.textContent = "НИЧЬЯ!";
      ui.resultSubtitle.textContent = "Никто не удержал позицию.";
      updateUI();
    } else {
      showWinner(alive[0] ? 0 : 1);
    }
    return true;
  }

  function stepProjectile(dt) {
    if (!projectile) return;
    const steps = Math.max(1, Math.ceil(dt / .007));
    const slice = dt / steps;
    for (let i = 0; i < steps; i++) {
      if (!projectile) break;
      const p = projectile;
      p.vx += wind * 9 * slice;
      p.vy += GRAVITY * slice;
      p.x += p.vx * slice;
      p.y += p.vy * slice;
      p.lifetime += slice;
      p.trail.push({ x: p.x, y: p.y });
      if (p.trail.length > 22) p.trail.shift();
      if (p.x < -15 || p.x > W + 15 || p.y > H + 15 || p.lifetime > 8) {
        finishShot();
        break;
      }
      if (p.y < -35) continue;
      const hitsSoldier = units.some((u) => u.hp > 0 && Math.hypot(u.x - p.x, u.y - 23 - p.y) < 13);
      if (hitsSoldier || terrainSolid(p.x, p.y)) {
        explode(p.x, p.y);
        break;
      }
    }
  }

  function stepUnits(dt) {
    for (const u of units) {
      if (u.hp <= 0) continue;
      if (Math.abs(u.vx) > .2) {
        const nx = clamp(u.x + u.vx * dt, 12, W - 12);
        if (!terrainSolid(nx, u.y - 19)) u.x = nx;
        else u.vx *= -.15;
        u.vx *= Math.max(0, 1 - 3.2 * dt);
      }
      if (terrainSolid(u.x, u.y + 2) && u.vy >= 0) {
        u.vy = 0;
        continue;
      }
      u.vy += GRAVITY * dt;
      const proposedY = u.y + u.vy * dt;
      if (!terrainSolid(u.x, proposedY + 1)) {
        u.y = proposedY;
      } else if (u.vy >= 0) {
        let targetY = Math.floor(proposedY);
        while (targetY > 0 && terrainSolid(u.x, targetY + 1)) targetY--;
        if (u.vy > 395 && u.y < targetY - 8) {
          const damage = Math.floor((u.vy - 395) * .09);
          u.hp = Math.max(0, u.hp - damage);
        }
        u.y = targetY;
        u.vy = 0;
      }
      if (u.y > H - 12) u.hp = 0;
    }
  }

  function stepParticles(dt) {
    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      p.life -= dt;
      if (p.life <= 0) {
        particles.splice(i, 1);
        continue;
      }
      if (p.kind !== "smoke") p.vy += GRAVITY * .47 * dt;
      else p.vy -= 14 * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vx *= Math.max(0, 1 - dt * 1.4);
      if (p.kind === "dirt" && terrainSolid(p.x, p.y)) p.life = 0;
    }
  }

  function update(dt) {
    stepUnits(dt);
    stepProjectile(dt);
    stepParticles(dt);
    cameraShake = Math.max(0, cameraShake - 26 * dt);
    if (phase === "resolving") {
      resolutionTimer -= dt;
      if (resolutionTimer <= 0) {
        if (!checkVictory()) nextTurn(1 - teamTurn);
      }
    }
  }

  function drawSky(t) {
    const gradient = ctx.createLinearGradient(0, 0, 0, 600);
    gradient.addColorStop(0, "#6c929e");
    gradient.addColorStop(.48, "#b1b7ac");
    gradient.addColorStop(1, "#dcc2a2");
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, W, H);
    const sunGlow = ctx.createRadialGradient(968, 140, 10, 968, 140, 300);
    sunGlow.addColorStop(0, "#fae2ad99");
    sunGlow.addColorStop(1, "#fae2ad00");
    ctx.fillStyle = sunGlow;
    ctx.fillRect(660, 0, 620, 470);
    ctx.fillStyle = "#f1dfb8";
    ctx.beginPath();
    ctx.arc(968, 140, 34, 0, Math.PI * 2);
    ctx.fill();

    drawMountains(330, 52, "#839c98", .004, 1.4);
    drawMountains(380, 48, "#6b8986", .007, 2.4);
    drawMountains(420, 24, "#587a75", .013, 1.2);
    ctx.fillStyle = "#3e645d";
    for (let x = -20; x < W + 30; x += 41) {
      const height = 24 + (Math.sin(x * .079) + 1) * 17;
      const y = 421 + Math.sin(x * .017) * 19;
      drawPine(x, y, height);
    }
    ctx.save();
    ctx.globalAlpha = .2;
    ctx.fillStyle = "#e1e5d5";
    for (let i = 0; i < 4; i++) {
      const x = ((i * 380 + t * (4 + i * 2)) % 1730) - 210;
      const y = 103 + i * 49;
      ctx.beginPath();
      ctx.ellipse(x, y, 90 + i * 14, 12, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  function drawMountains(base, amplitude, color, frequency, seed) {
    ctx.beginPath();
    ctx.moveTo(0, H);
    ctx.lineTo(0, base);
    for (let x = 0; x <= W + 8; x += 8) {
      const y = base + Math.sin(x * frequency + seed) * amplitude
        + Math.sin(x * frequency * 2.6 + seed * 3) * amplitude * .32;
      ctx.lineTo(x, y);
    }
    ctx.lineTo(W, H);
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();
  }

  function drawPine(x, y, height) {
    ctx.beginPath();
    ctx.moveTo(x, y - height);
    ctx.lineTo(x - height * .28, y);
    ctx.lineTo(x + height * .28, y);
    ctx.closePath();
    ctx.fill();
  }

  function drawTrajectory() {
    if (phase !== "aim" || !active) return;
    const a = radians(angle);
    const start = muzzle(active, a);
    const velocity = shotSpeed();
    let x = start.x, y = start.y;
    let vx = Math.cos(a) * velocity;
    let vy = -Math.sin(a) * velocity;
    let end = null;
    ctx.save();
    for (let step = 0; step < 76; step++) {
      const dt = .052;
      vx += wind * 9 * dt;
      vy += GRAVITY * dt;
      x += vx * dt;
      y += vy * dt;
      if (x < 0 || x > W || y > H || y < -50) break;
      if (terrainSolid(x, y)) {
        end = { x, y };
        break;
      }
      if (step % 2 === 0) {
        ctx.globalAlpha = Math.max(.10, .78 - step * .01);
        ctx.beginPath();
        ctx.arc(x, y, 2.4, 0, Math.PI * 2);
        ctx.fillStyle = "#f8e7af";
        ctx.fill();
      }
    }
    if (end) {
      ctx.globalAlpha = .5;
      ctx.strokeStyle = "#ffe5ad";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(end.x, end.y, 10, 0, Math.PI * 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(end.x - 14, end.y);
      ctx.lineTo(end.x + 14, end.y);
      ctx.moveTo(end.x, end.y - 14);
      ctx.lineTo(end.x, end.y + 14);
      ctx.stroke();
    }
    ctx.restore();
  }

  function drawSoldier(u, time) {
    if (u.hp <= 0) return;
    const selected = u === active && phase !== "over";
    const facing = u.team === 0 ? 1 : -1;
    const color = u.team === 0 ? "#5d8790" : "#b77c63";
    const shadow = u.team === 0 ? "#304e58" : "#764b3e";
    const light = u.team === 0 ? "#a2ced0" : "#e6a88a";
    ctx.save();
    ctx.translate(u.x, u.y);
    if (selected) {
      ctx.strokeStyle = "#f7d594";
      ctx.lineWidth = 2.5;
      ctx.globalAlpha = .65 + Math.sin(time * 4) * .2;
      ctx.beginPath();
      ctx.ellipse(0, -20, 20, 34, 0, 0, Math.PI * 2);
      ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.fillStyle = "#ffe4a7";
      ctx.beginPath();
      ctx.moveTo(0, -76);
      ctx.lineTo(-7, -87);
      ctx.lineTo(7, -87);
      ctx.closePath();
      ctx.fill();
    }
    ctx.fillStyle = "#21302e66";
    ctx.beginPath();
    ctx.ellipse(0, 0, 18, 4, 0, 0, Math.PI * 2);
    ctx.fill();
    // Legs + boots
    ctx.fillStyle = shadow;
    ctx.fillRect(-9, -17, 8, 15);
    ctx.fillRect(3, -17, 8, 15);
    ctx.fillStyle = "#242b2c";
    ctx.fillRect(-11, -4, 11, 5);
    ctx.fillRect(3, -4, 12, 5);
    // Torso and vest
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(-12, -39);
    ctx.lineTo(12, -39);
    ctx.lineTo(11, -17);
    ctx.lineTo(-11, -17);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = shadow;
    ctx.fillRect(-10, -32, 20, 10);
    ctx.fillStyle = light;
    ctx.globalAlpha = .46;
    ctx.fillRect(-7, -33, 5, 11);
    ctx.fillRect(2, -33, 5, 11);
    ctx.globalAlpha = 1;
    ctx.fillStyle = "#313d39";
    ctx.fillRect(-12, -20, 24, 4);
    // Head, neck and steel helmet. Head ≈ 1/6 of body height.
    ctx.fillStyle = "#d8b79b";
    ctx.fillRect(-4, -44, 8, 7);
    ctx.beginPath();
    ctx.ellipse(0, -48, 7, 8, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = shadow;
    ctx.beginPath();
    ctx.arc(0, -51, 9, Math.PI, 2 * Math.PI);
    ctx.lineTo(9, -50);
    ctx.lineTo(-9, -50);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = light;
    ctx.fillRect(-11, -51, 22, 3);
    ctx.fillStyle = "#292f2d";
    ctx.fillRect(facing > 0 ? 5 : -7, -46, 2, 2);
    // Rifle follows the aim only for the selected unit.
    const a = selected ? radians(angle) : radians(u.team === 0 ? 30 : 150);
    const tipX = Math.cos(a) * 29;
    const tipY = -31 - Math.sin(a) * 29;
    ctx.strokeStyle = "#353a35";
    ctx.lineWidth = 6;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(0, -31);
    ctx.lineTo(tipX, tipY);
    ctx.stroke();
    ctx.strokeStyle = "#a6a392";
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(tipX - Math.cos(a) * 7, tipY + Math.sin(a) * 7);
    ctx.lineTo(tipX + Math.cos(a) * 6, tipY - Math.sin(a) * 6);
    ctx.stroke();
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(facing * 9, -34, 5.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    // A health bar is always visible above each character.
    const barX = u.x - 23;
    const barY = u.y - 103;
    ctx.fillStyle = "#1b282dbd";
    ctx.fillRect(barX - 2, barY - 2, 50, 12);
    ctx.fillStyle = "#273639";
    ctx.fillRect(barX, barY, 46, 7);
    ctx.fillStyle = u.hp > 55 ? "#9ec4a3" : u.hp > 25 ? "#e7be79" : "#e77e6e";
    ctx.fillRect(barX, barY, 46 * (u.hp / 100), 7);
    ctx.fillStyle = "#f8f5e7";
    ctx.textAlign = "center";
    ctx.font = "bold 13px system-ui";
    ctx.fillText((u.team === 0 ? "С" : "К") + "-" + String(u.index).padStart(2, "0"), u.x, barY - 6);
  }

  function drawParticles() {
    for (const p of particles) {
      ctx.save();
      ctx.globalAlpha = clamp(p.life / .65, 0, .8);
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.kind === "smoke" ? p.size * (1 + (1 - p.life / 1.6) * 1.5) : p.size, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  }

  function drawProjectile() {
    if (!projectile) return;
    ctx.save();
    projectile.trail.forEach((p, i) => {
      ctx.fillStyle = "rgba(255,223,168," + (i / projectile.trail.length * .6) + ")";
      ctx.beginPath();
      ctx.arc(p.x, p.y, i / projectile.trail.length * 4, 0, Math.PI * 2);
      ctx.fill();
    });
    ctx.shadowColor = "#ffe3a7";
    ctx.shadowBlur = 20;
    ctx.fillStyle = "#ffedc2";
    ctx.beginPath();
    ctx.arc(projectile.x, projectile.y, 6, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  function render(t) {
    ctx.clearRect(0, 0, W, H);
    ctx.save();
    if (cameraShake > 0) ctx.translate(rand(-cameraShake, cameraShake), rand(-cameraShake, cameraShake));
    drawSky(t);
    ctx.drawImage(earthCanvas, 0, 0);
    drawTrajectory();
    for (const u of units) drawSoldier(u, t);
    drawParticles();
    drawProjectile();
    ctx.restore();
  }

  function frame(time) {
    const dt = lastTime ? clamp((time - lastTime) / 1000, 0, .035) : 0;
    lastTime = time;
    update(dt);
    render(time / 1000);
    requestAnimationFrame(frame);
  }

  function pointerAim(event) {
    if (phase !== "aim" || !active) return;
    const rect = canvas.getBoundingClientRect();
    const x = (event.clientX - rect.left) / rect.width * W;
    const y = (event.clientY - rect.top) / rect.height * H;
    const a = Math.atan2(-(y - (active.y - 25)), x - active.x) * 180 / Math.PI;
    if (Number.isFinite(a)) setAngle(a);
  }

  canvas.addEventListener("pointerdown", (event) => {
    if (phase !== "aim") return;
    aimDragging = true;
    canvas.setPointerCapture(event.pointerId);
    pointerAim(event);
  });
  canvas.addEventListener("pointermove", (event) => {
    if (aimDragging) pointerAim(event);
  });
  for (const type of ["pointerup", "pointercancel", "lostpointercapture"]) {
    canvas.addEventListener(type, () => { aimDragging = false; });
  }

  function repeatingMove(id, direction) {
    const button = $(id);
    let timer = null;
    const stop = () => {
      if (timer !== null) clearInterval(timer);
      timer = null;
    };
    button.addEventListener("pointerdown", (event) => {
      if (button.disabled) return;
      event.preventDefault();
      moveSoldier(direction);
      stop();
      timer = setInterval(() => moveSoldier(direction), 115);
    });
    for (const type of ["pointerup", "pointercancel", "pointerleave", "lostpointercapture"]) {
      button.addEventListener(type, stop);
    }
    button.addEventListener("click", (event) => {
      if (event.detail === 0) moveSoldier(direction);
    });
    window.addEventListener("blur", stop);
  }

  repeatingMove("move-left", -1);
  repeatingMove("move-right", 1);
  $("angle-down").addEventListener("click", () => setAngle(angle - 3));
  $("angle-up").addEventListener("click", () => setAngle(angle + 3));
  ui.power.addEventListener("input", (event) => changePower(Number(event.target.value)));
  ui.fire.addEventListener("click", fire);
  $("restart").addEventListener("click", reset);
  $("play-again").addEventListener("click", reset);

  window.addEventListener("keydown", (event) => {
    if (event.target instanceof HTMLInputElement) return;
    if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", " ", "Enter"].includes(event.key)) event.preventDefault();
    if (event.repeat && (event.key === " " || event.key === "Enter")) return;
    switch (event.key.toLowerCase()) {
      case "a": case "arrowleft": moveSoldier(-1); break;
      case "d": case "arrowright": moveSoldier(1); break;
      case "w": case "arrowup": setAngle(angle + 3); break;
      case "s": case "arrowdown": setAngle(angle - 3); break;
      case " ": case "enter": fire(); break;
      case "r": reset(); break;
    }
  });

  reset();
  requestAnimationFrame(frame);
})();