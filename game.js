"use strict";
(() => {
  // World is three times as wide as Alpha 0.1. The 1280×720 canvas is a camera viewport.
  const VW = 1280, VH = 720, W = 3840, H = 960;
  const GRAVITY = 700, MOVE_LIMIT = 180, JUMP_COST = 25;
  const TEAM_NAMES = ["СИНИХ", "КРАСНЫХ"];
  const WEAPONS = ["launcher", "rifle", "cluster", "artillery"];
  const $ = (id) => document.getElementById(id);
  const canvas = $("game"), ctx = canvas.getContext("2d");
  const terrainCanvas = document.createElement("canvas");
  terrainCanvas.width = W; terrainCanvas.height = H;
  const dirt = terrainCanvas.getContext("2d");
  const solid = new Uint8Array(W * H), heights = new Int16Array(W);
  const ui = {
    fire: $("fire"), power: $("power"), powerValue: $("power-value"), angleValue: $("angle-value"),
    steps: $("steps-label"), turn: $("turn-label"), wind: $("wind-label"), round: $("round-label"),
    blue: $("team-blue"), red: $("team-orange"), blueHp: $("blue-hp"), redHp: $("orange-hp"),
    message: $("field-message"), result: $("result-panel"), resultTitle: $("result-title"),
    resultSubtitle: $("result-subtitle"), kills: $("kill-label"), cluster: $("cluster-label"),
    artillery: $("artillery-label"), cameraMode: $("camera-mode"), cameraReset: $("camera-reset"),
    cameraLabel: $("camera-label"), mapPosition: $("map-position"), jump: $("jump")
  };
  let units = [], shots = [], sparks = [], delayed = [], platforms = [];
  let team = 0, active = null, turn = 0, visits = [0, 0], kills = [0, 0];
  let artillerySpent = [0, 0], clusterAmmo = [2, 2];
  let angle = 55, power = 70, movement = MOVE_LIMIT, wind = 0, weapon = "launcher";
  let phase = "aim", resolutionTimer = 0, volleyRemaining = 0, volleyDelay = 0, shotSerial = 0;
  let chosenTarget = null, shake = 0, camera = {x: 0, y: 0, manual: false};
  let lastTime = 0, drag = null, cameraStamp = "";
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const rand = (a, b) => a + Math.random() * (b - a);
  const rad = (a) => a * Math.PI / 180;
  const ammoArtillery = (side) => Math.max(0, Math.floor(kills[side] / 3) - artillerySpent[side]);
  const isSolid = (x, y) => {
    x = Math.floor(x); y = Math.floor(y);
    if (y >= H) return true;
    if (x < 0 || x >= W || y < 0) return false;
    return solid[y * W + x] === 1;
  };

  function makeTerrain() {
    solid.fill(0);
    const image = dirt.createImageData(W, H);
    const pixels = image.data;
    for (let x = 0; x < W; x++) {
      const h = 530 + 72 * Math.sin(x * .0038 + .5) +
        46 * Math.sin(x * .0105 + 1.7) + 19 * Math.sin(x * .026 + 2.1) +
        8 * Math.sin(x * .061 + 1.3);
      heights[x] = clamp(Math.floor(h), 350, 700);
    }
    for (let x = 0; x < W; x++) {
      const first = heights[x], xNoise = ((x * 33) ^ (x >> 2)) & 31;
      for (let y = first; y < H; y++) {
        // Two long ravines; each has a destructible narrow wooden bridge.
        if ((x >= 978 && x < 1075) || (x >= 2510 && x < 2610)) continue;
        const pos = y * W + x, i = pos * 4, depth = y - first;
        const shade = ((x * 17 + y * 29 + (x ^ y) * 7 + xNoise) & 15) - 7;
        if (depth <= 7) {
          pixels[i] = 94 + shade; pixels[i + 1] = 119 + shade; pixels[i + 2] = 75 + shade;
        } else if (depth < 29) {
          pixels[i] = 116 + shade; pixels[i + 1] = 102 + shade; pixels[i + 2] = 77 + shade;
        } else {
          const stripe = (Math.floor((y + x * .11) / 48) % 3) * 7;
          pixels[i] = 98 + shade - stripe;
          pixels[i + 1] = 83 + shade - stripe;
          pixels[i + 2] = 71 + shade - stripe;
        }
        pixels[i + 3] = 255; solid[pos] = 1;
      }
    }
    dirt.clearRect(0, 0, W, H);
    dirt.putImageData(image, 0, 0);
    // Arched underground passages, connected to accessible surface entrances.
    digTunnel(1410, 1855, 735, 38);
    digTunnel(3000, 3425, 755, 42);
    platforms = [];
    const makePlatform = (x1, x2, y, kind) => {
      y = clamp(Math.round(y), 250, 760);
      const height = kind === "bridge" ? 17 : 22;
      dirt.fillStyle = kind === "bridge" ? "#786c51" : "#797765";
      dirt.fillRect(x1, y, x2 - x1, height);
      dirt.fillStyle = kind === "bridge" ? "#bb9864" : "#a7a28a";
      dirt.fillRect(x1, y, x2 - x1, 5);
      dirt.strokeStyle = "#383f36";
      dirt.lineWidth = 3;
      for (let x = x1 + 20; x < x2; x += 25) {
        dirt.beginPath(); dirt.moveTo(x, y + 4); dirt.lineTo(x, y + height); dirt.stroke();
      }
      for (let yy = y; yy < y + height; yy++) {
        for (let xx = x1; xx < x2; xx++) {
          if (xx >= 0 && xx < W && yy >= 0 && yy < H) solid[yy * W + xx] = 1;
        }
      }
      platforms.push({x1, x2, y, kind});
    };
    makePlatform(927, 1118, Math.min(heights[950], heights[1090]) - 7, "bridge");
    makePlatform(2473, 2651, Math.min(heights[2470], heights[2630]) - 7, "bridge");
    for (const [x1, x2] of [[440, 610], [1650, 1850], [2860, 3010], [3350, 3530]]) {
      const y = Math.min(heights[x1], heights[x2]) - 85;
      makePlatform(x1, x2, y, "ledge");
    }
  }

  function digCircle(cx, cy, r, updateTexture = true) {
    const l = clamp(Math.floor(cx - r), 0, W - 1);
    const rr = clamp(Math.ceil(cx + r), 0, W - 1);
    const top = clamp(Math.floor(cy - r), 0, H - 1);
    const bot = clamp(Math.ceil(cy + r), 0, H - 1);
    const rad2 = r * r;
    for (let y = top; y <= bot; y++) {
      const dy = y - cy;
      for (let x = l; x <= rr; x++) {
        const dx = x - cx;
        if (dx * dx + dy * dy < rad2) solid[y * W + x] = 0;
      }
    }
    if (updateTexture) {
      dirt.save(); dirt.globalCompositeOperation = "destination-out";
      dirt.beginPath(); dirt.arc(cx, cy, r, 0, Math.PI * 2); dirt.fill(); dirt.restore();
    }
  }

  function digTunnel(x1, x2, floorY, radius) {
    const tunnelStart = x1 + 105, tunnelEnd = x2 - 105;
    for (let x = x1; x <= x2; x += 9) {
      // Ramp both entrances into the buried tunnel.
      let y;
      if (x < tunnelStart) {
        const p = (x - x1) / (tunnelStart - x1);
        y = heights[x1] - 10 + (floorY - (heights[x1] - 10)) * p;
      } else if (x > tunnelEnd) {
        const p = (x - tunnelEnd) / (x2 - tunnelEnd);
        y = floorY + (heights[x2] - 10 - floorY) * p;
      } else {
        y = floorY + Math.sin(x * .014) * 16;
      }
      digCircle(x, y, radius);
    }
  }

  function makeCrater(cx, cy, radius) {
    // Uneven silhouette and NO brightly outlined circle.
    const n = 36, radii = [];
    for (let i = 0; i < n; i++) radii.push(radius * rand(.86, 1.09));
    const left = clamp(Math.floor(cx - radius * 1.2), 0, W - 1);
    const right = clamp(Math.ceil(cx + radius * 1.2), 0, W - 1);
    const top = clamp(Math.floor(cy - radius * 1.2), 0, H - 1);
    const bottom = clamp(Math.ceil(cy + radius * 1.2), 0, H - 1);
    for (let y = top; y <= bottom; y++) {
      for (let x = left; x <= right; x++) {
        const dx = x - cx, dy = y - cy;
        const theta = (Math.atan2(dy, dx) + Math.PI * 2) % (Math.PI * 2);
        const a = theta / (Math.PI * 2) * n, i = Math.floor(a) % n, f = a - Math.floor(a);
        const r = radii[i] * (1 - f) + radii[(i + 1) % n] * f;
        if (dx * dx + dy * dy <= r * r) solid[y * W + x] = 0;
      }
    }
    dirt.save();
    dirt.globalCompositeOperation = "destination-out";
    dirt.beginPath();
    for (let i = 0; i <= n; i++) {
      const a = i % n / n * Math.PI * 2, r = radii[i % n];
      const x = cx + Math.cos(a) * r, y = cy + Math.sin(a) * r;
      if (i === 0) dirt.moveTo(x, y); else dirt.lineTo(x, y);
    }
    dirt.closePath(); dirt.fill(); dirt.restore();
  }

  function firstFloor(x) {
    for (let y = 150; y < H; y++) if (isSolid(x, y)) return y - 1;
    return H - 1;
  }

  function spawn(x, side, index) {
    const px = clamp(Math.round(x + rand(-34, 34)), 24, W - 24);
    return {x: px, y: firstFloor(px), team: side, index, hp: 100,
      vx: 0, vy: 0, ground: true, airStartY: 0, lastAttacker: -1, lastHitTurn: -50};
  }

  function reset() {
    makeTerrain(); units = []; shots = []; sparks = []; delayed = [];
    visits = [0, 0]; kills = [0, 0]; artillerySpent = [0, 0]; clusterAmmo = [2, 2];
    const xBlue = [190, 385, 680, 1210, 1440];
    const xRed = [2410, 2740, 3060, 3385, 3640];
    for (let i = 0; i < 5; i++) units.push(spawn(xBlue[i], 0, i + 1));
    for (let i = 0; i < 5; i++) units.push(spawn(xRed[i], 1, i + 1));
    turn = 0; shotSerial = 0; phase = "aim"; volleyRemaining = 0; resolutionTimer = 0;
    camera.manual = false; shake = 0; ui.result.hidden = true;
    nextTurn(0);
    snapCamera();
  }

  function snapCamera() {
    if (!active) return;
    camera.x = clamp(active.x - VW * .42, 0, W - VW);
    camera.y = clamp(active.y - VH * .60, 0, H - VH);
    updateCameraUI();
  }

  function setCameraMode(manual) {
    camera.manual = !!manual;
    ui.cameraMode.setAttribute("aria-pressed", String(camera.manual));
    ui.cameraMode.textContent = camera.manual ? "✥ ОБЗОР: ВКЛ" : "✥ ОБЗОР";
    ui.cameraLabel.textContent = camera.manual ? "КАМЕРА: РУЧНАЯ" : "КАМЕРА: АВТО";
    if (!camera.manual) snapCamera();
  }

  function updateCameraUI() {
    const stamp = String(Math.round(camera.x / (W - VW) * 100));
    if (stamp !== cameraStamp) {
      cameraStamp = stamp;
      ui.mapPosition.textContent = "КАРТА: " + stamp + "%";
    }
  }

  function nextTurn(side) {
    const living = units.filter((u) => u.team === side && u.hp > 0);
    if (!living.length) { finishGame(1 - side); return; }
    team = side; active = living[visits[side] % living.length]; visits[side]++;
    turn++; movement = MOVE_LIMIT; angle = side === 0 ? 55 : 125; power = 70;
    wind = Math.round(rand(-8, 8)); weapon = "launcher"; chosenTarget = null;
    shots = []; delayed = []; phase = "aim"; resolutionTimer = 0; volleyRemaining = 0;
    ui.message.textContent = (side === 0 ? "СИНИЕ" : "КРАСНЫЕ") + ": ВЫБЕРИ ОРУЖИЕ И ПРИЦЕЛЬСЯ";
    setCameraMode(false); refreshUI(); snapCamera();
  }

  function refreshUI() {
    const living = [0, 1].map(s => units.filter(u => u.team === s && u.hp > 0));
    const hp = (group) => group.reduce((sum, u) => sum + Math.ceil(u.hp), 0);
    ui.blueHp.textContent = living[0].length + " бойцов · " + hp(living[0]) + " HP";
    ui.redHp.textContent = living[1].length + " бойцов · " + hp(living[1]) + " HP";
    ui.turn.textContent = phase === "over" ? "МАТЧ ЗАВЕРШЁН" : "ХОД " + (team === 0 ? "СИНЕГО" : "КРАСНОГО") + " ОТРЯДА";
    ui.blue.classList.toggle("active", team === 0 && phase !== "over");
    ui.red.classList.toggle("active", team === 1 && phase !== "over");
    ui.wind.textContent = "ВЕТЕР " + (wind < 0 ? "← " : wind > 0 ? "→ " : "· ") + Math.abs(wind) + " м/с";
    ui.round.textContent = "ХОД " + String(turn).padStart(2, "0");
    ui.angleValue.textContent = Math.round(angle) + "°";
    ui.powerValue.textContent = power + "%";
    ui.power.value = String(power);
    ui.steps.textContent = Math.max(0, Math.floor(movement)) + " ЕД.";
    ui.kills.textContent = "УБИЙСТВА: СИНИЕ " + kills[0] + " · КРАСНЫЕ " + kills[1];
    ui.cluster.textContent = clusterAmmo[team] + " / 2 · 5 ОСКОЛКОВ";
    ui.artillery.textContent = ammoArtillery(team)
      ? "ЗАРЯЖЕНА · " + ammoArtillery(team)
      : "УБИЙСТВА " + (kills[team] % 3) + "/3";
    const locked = phase !== "aim";
    for (const id of ["move-left", "move-right", "angle-down", "angle-up"]) $(id).disabled = locked || (id.startsWith("move") && movement < 1);
    ui.jump.disabled = locked || movement < JUMP_COST || !active || !active.ground;
    ui.power.disabled = locked || weapon === "artillery";
    ui.fire.disabled = locked || (weapon === "artillery" && !chosenTarget);
    for (const id of WEAPONS) {
      const b = $("weapon-" + id);
      b.classList.toggle("selected", weapon === id);
      b.setAttribute("aria-pressed", String(weapon === id));
      b.disabled = locked || (id === "cluster" && clusterAmmo[team] <= 0) ||
        (id === "artillery" && ammoArtillery(team) <= 0);
    }
  }

  function selectWeapon(id) {
    if (phase !== "aim" || !WEAPONS.includes(id)) return;
    if (id === "cluster" && clusterAmmo[team] <= 0) return;
    if (id === "artillery" && !ammoArtillery(team)) return;
    weapon = id;
    ui.message.textContent = id === "artillery"
      ? "НАЖМИ НА ТОЧКУ УДАРА · В РЕЖИМЕ ОБЗОРА МОЖНО ПРОКРУЧИВАТЬ КАРТУ"
      : id === "rifle" ? "АВТОМАТ: 10 ПУЛЬ · КОРОТКАЯ ДИСТАНЦИЯ"
      : id === "cluster" ? "КЛАСТЕР: ПОДРЫВ ПО ТАЙМЕРУ И 5 МИНИ-ГРАНАТ"
      : "ГРАНАТОМЁТ: БАЛЛИСТИЧЕСКИЙ СНАРЯД";
    refreshUI();
  }

  function setAngle(next) {
    if (phase !== "aim") return;
    angle = clamp(next, 8, 172);
    refreshUI();
  }
  function setPower(next) {
    if (phase !== "aim") return;
    power = clamp(Math.round(next), 25, 100);
    refreshUI();
  }

  function walk(dir) {
    if (phase !== "aim" || !active || movement < 1) return;
    const step = Math.min(12, movement);
    const x = clamp(active.x + step * dir, 18, W - 18);
    if (Math.abs(x - active.x) < .1) return;
    if (isSolid(x, active.y - 45) || isSolid(x, active.y - 27)) return;
    if (active.ground) {
      let floor = null;
      for (let y = Math.floor(active.y - 15); y <= active.y + 26; y++) {
        if (isSolid(x, y)) { floor = y - 1; break; }
      }
      if (floor !== null) {
        if (isSolid(x, floor - 46)) return;
        active.y = floor;
      } else {
        active.ground = false;
        active.airStartY = active.y;
      }
    }
    active.x = x;
    movement -= step;
    refreshUI();
  }

  function jump() {
    if (phase !== "aim" || !active || !active.ground || movement < JUMP_COST) return;
    active.vy = -410; active.ground = false; active.airStartY = active.y;
    movement -= JUMP_COST; ui.message.textContent = "ПРЫЖОК!";
    refreshUI();
  }

  function muzzle(u, a, kind) {
    const offset = kind === "rifle" ? 31 : 33;
    return {x: u.x + Math.cos(a) * offset, y: u.y - 31 - Math.sin(a) * offset};
  }
  function shellSpeed(kind) {
    if (kind === "cluster") return 200 + power * 2.6;
    if (kind === "rifle") return 1020;
    return 370 + power * 5.3;
  }

  function addShot(kind, x, y, vx, vy, owner, options = {}) {
    shots.push({kind, x, y, vx, vy, owner, age: 0, fuse: options.fuse || 0,
      trail: [], gravity: options.gravity === undefined ? 1 : options.gravity,
      bounceCount: 0, target: options.target || null});
  }

  function fire() {
    if (phase !== "aim" || !active || ui.fire.disabled) return;
    const id = weapon, a = rad(angle), at = muzzle(active, a, id), speed = shellSpeed(id);
    phase = "flight"; shotSerial++; resolutionTimer = 0;
    ui.message.textContent = "ВЫСТРЕЛ!";
    if (id === "launcher") {
      addShot("launcher", at.x, at.y, Math.cos(a) * speed, -Math.sin(a) * speed, team);
      emit(at.x, at.y, 14, "flash");
    } else if (id === "rifle") {
      volleyRemaining = 10; volleyDelay = 0;
    } else if (id === "cluster") {
      clusterAmmo[team]--;
      addShot("cluster", at.x, at.y, Math.cos(a) * speed, -Math.sin(a) * speed, team, {fuse: 2.3});
      emit(at.x, at.y, 9, "flash");
    } else if (id === "artillery" && chosenTarget) {
      artillerySpent[team]++;
      const target = {x: chosenTarget.x, y: chosenTarget.y};
      addShot("artillery", target.x + (target.x > W - 260 ? -180 : 180), target.y - 640, 0, 0, team, {target});
      ui.message.textContent = "АРТИЛЛЕРИЯ! ТЯЖЁЛАЯ РАКЕТА ПОДХОДИТ К ЦЕЛИ";
    }
    camera.manual = false; ui.cameraMode.setAttribute("aria-pressed", "false");
    ui.cameraMode.textContent = "✥ ОБЗОР";
    ui.cameraLabel.textContent = "КАМЕРА: АВТО";
    refreshUI();
  }

  function fireRifleBullet(index) {
    if (!active) return;
    const recoil = index * .66;
    const actualAngle = clamp(angle + recoil + rand(-2.7, 2.7), 8, 172);
    const a = rad(actualAngle), at = muzzle(active, a, "rifle");
    addShot("bullet", at.x, at.y, Math.cos(a) * 1030, -Math.sin(a) * 1030, team, {gravity: .42});
    emit(at.x, at.y, 5, "flash");
    ui.message.textContent = "ОЧЕРЕДЬ: " + (index + 1) + "/10";
  }

  function emit(x, y, count, kind) {
    for (let i = 0; i < count; i++) {
      const a = rand(0, Math.PI * 2), speed = rand(kind === "smoke" ? 10 : 40, kind === "flash" ? 170 : 290);
      const life = rand(kind === "smoke" ? .6 : .23, kind === "smoke" ? 1.5 : .9);
      sparks.push({
        x, y, vx: Math.cos(a) * speed, vy: Math.sin(a) * speed - (kind === "smoke" ? 35 : 0),
        life, maxLife: life, radius: rand(1.5, kind === "smoke" ? 14 : 5),
        kind, color: kind === "dirt" ? (Math.random() > .5 ? "#a18460" : "#78664f") :
          kind === "smoke" ? "#73807c" : (Math.random() > .5 ? "#ffe3a2" : "#df8753")
      });
    }
    if (sparks.length > 480) sparks.splice(0, sparks.length - 480);
  }

  function damageUnit(u, amount, attacker, forceX, forceY) {
    if (u.hp <= 0) return;
    if (amount > 0) {
      u.lastAttacker = attacker; u.lastHitTurn = turn;
      const wasAlive = u.hp > 0;
      u.hp = Math.max(0, u.hp - amount);
      if (wasAlive && u.hp <= 0 && attacker !== u.team && (attacker === 0 || attacker === 1)) {
        kills[attacker]++;
        if (kills[attacker] % 3 === 0) {
          ui.message.textContent = "АРТИЛЛЕРИЯ ЗАРЯЖЕНА: " + TEAM_NAMES[attacker] + "!";
        }
      }
    }
    if (u.hp <= 0) return;
    if (forceX || forceY) {
      if (u.ground) u.airStartY = u.y;
      u.ground = false;
      u.vx += forceX;
      u.vy += forceY;
    }
  }

  function explosion(x, y, radius, maxDamage, owner, kind) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    makeCrater(x, y, radius);
    emit(x, y, kind === "artillery" ? 70 : 32, "dirt");
    emit(x, y, 28, "flash");
    emit(x, y, 12, "smoke");
    shake = Math.max(shake, kind === "artillery" ? 22 : radius / 5);
    let total = 0;
    for (const u of units) {
      if (u.hp <= 0) continue;
      const dx = u.x - x, dy = u.y - 24 - y;
      const dist = Math.hypot(dx, dy);
      const intensity = clamp(1 - dist / (radius + 43), 0, 1);
      if (intensity <= 0) continue;
      const dmg = Math.round(maxDamage * intensity);
      total += dmg;
      const dir = dx === 0 ? (Math.random() > .5 ? 1 : -1) : Math.sign(dx);
      damageUnit(u, dmg, owner, dir * 255 * intensity, -270 * intensity);
    }
    if (total > 0) ui.message.textContent = "ВЗРЫВ · УРОН " + total + " HP";
    refreshUI();
  }

  function grenadeBurst(shot) {
    explosion(shot.x, shot.y, 32, 22, shot.owner, "cluster");
    for (let i = 0; i < 5; i++) {
      const a = rad(145 - i * 27 + rand(-5, 5));
      const v = rand(210, 300);
      addShot("mini", shot.x, shot.y - 9, Math.cos(a) * v,
        -Math.sin(a) * v, shot.owner, {fuse: .85 + i * .11});
    }
    ui.message.textContent = "КЛАСТЕР РАСКРЫЛСЯ: 5 МИНИ-ГРАНАТ";
  }

  function artilleryImpact(x, y, owner) {
    explosion(x, y, 105, 145, owner, "artillery");
    // Four follow-up blasts; together with the primary impact this is five major hits.
    for (let i = 0; i < 4; i++) {
      delayed.push({time: .16 + i * .13, x: x + [-82, 76, -40, 48][i],
        y: y + [8, -18, 31, 26][i], owner});
    }
    ui.message.textContent = "АРТИЛЛЕРИЙСКИЙ УДАР: ОСНОВНОЙ + 4 ВТОРИЧНЫХ";
  }

  function hitBullet(shot, soldier) {
    if (soldier) {
      damageUnit(soldier, 11, shot.owner,
        Math.sign(shot.vx || 1) * 27, -25);
      refreshUI();
    }
    emit(shot.x, shot.y, 3, soldier ? "flash" : "dirt");
  }

  function updateShots(dt) {
    if (phase === "flight" && volleyRemaining > 0) {
      volleyDelay -= dt;
      while (volleyDelay <= 0 && volleyRemaining > 0) {
        fireRifleBullet(10 - volleyRemaining);
        volleyRemaining--; volleyDelay += .095;
      }
    }
    if (phase !== "flight") return;
    const steps = Math.max(1, Math.ceil(dt / .006));
    const subdt = dt / steps;
    for (let k = 0; k < steps; k++) {
      for (let i = shots.length - 1; i >= 0; i--) {
        const p = shots[i], beforeX = p.x, beforeY = p.y;
        p.age += subdt;
        let removed = false;
        if (p.kind === "artillery") {
          const progress = clamp(p.age / .85, 0, 1);
          p.x = p.target.x + (1 - progress) * (p.target.x > W - 260 ? -180 : 180);
          p.y = p.target.y - (1 - progress) * 640;
        } else {
          p.vx += wind * (p.kind === "bullet" ? 1.2 : 8) * subdt;
          p.vy += GRAVITY * p.gravity * subdt;
          p.x += p.vx * subdt;
          p.y += p.vy * subdt;
        }
        if (k % 2 === 0) {
          p.trail.push({x: p.x, y: p.y});
          if (p.trail.length > 18) p.trail.shift();
        }
        const escape = p.x < -100 || p.x > W + 100 || p.y > H + 100;
        const collidedTerrain = isSolid(p.x, p.y);
        const victim = units.find((u) =>
          u.hp > 0 && Math.hypot(p.x - u.x, p.y - (u.y - 27)) < (p.kind === "bullet" ? 12 : 14));
        if (p.kind === "cluster" || p.kind === "mini") {
          if (collidedTerrain) {
            p.x = beforeX; p.y = beforeY;
            const wall = isSolid(p.x + Math.sign(p.vx) * 6, p.y - 5) &&
              !isSolid(p.x, p.y + 7);
            if (wall) p.vx *= -.52;
            else {p.vy = -Math.abs(p.vy) * .48; p.vx *= .68;}
            p.bounceCount++;
            if (Math.abs(p.vy) < 48 && !wall) p.vy = 0;
          }
          if (victim && p.bounceCount === 0) {
            p.vx *= -.4; p.vy = -Math.abs(p.vy) * .35;
            p.bounceCount++;
          }
          if (p.age >= p.fuse || escape) {
            shots.splice(i, 1); removed = true;
            if (!escape) {
              if (p.kind === "cluster") grenadeBurst(p);
              else explosion(p.x, p.y, 34, 38, p.owner, "mini");
            }
          }
        } else if (p.kind === "bullet") {
          if (victim || collidedTerrain || escape || p.age > 1.15) {
            shots.splice(i, 1); removed = true;
            if (!escape && (victim || collidedTerrain)) hitBullet(p, victim);
          }
        } else if (p.kind === "launcher" || p.kind === "artillery") {
          if (victim || collidedTerrain || escape ||
              (p.kind === "artillery" && p.age >= .85)) {
            shots.splice(i, 1); removed = true;
            if (!escape) {
              if (p.kind === "artillery") artilleryImpact(p.x, p.y, p.owner);
              else explosion(p.x, p.y, 65, 86, p.owner, "launcher");
            }
          }
        }
        if (!removed && p.age > 11) shots.splice(i, 1);
      }
    }
    for (let i = delayed.length - 1; i >= 0; i--) {
      delayed[i].time -= dt;
      if (delayed[i].time <= 0) {
        const p = delayed[i];
        delayed.splice(i, 1);
        explosion(p.x, p.y, 66, 82, p.owner, "artillery");
      }
    }
    if (shots.length === 0 && delayed.length === 0 && volleyRemaining === 0) {
      phase = "resolving"; resolutionTimer = 1.25;
      refreshUI();
    }
  }

  function updateUnits(dt) {
    for (const u of units) {
      if (u.hp <= 0) continue;
      if (Math.abs(u.vx) >= .25) {
        const nx = clamp(u.x + u.vx * dt, 15, W - 15);
        if (!isSolid(nx, u.y - 31) && !isSolid(nx, u.y - 10)) u.x = nx;
        else u.vx *= -.25;
        u.vx *= Math.max(0, 1 - 3 * dt);
      }
      if (u.ground && !isSolid(u.x, u.y + 3)) {
        u.ground = false; u.airStartY = u.y; u.vy = Math.max(0, u.vy);
      }
      if (u.ground) continue;
      u.vy += GRAVITY * dt;
      const shift = u.vy * dt, n = Math.max(1, Math.ceil(Math.abs(shift) / 4));
      const sy = shift / n;
      for (let i = 0; i < n; i++) {
        const ny = u.y + sy;
        if (sy > 0 && isSolid(u.x, ny + 1)) {
          const drop = Math.max(0, u.y - u.airStartY);
          if (drop > 95) {
            const attacker = turn - u.lastHitTurn <= 2 ? u.lastAttacker : -1;
            damageUnit(u, Math.min(100, Math.floor((drop - 95) * .35)), attacker, 0, 0);
          }
          u.vy = 0; u.ground = true;
          break;
        }
        if (sy < 0 && isSolid(u.x, ny - 53)) {
          u.vy = 0;
          break;
        }
        u.y = ny;
      }
      if (u.y > H - 10) damageUnit(u, 1000, -1, 0, 0);
    }
  }

  function updateParticles(dt) {
    for (let i = sparks.length - 1; i >= 0; i--) {
      const p = sparks[i]; p.life -= dt;
      if (p.life <= 0) { sparks.splice(i, 1); continue; }
      p.vy += (p.kind === "smoke" ? -30 : GRAVITY * .48) * dt;
      p.x += p.vx * dt; p.y += p.vy * dt;
      p.vx *= Math.max(0, 1 - 1.4 * dt);
      if (p.kind === "dirt" && isSolid(p.x, p.y)) sparks.splice(i, 1);
    }
  }

  function checkFinish() {
    const alive = [0, 1].map(t => units.some(u => u.team === t && u.hp > 0));
    if (alive[0] && alive[1]) return false;
    phase = "over"; ui.result.hidden = false;
    if (!alive[0] && !alive[1]) {
      ui.resultTitle.textContent = "НИЧЬЯ!";
      ui.resultSubtitle.textContent = "Оба отряда выбыли.";
    } else {
      const winner = alive[0] ? 0 : 1;
      ui.resultTitle.textContent = "ПОБЕДА " + TEAM_NAMES[winner] + "!";
      ui.resultSubtitle.textContent = "Противник уничтожен. Запускаем новую дуэль?";
    }
    ui.message.textContent = "БОЙ ОКОНЧЕН";
    refreshUI();
    return true;
  }

  function finishGame(winner) {
    phase = "over"; ui.result.hidden = false;
    ui.resultTitle.textContent = "ПОБЕДА " + TEAM_NAMES[winner] + "!";
    ui.resultSubtitle.textContent = "На поле не осталось бойцов противника.";
    refreshUI();
  }

  function updateCamera(dt) {
    if (!camera.manual) {
      let follow = active;
      if (phase === "flight" && shots.length) {
        const s = shots.find(s => s.kind === "artillery") || shots[0];
        follow = {x: s.x, y: s.y};
      } else if (phase === "flight" && chosenTarget && weapon === "artillery") {
        follow = chosenTarget;
      }
      if (follow) {
        const targetX = clamp(follow.x - VW * .45, 0, W - VW);
        const targetY = clamp(follow.y - VH * .58, 0, H - VH);
        const rate = Math.min(1, dt * 5);
        camera.x += (targetX - camera.x) * rate;
        camera.y += (targetY - camera.y) * rate;
      }
    }
    updateCameraUI();
  }

  function update(dt) {
    updateUnits(dt);
    updateShots(dt);
    updateParticles(dt);
    shake = Math.max(0, shake - 30 * dt);
    if (phase === "resolving") {
      resolutionTimer -= dt;
      if (resolutionTimer <= 0) {
        if (!checkFinish()) nextTurn(1 - team);
      }
    }
    if (phase === "aim") ui.jump.disabled = movement < JUMP_COST || !active || !active.ground;
    updateCamera(dt);
  }

  function sky(t) {
    const gradient = ctx.createLinearGradient(0, 0, 0, VH);
    gradient.addColorStop(0, "#7296a1");
    gradient.addColorStop(.57, "#c0bfb1");
    gradient.addColorStop(1, "#dfc49f");
    ctx.fillStyle = gradient; ctx.fillRect(0, 0, VW, VH);
    ctx.fillStyle = "#eed9b0a0";
    ctx.beginPath(); ctx.arc(997 - camera.x * .05, 126, 42, 0, Math.PI * 2); ctx.fill();
    for (let layer = 0; layer < 3; layer++) {
      ctx.beginPath(); ctx.moveTo(0, VH);
      const base = 346 + layer * 64;
      const parallax = camera.x * (.07 + layer * .055);
      for (let x = 0; x <= VW + 10; x += 10) {
        const w = x + parallax;
        const y = base + 48 * Math.sin(w * (.004 + layer * .002) + layer) +
          21 * Math.sin(w * .016 + layer * 3);
        ctx.lineTo(x, y);
      }
      ctx.lineTo(VW, VH); ctx.closePath();
      ctx.fillStyle = ["#91a6a0", "#6f8c84", "#4d716b"][layer];
      ctx.fill();
    }
    ctx.save(); ctx.globalAlpha = .18; ctx.fillStyle = "#edf0dd";
    for (let i = 0; i < 5; i++) {
      const x = ((i * 400 + t * (5 + i) - camera.x * .12) % 1900 + 1900) % 1900 - 220;
      ctx.beginPath(); ctx.ellipse(x, 75 + i * 36, 95, 14, 0, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();
  }

  function drawSoldier(u, time) {
    if (u.hp <= 0 || u.x < camera.x - 70 || u.x > camera.x + VW + 70 ||
        u.y < camera.y - 150 || u.y > camera.y + VH + 100) return;
    const selected = u === active && phase !== "over";
    const direction = u.team === 0 ? 1 : -1;
    const uniform = u.team === 0 ? "#608d98" : "#ba8069";
    const shade = u.team === 0 ? "#304d57" : "#764c3d";
    ctx.save(); ctx.translate(u.x, u.y);
    if (selected) {
      ctx.strokeStyle = "#f9d398"; ctx.lineWidth = 2.7;
      ctx.globalAlpha = .77 + Math.sin(time * 5) * .17;
      ctx.beginPath(); ctx.ellipse(0, -23, 23, 37, 0, 0, Math.PI * 2); ctx.stroke();
      ctx.globalAlpha = 1; ctx.fillStyle = "#fbe3ad";
      ctx.beginPath(); ctx.moveTo(0,-83); ctx.lineTo(-8,-97); ctx.lineTo(8,-97); ctx.fill();
    }
    ctx.fillStyle = "#14262455"; ctx.beginPath(); ctx.ellipse(0, 1, 19, 4, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = shade; ctx.fillRect(-9,-18,8,16); ctx.fillRect(3,-18,8,16);
    ctx.fillStyle = "#293331"; ctx.fillRect(-11,-4,12,5); ctx.fillRect(2,-4,13,5);
    ctx.fillStyle = uniform; ctx.fillRect(-12,-42,24,25);
    ctx.fillStyle = shade; ctx.fillRect(-10,-34,20,12); ctx.fillRect(-12,-20,24,4);
    ctx.fillStyle = "#b0b29f"; ctx.globalAlpha=.5; ctx.fillRect(-7,-34,5,10); ctx.fillRect(2,-34,5,10); ctx.globalAlpha=1;
    ctx.fillStyle="#d4b49a"; ctx.fillRect(-4,-47,8,7);
    ctx.beginPath(); ctx.ellipse(0,-50,7,8,0,0,Math.PI*2); ctx.fill();
    ctx.fillStyle=shade; ctx.beginPath(); ctx.arc(0,-53,9,Math.PI,2*Math.PI); ctx.lineTo(10,-52); ctx.lineTo(-10,-52); ctx.closePath(); ctx.fill();
    ctx.fillStyle="#a8af9e"; ctx.fillRect(-10,-52,20,3);
    ctx.fillStyle="#242d2a"; ctx.fillRect(direction>0?5:-7,-48,2,2);
    const aim = selected ? rad(angle) : rad(u.team === 0 ? 24 : 156);
    const range = selected && weapon === "rifle" ? 37 : 32;
    ctx.strokeStyle="#313b38"; ctx.lineWidth=selected && weapon === "launcher"?8:5;
    ctx.lineCap="round"; ctx.beginPath(); ctx.moveTo(0,-32);
    ctx.lineTo(Math.cos(aim)*range,-32-Math.sin(aim)*range); ctx.stroke();
    ctx.fillStyle=uniform; ctx.beginPath(); ctx.arc(direction*9,-34,5.5,0,Math.PI*2);ctx.fill();
    ctx.restore();
    const bx=u.x-25, by=u.y-111;
    ctx.fillStyle="#19282ed8"; ctx.fillRect(bx-2,by-2,54,13);
    ctx.fillStyle="#243637";ctx.fillRect(bx,by,50,7);
    ctx.fillStyle=u.hp>60?"#a8cb9d":u.hp>30?"#e2c078":"#dd7869";
    ctx.fillRect(bx,by,50*u.hp/100,7);
    ctx.fillStyle="#f8f0dc";ctx.font="bold 12px system-ui";ctx.textAlign="center";
    ctx.fillText((u.team===0?"С":"К")+"-"+u.index,u.x,by-7);
  }

  function drawAim() {
    if (phase !== "aim" || !active) return;
    if (weapon === "artillery") {
      if (!chosenTarget) return;
      const x=chosenTarget.x,y=chosenTarget.y;
      ctx.strokeStyle="#ffc178";ctx.fillStyle="#ffe0ac";ctx.lineWidth=3;
      ctx.beginPath();ctx.arc(x,y,29,0,Math.PI*2);ctx.stroke();
      ctx.beginPath();ctx.moveTo(x-43,y);ctx.lineTo(x-15,y);
      ctx.moveTo(x+15,y);ctx.lineTo(x+43,y);
      ctx.moveTo(x,y-43);ctx.lineTo(x,y-15);
      ctx.moveTo(x,y+15);ctx.lineTo(x,y+43);ctx.stroke();
      ctx.font="bold 14px system-ui";ctx.textAlign="center";ctx.fillText("ЦЕЛЬ АРТИЛЛЕРИИ",x,y-52);
      return;
    }
    const a=rad(angle), speed=shellSpeed(weapon), p=muzzle(active,a,weapon);
    let x=p.x,y=p.y,vx=Math.cos(a)*speed,vy=-Math.sin(a)*speed;
    ctx.save();
    const dt=.05, count=weapon==="rifle"?25:84;
    for(let k=0;k<count;k++){
      vx+=wind*(weapon==="rifle"?1.2:8)*dt;
      vy+=GRAVITY*(weapon==="rifle"?.42:1)*dt;
      x+=vx*dt;y+=vy*dt;
      if(x<0||x>W||y>H)break;
      if(y>=0&&isSolid(x,y))break;
      if(k%2===0){
        ctx.globalAlpha=Math.max(.13,.8-k*.012);
        ctx.fillStyle="#ffe7ad";ctx.beginPath();ctx.arc(x,y,2.4,0,Math.PI*2);ctx.fill();
      }
    }
    ctx.restore();
  }

  function drawShots() {
    for(const p of shots){
      if(p.x<camera.x-150||p.x>camera.x+VW+150||
         p.y<camera.y-150||p.y>camera.y+VH+150)continue;
      ctx.save();
      for(let i=0;i<p.trail.length;i++){
        const q=p.trail[i];ctx.globalAlpha=i/p.trail.length*.58;
        ctx.fillStyle=p.kind==="artillery"?"#eeeecc":"#ffe0a2";
        ctx.beginPath();ctx.arc(q.x,q.y,Math.max(1,i/p.trail.length*5),0,Math.PI*2);ctx.fill();
      }
      ctx.globalAlpha=1;ctx.shadowColor="#ffe1a6";ctx.shadowBlur=p.kind==="artillery"?25:12;
      ctx.fillStyle=p.kind==="bullet"?"#fff9c6":p.kind==="artillery"?"#ecded1":"#f6d3a0";
      ctx.beginPath();ctx.arc(p.x,p.y,p.kind==="artillery"?13:p.kind==="bullet"?3:7,0,Math.PI*2);ctx.fill();
      if(p.kind==="artillery"){
        ctx.strokeStyle="#444d4a";ctx.lineWidth=7;ctx.beginPath();
        ctx.moveTo(p.x+19,p.y-42);ctx.lineTo(p.x,p.y);ctx.stroke();
      }
      ctx.restore();
    }
  }

  function drawSparks() {
    for(const p of sparks){
      if(p.x<camera.x-25||p.x>camera.x+VW+25||
         p.y<camera.y-30||p.y>camera.y+VH+30)continue;
      ctx.globalAlpha=clamp(p.life/p.maxLife,0,.76);
      ctx.fillStyle=p.color;ctx.beginPath();
      ctx.arc(p.x,p.y,p.kind==="smoke"?p.radius*(1+(1-p.life/p.maxLife)*1.5):p.radius,0,Math.PI*2);
      ctx.fill();
    }
    ctx.globalAlpha=1;
  }

  function drawMinimap() {
    const x=440,y=18,w=400,h=62;
    ctx.save();
    ctx.fillStyle="#102b30bd";ctx.fillRect(x-7,y-7,w+14,h+14);
    ctx.strokeStyle="#d6e0ce66";ctx.lineWidth=1;ctx.strokeRect(x-7,y-7,w+14,h+14);
    ctx.fillStyle="#42675f";
    ctx.beginPath();ctx.moveTo(x,y+h);
    for(let i=0;i<W;i+=26){
      const yp=y+9+((heights[i]-350)/420)*45;
      ctx.lineTo(x+i/W*w,yp);
    }
    ctx.lineTo(x+w,y+h);ctx.closePath();ctx.fill();
    for(const u of units){
      if(u.hp<=0)continue;
      ctx.fillStyle=u.team===0?"#a4ddea":"#f3a783";
      ctx.beginPath();ctx.arc(x+u.x/W*w,y+9+(u.y/H)*44,3.6,0,Math.PI*2);ctx.fill();
    }
    ctx.strokeStyle="#ffe09a";ctx.lineWidth=2;
    ctx.strokeRect(x+camera.x/W*w,y+camera.y/H*h,VW/W*w,VH/H*h);
    ctx.restore();
  }

  function render(time) {
    ctx.clearRect(0,0,VW,VH);
    sky(time);
    ctx.save();
    if(shake>0) ctx.translate(rand(-shake,shake),rand(-shake,shake));
    ctx.translate(-camera.x,-camera.y);
    ctx.drawImage(terrainCanvas, camera.x, camera.y, VW, VH, camera.x, camera.y, VW, VH);
    drawAim();
    for(const u of units)drawSoldier(u,time);
    drawSparks();drawShots();
    ctx.restore();
    drawMinimap();
  }

  function frame(time) {
    const dt=lastTime?clamp((time-lastTime)/1000,0,.034):0;
    lastTime=time;update(dt);render(time/1000);
    requestAnimationFrame(frame);
  }

  function screenToWorld(e) {
    const r=canvas.getBoundingClientRect();
    return {sx:(e.clientX-r.left)/r.width*VW, sy:(e.clientY-r.top)/r.height*VH,
      x:(e.clientX-r.left)/r.width*VW+camera.x,
      y:(e.clientY-r.top)/r.height*VH+camera.y};
  }

  function pointerAim(p) {
    if(phase!=="aim"||!active)return;
    const dx=p.x-active.x,dy=active.y-31-p.y;
    if(Math.hypot(dx,dy)<8)return;
    setAngle(Math.atan2(dy,dx)*180/Math.PI);
  }

  canvas.addEventListener("pointerdown",e=>{
    if(phase!=="aim")return;
    const p=screenToWorld(e);
    drag={x:p.sx,y:p.sy,lastX:p.sx,lastY:p.sy,moved:false,manual:camera.manual};
    canvas.setPointerCapture(e.pointerId);
    if(!camera.manual){
      if(weapon==="artillery"){chosenTarget={x:clamp(p.x,0,W-1),y:clamp(p.y,0,H-1)};refreshUI();}
      else pointerAim(p);
    }
  });
  canvas.addEventListener("pointermove",e=>{
    if(!drag)return;
    const p=screenToWorld(e),dx=p.sx-drag.lastX,dy=p.sy-drag.lastY;
    if(Math.hypot(p.sx-drag.x,p.sy-drag.y)>10)drag.moved=true;
    if(drag.manual){
      camera.x=clamp(camera.x-dx,0,W-VW);
      camera.y=clamp(camera.y-dy,0,H-VH);
      updateCameraUI();
    }else if(weapon!=="artillery")pointerAim(p);
    drag.lastX=p.sx;drag.lastY=p.sy;
  });
  function releasePointer(e,cancelled=false){
    if(!drag)return;
    if(!cancelled&&drag.manual&&!drag.moved&&phase==="aim"&&weapon==="artillery"){
      const p=screenToWorld(e);
      chosenTarget={x:clamp(p.x,0,W-1),y:clamp(p.y,0,H-1)};
      ui.message.textContent="ЦЕЛЬ ВЫБРАНА · НАЖМИ ОГОНЬ!";
      refreshUI();
    }
    drag=null;
  }
  canvas.addEventListener("pointerup",e=>releasePointer(e));
  canvas.addEventListener("pointercancel",e=>releasePointer(e,true));
  canvas.addEventListener("lostpointercapture",e=>releasePointer(e,true));

  function repeating(id,fn){
    const button=$(id);let timer=null;
    const stop=()=>{if(timer!==null)clearInterval(timer);timer=null;};
    button.addEventListener("pointerdown",e=>{
      if(button.disabled)return;
      e.preventDefault();fn();stop();timer=setInterval(fn,110);
    });
    for(const type of ["pointerup","pointercancel","pointerleave","lostpointercapture"])
      button.addEventListener(type,stop);
    button.addEventListener("click",e=>{if(e.detail===0)fn();});
    window.addEventListener("blur",stop);
  }
  repeating("move-left",()=>walk(-1));
  repeating("move-right",()=>walk(1));
  $("jump").addEventListener("click",jump);
  $("angle-down").addEventListener("click",()=>setAngle(angle-3));
  $("angle-up").addEventListener("click",()=>setAngle(angle+3));
  ui.power.addEventListener("input",e=>setPower(Number(e.target.value)));
  for(const name of WEAPONS)$("weapon-"+name).addEventListener("click",()=>selectWeapon(name));
  ui.fire.addEventListener("click",fire);
  $("restart").addEventListener("click",reset);
  $("play-again").addEventListener("click",reset);
  ui.cameraMode.addEventListener("click",()=>setCameraMode(!camera.manual));
  ui.cameraReset.addEventListener("click",()=>setCameraMode(false));
  window.addEventListener("keydown",e=>{
    if(e.target instanceof HTMLInputElement)return;
    const key=e.key.toLowerCase();
    if(["arrowleft","arrowright","arrowup","arrowdown"," ","enter"].includes(key))e.preventDefault();
    if(e.repeat&&[" ","enter","j"].includes(key))return;
    switch(key){
      case "a":case "arrowleft":walk(-1);break;
      case "d":case "arrowright":walk(1);break;
      case "w":case "arrowup":setAngle(angle+3);break;
      case "s":case "arrowdown":setAngle(angle-3);break;
      case "j":jump();break;
      case "1":selectWeapon("launcher");break;
      case "2":selectWeapon("rifle");break;
      case "3":selectWeapon("cluster");break;
      case "4":selectWeapon("artillery");break;
      case " ":case "enter":fire();break;
      case "r":reset();break;
      case "c":setCameraMode(!camera.manual);break;
      case "f":setCameraMode(false);break;
    }
  });

  reset();
  requestAnimationFrame(frame);
})();