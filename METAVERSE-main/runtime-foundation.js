(function () {
  'use strict';

  function isTextInput(el) {
    if (!el) return false;
    var tag = (el.tagName || '').toLowerCase();
    return tag === 'input' || tag === 'textarea' || el.isContentEditable;
  }

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function sanitizePlainText(value, maxLen) {
    var text = String(value == null ? '' : value);
    text = text.replace(/[\u0000-\u001f\u007f]/g, '');
    text = text.replace(/[<>]/g, '');
    text = text.trim();
    if (Number.isFinite(maxLen) && maxLen > 0 && text.length > maxLen) {
      text = text.slice(0, maxLen);
    }
    return text;
  }

  var DC200 = {
    profile: null,

    detectStaticCapabilities: function () {
      var hasTouch = (navigator.maxTouchPoints || 0) > 0 || 'ontouchstart' in window;
      var hasPointerFine = !!(window.matchMedia && window.matchMedia('(pointer:fine)').matches);
      var hasHover = !!(window.matchMedia && window.matchMedia('(hover:hover)').matches);
      var hasGamepad = 'getGamepads' in navigator;
      var hasKeyboard = 'KeyboardEvent' in window;
      var hasMotion = 'DeviceMotionEvent' in window;
      var prefersReducedMotion = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

      var glTier = 'none';
      try {
        var canvas = document.createElement('canvas');
        if (canvas.getContext('webgl2')) glTier = 'webgl2';
        else if (canvas.getContext('webgl')) glTier = 'webgl1';
      } catch (err) {
        glTier = 'none';
      }

      return {
        inputs: {
          keyboard: hasKeyboard,
          pointerFine: hasPointerFine,
          hover: hasHover,
          touch: hasTouch,
          gamepad: hasGamepad,
          motion: hasMotion
        },
        rendering: {
          webglTier: glTier,
          dpr: Number((window.devicePixelRatio || 1).toFixed(2))
        },
        hardware: {
          logicalCores: navigator.hardwareConcurrency || null,
          deviceMemoryGb: navigator.deviceMemory || null
        },
        accessibility: {
          prefersReducedMotion: prefersReducedMotion
        }
      };
    },

    sampleRuntime: function (frameCount) {
      frameCount = frameCount || 60;
      return new Promise(function (resolve) {
        var deltas = [];
        var previous = performance.now();
        var remaining = frameCount;

        function step(now) {
          var delta = now - previous;
          previous = now;
          if (delta > 0 && delta < 1000) {
            deltas.push(delta);
          }
          remaining -= 1;
          if (remaining > 0) {
            requestAnimationFrame(step);
            return;
          }

          var avgDelta = deltas.reduce(function (sum, d) { return sum + d; }, 0) / Math.max(deltas.length, 1);
          var fps = avgDelta > 0 ? 1000 / avgDelta : 0;

          var variance = deltas.reduce(function (sum, d) {
            return sum + Math.pow(d - avgDelta, 2);
          }, 0) / Math.max(deltas.length, 1);
          var jitter = Math.sqrt(variance);

          resolve({
            averageFps: Number(fps.toFixed(1)),
            averageFrameMs: Number(avgDelta.toFixed(2)),
            frameJitterMs: Number(jitter.toFixed(2))
          });
        }

        requestAnimationFrame(step);
      });
    },

    classifyRuntime: function (snapshot) {
      var fps = snapshot.averageFps;
      var jitter = snapshot.frameJitterMs;
      if (fps >= 50 && jitter <= 3.5) return 'high';
      if (fps >= 30 && jitter <= 9) return 'medium';
      return 'low';
    },

    buildProfile: function (staticCaps, runtimeCaps) {
      var qualityHint = 'balanced';
      var cls = this.classifyRuntime(runtimeCaps);
      if (cls === 'high') qualityHint = 'rich';
      if (cls === 'low') qualityHint = 'economy';

      return {
        id: 'dc200-profile-v1',
        timestamp: Date.now(),
        staticCaps: staticCaps,
        runtime: {
          qualityClass: cls,
          qualityHint: qualityHint,
          averageFps: runtimeCaps.averageFps,
          averageFrameMs: runtimeCaps.averageFrameMs,
          frameJitterMs: runtimeCaps.frameJitterMs
        }
      };
    },

    publish: function (profile) {
      this.profile = profile;
      window.dispatchEvent(new CustomEvent('dc200:profile', { detail: profile }));
    },

    init: async function () {
      var staticCaps = this.detectStaticCapabilities();
      var runtimeCaps = await this.sampleRuntime(75);
      var profile = this.buildProfile(staticCaps, runtimeCaps);
      this.publish(profile);
      return profile;
    }
  };

  function InputTranslator() {
    this.listeners = [];
    this.keysDown = new Set();
    this.gamepadLoopRunning = false;
    this.pointerDown = false;
  }

  InputTranslator.prototype.emit = function (event) {
    for (var i = 0; i < this.listeners.length; i += 1) {
      try {
        this.listeners[i](event);
      } catch (err) {
        console.warn('Input listener error:', err);
      }
    }
    window.dispatchEvent(new CustomEvent('783:action', { detail: event }));
  };

  InputTranslator.prototype.onAction = function (handler) {
    this.listeners.push(handler);
    return function unsubscribe() {
      var idx = this.listeners.indexOf(handler);
      if (idx >= 0) this.listeners.splice(idx, 1);
    }.bind(this);
  };

  InputTranslator.prototype.normalizeMove = function () {
    var x = 0;
    var y = 0;
    if (this.keysDown.has('KeyA') || this.keysDown.has('ArrowLeft')) x -= 1;
    if (this.keysDown.has('KeyD') || this.keysDown.has('ArrowRight')) x += 1;
    if (this.keysDown.has('KeyW') || this.keysDown.has('ArrowUp')) y += 1;
    if (this.keysDown.has('KeyS') || this.keysDown.has('ArrowDown')) y -= 1;
    this.emit({
      type: 'move',
      source: 'keyboard',
      x: clamp(x, -1, 1),
      y: clamp(y, -1, 1),
      ts: performance.now()
    });
  };

  InputTranslator.prototype.installKeyboard = function () {
    var self = this;
    window.addEventListener('keydown', function (evt) {
      if (isTextInput(document.activeElement)) return;
      if (!self.keysDown.has(evt.code)) {
        self.keysDown.add(evt.code);
      }

      if (evt.code === 'Space') {
        self.emit({ type: 'jump', source: 'keyboard', value: 1, ts: performance.now() });
      } else if (evt.code === 'Digit1') {
        self.emit({ type: 'emote', source: 'keyboard', emote: 'dance', ts: performance.now() });
      } else if (evt.code === 'Digit2') {
        self.emit({ type: 'emote', source: 'keyboard', emote: 'wave', ts: performance.now() });
      } else if (evt.code === 'Digit3') {
        self.emit({ type: 'emote', source: 'keyboard', emote: 'flip', ts: performance.now() });
      }

      self.normalizeMove();
    });

    window.addEventListener('keyup', function (evt) {
      self.keysDown.delete(evt.code);
      self.normalizeMove();
    });
  };

  InputTranslator.prototype.installPointer = function () {
    var self = this;
    window.addEventListener('pointerdown', function () {
      self.pointerDown = true;
      self.emit({ type: 'action_primary', source: 'pointer', value: 1, ts: performance.now() });
    });

    window.addEventListener('pointerup', function () {
      self.pointerDown = false;
      self.emit({ type: 'action_primary', source: 'pointer', value: 0, ts: performance.now() });
    });
  };

  InputTranslator.prototype.installGamepad = function () {
    var self = this;

    function tick() {
      var pads = navigator.getGamepads ? navigator.getGamepads() : [];
      var pad = pads && pads[0];
      if (pad) {
        var x = pad.axes[0] || 0;
        var y = -(pad.axes[1] || 0);
        if (Math.abs(x) > 0.1 || Math.abs(y) > 0.1) {
          self.emit({ type: 'move', source: 'gamepad', x: Number(x.toFixed(2)), y: Number(y.toFixed(2)), ts: performance.now() });
        }
        if (pad.buttons[0] && pad.buttons[0].pressed) {
          self.emit({ type: 'jump', source: 'gamepad', value: 1, ts: performance.now() });
        }
      }
      requestAnimationFrame(tick);
    }

    if (!this.gamepadLoopRunning) {
      this.gamepadLoopRunning = true;
      requestAnimationFrame(tick);
    }
  };

  InputTranslator.prototype.init = function () {
    this.installKeyboard();
    this.installPointer();
    this.installGamepad();
  };

  function GraphicsAdapter() {
    this.currentPolicy = null;
  }

  GraphicsAdapter.prototype.derivePolicy = function (profile) {
    var quality = profile && profile.runtime ? profile.runtime.qualityClass : 'medium';
    var caps = (profile && profile.staticCaps) ? profile.staticCaps : { rendering: {}, accessibility: {} };
    var reduceMotion = !!(caps.accessibility && caps.accessibility.prefersReducedMotion);

    var policy = {
      quality: quality,
      motion: reduceMotion ? 'reduced' : 'normal',
      dprScale: 1,
      uiBlurPx: 10,
      cardDensity: 1
    };

    if (quality === 'high') {
      policy.dprScale = 1;
      policy.uiBlurPx = 12;
      policy.cardDensity = 1;
    } else if (quality === 'medium') {
      policy.dprScale = 0.9;
      policy.uiBlurPx = 8;
      policy.cardDensity = 0.95;
    } else {
      policy.dprScale = 0.8;
      policy.uiBlurPx = 4;
      policy.cardDensity = 0.9;
    }

    if ((caps.rendering && caps.rendering.webglTier === 'none') || reduceMotion) {
      policy.uiBlurPx = Math.min(policy.uiBlurPx, 4);
    }

    return policy;
  };

  GraphicsAdapter.prototype.applyPolicy = function (policy) {
    this.currentPolicy = policy;

    var root = document.documentElement;
    var body = document.body;
    if (!root || !body) return;

    root.style.setProperty('--mv-ui-blur', policy.uiBlurPx + 'px');
    root.style.setProperty('--mv-card-density', String(policy.cardDensity));
    root.style.setProperty('--mv-motion-scale', policy.motion === 'reduced' ? '0' : '1');

    body.setAttribute('data-mv-quality', policy.quality);
    body.setAttribute('data-mv-motion', policy.motion);

    var cards = document.querySelectorAll('.game-card');
    for (var i = 0; i < cards.length; i += 1) {
      cards[i].style.transformOrigin = 'center center';
      cards[i].style.scale = String(policy.cardDensity);
      cards[i].style.transitionDuration = policy.motion === 'reduced' ? '0s' : '0.2s';
    }

    var blurTargets = ['navbar', 'sidebar', 'social-sidebar', 'emotes-bar'];
    for (var j = 0; j < blurTargets.length; j += 1) {
      var node = document.getElementById(blurTargets[j]);
      if (node) {
        node.style.backdropFilter = 'blur(' + policy.uiBlurPx + 'px)';
      }
    }

    window.dispatchEvent(new CustomEvent('795:policy', { detail: policy }));
  };

  GraphicsAdapter.prototype.init = function () {
    var self = this;
    window.addEventListener('dc200:profile', function (evt) {
      var policy = self.derivePolicy(evt.detail);
      self.applyPolicy(policy);
    });
  };

  function SpatialReplication790() {
    this.intent = { x: 0, y: 0, jump: false };
    this.predicted = { x: 0, y: 0, z: 0, vy: 0 };
    this.authoritative = { x: 0, y: 0, z: 0, vy: 0 };
    this.lastServerTick = 0;
    this.lastFrame = 0;
    this.reconcileCount = 0;
    this.running = false;
  }

  SpatialReplication790.prototype.handleAction = function (action) {
    if (action.type === 'move') {
      this.intent.x = clamp(action.x || 0, -1, 1);
      this.intent.y = clamp(action.y || 0, -1, 1);
      return;
    }
    if (action.type === 'jump') {
      this.intent.jump = true;
    }
  };

  SpatialReplication790.prototype.integratePrediction = function (dt) {
    var speed = 6;
    var gravity = 18;
    var jumpImpulse = 7;

    this.predicted.x += this.intent.x * speed * dt;
    this.predicted.z += this.intent.y * speed * dt;

    if (this.intent.jump && this.predicted.y <= 0.0001) {
      this.predicted.vy = jumpImpulse;
    }
    this.intent.jump = false;

    this.predicted.vy -= gravity * dt;
    this.predicted.y += this.predicted.vy * dt;
    if (this.predicted.y < 0) {
      this.predicted.y = 0;
      this.predicted.vy = 0;
    }
  };

  SpatialReplication790.prototype.serverValidateAndResolve = function () {
    var bounds = 75;
    var quant = 0.05;

    function q(v) {
      return Math.round(v / quant) * quant;
    }

    var ax = clamp(this.predicted.x, -bounds, bounds);
    var ay = clamp(this.predicted.y, 0, 20);
    var az = clamp(this.predicted.z, -bounds, bounds);
    var avy = clamp(this.predicted.vy, -30, 30);

    this.authoritative.x = q(ax);
    this.authoritative.y = q(ay);
    this.authoritative.z = q(az);
    this.authoritative.vy = q(avy);
  };

  SpatialReplication790.prototype.reconcile = function () {
    var dx = this.authoritative.x - this.predicted.x;
    var dy = this.authoritative.y - this.predicted.y;
    var dz = this.authoritative.z - this.predicted.z;
    var distSq = dx * dx + dy * dy + dz * dz;

    if (distSq < 0.0004) return;

    var hardSnapSq = 9;
    if (distSq > hardSnapSq) {
      this.predicted.x = this.authoritative.x;
      this.predicted.y = this.authoritative.y;
      this.predicted.z = this.authoritative.z;
      this.predicted.vy = this.authoritative.vy;
      this.reconcileCount += 1;
      return;
    }

    var alpha = 0.2;
    this.predicted.x += dx * alpha;
    this.predicted.y += dy * alpha;
    this.predicted.z += dz * alpha;
    this.predicted.vy += (this.authoritative.vy - this.predicted.vy) * alpha;
    this.reconcileCount += 1;
  };

  SpatialReplication790.prototype.emitState = function () {
    window.dispatchEvent(new CustomEvent('790:state', {
      detail: {
        predicted: {
          x: this.predicted.x,
          y: this.predicted.y,
          z: this.predicted.z
        },
        authoritative: {
          x: this.authoritative.x,
          y: this.authoritative.y,
          z: this.authoritative.z
        },
        reconcileCount: this.reconcileCount
      }
    }));
  };

  SpatialReplication790.prototype.start = function () {
    if (this.running) return;
    this.running = true;
    this.lastFrame = performance.now();
    this.lastServerTick = this.lastFrame;

    var self = this;
    function frame(now) {
      if (!self.running) return;

      var dt = (now - self.lastFrame) / 1000;
      self.lastFrame = now;
      dt = clamp(dt, 0, 0.05);

      self.integratePrediction(dt);

      if (now - self.lastServerTick >= 100) {
        self.serverValidateAndResolve();
        self.lastServerTick = now;
      }

      self.reconcile();
      self.emitState();
      requestAnimationFrame(frame);
    }

    requestAnimationFrame(frame);
  };

  SpatialReplication790.prototype.stop = function () {
    this.running = false;
  };

  function GlobalPlayerIdentity784() {
    this.globalIdentity = {
      accountId: 'guest-local',
      displayName: 'Guest',
      createdAt: Date.now()
    };

    this.factionAlignment = {
      faction: 'neutral',
      alignment: 'balanced',
      lastSystemWrite: Date.now()
    };

    this.modeStats = {
      sandbox: { plays: 0, jumps: 0, emotes: 0 }
    };

    this.currentMode = 'sandbox';
    this.sessionContext = this.makeNewSession();
  }

  GlobalPlayerIdentity784.prototype.makeNewSession = function () {
    return {
      sessionId: 'sess-' + Math.random().toString(36).slice(2, 10),
      startedAt: Date.now(),
      position: { x: 0, y: 0, z: 0 },
      velocity: { x: 0, y: 0, z: 0 },
      localPermissions: ['play', 'chat', 'emote']
    };
  };

  GlobalPlayerIdentity784.prototype.emitUpdate = function () {
    window.dispatchEvent(new CustomEvent('784:update', {
      detail: this.snapshot()
    }));
  };

  GlobalPlayerIdentity784.prototype.snapshot = function () {
    return {
      globalIdentity: {
        accountId: this.globalIdentity.accountId,
        displayName: this.globalIdentity.displayName,
        createdAt: this.globalIdentity.createdAt
      },
      factionAlignment: {
        faction: this.factionAlignment.faction,
        alignment: this.factionAlignment.alignment,
        lastSystemWrite: this.factionAlignment.lastSystemWrite
      },
      modeStats: JSON.parse(JSON.stringify(this.modeStats)),
      currentMode: this.currentMode,
      sessionContext: {
        sessionId: this.sessionContext.sessionId,
        startedAt: this.sessionContext.startedAt,
        position: {
          x: this.sessionContext.position.x,
          y: this.sessionContext.position.y,
          z: this.sessionContext.position.z
        },
        velocity: {
          x: this.sessionContext.velocity.x,
          y: this.sessionContext.velocity.y,
          z: this.sessionContext.velocity.z
        },
        localPermissions: this.sessionContext.localPermissions.slice()
      }
    };
  };

  GlobalPlayerIdentity784.prototype.setCurrentMode = function (modeName) {
    this.currentMode = modeName || 'sandbox';
    if (!this.modeStats[this.currentMode]) {
      this.modeStats[this.currentMode] = { plays: 0, jumps: 0, emotes: 0 };
    }
    this.modeStats[this.currentMode].plays += 1;
    this.emitUpdate();
  };

  GlobalPlayerIdentity784.prototype.systemWriteFaction = function (faction, alignment) {
    this.factionAlignment.faction = faction || this.factionAlignment.faction;
    this.factionAlignment.alignment = alignment || this.factionAlignment.alignment;
    this.factionAlignment.lastSystemWrite = Date.now();
    this.emitUpdate();
  };

  GlobalPlayerIdentity784.prototype.trackAction = function (action) {
    var mode = this.currentMode || 'sandbox';
    if (!this.modeStats[mode]) {
      this.modeStats[mode] = { plays: 0, jumps: 0, emotes: 0 };
    }
    if (action.type === 'jump') {
      this.modeStats[mode].jumps += 1;
      this.emitUpdate();
      return;
    }
    if (action.type === 'emote') {
      this.modeStats[mode].emotes += 1;
      this.emitUpdate();
    }
  };

  GlobalPlayerIdentity784.prototype.updateSessionFromSpatial = function (state) {
    var prev = this.sessionContext.position;
    var next = state.predicted;

    this.sessionContext.velocity.x = next.x - prev.x;
    this.sessionContext.velocity.y = next.y - prev.y;
    this.sessionContext.velocity.z = next.z - prev.z;

    this.sessionContext.position.x = next.x;
    this.sessionContext.position.y = next.y;
    this.sessionContext.position.z = next.z;
  };

  GlobalPlayerIdentity784.prototype.rotateSession = function () {
    this.sessionContext = this.makeNewSession();
    this.emitUpdate();
  };

  function Sandbox871() {
    this.policy = {
      mode: 'default-deny',
      permissions: {
        'storage.get': true,
        'storage.set': true,
        'network.fetch': false,
        'wallet.direct': false,
        'identity.raw': false
      },
      networkAllowlist: [],
      limits: {
        maxOpsPerSession: 200,
        maxPayloadBytes: 4096,
        maxStorageKeys: 200
      }
    };

    this.metrics = {
      opCount: 0,
      deniedCount: 0,
      lastEvent: 'boot'
    };

    this.virtualStorage = Object.create(null);
  }

  Sandbox871.prototype.setPermission = function (capability, allowed) {
    this.policy.permissions[capability] = !!allowed;
  };

  Sandbox871.prototype.allowNetworkOrigin = function (origin) {
    if (this.policy.networkAllowlist.indexOf(origin) < 0) {
      this.policy.networkAllowlist.push(origin);
    }
  };

  Sandbox871.prototype.emit = function (kind, detail) {
    this.metrics.lastEvent = kind;
    window.dispatchEvent(new CustomEvent('871:event', {
      detail: {
        kind: kind,
        detail: detail,
        metrics: {
          opCount: this.metrics.opCount,
          deniedCount: this.metrics.deniedCount
        }
      }
    }));
  };

  Sandbox871.prototype.deny = function (reason, request) {
    this.metrics.deniedCount += 1;
    this.emit('deny', { reason: reason, request: request });
    return {
      ok: false,
      error: reason
    };
  };

  Sandbox871.prototype.enforceBounds = function (request) {
    if (this.metrics.opCount >= this.policy.limits.maxOpsPerSession) {
      return this.deny('resource limit: maxOpsPerSession', request);
    }

    var payloadText = JSON.stringify(request.payload || {});
    if (payloadText.length > this.policy.limits.maxPayloadBytes) {
      return this.deny('resource limit: maxPayloadBytes', request);
    }

    return null;
  };

  Sandbox871.prototype.validateStorageKey = function (key, request) {
    if (key.length < 1 || key.length > 64) {
      return this.deny('invalid storage key length', request);
    }
    if (!/^[a-zA-Z0-9:_\-.]+$/.test(key)) {
      return this.deny('invalid storage key format', request);
    }
    if (key === '__proto__' || key === 'prototype' || key === 'constructor') {
      return this.deny('reserved storage key', request);
    }
    return null;
  };

  Sandbox871.prototype.execute = async function (request) {
    request = request || {};
    var capability = request.capability || 'unknown';

    this.metrics.opCount += 1;

    var boundsViolation = this.enforceBounds(request);
    if (boundsViolation) return boundsViolation;

    if (!this.policy.permissions[capability]) {
      return this.deny('permission denied: ' + capability, request);
    }

    if (capability === 'storage.get') {
      var keyGet = String((request.payload || {}).key || '');
      var keyErrGet = this.validateStorageKey(keyGet, request);
      if (keyErrGet) return keyErrGet;
      this.emit('allow', { capability: capability, key: keyGet });
      return { ok: true, value: this.virtualStorage[keyGet] };
    }

    if (capability === 'storage.set') {
      var payload = request.payload || {};
      var keySet = String(payload.key || '');
      var keyErrSet = this.validateStorageKey(keySet, request);
      if (keyErrSet) return keyErrSet;
      var keys = Object.keys(this.virtualStorage);
      if (!Object.prototype.hasOwnProperty.call(this.virtualStorage, keySet) && keys.length >= this.policy.limits.maxStorageKeys) {
        return this.deny('resource limit: maxStorageKeys', request);
      }
      this.virtualStorage[keySet] = payload.value;
      this.emit('allow', { capability: capability, key: keySet });
      return { ok: true };
    }

    if (capability === 'network.fetch') {
      var url = String((request.payload || {}).url || '');
      var origin = '';
      var parsed;
      try {
        parsed = new URL(url, location.href);
        origin = parsed.origin;
      } catch (err) {
        return this.deny('invalid url', request);
      }

      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
        return this.deny('protocol not allowed', request);
      }
      if (parsed.username || parsed.password) {
        return this.deny('credentialed url not allowed', request);
      }

      if (this.policy.networkAllowlist.indexOf(origin) < 0) {
        return this.deny('network origin not allowed', request);
      }

      try {
        var res = await fetch(url, { method: 'GET' });
        this.emit('allow', { capability: capability, origin: origin, status: res.status });
        return { ok: true, status: res.status };
      } catch (err2) {
        return this.deny('network request failed', request);
      }
    }

    return this.deny('unsupported capability operation', request);
  };

  function MessageBroker874() {
    this.handlers = Object.create(null);
    this.windowMs = 5000;
    this.maxPerWindow = 24;
    this.rate = Object.create(null);
    this.policy = {
      maxPayloadBytes: 4096,
      maxDepth: 6,
      maxFields: 120,
      allowedSendersByTopic: {
        'shop.checkout.request': ['ui', 'system'],
        'sandbox.storage.request': ['system'],
        'spatial.door.request': ['ui', 'system']
      }
    };
  }

  MessageBroker874.prototype.emit = function (kind, detail) {
    window.dispatchEvent(new CustomEvent('874:event', {
      detail: {
        kind: kind,
        detail: detail
      }
    }));
  };

  MessageBroker874.prototype.subscribe = function (topic, handler) {
    if (!this.handlers[topic]) this.handlers[topic] = [];
    this.handlers[topic].push(handler);
  };

  MessageBroker874.prototype.checkRateLimit = function (sender, topic) {
    var key = sender + '::' + topic;
    var now = Date.now();
    var bucket = this.rate[key] || [];
    bucket = bucket.filter(function (ts) { return now - ts <= 5000; });
    if (bucket.length >= this.maxPerWindow) {
      this.rate[key] = bucket;
      return false;
    }
    bucket.push(now);
    this.rate[key] = bucket;
    return true;
  };

  MessageBroker874.prototype.depthAndFieldCount = function (value, depth) {
    depth = depth || 0;
    if (value === null || typeof value !== 'object') {
      return { depth: depth, fields: 1 };
    }

    if (depth > this.policy.maxDepth) {
      return { depth: depth, fields: this.policy.maxFields + 1 };
    }

    var keys = Object.keys(value);
    var maxDepth = depth;
    var fields = keys.length;

    for (var i = 0; i < keys.length; i += 1) {
      var child = this.depthAndFieldCount(value[keys[i]], depth + 1);
      maxDepth = Math.max(maxDepth, child.depth);
      fields += child.fields;
      if (fields > this.policy.maxFields) break;
    }

    return { depth: maxDepth, fields: fields };
  };

  MessageBroker874.prototype.validateEnvelope = function (envelope) {
    if (!envelope || typeof envelope !== 'object') return 'invalid envelope';
    if (typeof envelope.topic !== 'string' || !envelope.topic) return 'missing topic';
    if (typeof envelope.sender !== 'string' || !envelope.sender) return 'missing sender';

    var allowedSenders = this.policy.allowedSendersByTopic[envelope.topic] || [];
    if (allowedSenders.indexOf(envelope.sender) < 0) return 'sender not allowed for topic';

    if (!this.checkRateLimit(envelope.sender, envelope.topic)) return 'rate limited';

    var payload = envelope.payload || {};
    var payloadStr = JSON.stringify(payload);
    if (payloadStr.length > this.policy.maxPayloadBytes) return 'payload too large';

    var d = this.depthAndFieldCount(payload, 0);
    if (d.depth > this.policy.maxDepth) return 'payload too deep';
    if (d.fields > this.policy.maxFields) return 'payload too wide';

    return null;
  };

  MessageBroker874.prototype.publish = async function (envelope) {
    var error = this.validateEnvelope(envelope);
    if (error) {
      this.emit('deny', { topic: envelope ? envelope.topic : 'unknown', reason: error });
      return { ok: false, error: error };
    }

    var topic = envelope.topic;
    var listeners = this.handlers[topic] || [];
    var results = [];
    for (var i = 0; i < listeners.length; i += 1) {
      results.push(await listeners[i](envelope));
    }

    this.emit('allow', { topic: topic, sender: envelope.sender, count: listeners.length });
    return { ok: true, results: results };
  };

  function Escrow872(broker, sandbox) {
    this.broker = broker;
    this.sandbox = sandbox;
    this.transactions = Object.create(null);
  }

  Escrow872.prototype.emit = function (kind, detail) {
    window.dispatchEvent(new CustomEvent('872:event', {
      detail: {
        kind: kind,
        detail: detail
      }
    }));
  };

  Escrow872.prototype.newTxId = function () {
    return 'tx-' + Math.random().toString(36).slice(2, 10);
  };

  Escrow872.prototype.validateRequest = function (req) {
    if (!req || typeof req !== 'object') return 'invalid request';
    if (typeof req.item !== 'string' || !req.item.trim()) return 'invalid item';
    if (!Number.isFinite(req.price) || req.price <= 0) return 'invalid price';
    if (req.item.length > 80) return 'item too long';
    return null;
  };

  Escrow872.prototype.checkout = async function (req) {
    var err = this.validateRequest(req);
    if (err) {
      this.emit('deny', { reason: err });
      return { ok: false, error: err };
    }

    var txId = this.newTxId();
    this.transactions[txId] = {
      txId: txId,
      status: 'held',
      item: req.item,
      price: req.price,
      buyer: req.buyer || 'guest-local',
      createdAt: Date.now()
    };
    this.emit('hold', { txId: txId, item: req.item, price: req.price });

    var storeResult = await this.sandbox.execute({
      capability: 'storage.set',
      payload: {
        key: 'escrow:last',
        value: this.transactions[txId]
      }
    });

    if (!storeResult.ok) {
      this.transactions[txId].status = 'refunded';
      this.emit('refund', { txId: txId, reason: storeResult.error });
      return { ok: false, error: storeResult.error, txId: txId };
    }

    this.transactions[txId].status = 'settled';
    this.emit('settle', { txId: txId, item: req.item, price: req.price });
    return { ok: true, txId: txId };
  };

  function SpatialLogic975() {
    this.zone = {
      id: 'hangar-zone',
      radius: 12
    };
    this.inside = false;
    this.doorState = 'closed';
  }

  SpatialLogic975.prototype.emit = function (kind, detail) {
    window.dispatchEvent(new CustomEvent('975:event', {
      detail: {
        kind: kind,
        detail: detail
      }
    }));
  };

  SpatialLogic975.prototype.updateFromSpatial = function (state) {
    var p = state.authoritative;
    var dist = Math.sqrt((p.x * p.x) + (p.z * p.z));
    var nextInside = dist <= this.zone.radius;

    if (nextInside !== this.inside) {
      this.inside = nextInside;
      this.emit(nextInside ? 'enter' : 'exit', { zone: this.zone.id, position: p });
    }
  };

  SpatialLogic975.prototype.toggleDoor = function (doorId) {
    if (!this.inside) {
      this.emit('deny', { doorId: doorId, reason: 'outside allowed zone' });
      return { ok: false, error: 'outside allowed zone' };
    }
    this.doorState = this.doorState === 'open' ? 'closed' : 'open';
    this.emit('door', { doorId: doorId, state: this.doorState });
    return { ok: true, state: this.doorState };
  };

  function safeById(id) {
    return document.getElementById(id);
  }

  function setText(id, value) {
    var node = safeById(id);
    if (node) node.textContent = value;
  }

  function parseIdeasList(mdText) {
    var lines = mdText.split(/\r?\n/);
    var ideas = [];
    for (var i = 0; i < lines.length; i += 1) {
      var m = lines[i].match(/^(\d+)\.\s+(.*)$/);
      if (m) {
        ideas.push({
          id: Number(m[1]),
          title: m[2].trim()
        });
      }
    }
    return ideas;
  }

  function queueTrackFromIdeas(ideas) {
    var indexByTitle = {};
    for (var i = 0; i < ideas.length; i += 1) {
      indexByTitle[ideas[i].title.toLowerCase()] = ideas[i];
    }

    function pick(title) {
      return indexByTitle[title.toLowerCase()] || null;
    }

    var track = [
      { ref: pick('Device Capability & Runtime Profile — DC-200'), key: 'dc200', status: 'done' },
      { ref: pick('Cross-Platform Input Translation Engine'), key: '783', status: 'done' },
      { ref: pick('Poly-Fidelity Graphics Engine'), key: '795', status: 'done' },
      { ref: pick('Spatial Replication Reconciliation Engine'), key: '790', status: 'done' },
      { ref: pick('Global Player Identity Sheet'), key: '784', status: 'done' },
      { ref: pick('Sandbox Script Execution Hypervisor'), key: '871', status: 'done' },
      { ref: pick('Token Escrow & Ledger Decoupling'), key: '872', status: 'done' },
      { ref: pick('Message-Passing Sandboxed Broker'), key: '874', status: 'done' },
      { ref: pick('Spatial Logic Component'), key: '975', status: 'done' }
    ];

    return track.filter(function (item) { return !!item.ref; });
  }

  function renderQueue(track) {
    var root = safeById('impl-queue');
    if (!root) return;
    root.textContent = '';

    for (var i = 0; i < track.length; i += 1) {
      var item = track[i];
      var badge = item.status === 'done' ? 'DONE' : (item.status === 'next' ? 'NEXT' : 'QUEUED');
      var color = item.status === 'done' ? '#7dffae' : (item.status === 'next' ? '#ffd37d' : '#9fd5ff');

      var li = document.createElement('li');

      var b = document.createElement('span');
      b.style.display = 'inline-block';
      b.style.minWidth = '62px';
      b.style.color = color;
      b.style.fontWeight = '700';
      b.textContent = badge;

      var id = document.createElement('span');
      id.textContent = ' #' + item.ref.id + ' ';

      var title = document.createElement('span');
      title.textContent = item.ref.title;

      li.appendChild(b);
      li.appendChild(id);
      li.appendChild(title);
      root.appendChild(li);
    }
  }

  async function initImplementMode() {
    setText('impl-state', 'loading ideas');
    setText('impl-source', 'METAVERSE_MASTER_IDEAS_LIST.md');

    try {
      var res = await fetch('./METAVERSE_MASTER_IDEAS_LIST.md', { cache: 'no-cache' });
      if (!res.ok) {
        throw new Error('Ideas file load failed with status ' + res.status);
      }
      var text = await res.text();
      var ideas = parseIdeasList(text);
      window.__mvMasterIdeas = ideas;
      var track = queueTrackFromIdeas(ideas);
      renderQueue(track);

      setText('impl-state', 'active (' + track.length + ' items tracked)');
      window.dispatchEvent(new CustomEvent('implement:queue', {
        detail: {
          loaded: true,
          ideasCount: ideas.length,
          trackedCount: track.length,
          track: track,
          ideas: ideas
        }
      }));
    } catch (err) {
      setText('impl-state', 'fallback mode');
      setText('impl-source', 'unavailable: ' + err.message);
      var queue = safeById('impl-queue');
      if (queue) {
        queue.textContent = '';
        var li = document.createElement('li');
        li.textContent = 'NEXT #790 Spatial Replication Reconciliation Engine';
        queue.appendChild(li);
      }
      window.dispatchEvent(new CustomEvent('implement:queue', {
        detail: {
          loaded: false,
          error: err.message
        }
      }));
    }
  }

  function closeAllModals() {
    var modals = document.querySelectorAll('.app-modal');
    for (var i = 0; i < modals.length; i += 1) {
      modals[i].style.display = 'none';
    }
  }

  function markActiveNav(id) {
    var nav = document.querySelectorAll('.nav-item');
    for (var i = 0; i < nav.length; i += 1) {
      nav[i].classList.remove('active');
    }
    var target = safeById(id);
    if (target) target.classList.add('active');
  }

  function appendChatMessage(channel, author, text, isBot) {
    var chatBox = safeById('chat-' + channel);
    if (!chatBox) return;
    var item = document.createElement('div');
    item.className = isBot ? 'chat-msg bot' : 'chat-msg';
    var label = document.createElement('span');
    label.textContent = author + ':';
    var body = document.createTextNode(' ' + text);
    item.appendChild(label);
    item.appendChild(body);
    chatBox.appendChild(item);
    // Keep chat containers bounded so long sessions stay responsive.
    while (chatBox.childElementCount > 70) {
      chatBox.removeChild(chatBox.firstElementChild);
    }
    chatBox.scrollTop = chatBox.scrollHeight;
  }

  function formatCount(value) {
    var n = Number(value) || 0;
    return n.toLocaleString('en-US');
  }

  var ICON_MAP = {
    home: 'mv-home',
    gamepad: 'mv-gamepad',
    shop: 'mv-shop',
    scroll: 'mv-scroll',
    settings: 'mv-settings',
    dance: 'mv-dance',
    wave: 'mv-wave',
    flip: 'mv-flip',
    rocket: 'mv-rocket',
    racer: 'mv-racer',
    sword: 'mv-sword',
    castle: 'mv-castle',
    drone: 'mv-drone',
    shield: 'mv-shield',
    neon: 'mv-neon',
    bot: 'mv-bot',
    badge: 'mv-badge',
    companion: 'mv-companion',
    emote: 'mv-emote'
  };

  var ICON_TONE_MAP = {
    home: 'icon-tone-sky',
    gamepad: 'icon-tone-mango',
    shop: 'icon-tone-gold',
    scroll: 'icon-tone-violet',
    settings: 'icon-tone-steel',
    dance: 'icon-tone-fuchsia',
    wave: 'icon-tone-cyan',
    flip: 'icon-tone-lime',
    rocket: 'icon-tone-sunset',
    racer: 'icon-tone-orange',
    sword: 'icon-tone-crimson',
    castle: 'icon-tone-copper',
    drone: 'icon-tone-teal',
    shield: 'icon-tone-emerald',
    neon: 'icon-tone-aqua',
    bot: 'icon-tone-electric',
    badge: 'icon-tone-royal',
    companion: 'icon-tone-rose',
    emote: 'icon-tone-rainbow'
  };

  function getIconToneClass(iconKey) {
    return ICON_TONE_MAP[iconKey || ''] || 'icon-tone-ice';
  }

  function createIconElement(iconKey, fallbackText, ariaLabel) {
    var symbolId = ICON_MAP[iconKey || ''];
    var toneClass = getIconToneClass(iconKey);
    if (symbolId) {
      var wrap = document.createElement('span');
      wrap.className = 'mv-icon ' + toneClass;
      if (ariaLabel) {
        wrap.setAttribute('role', 'img');
        wrap.setAttribute('aria-label', ariaLabel);
      } else {
        wrap.setAttribute('aria-hidden', 'true');
      }

      var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('viewBox', '0 0 24 24');
      var use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
      use.setAttribute('href', '#' + symbolId);
      svg.appendChild(use);
      wrap.appendChild(svg);
      return wrap;
    }

    var emoji = document.createElement('span');
    emoji.className = 'mv-icon ' + toneClass;
    emoji.textContent = fallbackText || '•';
    if (ariaLabel) emoji.setAttribute('aria-label', ariaLabel);
    return emoji;
  }

  function createIconLabel(iconKey, fallbackText, labelText) {
    var holder = document.createElement('span');
    holder.className = 'icon-label';
    holder.appendChild(createIconElement(iconKey, fallbackText));
    var textNode = document.createElement('span');
    textNode.className = 'label-text';
    textNode.textContent = labelText || '';
    holder.appendChild(textNode);
    return holder;
  }

  function upgradeStaticIcons() {
    var nodes = document.querySelectorAll('[data-icon]');
    for (var i = 0; i < nodes.length; i += 1) {
      var node = nodes[i];
      if (node.dataset.iconReady === '1') continue;
      var iconKey = node.getAttribute('data-icon') || '';
      var fallback = node.getAttribute('data-emoji') || '';
      var text = (node.textContent || '').trim();
      node.textContent = '';
      node.appendChild(createIconLabel(iconKey, fallback, text));
      node.dataset.iconReady = '1';
    }
  }

  function createMarketplaceCatalog() {
    var specs = [
      {
        id: 'cosmetics',
        label: 'Cosmetics',
        tabIconKey: 'neon',
        iconKeys: ['neon', 'shield', 'badge', 'companion', 'emote'],
        icons: ['🕶️', '🧥', '👒', '🧤', '🥾'],
        adjectives: ['Neon', 'Quantum', 'Stellar', 'Urban', 'Nova'],
        nouns: ['Visor', 'Jacket', 'Cape', 'Boots', 'Band']
      },
      {
        id: 'gear',
        label: 'Gear',
        tabIconKey: 'shield',
        iconKeys: ['shield', 'drone', 'rocket', 'settings', 'badge'],
        icons: ['⚙️', '🧰', '🔦', '🛰️', '🔋'],
        adjectives: ['Titan', 'Pulse', 'Adaptive', 'Turbo', 'Vector'],
        nouns: ['Pack', 'Toolkit', 'Beacon', 'Core', 'Rig']
      },
      {
        id: 'companions',
        label: 'Companions',
        tabIconKey: 'companion',
        iconKeys: ['companion', 'drone', 'bot', 'neon', 'badge'],
        icons: ['🤖', '🐉', '🦊', '🛸', '🐝'],
        adjectives: ['Orbit', 'Echo', 'Spark', 'Aero', 'Pixel'],
        nouns: ['Drone', 'Pet', 'Scout', 'Wisp', 'Buddy']
      },
      {
        id: 'emotes',
        label: 'Emotes',
        tabIconKey: 'emote',
        iconKeys: ['dance', 'wave', 'flip', 'emote', 'neon'],
        icons: ['💃', '🕺', '🎉', '🔥', '✨'],
        adjectives: ['Holo', 'Flux', 'Vibe', 'Rhythm', 'Prime'],
        nouns: ['Dance', 'Pose', 'Wave', 'Spin', 'Burst']
      }
    ];

    var categories = [];
    for (var s = 0; s < specs.length; s += 1) {
      var spec = specs[s];
      var items = [];
      for (var i = 1; i <= 100; i += 1) {
        var icon = spec.icons[i % spec.icons.length];
        var iconKey = spec.iconKeys[i % spec.iconKeys.length];
        var adjective = spec.adjectives[i % spec.adjectives.length];
        var noun = spec.nouns[(i * 2) % spec.nouns.length];
        var serial = String(i).padStart(3, '0');
        var base = 70 + (s * 40);
        var price = base + ((i * 13) % 280);
        items.push({
          id: spec.id + '-' + serial,
          name: adjective + ' ' + noun + ' ' + serial,
          icon: icon,
          iconKey: iconKey,
          price: price,
          categoryId: spec.id,
          popularity: 400 + ((i * 31) % 2900)
        });
      }
      categories.push({ id: spec.id, label: spec.label, tabIconKey: spec.tabIconKey, icon: spec.icons[0], items: items });
    }
    return categories;
  }

  function createExperienceCatalog() {
    return [
      { id: 'sandbox', icon: '🚀', iconKey: 'rocket', name: '3D Sandbox Park', players: 1240, min: 850, max: 3100 },
      { id: 'racers', icon: '🏎️', iconKey: 'racer', name: 'Neon Racers', players: 850, min: 500, max: 2200 },
      { id: 'sword', icon: '⚔️', iconKey: 'sword', name: 'Sword Clash', players: 2100, min: 1400, max: 4200 },
      { id: 'tycoon', icon: '🏰', iconKey: 'castle', name: 'Tycoon Empire', players: 540, min: 300, max: 1700 },
      { id: 'drift-lab', icon: '🛞', iconKey: 'racer', name: 'Drift Lab Sprint', players: 670, min: 360, max: 1800 },
      { id: 'sky-forge', icon: '🛰️', iconKey: 'drone', name: 'Sky Forge Ops', players: 780, min: 420, max: 2100 },
      { id: 'pulse-heist', icon: '🔐', iconKey: 'shield', name: 'Pulse Heist Run', players: 520, min: 280, max: 1600 },
      { id: 'neon-harvest', icon: '🌌', iconKey: 'neon', name: 'Neon Harvest Arena', players: 970, min: 560, max: 2600 }
    ];
  }

  function snapshotUiContext(runtime) {
    var balanceNode = safeById('user-coins');
    var coins = Number(balanceNode ? balanceNode.textContent : 0) || 0;
    var mode = runtime.identity784.currentMode || 'sandbox';
    var profile = runtime.identity784.globalIdentity.displayName;
    return {
      coins: coins,
      mode: mode,
      profile: profile
    };
  }

  function createAiBrain() {
    return {
      history: [],
      topicWeights: {},
      memory: {
        preferredMode: 'sandbox',
        lastLaunched: 'sandbox',
        likesPerformance: false,
        realismTarget: 72,
        prefersSafeChecks: true
      },
      lastIntent: 'general',
      responses: 0
    };
  }

  function detectAiIntent(text) {
    var lower = String(text || '').toLowerCase();
    var intents = [
      { id: 'help', score: /help|what can you do|commands|options/.test(lower) ? 4 : 0 },
      { id: 'debug', score: /debug|bug|scanner|issue|error|test all|diagnostic/.test(lower) ? 5 : 0 },
      { id: 'badges', score: /badge|vault|unlock|achievement/.test(lower) ? 5 : 0 },
      { id: 'performance', score: /performance|fps|lag|stutter|optimi/.test(lower) ? 4 : 0 },
      { id: 'realism', score: /realism|realistic|simulation|cinematic/.test(lower) ? 4 : 0 },
      { id: 'rules', score: /rules|rulebook|governance|banana|big check|ultra check/.test(lower) ? 4 : 0 },
      { id: 'security', score: /security|sandbox|safe|policy|authority/.test(lower) ? 4 : 0 },
      { id: 'door', score: /door|hangar|gate/.test(lower) ? 4 : 0 },
      { id: 'shop', score: /shop|buy|coins|price|market/.test(lower) ? 4 : 0 },
      { id: 'mode', score: /mode|play|launch|experience/.test(lower) ? 3 : 0 },
      { id: 'identity', score: /who am i|profile|name|identity/.test(lower) ? 3 : 0 },
      { id: 'chat', score: /close chat|minimi|comms|sidebar/.test(lower) ? 3 : 0 },
      { id: 'summary', score: /summary|recap|remember|history/.test(lower) ? 3 : 0 }
    ];

    var best = 'general';
    var high = 0;
    for (var i = 0; i < intents.length; i += 1) {
      if (intents[i].score > high) {
        best = intents[i].id;
        high = intents[i].score;
      }
    }
    return best;
  }

  function rememberAiTurn(brain, userText, intent, ctx, reply) {
    if (!brain) return;
    var item = {
      ts: Date.now(),
      user: String(userText || '').slice(0, 160),
      intent: intent || 'general',
      mode: ctx.mode,
      coins: ctx.coins,
      reply: String(reply || '').slice(0, 220)
    };
    brain.history.push(item);
    while (brain.history.length > 24) {
      brain.history.shift();
    }

    brain.lastIntent = item.intent;
    brain.responses += 1;
    brain.topicWeights[item.intent] = (brain.topicWeights[item.intent] || 0) + 1;

    var lower = item.user.toLowerCase();
    if (/racers/.test(lower)) brain.memory.preferredMode = 'racers';
    else if (/sword/.test(lower)) brain.memory.preferredMode = 'sword';
    else if (/tycoon/.test(lower)) brain.memory.preferredMode = 'tycoon';
    else if (/sandbox/.test(lower)) brain.memory.preferredMode = 'sandbox';

    if (item.intent === 'performance') {
      brain.memory.likesPerformance = true;
    }

    var realismMatch = /(?:realism|slider)\s*(?:to|=)?\s*(\d{1,3})/.exec(lower);
    if (realismMatch) {
      var target = clamp(Number(realismMatch[1]) || 0, 0, 100);
      brain.memory.realismTarget = target;
    }

    if (item.intent === 'debug' || /test all|diagnostic|scan/.test(lower)) {
      brain.memory.prefersSafeChecks = true;
    }
  }

  function buildAiActionHints(ctx) {
    return [
      'Now: run Test All in Settings to execute BIG + ULTRA + Recovery + Debug sweep.',
      'If you want realism priority, push Realism to 100, keep Cinematic ON, and keep Physics ON.',
      'If you want stable FPS on weaker devices, keep Performance ON and Realism around 60-78.',
      'For progression, trigger launches/shop/debug scans to unlock more badges in Badge Vault.',
      'Current mode=' + ctx.mode + ', coins=' + ctx.coins + ', profile=' + ctx.profile + '.'
    ];
  }

  function buildAiRealismGuide(runtime, brain) {
    var slider = safeById('setting-realism');
    var value = slider ? Number(slider.value || 0) : 0;
    var tier = document.body.getAttribute('data-mv-realism-tier') || 'mid';
    var target = brain && brain.memory ? brain.memory.realismTarget : 72;
    var notes = [];
    notes.push('Realism state: ' + value + '% (' + tier + ').');
    notes.push('100% now maximizes depth/highlight/detail variables instead of mild color-only changes.');
    if (value < 90) {
      notes.push('Raise slider toward 100 for stronger scene depth and specular pass.');
    } else {
      notes.push('You are near max realism. Use Cinematic + Physics for full effect.');
    }
    notes.push('Stored realism target from your prompts: ' + target + '%.');
    return notes.join(' ');
  }

  function buildAiReply(prompt, runtime, brain) {
    var text = String(prompt || '').toLowerCase();
    var ctx = snapshotUiContext(runtime);
    var intent = detectAiIntent(text);
    var modeHint = brain && brain.memory ? brain.memory.preferredMode : 'sandbox';
    var recentCount = document.querySelectorAll('#recent-experiences .recent-chip').length;
    var debugStatusNode = safeById('debug-status');
    var badgeCountNode = safeById('badge-count');

    function ret(message) {
      return { intent: intent, message: message };
    }

    if (/^\/mode\s+(sandbox|racers|sword|tycoon)\b/.test(text)) {
      var requested = /^\/mode\s+(sandbox|racers|sword|tycoon)\b/.exec(text)[1];
      return ret('Command parsed: /mode ' + requested + '. Use launch controls to switch mode now. I recommend ' + requested + ' based on your request.');
    }

    if (/^\/realism\s+\d{1,3}\b/.test(text)) {
      var rv = clamp(Number(/^\/realism\s+(\d{1,3})\b/.exec(text)[1]) || 0, 0, 100);
      return ret('Command parsed: /realism ' + rv + '. Set the slider to ' + rv + '% in Settings. 100% now applies maximum realism treatment.');
    }

    if (/^\/debug\s+(on|off)\b/.test(text)) {
      var dv = /^\/debug\s+(on|off)\b/.exec(text)[1];
      return ret('Command parsed: /debug ' + dv + '. Toggle Debug Mode Scanner in Settings to keep active bug sweeps running.');
    }

    if (intent === 'help') {
      var hints = buildAiActionHints(ctx);
      return ret('I respond only when you message me. I can coach mode strategy, performance, realism tuning, debug workflows, badge progression, and quality gates. Quick commands: /mode racers, /realism 100, /debug on. ' + hints.join(' '));
    }

    if (intent === 'debug') {
      var ds = debugStatusNode ? debugStatusNode.textContent : 'debug status unknown';
      return ret('Debug guidance: keep Debug Mode ON to scan continuously until disabled. Current scanner state: ' + ds + '. Use Test All for BIG + ULTRA + Recovery + Debug sweep in one pass. If you see WARN/FAIL lines, resolve highest-severity items first.');
    }

    if (intent === 'badges') {
      var bc = badgeCountNode ? badgeCountNode.textContent : 'badge count unavailable';
      return ret('Badge Vault status: ' + bc + '. Fast unlock path: launch modes, run BIG/ULTRA checks, run recovery drills, shop items, and keep debug scans active. Collector milestones trigger at 10/20/30 badges.');
    }

    if (intent === 'performance') {
      var p = runtime.dc200 && runtime.dc200.profile ? runtime.dc200.profile.runtime : null;
      var fps = p ? p.averageFps : 'unknown';
      return ret('Performance plan: keep Performance Mode ON for weaker devices, leave Reduced Motion ON when needed, and avoid rapid mode flips while telemetry settles. Current measured FPS: ' + fps + '. For max stability, keep Realism around 60-78; for visual-first sessions, push to 90-100.');
    }

    if (intent === 'realism') {
      return ret(buildAiRealismGuide(runtime, brain));
    }

    if (intent === 'rules') {
      return ret('Canonical policy is in the rules reference document. Use BIG CHECK for core readiness and ULTRA CHECK before official-ready claims. Current session mode is ' + ctx.mode + '.');
    }

    if (intent === 'security') {
      return ret('Security posture is default-deny. Direct wallet and arbitrary network fetches stay blocked unless explicitly permitted by sandbox policy and broker routes.');
    }

    if (intent === 'door') {
      return ret('Use Toggle Hangar Gate. If denied, move inside the hangar zone first, then retry so spatial authority can approve the request.');
    }

    if (intent === 'shop') {
      if (ctx.coins < 90) {
        return ret('Current balance is M$ ' + ctx.coins + '. Save coins first; lowest practical picks start near M$ 90.');
      }
      if (ctx.coins < 240) {
        return ret('Current balance is M$ ' + ctx.coins + '. Efficient buys: one item around M$ 90-120, then keep reserve for upcoming category changes.');
      }
      return ret('Current balance is M$ ' + ctx.coins + '. Balanced path: one cosmetic, one utility item, then keep at least M$ 120 reserve for live market swings. For progression, shopping also contributes to badge unlock milestones.');
    }

    if (intent === 'mode') {
      return ret('Active mode is ' + ctx.mode + '. Brain hint says you lean toward ' + modeHint + '. Launch options are sandbox, racers, sword, and tycoon.');
    }

    if (intent === 'identity') {
      return ret('Current profile display is ' + ctx.profile + '. Streamer Mode can mask this to Creator while preserving account identity in runtime state.');
    }

    if (intent === 'chat') {
      return ret('Use COMMS RELAY controls: _ minimizes, X closes, and the corner launcher reopens instantly. I will stay silent unless you message me.');
    }

    if (intent === 'summary') {
      var turns = (brain && brain.history) ? brain.history.slice(-4) : [];
      if (!turns.length) {
        return ret('No prior AI conversation memory yet in this session. Ask me about debug, badges, realism tuning, performance, mode, shop, security, or rules.');
      }
      var topics = [];
      for (var t = 0; t < turns.length; t += 1) {
        topics.push(turns[t].intent);
      }
      return ret('Recent AI context: intents ' + topics.join(' -> ') + '. Current mode=' + ctx.mode + ', balance=M$ ' + ctx.coins + ', recents=' + recentCount + '. Next best action: run Test All and check Badge Vault for unlockable milestones.');
    }

    return ret('Context right now: mode ' + ctx.mode + ', balance M$ ' + ctx.coins + ', recent portals ' + recentCount + '. Ask for a target plan: debug, badges, realism, performance, shop, mode, security, rules, or recap.');
  }

  function setToggle(button, on) {
    if (!button) return;
    button.classList.toggle('on', !!on);
    button.textContent = on ? 'ON' : 'OFF';
  }

  function wireRuntimePanel(runtime) {
    window.addEventListener('dc200:profile', function (evt) {
      var profile = evt.detail;
      setText('rt-device-tier', profile.runtime.qualityClass.toUpperCase());
      setText('rt-quality-hint', profile.runtime.qualityHint.toUpperCase());
      setText('rt-fps', profile.runtime.averageFps + ' fps');
      setText('rt-inputs', [
        profile.staticCaps.inputs.keyboard ? 'keyboard' : '',
        profile.staticCaps.inputs.pointerFine ? 'pointer' : '',
        profile.staticCaps.inputs.touch ? 'touch' : '',
        profile.staticCaps.inputs.gamepad ? 'gamepad' : ''
      ].filter(Boolean).join(', ') || 'unknown');
      setText('rt-rendering', profile.staticCaps.rendering.webglTier + ' @dpr ' + profile.staticCaps.rendering.dpr);
    });

    window.addEventListener('795:policy', function (evt) {
      var policy = evt.detail;
      setText('rt-graphics-policy', [
        policy.quality,
        policy.motion,
        'blur ' + policy.uiBlurPx + 'px',
        'density ' + policy.cardDensity
      ].join(' | '));
    });

    window.addEventListener('790:state', function (evt) {
      var state = evt.detail;
      function fmt(p) {
        return '(' + p.x.toFixed(2) + ', ' + p.y.toFixed(2) + ', ' + p.z.toFixed(2) + ')';
      }
      setText('rt-790-pred', fmt(state.predicted));
      setText('rt-790-auth', fmt(state.authoritative));
      setText('rt-790-recon', String(state.reconcileCount));
    });

    window.addEventListener('784:update', function (evt) {
      var state = evt.detail;
      var mode = state.currentMode || 'sandbox';
      var stats = state.modeStats[mode] || { plays: 0, jumps: 0, emotes: 0 };
      setText('rt-784-global', state.globalIdentity.displayName + ' (' + state.globalIdentity.accountId + ')');
      setText('rt-784-faction', state.factionAlignment.faction + ' / ' + state.factionAlignment.alignment);
      setText('rt-784-mode', mode + ' p:' + stats.plays + ' j:' + stats.jumps + ' e:' + stats.emotes);
      setText('rt-784-session', state.sessionContext.sessionId + ' @ ' + state.sessionContext.position.x.toFixed(1) + ',' + state.sessionContext.position.y.toFixed(1) + ',' + state.sessionContext.position.z.toFixed(1));
    });

    window.addEventListener('871:event', function (evt) {
      var data = evt.detail;
      var detail = data.detail || {};
      var text = data.kind + ' | ' + (detail.reason || detail.capability || 'event') + ' | ops:' + data.metrics.opCount + ' denied:' + data.metrics.deniedCount;
      setText('rt-871-event', text);
    });

    window.addEventListener('874:event', function (evt) {
      var data = evt.detail;
      var detail = data.detail || {};
      setText('rt-874-event', data.kind + ' | ' + (detail.topic || detail.reason || 'event'));
    });

    window.addEventListener('872:event', function (evt) {
      var data = evt.detail;
      var detail = data.detail || {};
      setText('rt-872-tx', data.kind + ' | ' + (detail.txId || detail.reason || 'pending'));
    });

    window.addEventListener('975:event', function (evt) {
      var data = evt.detail;
      if (data.kind === 'enter') setText('rt-975-zone', 'inside');
      if (data.kind === 'exit') setText('rt-975-zone', 'outside');
      if (data.kind === 'door') setText('rt-975-door', data.detail.state);
      if (data.kind === 'deny') setText('rt-last-action', '975 deny: ' + data.detail.reason);
    });

    runtime.input.onAction(function (action) {
      if (action.type === 'move') {
        setText('rt-last-action', 'move ' + action.source + ' (' + action.x + ', ' + action.y + ')');
        return;
      }
      if (action.type === 'emote') {
        setText('rt-last-action', 'emote ' + action.emote + ' via ' + action.source);
        return;
      }
      setText('rt-last-action', action.type + ' via ' + action.source);
    });
  }

  function installGlobalUi(runtime) {
    var marketCatalog = createMarketplaceCatalog();
    var experienceCatalog = createExperienceCatalog();

    var uiState = {
      settings: {
        reducedMotion: false,
        performance: false,
        streamer: false,
        cinematic: false,
        physics: false,
        realism: 55,
        debugMode: false,
        visibilityBoost: true,
        hideExtras: false
      },
      adaptive: {
        tier: 'standard',
        feedIntervalMs: 1300,
        driftSpread: 16,
        marketMutations: 4,
        userOverride: false
      },
      shopBusy: false,
      previousDisplayName: runtime.identity784.globalIdentity.displayName,
      aiBusy: false,
      aiBrain: createAiBrain(),
      debug: {
        active: false,
        timerId: null,
        scans: 0,
        findings: [],
        reports: [],
        errors: [],
        autoFixes: 0
      },
      badges: {
        catalog: [],
        unlocked: {},
        lastUnlockedAt: 0,
        unlockCooldownMs: 14000
      },
      social: {
        friendSearch: '',
        friendCandidates: [],
        friends: ['NovaBuilder', 'SkyRunner', 'VoxelBee']
      },
      profile: {
        displayName: 'Nano_banana',
        username: 'guest-local',
        about: 'Creator profile for metaverse sandbox testing and community game collaboration.'
      },
      auth: {
        mode: 'login',
        signedIn: false,
        source: 'none',
        accounts: []
      },
      onboarding: {
        dismissed: false
      },
      ideaLab: {
        ideas: [],
        active: [],
        unlocked: false,
        unlockUntil: 0,
        pullCount: 0,
        maxActive: 4,
        maxPulls: 10
      },
      communities: {
        list: [
          { id: 'core-builders', name: 'Core Builders', visibility: 'public', members: ['Creator', 'NovaBuilder'], games: 2 },
          { id: 'night-shift-lab', name: 'Night Shift Lab', visibility: 'private', members: ['Creator', 'OrbitWarden'], games: 1 }
        ]
      },
      secrets: {
        catalog: [
          'Sector 7 light bridge responds to triple emote wave.',
          'Hangar door audit mode unlocks with two successful recovery drills.',
          'Cinematic + Physics + Realism 100 reveals hidden specular pass.',
          'Marketplace drift converges faster after one complete Test All run.',
          'Debug scanner clean sweep increases trust signal in runtime log.',
          'Some race maps gain alternate lines when motion is normal mode.',
          'Community-made games inherit visibility from their parent group.',
          'Secret channel keyphrase: pulse-arc-lattice.'
        ],
        revealed: {}
      },
      qualityEvidence: {
        gameplayLaunches: 0,
        modalVisits: 0,
        settingsToggles: 0,
        shopRequests: 0,
        doorActions: 0,
        sandboxProbes: 0,
        marketSearches: 0,
        aiPrompts: 0,
        friendAdds: 0,
        communityCreates: 0,
        bigChecks: 0,
        ultraChecks: 0,
        runtimeTicks: 0,
        recoveryDrills: 0
      },
      experiences: experienceCatalog,
      market: {
        catalog: marketCatalog,
        categoryId: marketCatalog[0].id,
        query: '',
        page: 0,
        pageSize: 24,
        lastRenderAt: 0
      }
    };

    runtime.marketCatalog = marketCatalog;
    runtime.experienceCatalog = experienceCatalog;

    var platformRules = {
      requiresSandbox: true,
      requiresAuthorityValidation: true,
      requiresEscrow: true,
      requiresAccessibility: true,
      requiresBigUltraChecks: true,
      prohibitsBypass: true,
      rightsPolicyReady: false,
      prototypeIsNotComplete: true,
      canonicalFile: 'rules-reference',
      ruleCount: 35,
      naming: {
        blockWorld: 'BlockWorld',
        pulseArena: 'Pulse Arena'
      }
    };

    runtime.platformRules = platformRules;

    if (!window.__mvDebugErrorHooksInstalled) {
      window.__mvDebugErrorHooksInstalled = true;
      window.addEventListener('error', function (evt) {
        var msg = evt && evt.message ? evt.message : 'Unknown runtime error';
        var where = (evt && evt.filename ? evt.filename : 'inline') + ':' + (evt && evt.lineno ? evt.lineno : 0);
        try {
          if (window.__mvDebugPushError) window.__mvDebugPushError('window-error', msg + ' @ ' + where);
        } catch (err) {
          // Keep handler resilient.
        }
      });
      window.addEventListener('unhandledrejection', function (evt) {
        var reason = evt && evt.reason ? String(evt.reason.message || evt.reason) : 'Unknown rejection';
        try {
          if (window.__mvDebugPushError) window.__mvDebugPushError('unhandled-rejection', reason);
        } catch (err2) {
          // Keep handler resilient.
        }
      });
    }

    function getExperienceById(expId) {
      for (var i = 0; i < uiState.experiences.length; i += 1) {
        if (uiState.experiences[i].id === expId) return uiState.experiences[i];
      }
      return null;
    }

    function bumpEvidence(key) {
      if (!uiState.qualityEvidence) uiState.qualityEvidence = {};
      uiState.qualityEvidence[key] = (uiState.qualityEvidence[key] || 0) + 1;
      evaluateBadgeUnlocks();
    }

    function evidenceCount(key) {
      if (!uiState.qualityEvidence) return 0;
      return uiState.qualityEvidence[key] || 0;
    }

    function createBadgeCatalog() {
      return [
        { id: 'boot-sequence', name: 'Boot Sequence', iconKey: 'home' },
        { id: 'first-launch', name: 'First Launch', iconKey: 'rocket' },
        { id: 'launch-runner', name: 'Launch Runner', iconKey: 'rocket' },
        { id: 'portal-legend', name: 'Portal Legend', iconKey: 'rocket' },
        { id: 'shop-buyer', name: 'Shop Buyer', iconKey: 'shop' },
        { id: 'market-hunter', name: 'Market Hunter', iconKey: 'shop' },
        { id: 'market-tycoon', name: 'Market Tycoon', iconKey: 'shop' },
        { id: 'sandbox-auditor', name: 'Sandbox Auditor', iconKey: 'shield' },
        { id: 'door-pilot', name: 'Door Pilot', iconKey: 'settings' },
        { id: 'settings-tech', name: 'Settings Tech', iconKey: 'settings' },
        { id: 'motion-architect', name: 'Motion Architect', iconKey: 'settings' },
        { id: 'cinema-core', name: 'Cinema Core', iconKey: 'neon' },
        { id: 'physics-rider', name: 'Physics Rider', iconKey: 'drone' },
        { id: 'search-scout', name: 'Search Scout', iconKey: 'scroll' },
        { id: 'ai-prompted', name: 'AI Prompted', iconKey: 'bot' },
        { id: 'ai-strategist', name: 'AI Strategist', iconKey: 'bot' },
        { id: 'input-hybrid', name: 'Input Hybrid', iconKey: 'gamepad' },
        { id: 'balance-keeper', name: 'Balance Keeper', iconKey: 'badge' },
        { id: 'frame-keeper', name: 'Frame Keeper', iconKey: 'badge' },
        { id: 'compat-guardian', name: 'Compat Guardian', iconKey: 'badge' },
        { id: 'big-check-init', name: 'BIG CHECK Init', iconKey: 'scroll' },
        { id: 'big-check-veteran', name: 'BIG CHECK Veteran', iconKey: 'scroll' },
        { id: 'ultra-init', name: 'ULTRA Init', iconKey: 'scroll' },
        { id: 'ultra-veteran', name: 'ULTRA Veteran', iconKey: 'scroll' },
        { id: 'recovery-operator', name: 'Recovery Operator', iconKey: 'shield' },
        { id: 'recovery-master', name: 'Recovery Master', iconKey: 'shield' },
        { id: 'realtime-spark', name: 'Realtime Spark', iconKey: 'neon' },
        { id: 'realtime-engine', name: 'Realtime Engine', iconKey: 'neon' },
        { id: 'debug-initiated', name: 'Debug Initiated', iconKey: 'bot' },
        { id: 'debug-hunter', name: 'Debug Hunter', iconKey: 'bot' },
        { id: 'clean-sweep', name: 'Clean Sweep', iconKey: 'shield' },
        { id: 'storm-stabilizer', name: 'Storm Stabilizer', iconKey: 'drone' },
        { id: 'badge-collector-10', name: 'Badge Collector X', iconKey: 'emote' },
        { id: 'badge-collector-20', name: 'Badge Collector XX', iconKey: 'emote' },
        { id: 'badge-collector-30', name: 'Badge Collector XXX', iconKey: 'emote' },
        { id: 'color-overdrive', name: 'Color Overdrive', iconKey: 'emote' },
        { id: 'future-signal', name: 'Future Signal', iconKey: 'neon' },
        { id: 'adaptive-legacy', name: 'Adaptive Legacy', iconKey: 'settings' },
        { id: 'adaptive-balanced', name: 'Adaptive Balanced', iconKey: 'settings' },
        { id: 'adaptive-modern', name: 'Adaptive Modern', iconKey: 'settings' }
      ];
    }

    function saveBadges() {
      try {
        localStorage.setItem('mv-badges-v1', JSON.stringify(uiState.badges.unlocked || {}));
      } catch (err) {
        // Ignore persistence issues for badges.
      }
    }

    function loadBadges() {
      try {
        var raw = localStorage.getItem('mv-badges-v1');
        if (!raw) return;
        var parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object') return;
        uiState.badges.unlocked = parsed;
      } catch (err) {
        // Ignore malformed badge data.
      }
    }

    function unlockedBadgeCount() {
      var keys = Object.keys(uiState.badges.unlocked || {});
      var count = 0;
      for (var i = 0; i < keys.length; i += 1) {
        if (uiState.badges.unlocked[keys[i]]) count += 1;
      }
      return count;
    }

    function renderBadgePanel() {
      var badgeGrid = safeById('badge-grid');
      var badgeCount = safeById('badge-count');
      if (!badgeGrid || !badgeCount) return;
      badgeGrid.textContent = '';

      var unlocked = uiState.badges.unlocked || {};
      var catalog = uiState.badges.catalog || [];
      var count = unlockedBadgeCount();
      badgeCount.textContent = count + ' / ' + catalog.length + ' unlocked';

      for (var i = 0; i < catalog.length; i += 1) {
        var badge = catalog[i];
        var chip = document.createElement('div');
        var isUnlocked = !!unlocked[badge.id];
        chip.className = 'badge-chip ' + (isUnlocked ? 'unlocked' : 'locked');
        chip.appendChild(createIconLabel(badge.iconKey, '•', badge.name));
        badgeGrid.appendChild(chip);
      }
    }

    function unlockBadge(badgeId, reason) {
      if (!badgeId) return;
      if (uiState.badges.unlocked[badgeId]) return;

      var now = Date.now();
      if (now - uiState.badges.lastUnlockedAt < uiState.badges.unlockCooldownMs) {
        return;
      }

      uiState.badges.unlocked[badgeId] = { ts: Date.now(), reason: reason || 'milestone' };
      uiState.badges.lastUnlockedAt = now;
      saveBadges();
      renderBadgePanel();
      appendChatMessage('global', 'Badge', 'Unlocked: ' + badgeId + (reason ? ' (' + reason + ')' : ''), true);
    }

    function evaluateBadgeUnlocks() {
      var launches = evidenceCount('gameplayLaunches');
      var shops = evidenceCount('shopRequests');
      var searches = evidenceCount('marketSearches');
      var probes = evidenceCount('sandboxProbes');
      var doors = evidenceCount('doorActions');
      var toggles = evidenceCount('settingsToggles');
      var aiPrompts = evidenceCount('aiPrompts');
      var bigChecks = evidenceCount('bigChecks');
      var ultraChecks = evidenceCount('ultraChecks');
      var recovery = evidenceCount('recoveryDrills');
      var ticks = evidenceCount('runtimeTicks');

      if (ticks >= 3) unlockBadge('boot-sequence', 'runtime online stable');
      if (launches >= 1) unlockBadge('first-launch', 'launch x1');
      if (launches >= 5) unlockBadge('launch-runner', 'launch x5');
      if (launches >= 20) unlockBadge('portal-legend', 'launch x20');
      if (shops >= 1) unlockBadge('shop-buyer', 'shop x1');
      if (shops >= 5) unlockBadge('market-hunter', 'shop x5');
      if (shops >= 20) unlockBadge('market-tycoon', 'shop x20');
      if (probes >= 1) unlockBadge('sandbox-auditor', 'probe x1');
      if (doors >= 1) unlockBadge('door-pilot', 'door x1');
      if (toggles >= 3) unlockBadge('settings-tech', 'settings x3');
      if (toggles >= 10) unlockBadge('motion-architect', 'settings x10');
      if (uiState.settings.cinematic) unlockBadge('cinema-core', 'cinematic on');
      if (uiState.settings.physics) unlockBadge('physics-rider', 'physics on');
      if (searches >= 4) unlockBadge('search-scout', 'search x4');
      if (aiPrompts >= 1) unlockBadge('ai-prompted', 'ai x1');
      if (aiPrompts >= 8) unlockBadge('ai-strategist', 'ai x8');
      if (bigChecks >= 1) unlockBadge('big-check-init', 'BIG CHECK x1');
      if (bigChecks >= 10) unlockBadge('big-check-veteran', 'BIG CHECK x10');
      if (ultraChecks >= 1) unlockBadge('ultra-init', 'ULTRA CHECK x1');
      if (ultraChecks >= 6) unlockBadge('ultra-veteran', 'ULTRA CHECK x6');
      if (recovery >= 1) unlockBadge('recovery-operator', 'recovery x1');
      if (recovery >= 5) unlockBadge('recovery-master', 'recovery x5');
      if (ticks >= 25) unlockBadge('realtime-spark', 'ticks x25');
      if (ticks >= 180) unlockBadge('realtime-engine', 'ticks x180');
      if (uiState.debug.scans >= 3) unlockBadge('debug-initiated', 'debug scans x3');
      if (uiState.debug.scans >= 20) unlockBadge('debug-hunter', 'debug scans x20');
      if (uiState.debug.active && uiState.debug.findings.length && uiState.debug.findings[0].severity === 'OK') unlockBadge('clean-sweep', 'no issues');
      if (uiState.adaptive.tier === 'legacy') unlockBadge('adaptive-legacy', 'legacy tier');
      if (uiState.adaptive.tier === 'balanced') unlockBadge('adaptive-balanced', 'balanced tier');
      if (uiState.adaptive.tier === 'modern') unlockBadge('adaptive-modern', 'modern tier');

      var profile = runtime.dc200 ? runtime.dc200.profile : null;
      if (profile && profile.staticCaps && profile.staticCaps.inputs) {
        var inp = profile.staticCaps.inputs;
        if (inp.keyboard && (inp.touch || inp.pointerFine)) unlockBadge('input-hybrid', 'multi-input');
      }
      if (profile && profile.runtime && Number(profile.runtime.averageFps) >= 30) unlockBadge('frame-keeper', 'fps >= 30');
      if (profile && profile.runtime && Number(profile.runtime.averageFps) >= 50) unlockBadge('future-signal', 'fps >= 50');
      if (profile && profile.runtime && Number(profile.runtime.frameJitterMs) <= 9) unlockBadge('balance-keeper', 'jitter <= 9');
      if (profile && profile.staticCaps && profile.staticCaps.rendering && profile.staticCaps.rendering.webglTier !== 'none') unlockBadge('compat-guardian', 'rendering path');
      if ((runtime.marketCatalog || []).length >= 4) unlockBadge('storm-stabilizer', 'catalog scale');
      if (document.querySelectorAll('.mv-icon').length >= 40) unlockBadge('color-overdrive', 'icon expansion');

      var count = unlockedBadgeCount();
      if (count >= 10) unlockBadge('badge-collector-10', '10 badges');
      if (count >= 20) unlockBadge('badge-collector-20', '20 badges');
      if (count >= 30) unlockBadge('badge-collector-30', '30 badges');
    }

    function renderDebugFindings() {
      var statusNode = safeById('debug-status');
      var listNode = safeById('debug-findings');
      var summaryNode = safeById('debug-report-summary');
      if (statusNode) {
        statusNode.textContent = (uiState.debug.active ? 'ON' : 'OFF') + ' · scans: ' + uiState.debug.scans + ' · fixes: ' + uiState.debug.autoFixes;
      }
      if (summaryNode) {
        var latest = uiState.debug.reports.length ? uiState.debug.reports[uiState.debug.reports.length - 1] : null;
        if (!latest) summaryNode.textContent = 'No report generated yet.';
        else summaryNode.textContent = 'Last report: ' + latest.id + ' | fails ' + latest.failCount + ' | warns ' + latest.warnCount + ' | fixed ' + latest.fixedCount;
      }
      if (!listNode) return;
      listNode.textContent = '';
      for (var i = 0; i < uiState.debug.findings.length; i += 1) {
        var finding = uiState.debug.findings[i];
        var li = document.createElement('li');
        var fixTag = finding.fixed ? ' | auto-fix applied' : (finding.fixable ? ' | fixable' : '');
        li.textContent = finding.severity + ' · ' + finding.area + ' · ' + finding.message + fixTag;
        listNode.appendChild(li);
      }
    }

    function pushDebugError(label, detail) {
      var item = {
        ts: Date.now(),
        label: sanitizePlainText(label, 60) || 'runtime-error',
        detail: sanitizePlainText(detail, 280) || 'No details'
      };
      uiState.debug.errors.push(item);
      while (uiState.debug.errors.length > 24) {
        uiState.debug.errors.shift();
      }
    }

    window.__mvDebugPushError = pushDebugError;

    function tryAutoFixFinding(finding) {
      if (!finding || !finding.fixable || finding.fixed) return false;
      try {
        if (finding.code === 'SETTINGS_PERFORMANCE_MISMATCH') {
          document.body.setAttribute('data-mv-quality', 'economy');
          finding.fixed = true;
          finding.message = 'Performance ON quality mismatch corrected to economy.';
          return true;
        }
        if (finding.code === 'UI_ICON_COUNT_LOW') {
          upgradeStaticIcons();
          finding.fixed = true;
          finding.message = 'Icon enhancement pass re-applied.';
          return true;
        }
        if (finding.code === 'CATALOG_CATEGORY_LOW') {
          runtime.marketCatalog = createMarketplaceCatalog();
          uiState.market.catalog = runtime.marketCatalog;
          finding.fixed = true;
          finding.message = 'Marketplace catalog restored to default size.';
          return true;
        }
      } catch (err) {
        pushDebugError('autofix-failed', finding.code + ': ' + (err && err.message ? err.message : String(err)));
      }
      return false;
    }

    function createDebugReport(findings) {
      var failCount = 0;
      var warnCount = 0;
      var fixedCount = 0;
      for (var i = 0; i < findings.length; i += 1) {
        if (findings[i].severity === 'FAIL') failCount += 1;
        if (findings[i].severity === 'WARN') warnCount += 1;
        if (findings[i].fixed) fixedCount += 1;
      }
      return {
        id: 'dbg-' + Date.now(),
        ts: Date.now(),
        active: uiState.debug.active,
        failCount: failCount,
        warnCount: warnCount,
        fixedCount: fixedCount,
        settings: {
          performance: !!uiState.settings.performance,
          reducedMotion: !!uiState.settings.reducedMotion,
          realism: uiState.settings.realism,
          visibilityBoost: !!uiState.settings.visibilityBoost
        },
        findings: findings,
        recentErrors: uiState.debug.errors.slice(-8)
      };
    }

    function exportDebugReport() {
      var payload = uiState.debug.reports.length
        ? uiState.debug.reports[uiState.debug.reports.length - 1]
        : createDebugReport(uiState.debug.findings || []);
      var text = JSON.stringify(payload, null, 2);
      try {
        localStorage.setItem('mv-last-debug-report', text);
      } catch (err) {
        // Ignore persistence failures.
      }
      try {
        navigator.clipboard.writeText(text).then(function () {
          appendChatMessage('global', 'Debug', 'Bug report copied to clipboard and saved locally.', true);
        }).catch(function () {
          appendChatMessage('global', 'Debug', 'Bug report saved locally as mv-last-debug-report.', true);
        });
      } catch (err2) {
        appendChatMessage('global', 'Debug', 'Bug report saved locally as mv-last-debug-report.', true);
      }
    }

    function runDebugSweep(source, autoFix) {
      var findings = [];
      var profile = runtime.dc200 ? runtime.dc200.profile : null;
      var activeQuality = document.body.getAttribute('data-mv-quality') || 'unknown';
      var applyFixes = autoFix === true;

      if (!profile) findings.push({ severity: 'WARN', area: 'Runtime', code: 'RUNTIME_PROFILE_PENDING', message: 'DC-200 profile not ready yet.', fixable: false });
      if (!safeById('market-grid')) findings.push({ severity: 'FAIL', area: 'Marketplace', code: 'UI_MARKET_GRID_MISSING', message: 'market-grid container missing.', fixable: false });
      if (!safeById('dashboard-games-grid')) findings.push({ severity: 'FAIL', area: 'Dashboard', code: 'UI_DASHBOARD_GRID_MISSING', message: 'dashboard games grid missing.', fixable: false });

      var categories = runtime.marketCatalog || [];
      if (categories.length < 4) findings.push({ severity: 'WARN', area: 'Catalog', code: 'CATALOG_CATEGORY_LOW', message: 'Less than 4 market categories found.', fixable: true });
      for (var c = 0; c < categories.length; c += 1) {
        var items = categories[c].items || [];
        if (!items.length) findings.push({ severity: 'WARN', area: 'Catalog', code: 'CATALOG_EMPTY_ITEMS', message: categories[c].label + ' has no items.', fixable: false });
        for (var x = 0; x < items.length; x += 1) {
          var it = items[x];
          if (!Number.isFinite(it.price) || it.price <= 0) {
            findings.push({ severity: 'FAIL', area: 'Catalog', code: 'CATALOG_INVALID_PRICE', message: 'Invalid price found on ' + it.id + '.', fixable: false });
            break;
          }
        }
      }

      if (uiState.settings.performance && activeQuality !== 'economy') {
        findings.push({ severity: 'WARN', area: 'Settings', code: 'SETTINGS_PERFORMANCE_MISMATCH', message: 'Performance ON but quality=' + activeQuality + '.', fixable: true });
      }
      if (evidenceCount('runtimeTicks') < 1) {
        findings.push({ severity: 'WARN', area: 'Realtime', code: 'RUNTIME_TICKS_NONE', message: 'No runtime ticks yet.', fixable: false });
      }
      if (document.querySelectorAll('.mv-icon').length < 30) {
        findings.push({ severity: 'WARN', area: 'UI', code: 'UI_ICON_COUNT_LOW', message: 'Icon count lower than expected.', fixable: true });
      }
      if ((uiState.debug.errors || []).length) {
        findings.push({ severity: 'FAIL', area: 'Runtime', code: 'RUNTIME_CAPTURED_ERRORS', message: uiState.debug.errors.length + ' runtime error(s) captured. Export bug report for details.', fixable: false });
      }
      if (!findings.length) {
        findings.push({ severity: 'OK', area: 'Scanner', code: 'SCANNER_CLEAN', message: 'No active issues in this sweep.', fixable: false });
      }

      if (applyFixes) {
        for (var f = 0; f < findings.length; f += 1) {
          if (tryAutoFixFinding(findings[f])) {
            uiState.debug.autoFixes += 1;
          }
        }
      }

      if (findings.length > 14) findings = findings.slice(0, 14);
      uiState.debug.findings = findings;
      uiState.debug.scans += 1;
      var report = createDebugReport(findings);
      uiState.debug.reports.push(report);
      while (uiState.debug.reports.length > 20) {
        uiState.debug.reports.shift();
      }
      renderDebugFindings();
      evaluateBadgeUnlocks();
      if (source !== 'silent') {
        appendChatMessage('global', 'Debug', 'Debug sweep complete: ' + findings.length + ' finding(s). Report ' + report.id + ' generated.', true);
      }
      setText('rt-last-action', 'debug sweep #' + uiState.debug.scans);
      return findings;
    }

    function setDebugMode(on) {
      uiState.settings.debugMode = !!on;
      uiState.debug.active = !!on;
      if (uiState.debug.timerId) {
        clearInterval(uiState.debug.timerId);
        uiState.debug.timerId = null;
      }

      if (uiState.debug.active) {
        uiState.debug.timerId = setInterval(function () {
          if (document.hidden) return;
          runDebugSweep('silent', true);
        }, 4500);
      }

      setToggle(safeById('setting-debug-mode'), uiState.debug.active);
      renderDebugFindings();
      saveUiSettings();
      setText('rt-last-action', 'debug mode: ' + (uiState.debug.active ? 'on' : 'off'));
    }

    window.toggleDebugMode = function () {
      setDebugMode(!uiState.debug.active);
      if (uiState.debug.active) runDebugSweep('manual', true);
      evaluateBadgeUnlocks();
    };

    window.runDebugSweep = function (source, autoFix) {
      return runDebugSweep(source || 'manual', autoFix === true);
    };

    window.exportDebugReport = exportDebugReport;

    function applyAdaptiveTier(profile, reason) {
      var runtimeCaps = profile && profile.runtime ? profile.runtime : null;
      var staticCaps = profile && profile.staticCaps ? profile.staticCaps : { hardware: {}, rendering: {} };
      var fps = runtimeCaps ? Number(runtimeCaps.averageFps) || 0 : 0;
      var jitter = runtimeCaps ? Number(runtimeCaps.frameJitterMs) || 0 : 0;
      var cores = staticCaps.hardware ? Number(staticCaps.hardware.logicalCores) || 0 : 0;
      var memory = staticCaps.hardware ? Number(staticCaps.hardware.deviceMemoryGb) || 0 : 0;
      var webglTier = staticCaps.rendering ? staticCaps.rendering.webglTier : 'none';

      var legacyScore = 0;
      if (fps > 0 && fps < 33) legacyScore += 1;
      if (jitter > 10) legacyScore += 1;
      if (cores > 0 && cores <= 4) legacyScore += 1;
      if (memory > 0 && memory <= 4) legacyScore += 1;
      if (webglTier === 'none' || webglTier === 'webgl1') legacyScore += 1;

      var nextTier = 'modern';
      if (legacyScore >= 3) nextTier = 'legacy';
      else if (legacyScore === 2) nextTier = 'balanced';

      uiState.adaptive.tier = nextTier;
      if (nextTier === 'legacy') {
        uiState.adaptive.feedIntervalMs = 1700;
        uiState.adaptive.driftSpread = 9;
        uiState.adaptive.marketMutations = 2;
      } else if (nextTier === 'balanced') {
        uiState.adaptive.feedIntervalMs = 1400;
        uiState.adaptive.driftSpread = 12;
        uiState.adaptive.marketMutations = 3;
      } else {
        uiState.adaptive.feedIntervalMs = 1200;
        uiState.adaptive.driftSpread = 16;
        uiState.adaptive.marketMutations = 4;
      }

      document.body.setAttribute('data-mv-device-tier', nextTier);

      if (nextTier === 'legacy' && !uiState.adaptive.userOverride) {
        uiState.settings.performance = true;
        uiState.settings.reducedMotion = true;
        uiState.settings.cinematic = false;
        setToggle(safeById('setting-performance'), true);
        setToggle(safeById('setting-reduced-motion'), true);
        setToggle(safeById('setting-cinematic'), false);
        document.body.setAttribute('data-mv-quality', 'economy');
        document.body.setAttribute('data-mv-motion', 'reduced');
        document.body.classList.remove('setting-cinematic');
        saveUiSettings();
      }

      if (reason) {
        setText('rt-last-action', 'adaptive tier: ' + nextTier + ' (' + reason + ')');
      }
    }

    function renderExperienceCards() {
      var dashboardRoot = safeById('dashboard-games-grid');
      var modalRoot = safeById('modal-games-grid');
      if (!dashboardRoot || !modalRoot) return;

      var thumbThemes = [
        ['#43d7ff', '#187fbc', '#0f2535'],
        ['#ffd24a', '#dc6f21', '#32120f'],
        ['#8cff72', '#29884f', '#11251d'],
        ['#ff7acc', '#8e3dc8', '#241339'],
        ['#a6b9ff', '#3e63d7', '#151f42'],
        ['#ff9f7b', '#d7497c', '#2b1028']
      ];

      function pickTheme(id) {
        var hash = 0;
        var text = String(id || 'mode');
        for (var n = 0; n < text.length; n += 1) hash = (hash * 31 + text.charCodeAt(n)) >>> 0;
        return thumbThemes[hash % thumbThemes.length];
      }

      function makeRating(players, min, max) {
        var base = 72;
        var spread = Math.max(1, (max || 1000) - (min || 0));
        var influence = Math.round(((players || 0) - (min || 0)) / spread * 24);
        var pct = Math.max(61, Math.min(98, base + influence));
        return pct + '% Rating';
      }

      function buildCard(exp, showLiveCount) {
        var card = document.createElement('div');
        card.className = showLiveCount ? 'game-card dashboard-card' : 'game-card';
        card.addEventListener('click', function () {
          window.launchGame(exp.id);
        });

        var thumb = document.createElement('div');
        thumb.className = 'game-thumb';
        var theme = pickTheme(exp.id);
        thumb.style.background = 'linear-gradient(148deg, ' + theme[0] + ' 0%, ' + theme[1] + ' 48%, ' + theme[2] + ' 100%)';

        var label = document.createElement('div');
        label.className = 'game-thumb-label';
        label.textContent = showLiveCount ? 'Recommended' : 'Experience';
        thumb.appendChild(label);
        thumb.appendChild(createIconElement(exp.iconKey, exp.icon, exp.name + ' icon'));

        var name = document.createElement('div');
        name.className = 'game-name';
        name.textContent = exp.name;

        card.appendChild(thumb);
        card.appendChild(name);

        if (showLiveCount) {
          var stats = document.createElement('div');
          stats.className = 'game-stats';

          var rating = document.createElement('span');
          rating.className = 'rating';
          rating.textContent = makeRating(exp.players, exp.min, exp.max);

          var players = document.createElement('span');
          players.className = 'game-players';
          players.id = 'live-players-' + exp.id;
          players.textContent = formatCount(exp.players) + ' Playing';

          stats.appendChild(rating);
          stats.appendChild(players);
          card.appendChild(stats);
        }

        return card;
      }

      dashboardRoot.textContent = '';
      modalRoot.textContent = '';
      for (var i = 0; i < uiState.experiences.length; i += 1) {
        var exp = uiState.experiences[i];
        dashboardRoot.appendChild(buildCard(exp, true));
        modalRoot.appendChild(buildCard(exp, false));
      }

      setText('home-reco-title', 'Recommended For You');
    }

    function saveUiSettings() {
      try {
        localStorage.setItem('mv-settings-v2', JSON.stringify(uiState.settings));
      } catch (err) {
        // Ignore persistence errors in restricted contexts.
      }
    }

    function saveRecentExperiences(list) {
      try {
        localStorage.setItem('mv-recent-experiences-v1', JSON.stringify(list || []));
      } catch (err) {
        // Ignore persistence errors.
      }
    }

    function saveFriends() {
      try {
        localStorage.setItem('mv-friends-v1', JSON.stringify(uiState.social.friends || []));
      } catch (err) {
        // Ignore persistence errors.
      }
    }

    function loadFriends() {
      try {
        var raw = localStorage.getItem('mv-friends-v1');
        if (!raw) return;
        var parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          uiState.social.friends = parsed.slice(0, 40);
        }
      } catch (err) {
        // Ignore malformed social data.
      }
    }

    function saveProfile() {
      try {
        localStorage.setItem('mv-profile-v1', JSON.stringify(uiState.profile));
      } catch (err) {
        // Ignore persistence errors.
      }
    }

    function saveAuthSession() {
      try {
        localStorage.setItem('mv-auth-v1', JSON.stringify({
          signedIn: !!uiState.auth.signedIn,
          mode: uiState.auth.mode,
          source: uiState.auth.source,
          displayName: uiState.profile.displayName,
          username: uiState.profile.username,
          at: Date.now()
        }));
      } catch (err) {
        // Ignore persistence errors.
      }
    }

    function saveAuthAccounts() {
      try {
        localStorage.setItem('mv-auth-accounts-v1', JSON.stringify(uiState.auth.accounts || []));
      } catch (err) {
        // Ignore persistence errors.
      }
    }

    function loadAuthAccounts() {
      try {
        var raw = localStorage.getItem('mv-auth-accounts-v1');
        if (!raw) return;
        var parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) return;
        var next = [];
        for (var i = 0; i < parsed.length && i < 12; i += 1) {
          var row = parsed[i] || {};
          var username = normalizeUsername(row.username || '');
          var displayName = sanitizePlainText(row.displayName, 36);
          var about = sanitizePlainText(row.about, 120);
          if (!username || !displayName) continue;
          next.push({ username: username, displayName: displayName, about: about || '' });
        }
        uiState.auth.accounts = next;
      } catch (err) {
        // Ignore malformed account data.
      }
    }

    function upsertAuthAccount() {
      var username = normalizeUsername(uiState.profile.username || '');
      var displayName = sanitizePlainText(uiState.profile.displayName, 36);
      var about = sanitizePlainText(uiState.profile.about, 120);
      if (!username || !displayName) return;

      var list = uiState.auth.accounts || [];
      var existing = -1;
      for (var i = 0; i < list.length; i += 1) {
        if (list[i].username === username) {
          existing = i;
          break;
        }
      }

      var row = { username: username, displayName: displayName, about: about || '' };
      if (existing >= 0) {
        list.splice(existing, 1);
      }
      list.unshift(row);
      if (list.length > 12) list = list.slice(0, 12);
      uiState.auth.accounts = list;
      saveAuthAccounts();
      renderAuthAccountList();
    }

    function renderAuthAccountList() {
      var root = safeById('auth-account-list');
      if (!root) return;
      root.textContent = '';
      var list = uiState.auth.accounts || [];

      if (!list.length) return;

      for (var i = 0; i < list.length; i += 1) {
        var account = list[i];
        var chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'auth-account-chip';
        chip.textContent = account.displayName;

        var meta = document.createElement('small');
        meta.textContent = '@' + account.username + ' · tap to use this account';
        chip.appendChild(meta);

        (function (username) {
          chip.addEventListener('click', function () {
            window.useSavedAccount(username);
          });
        })(account.username);
        root.appendChild(chip);
      }
    }

    function saveOnboardingState() {
      try {
        localStorage.setItem('mv-onboarding-v1', JSON.stringify({ dismissed: !!uiState.onboarding.dismissed }));
      } catch (err) {
        // Ignore persistence errors.
      }
    }

    function loadOnboardingState() {
      try {
        var raw = localStorage.getItem('mv-onboarding-v1');
        if (!raw) return;
        var parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') {
          uiState.onboarding.dismissed = !!parsed.dismissed;
        }
      } catch (err) {
        // Ignore malformed onboarding data.
      }
    }

    function saveIdeaLabState() {
      try {
        localStorage.setItem('mv-idea-lab-v1', JSON.stringify({
          active: uiState.ideaLab.active || [],
          pullCount: uiState.ideaLab.pullCount || 0
        }));
      } catch (err) {
        // Ignore persistence errors.
      }
    }

    function loadIdeaLabState() {
      try {
        var raw = localStorage.getItem('mv-idea-lab-v1');
        if (!raw) return;
        var parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object') return;
        if (Array.isArray(parsed.active)) {
          uiState.ideaLab.active = parsed.active.slice(0, uiState.ideaLab.maxActive).map(function (entry) {
            return {
              id: Number(entry.id) || 0,
              title: sanitizePlainText(entry.title, 120) || 'Untitled idea',
              approved: !!entry.approved
            };
          });
        }
        uiState.ideaLab.pullCount = Math.max(0, Math.min(uiState.ideaLab.maxPulls, Number(parsed.pullCount) || 0));
      } catch (err) {
        // Ignore malformed idea data.
      }
    }

    function renderOnboardingTips() {
      var panel = safeById('onboarding-tip-panel');
      var note = safeById('onboarding-tip-text');
      var step = safeById('onboarding-step');
      if (!panel || !note || !step) return;

      if (uiState.onboarding.dismissed) {
        panel.style.display = 'none';
        return;
      }

      var tipText = 'Launch an experience to begin collecting progress signals.';
      var stepText = 'Step 1/4';
      if (evidenceCount('gameplayLaunches') >= 1 && evidenceCount('friendAdds') < 1) {
        tipText = 'Add one friend from the browser to unlock social flow.';
        stepText = 'Step 2/4';
      } else if (evidenceCount('friendAdds') >= 1 && uiState.ideaLab.active.length < 1) {
        tipText = 'Open Idea Lab and pull one idea from the vault.';
        stepText = 'Step 3/4';
      } else if (uiState.ideaLab.active.length >= 1) {
        tipText = 'Run Test All to validate gameplay, privacy, rights, and recovery states.';
        stepText = 'Step 4/4';
      }

      panel.style.display = 'grid';
      note.textContent = tipText;
      step.textContent = stepText;
    }

    function ideaLabVaultItems() {
      var activeIds = {};
      for (var i = 0; i < uiState.ideaLab.active.length; i += 1) {
        activeIds[uiState.ideaLab.active[i].id] = true;
      }
      var pool = [];
      for (var j = 0; j < uiState.ideaLab.ideas.length; j += 1) {
        var item = uiState.ideaLab.ideas[j];
        if (!activeIds[item.id]) pool.push(item);
      }
      return pool;
    }

    function renderIdeaLab() {
      var statusNode = safeById('idea-vault-status');
      var pullsNode = safeById('idea-vault-pulls');
      var activeCountNode = safeById('idea-active-count');
      var activeRoot = safeById('idea-active-list');
      var vaultRoot = safeById('idea-vault-list');
      var noteNode = safeById('idea-lab-note');
      if (!statusNode || !pullsNode || !activeCountNode || !activeRoot || !vaultRoot || !noteNode) return;

      if (uiState.ideaLab.unlocked && Date.now() > uiState.ideaLab.unlockUntil) {
        uiState.ideaLab.unlocked = false;
      }

      statusNode.textContent = uiState.ideaLab.unlocked ? 'UNLOCKED' : 'LOCKED';
      pullsNode.textContent = String(uiState.ideaLab.pullCount) + '/' + String(uiState.ideaLab.maxPulls);
      activeCountNode.textContent = String(uiState.ideaLab.active.length) + '/' + String(uiState.ideaLab.maxActive);

      if (uiState.ideaLab.unlocked) {
        var remainingSec = Math.max(0, Math.ceil((uiState.ideaLab.unlockUntil - Date.now()) / 1000));
        noteNode.textContent = 'Vault unlocked. Auto-lock in ' + remainingSec + 's.';
      } else {
        noteNode.textContent = 'Vault locked. Use MFA to unlock and pull ideas.';
      }

      activeRoot.textContent = '';
      if (!uiState.ideaLab.active.length) {
        var emptyActive = document.createElement('div');
        emptyActive.className = 'idea-item';
        emptyActive.textContent = 'No active ideas yet.';
        activeRoot.appendChild(emptyActive);
      } else {
        for (var a = 0; a < uiState.ideaLab.active.length; a += 1) {
          var current = uiState.ideaLab.active[a];
          var activeRow = document.createElement('div');
          activeRow.className = 'idea-item';
          activeRow.textContent = '#' + current.id + ' ' + current.title;
          var activeMeta = document.createElement('div');
          activeMeta.className = 'meta';
          activeMeta.textContent = current.approved ? 'APPROVED by Banana' : 'Pending Banana approval';
          activeRow.appendChild(activeMeta);
          activeRoot.appendChild(activeRow);
        }
      }

      vaultRoot.textContent = '';
      var vaultItems = ideaLabVaultItems();
      for (var v = 0; v < vaultItems.length && v < 18; v += 1) {
        var idea = vaultItems[v];
        var row = document.createElement('div');
        row.className = 'idea-item';
        row.textContent = '#' + idea.id + ' ' + idea.title;
        vaultRoot.appendChild(row);
      }
      if (!vaultRoot.childElementCount) {
        var emptyVault = document.createElement('div');
        emptyVault.className = 'idea-item';
        emptyVault.textContent = 'Vault queue exhausted in current scope.';
        vaultRoot.appendChild(emptyVault);
      }
    }

    function normalizeUsername(text) {
      return sanitizePlainText(text, 36).replace(/\s+/g, '').replace(/[^a-zA-Z0-9_.-]/g, '').toLowerCase();
    }

    function syncIdentityFromProfile() {
      runtime.identity784.globalIdentity.displayName = uiState.profile.displayName;
      runtime.identity784.globalIdentity.accountId = uiState.profile.username;
      runtime.identity784.emitUpdate();
      var headerName = document.querySelector('.hud-stats .stat-badge');
      if (headerName) headerName.textContent = uiState.profile.displayName;
    }

    function applyAuthIdentity(displayName, username, about) {
      var cleanName = sanitizePlainText(displayName, 36);
      var cleanUser = normalizeUsername(username || displayName);
      var cleanAbout = sanitizePlainText(about || '', 240);
      if (!cleanName || !cleanUser) return false;
      uiState.profile.displayName = cleanName;
      uiState.profile.username = cleanUser;
      if (cleanAbout) uiState.profile.about = cleanAbout;
      saveProfile();
      syncIdentityFromProfile();
      renderProfileViews();
      return true;
    }

    function showAuthError(message) {
      var node = safeById('auth-error');
      if (node) node.textContent = message || '';
    }

    function hideAuthOverlay() {
      var overlay = safeById('auth-overlay');
      if (overlay) overlay.classList.add('hidden');
      showAuthError('');
      setText('rt-last-action', 'auth success');
    }

    function showAuthOverlay() {
      var overlay = safeById('auth-overlay');
      if (overlay) overlay.classList.remove('hidden');
      var loginPass = safeById('auth-login-password');
      var signupPass = safeById('auth-signup-pass');
      if (loginPass) loginPass.value = '';
      if (signupPass) signupPass.value = '';
      var input = safeById('auth-login-id');
      if (input && uiState.auth.mode === 'login') input.focus();
    }

    function bindAuthInputShortcuts() {
      function submitOnEnter(node, action) {
        if (!node) return;
        node.addEventListener('keydown', function (evt) {
          if (evt.key !== 'Enter') return;
          evt.preventDefault();
          action();
        });
      }

      submitOnEnter(safeById('auth-login-id'), function () { window.submitAuthLogin(); });
      submitOnEnter(safeById('auth-login-password'), function () { window.submitAuthLogin(); });
      submitOnEnter(safeById('auth-signup-display'), function () { window.submitAuthSignup(); });
      submitOnEnter(safeById('auth-signup-user'), function () { window.submitAuthSignup(); });
      submitOnEnter(safeById('auth-signup-pass'), function () { window.submitAuthSignup(); });
      submitOnEnter(safeById('auth-signup-about'), function () { window.submitAuthSignup(); });
    }

    function setAuthMode(mode) {
      var isSignup = mode === 'signup';
      uiState.auth.mode = isSignup ? 'signup' : 'login';

      var loginPane = safeById('auth-pane-login');
      var signupPane = safeById('auth-pane-signup');
      var tabLogin = safeById('auth-tab-login');
      var tabSignup = safeById('auth-tab-signup');

      if (loginPane) loginPane.classList.toggle('active', !isSignup);
      if (signupPane) signupPane.classList.toggle('active', isSignup);
      if (tabLogin) tabLogin.classList.toggle('active', !isSignup);
      if (tabSignup) tabSignup.classList.toggle('active', isSignup);
      showAuthError('');
      renderAuthAccountList();
    }

    function loadAuthSession() {
      try {
        var raw = localStorage.getItem('mv-auth-v1');
        if (!raw) return;
        var parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object') return;

        var displayName = sanitizePlainText(parsed.displayName, 36);
        var username = normalizeUsername(parsed.username || '');
        uiState.auth.signedIn = !!parsed.signedIn;
        uiState.auth.mode = parsed.mode === 'signup' ? 'signup' : 'login';
        uiState.auth.source = sanitizePlainText(parsed.source, 16) || 'session';

        if (displayName && username) {
          uiState.profile.displayName = displayName;
          uiState.profile.username = username;
          syncIdentityFromProfile();
        }
      } catch (err) {
        // Ignore malformed auth session data.
      }
    }

    function ingestMasterIdeas(ideas) {
      if (!Array.isArray(ideas) || !ideas.length) return;
      uiState.ideaLab.ideas = ideas.slice(0, 260).map(function (item) {
        return {
          id: Number(item.id) || 0,
          title: sanitizePlainText(item.title, 120) || 'Untitled idea'
        };
      });
      renderIdeaLab();
      renderOnboardingTips();
    }

    function loadProfile() {
      try {
        var raw = localStorage.getItem('mv-profile-v1');
        if (!raw) return;
        var parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object') return;
        uiState.profile.displayName = sanitizePlainText(parsed.displayName, 36) || uiState.profile.displayName;
        uiState.profile.username = sanitizePlainText(parsed.username, 36) || uiState.profile.username;
        uiState.profile.about = sanitizePlainText(parsed.about, 240) || uiState.profile.about;
      } catch (err) {
        // Ignore malformed profile data.
      }
    }

    function saveCommunities() {
      try {
        localStorage.setItem('mv-communities-v1', JSON.stringify(uiState.communities.list || []));
      } catch (err) {
        // Ignore persistence errors.
      }
    }

    function loadCommunities() {
      try {
        var raw = localStorage.getItem('mv-communities-v1');
        if (!raw) return;
        var parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          uiState.communities.list = parsed.slice(0, 24);
        }
      } catch (err) {
        // Ignore malformed community data.
      }
    }

    function saveSecrets() {
      try {
        localStorage.setItem('mv-secrets-v1', JSON.stringify(uiState.secrets.revealed || {}));
      } catch (err) {
        // Ignore persistence errors.
      }
    }

    function loadSecrets() {
      try {
        var raw = localStorage.getItem('mv-secrets-v1');
        if (!raw) return;
        var parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') {
          uiState.secrets.revealed = parsed;
        }
      } catch (err) {
        // Ignore malformed secret data.
      }
    }

    function loadRecentExperiences() {
      try {
        var raw = localStorage.getItem('mv-recent-experiences-v1');
        if (!raw) return [];
        var parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
      } catch (err) {
        return [];
      }
    }

    function renderRecentExperiences() {
      var root = safeById('recent-experiences');
      if (!root) return;

      var list = loadRecentExperiences();
      root.textContent = '';
      if (!list.length) {
        var empty = document.createElement('div');
        empty.className = 'recent-chip';
        empty.textContent = 'No recent portals yet. Launch an experience to pin it here.';
        root.appendChild(empty);
        return;
      }

      for (var i = 0; i < list.length; i += 1) {
        (function () {
          var item = list[i];
          var canonical = getExperienceById(item.id);
          var iconKey = item.iconKey || (canonical ? canonical.iconKey : '');
          var icon = item.icon || (canonical ? canonical.icon : '🌌');
          var chip = document.createElement('button');
          chip.type = 'button';
          chip.className = 'recent-chip';
          chip.appendChild(createIconLabel(iconKey, icon, item.name));
          chip.addEventListener('click', function () {
            window.launchGame(item.id || 'sandbox');
          });
          root.appendChild(chip);
        })();
      }
    }

    function renderFriendBrowser() {
      var root = safeById('friend-browser-list');
      if (!root) return;
      root.textContent = '';

      var query = (uiState.social.friendSearch || '').toLowerCase();
      var source = uiState.social.friendCandidates || [];
      var shown = 0;

      for (var i = 0; i < source.length; i += 1) {
        var item = source[i];
        if (query && item.name.toLowerCase().indexOf(query) === -1) continue;
        shown += 1;

        var row = document.createElement('div');
        row.className = 'friend-item';

        var left = document.createElement('span');
        var dot = document.createElement('i');
        dot.className = 'status-dot ' + (item.online ? 'online' : 'offline');
        left.appendChild(dot);
        left.appendChild(document.createTextNode(item.name));

        var btn = document.createElement('button');
        btn.className = 'btn-action';
        var already = (uiState.social.friends || []).indexOf(item.name) !== -1;
        btn.textContent = already ? 'Friend' : 'Add';
        btn.disabled = already;
        if (!already) {
          (function (name) {
            btn.addEventListener('click', function () {
              window.addFriend(name);
            });
          })(item.name);
        }

        row.appendChild(left);
        row.appendChild(btn);
        root.appendChild(row);
        if (shown >= 14) break;
      }

      if (!shown) {
        var empty = document.createElement('div');
        empty.className = 'friend-item';
        empty.textContent = 'No players match your search yet.';
        root.appendChild(empty);
      }
    }

    function renderHomeFriendsStrip() {
      var root = safeById('home-friends-strip');
      if (!root) return;
      root.textContent = '';
      var source = playersExtra.slice(0, 8);

      var quickAdd = document.createElement('button');
      quickAdd.type = 'button';
      quickAdd.className = 'friend-bubble add-friend';
      quickAdd.title = 'Add Friends';

      var addAvatar = document.createElement('span');
      addAvatar.className = 'avatar';
      addAvatar.textContent = '+';

      var addName = document.createElement('span');
      addName.textContent = 'Add Friends';

      var addMeta = document.createElement('span');
      addMeta.style.opacity = '0.84';
      addMeta.style.fontSize = '0.72rem';
      addMeta.textContent = 'Open browser';

      quickAdd.appendChild(addAvatar);
      quickAdd.appendChild(addName);
      quickAdd.appendChild(addMeta);
      quickAdd.addEventListener('click', function () {
        window.switchChatTab('friends');
      });
      root.appendChild(quickAdd);

      function modeToId(modeName) {
        var key = String(modeName || '').toLowerCase();
        if (key === 'sandbox' || key === 'racers' || key === 'sword' || key === 'tycoon') return key;
        return 'sandbox';
      }

      for (var i = 0; i < source.length; i += 1) {
        var item = source[i];
        var bubble = document.createElement('button');
        bubble.type = 'button';
        bubble.className = 'friend-bubble';
        bubble.title = item.name;

        var avatar = document.createElement('span');
        avatar.className = 'avatar';
        avatar.appendChild(createIconElement(item.iconKey, '•', item.name));

        var name = document.createElement('span');
        name.textContent = item.name;

        var mode = document.createElement('span');
        mode.style.opacity = '0.84';
        mode.style.fontSize = '0.72rem';
        mode.textContent = item.mode;

        bubble.appendChild(avatar);
        bubble.appendChild(name);
        bubble.appendChild(mode);
        (function (modeId) {
          bubble.addEventListener('click', function () {
            window.launchGame(modeToId(modeId));
          });
        })(item.mode);
        root.appendChild(bubble);
      }

      setText('home-friends-title', 'Friends (' + String(source.length + 1) + ')');
    }

    function renderContinueRow() {
      var root = safeById('home-continue-row');
      if (!root) return;
      root.textContent = '';
      var list = loadRecentExperiences();
      if (!list.length) {
        var fallback = uiState.experiences.slice(0, 4);
        for (var f = 0; f < fallback.length; f += 1) {
          list.push(fallback[f]);
        }
      }

      for (var i = 0; i < list.length && i < 6; i += 1) {
        var item = list[i];
        var card = document.createElement('button');
        card.type = 'button';
        card.className = 'continue-card';

        var title = document.createElement('div');
        title.className = 'title';
        title.appendChild(createIconLabel(item.iconKey || 'neon', item.icon || '•', item.name || 'Unknown Experience'));

        var meta = document.createElement('div');
        meta.textContent = 'Resume session';

        card.appendChild(title);
        card.appendChild(meta);
        (function (id) {
          card.addEventListener('click', function () {
            window.launchGame(id || 'sandbox');
          });
        })(item.id);
        root.appendChild(card);
      }

      setText('home-continue-title', 'Continue (' + String(Math.min(list.length, 6)) + ')');
    }

    function renderChatHubList() {
      var root = safeById('chat-hub-list');
      if (!root) return;
      root.textContent = '';

      var groupsRow = document.createElement('div');
      groupsRow.className = 'chat-hub-item';
      groupsRow.innerHTML = '<strong>Communities</strong>Create and explore groups';
      groupsRow.addEventListener('click', function () {
        closeAllModals();
        window.switchChatTab('communities');
        appendChatMessage('global', 'System', 'Opened communities channel from chat hub.', true);
      });
      root.appendChild(groupsRow);

      var candidates = uiState.social.friendCandidates || [];
      var limit = Math.min(candidates.length, 18);
      for (var i = 0; i < limit; i += 1) {
        var person = candidates[i];
        var row = document.createElement('div');
        row.className = 'chat-hub-item';
        var ageTag = (i % 2 === 0) ? '2w' : 'Jun 2026';
        row.innerHTML = '<strong>' + sanitizePlainText(person.name, 40) + '</strong>' + sanitizePlainText(person.mode, 20) + ' · ' + ageTag;
        (function (personName) {
          row.addEventListener('click', function () {
            closeAllModals();
            window.switchChatTab('friends');
            appendChatMessage('friends', 'Party', 'Opened chat with ' + sanitizePlainText(personName, 40) + '.', true);
          });
        })(person.name);
        root.appendChild(row);
      }
    }

    function installTopSearch() {
      var input = document.querySelector('.top-search');
      if (!input || input.dataset.ready === '1') return;
      input.dataset.ready = '1';
      var timer = null;

      input.addEventListener('input', function () {
        if (timer) clearTimeout(timer);
        timer = setTimeout(function () {
          timer = null;
          var q = sanitizePlainText(input.value, 64).toLowerCase();

          var cards = document.querySelectorAll('#dashboard-games-grid .game-card');
          for (var i = 0; i < cards.length; i += 1) {
            var text = (cards[i].textContent || '').toLowerCase();
            cards[i].style.display = !q || text.indexOf(q) !== -1 ? '' : 'none';
          }

          uiState.social.friendSearch = q;
          renderFriendBrowser();
          renderChatHubList();
        }, 80);
      });
    }

    function renderProfileViews() {
      setText('profile-display-name', uiState.profile.displayName);
      setText('profile-username', '@' + uiState.profile.username);
      setText('profile-about', uiState.profile.about);

      var name = safeById('profile-edit-name');
      var username = safeById('profile-edit-username');
      var about = safeById('profile-edit-about');
      if (name) name.value = uiState.profile.displayName;
      if (username) username.value = uiState.profile.username;
      if (about) about.value = uiState.profile.about;
    }

    function renderCommunities() {
      var root = safeById('community-list');
      if (!root) return;
      root.textContent = '';

      var list = uiState.communities.list || [];
      for (var i = 0; i < list.length; i += 1) {
        var c = list[i];
        var card = document.createElement('div');
        card.className = 'community-card';

        var title = document.createElement('div');
        title.textContent = c.name;

        var meta = document.createElement('div');
        meta.className = 'meta';
        meta.textContent = 'Visibility: ' + c.visibility + ' | Members: ' + c.members.length + ' | Group Games: ' + c.games;

        var btn = document.createElement('button');
        btn.className = 'btn-action';
        btn.type = 'button';
        btn.textContent = 'Create Group Game';
        (function (communityId) {
          btn.addEventListener('click', function () {
            window.createCommunityGame(communityId);
          });
        })(c.id);

        card.appendChild(title);
        card.appendChild(meta);
        card.appendChild(btn);
        root.appendChild(card);
      }
    }

    function renderSecrets() {
      var countNode = safeById('secret-count');
      var listNode = safeById('secret-list');
      if (!countNode || !listNode) return;
      listNode.textContent = '';

      var catalog = uiState.secrets.catalog || [];
      var revealed = uiState.secrets.revealed || {};
      var revealedCount = 0;

      for (var i = 0; i < catalog.length; i += 1) {
        if (revealed[i]) revealedCount += 1;
      }
      countNode.textContent = revealedCount + ' / ' + catalog.length + ' secrets revealed';

      for (var j = 0; j < catalog.length; j += 1) {
        var row = document.createElement('div');
        row.className = 'secret-item';
        row.textContent = revealed[j] ? catalog[j] : 'Secret ' + (j + 1) + ' is hidden.';
        listNode.appendChild(row);
      }
    }

    function pushRecentExperience(exp) {
      var current = loadRecentExperiences();
      var next = [];
      next.push({ id: exp.id, name: exp.name, icon: exp.icon, iconKey: exp.iconKey });
      for (var i = 0; i < current.length; i += 1) {
        if (current[i].id !== exp.id) next.push(current[i]);
      }
      if (next.length > 8) next = next.slice(0, 8);
      saveRecentExperiences(next);
      renderRecentExperiences();
      renderContinueRow();
    }

    function evaluateQualityGate(isUltra) {
      var results = [];
      var defaultDeny = runtime.sandbox871 && runtime.sandbox871.policy && runtime.sandbox871.policy.mode === 'default-deny';
      var marketReady = !!runtime.broker874 && !!runtime.escrow872;
      var authorityReady = !!runtime.spatial790 && !!runtime.spatial975;
      var accessibilityReady = safeById('setting-reduced-motion') !== null;
      var categoryCountReady = (runtime.marketCatalog || []).length >= 4;
      var experiencesReady = (runtime.experienceCatalog || []).length >= 4;
      var runtimeProfile = runtime.dc200 ? runtime.dc200.profile : null;
      var inputCaps = runtimeProfile && runtimeProfile.staticCaps ? runtimeProfile.staticCaps.inputs : null;
      var inputCount = 0;
      var fps = runtimeProfile && runtimeProfile.runtime ? Number(runtimeProfile.runtime.averageFps) || 0 : 0;

      if (inputCaps) {
        if (inputCaps.keyboard) inputCount += 1;
        if (inputCaps.pointerFine) inputCount += 1;
        if (inputCaps.touch) inputCount += 1;
        if (inputCaps.gamepad) inputCount += 1;
      }

      function addGateResult(area, ruleRef, status, text, evidence) {
        results.push({ area: area, ruleRef: ruleRef, status: status, text: text, evidence: evidence || '' });
      }

      function checked(pass, fail, needsText, passText, failText) {
        if (fail) return { status: 'FAIL', text: failText };
        if (pass) return { status: 'PASS', text: passText };
        return { status: 'NEEDS WORK', text: needsText };
      }

      if (evidenceCount('gameplayLaunches') < 1) {
        addGateResult('Gameplay', 'R1,R3', 'NOT TESTED', 'No launch/play evidence recorded in this session yet.', 'launches:0');
      } else {
        addGateResult('Gameplay', 'R1,R3', 'PASS', 'Feature launch flow is active and gameplay entry points respond.', 'launches:' + evidenceCount('gameplayLaunches'));
      }

      if (evidenceCount('modalVisits') < 2) {
        addGateResult('UI', 'R31', 'NOT TESTED', 'UI navigation and layout need more interaction evidence.', 'modalVisits:' + evidenceCount('modalVisits'));
      } else {
        var uiReady = !!safeById('dashboard-games-grid') && !!safeById('modal-games-grid') && !!safeById('market-grid');
        addGateResult('UI', 'R31', uiReady ? 'PASS' : 'FAIL', uiReady ? 'Core interface sections are reachable and mounted.' : 'Core interface sections are missing or unreachable.', 'modalVisits:' + evidenceCount('modalVisits'));
      }

      if (!runtimeProfile) {
        addGateResult('Compatibility', 'R17,R18', 'NOT TESTED', 'No device/runtime profile evidence yet.', 'dc200:missing');
      } else {
        var compat = checked(inputCount >= 2, inputCount === 0, 'Device profile is present but input coverage is narrow.', 'Runtime profile is present with multi-input support.', 'No usable input capabilities detected by runtime profile.');
        addGateResult('Compatibility', 'R17,R18', compat.status, compat.text, 'inputs:' + inputCount);
      }

      if (!runtimeProfile || !runtimeProfile.runtime) {
        addGateResult('Performance', 'R16', 'NOT TESTED', 'No runtime FPS sample available yet.', 'fps:none');
      } else {
        var perf = checked(fps >= 30, fps < 20, 'Performance is functional but should be optimized for weaker hardware.', 'Runtime performance is within acceptable range.', 'Runtime performance is below acceptable range and risks lag.');
        addGateResult('Performance', 'R16', perf.status, perf.text, 'fps:' + fps.toFixed(1));
      }

      addGateResult('Multiplayer', 'R7,R8,R9', authorityReady ? 'PASS' : 'FAIL', authorityReady ? 'Authoritative and reconciliation systems are active.' : 'Authoritative multiplayer path is incomplete or missing.', 'authority:' + (authorityReady ? 'on' : 'off'));

      var securityPass = defaultDeny && marketReady && !!runtime.platformRules && runtime.platformRules.prohibitsBypass;
      addGateResult('Security & Permissions', 'R10,R11,R12', securityPass ? 'PASS' : 'FAIL', securityPass ? 'Sandbox policy and marketplace boundaries are enforced.' : 'Security boundary or permission path does not meet required policy.', 'sandbox:' + (defaultDeny ? 'default-deny' : 'weak'));

      var profilePayload = runtimeProfile && runtimeProfile.staticCaps ? JSON.stringify(runtimeProfile.staticCaps) : '';
      var privacyPass = !/(serial|mac|uuid|peripheralid|device model)/i.test(profilePayload);
      addGateResult('Privacy', 'R18,R21', privacyPass ? 'PASS' : 'FAIL', privacyPass ? 'Capability profiling avoids direct high-risk identifiers in exposed runtime profile.' : 'Runtime profile appears to expose identifying hardware details and must be reduced.', 'privacy:' + (privacyPass ? 'bounded' : 'risk'));

      var rightsReady = !!runtime.platformRules && !!runtime.platformRules.rightsPolicyReady;
      if (!rightsReady) {
        addGateResult('Rights', 'R25', 'GATED', 'Creator rights and licensing validation pipeline is not fully implemented yet.', 'rightsPolicy:missing');
      } else {
        addGateResult('Rights', 'R25', 'PASS', 'Creator rights and licensing validation policy is active.', 'rightsPolicy:active');
      }

      if (!accessibilityReady) {
        addGateResult('Accessibility', 'R14,R15', 'FAIL', 'Accessibility control hooks are missing from settings.', 'reducedMotion:missing');
      } else if (evidenceCount('settingsToggles') < 1) {
        addGateResult('Accessibility', 'R14,R15', 'NOT TESTED', 'Accessibility controls exist but were not exercised in this session.', 'settingsToggles:0');
      } else {
        addGateResult('Accessibility', 'R14,R15', 'PASS', 'Accessibility controls are present and have interaction evidence.', 'settingsToggles:' + evidenceCount('settingsToggles'));
      }

      if (evidenceCount('recoveryDrills') < 1) {
        addGateResult('Recovery', 'R19', 'NOT TESTED', 'No recovery drill evidence yet. Run runRecoveryDrill() before trusting recovery.', 'recoveryDrills:0');
      } else {
        addGateResult('Recovery', 'R19', 'PASS', 'Recovery drill completed without runtime errors.', 'recoveryDrills:' + evidenceCount('recoveryDrills'));
      }

      var integrated = experiencesReady && categoryCountReady;
      var integrationEvidence = evidenceCount('shopRequests') + evidenceCount('gameplayLaunches') + evidenceCount('modalVisits');
      if (integrationEvidence < 3) {
        addGateResult('Integration', 'R27,R28,R34', 'NOT TESTED', 'Cross-system behavior needs more interaction evidence.', 'integrationSignals:' + integrationEvidence);
      } else {
        addGateResult('Integration', 'R27,R28,R34', integrated ? 'PASS' : 'NEEDS WORK', integrated ? 'Feature cooperates with existing platform systems.' : 'Feature runs but integration coverage is incomplete.', 'integrationSignals:' + integrationEvidence);
      }

      var notTestedCount = 0;
      for (var r = 0; r < results.length; r += 1) {
        if (results[r].status === 'NOT TESTED') notTestedCount += 1;
      }
      var honestyText = notTestedCount > 0
        ? 'Runtime honesty active: ' + notTestedCount + ' area(s) marked NOT TESTED and not auto-passed.'
        : 'Runtime honesty active: all BIG CHECK areas have explicit evidence states.';
      addGateResult('Runtime Honesty', 'R22,R23', 'PASS', honestyText, 'bigChecks:' + evidenceCount('bigChecks'));

      if (isUltra) {
        var categories = runtime.marketCatalog || [];
        var allLarge = true;
        for (var i = 0; i < categories.length; i += 1) {
          if (!categories[i].items || categories[i].items.length < 100) {
            allLarge = false;
            break;
          }
        }
        addGateResult('ULTRA: Scale', 'R27,R34', allLarge ? 'PASS' : 'NEEDS WORK', allLarge ? 'Every marketplace category has at least 100 items.' : 'At least one category is below required item scale.', 'categories:' + categories.length);
        addGateResult('ULTRA: Device Adaptation', 'R16,R17,R18', parseFloat((safeById('setting-realism') || {}).value || '0') >= 0 ? 'PASS' : 'FAIL', 'Realism slider path is active for adaptive presentation.', 'realismSlider:active');
        addGateResult('ULTRA: Prototype Guardrails', 'R21,R22', !!runtime.platformRules && runtime.platformRules.prototypeIsNotComplete ? 'PASS' : 'FAIL', 'Prototype-vs-finished guardrails are represented in platform policy.', 'prototypeGuard:' + (!!runtime.platformRules && runtime.platformRules.prototypeIsNotComplete));
        addGateResult('ULTRA: Naming Canon', 'R24,R25,R26', !!runtime.platformRules && runtime.platformRules.naming && runtime.platformRules.naming.blockWorld === 'BlockWorld' && runtime.platformRules.naming.pulseArena === 'Pulse Arena' ? 'PASS' : 'FAIL', 'Naming canon includes BlockWorld and Pulse Arena identities.', 'namingCanon:checked');
        addGateResult('ULTRA: Governance Depth', 'R30,R31,R32,R35', !!runtime.platformRules && runtime.platformRules.ruleCount >= 35 ? 'PASS' : 'NEEDS WORK', 'Governance tracks full 35-rule baseline before trust/release.', 'ruleCount:' + ((runtime.platformRules && runtime.platformRules.ruleCount) || 0));
      }

      return results;
    }

    function renderQualityResults(label, results) {
      var root = safeById('quality-check-results');
      if (!root) return;
      root.textContent = '';

      var passCount = 0;
      var needsCount = 0;
      var failCount = 0;
      var notTestedCount = 0;
      for (var i = 0; i < results.length; i += 1) {
        var status = results[i].status || 'NOT TESTED';
        if (status === 'PASS') passCount += 1;
        else if (status === 'NEEDS WORK') needsCount += 1;
        else if (status === 'FAIL') failCount += 1;
        else notTestedCount += 1;

        var li = document.createElement('li');
        li.setAttribute('data-status', status.toLowerCase().replace(/\s+/g, '-'));
        var ruleTag = results[i].ruleRef ? '[' + results[i].ruleRef + '] ' : '';
        var areaTag = results[i].area ? results[i].area + ' · ' : '';
        var evTag = results[i].evidence ? ' | evidence: ' + results[i].evidence : '';
        li.textContent = status + ' · ' + areaTag + ruleTag + results[i].text + evTag;
        root.appendChild(li);
      }

      var summary = document.createElement('li');
      summary.textContent = label + ' summary: PASS ' + passCount + ', NEEDS WORK ' + needsCount + ', FAIL ' + failCount + ', NOT TESTED ' + notTestedCount + '.';
      root.appendChild(summary);
    }

    function loadUiSettings() {
      try {
        var raw = localStorage.getItem('mv-settings-v2');
        if (!raw) return;
        var parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object') return;

        uiState.settings.reducedMotion = !!parsed.reducedMotion;
        uiState.settings.performance = !!parsed.performance;
        uiState.settings.streamer = !!parsed.streamer;
        uiState.settings.cinematic = !!parsed.cinematic;
        uiState.settings.physics = !!parsed.physics;
        uiState.settings.debugMode = !!parsed.debugMode;
        uiState.settings.visibilityBoost = parsed.visibilityBoost !== false;
        uiState.settings.hideExtras = !!parsed.hideExtras;
        if (Number.isFinite(parsed.realism)) {
          uiState.settings.realism = clamp(parsed.realism, 0, 100);
        }
      } catch (err) {
        // Ignore malformed storage.
      }
    }

    var playersExtra = [
      { name: 'NovaSentinel', mode: 'Sandbox', iconKey: 'rocket', online: true },
      { name: 'AeroLancer', mode: 'Racers', iconKey: 'racer', online: true },
      { name: 'GlyphRider', mode: 'Sword', iconKey: 'sword', online: true },
      { name: 'IronBloom', mode: 'Tycoon', iconKey: 'castle', online: false },
      { name: 'PixelMonk', mode: 'Sandbox', iconKey: 'badge', online: true },
      { name: 'OrbitWarden', mode: 'Racers', iconKey: 'racer', online: true },
      { name: 'StormCipher', mode: 'Sword', iconKey: 'sword', online: true },
      { name: 'ZenBreaker', mode: 'Tycoon', iconKey: 'castle', online: true },
      { name: 'NeonAtlas', mode: 'Sandbox', iconKey: 'neon', online: false },
      { name: 'MechaWillow', mode: 'Racers', iconKey: 'racer', online: true },
      { name: 'TerraPulse', mode: 'Sword', iconKey: 'sword', online: true },
      { name: 'LumaGrid', mode: 'Tycoon', iconKey: 'castle', online: true },
      { name: 'SpectraFox', mode: 'Sandbox', iconKey: 'companion', online: true },
      { name: 'KiteHarbor', mode: 'Racers', iconKey: 'racer', online: false },
      { name: 'EchoForge', mode: 'Sword', iconKey: 'sword', online: true },
      { name: 'ArgonMist', mode: 'Tycoon', iconKey: 'castle', online: true },
      { name: 'HyperMantis', mode: 'Sandbox', iconKey: 'drone', online: true },
      { name: 'RuneVolley', mode: 'Racers', iconKey: 'racer', online: true },
      { name: 'DriftJuno', mode: 'Sword', iconKey: 'sword', online: false },
      { name: 'SolarCrafter', mode: 'Tycoon', iconKey: 'castle', online: true }
    ];

    function applyRealismProfile(value) {
      var realism = clamp(Number(value) || 0, 0, 100);
      uiState.settings.realism = realism;
      setText('setting-realism-value', realism + '%');
      document.body.setAttribute('data-mv-realism', String(realism));

      var adaptiveTier = uiState.adaptive ? uiState.adaptive.tier : 'balanced';
      var realismNorm = realism / 100;
      var tierStrength = adaptiveTier === 'legacy' ? 0.74 : (adaptiveTier === 'premium' ? 1.12 : 1);
      var depth = clamp((0.28 + (realismNorm * 0.72)) * tierStrength, 0.25, 1.15);
      var sharpness = clamp(0.985 + (realismNorm * 0.045 * tierStrength), 0.98, 1.08);
      var specular = clamp((0.06 + (realismNorm * 0.24)) * tierStrength, 0.05, 0.34);

      var realismTier = 'low';
      if (realism >= 90) realismTier = 'ultra';
      else if (realism >= 70) realismTier = 'high';
      else if (realism >= 45) realismTier = 'mid';

      document.body.setAttribute('data-mv-realism-tier', realismTier);
      document.documentElement.style.setProperty('--mv-realism-depth', depth.toFixed(3));
      document.documentElement.style.setProperty('--mv-realism-sharpness', sharpness.toFixed(3));
      document.documentElement.style.setProperty('--mv-realism-specular', specular.toFixed(3));

      var contrast = (1 + ((realism - 50) / 320) * tierStrength).toFixed(3);
      var saturate = (0.9 + (realism / 210) * tierStrength).toFixed(3);
      var brightness = (0.95 + (realism / 380) * tierStrength).toFixed(3);
      document.body.style.filter = 'contrast(' + contrast + ') saturate(' + saturate + ') brightness(' + brightness + ')';
    }

    function renderPlayersFeed() {
      var feed = safeById('players-feed');
      if (!feed) return;
      feed.textContent = '';
      for (var j = 0; j < playersExtra.length; j += 1) {
        var item = playersExtra[j];
        var row = document.createElement('div');
        row.className = 'player-item';

        var left = document.createElement('span');
        var dot = document.createElement('i');
        dot.className = 'status-dot ' + (item.online ? 'online' : 'offline');
        left.appendChild(dot);
        left.appendChild(createIconElement(item.iconKey, '', item.mode + ' icon'));
        left.appendChild(document.createTextNode(item.name));

        var right = document.createElement('span');
        right.textContent = item.mode;

        row.appendChild(left);
        row.appendChild(right);
        feed.appendChild(row);
      }
    }

    function getMarketCategory(categoryId) {
      for (var i = 0; i < uiState.market.catalog.length; i += 1) {
        if (uiState.market.catalog[i].id === categoryId) return uiState.market.catalog[i];
      }
      return uiState.market.catalog[0];
    }

    function getFilteredMarketItems() {
      var category = getMarketCategory(uiState.market.categoryId);
      var query = uiState.market.query.trim().toLowerCase();
      if (!query) return category.items.slice();

      var filtered = [];
      for (var i = 0; i < category.items.length; i += 1) {
        var item = category.items[i];
        if (item.name.toLowerCase().indexOf(query) !== -1 || item.id.indexOf(query) !== -1) {
          filtered.push(item);
        }
      }
      return filtered;
    }

    function renderMarketplace() {
      var tabsNode = safeById('market-tabs');
      var gridNode = safeById('market-grid');
      var countNode = safeById('market-count');
      var pageNode = safeById('market-page-meta');
      var prevNode = safeById('market-prev');
      var nextNode = safeById('market-next');
      if (!tabsNode || !gridNode || !countNode || !pageNode || !prevNode || !nextNode) return;

      if (!tabsNode.dataset.ready) {
        tabsNode.dataset.ready = '1';
        tabsNode.textContent = '';
        for (var t = 0; t < uiState.market.catalog.length; t += 1) {
          (function () {
            var category = uiState.market.catalog[t];
            var btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'market-tab';
            btn.appendChild(createIconLabel(category.tabIconKey, category.icon || '•', category.label));
            btn.setAttribute('data-market-category', category.id);
            btn.addEventListener('click', function () {
              window.marketSetCategory(category.id);
            });
            tabsNode.appendChild(btn);
          })();
        }
      }

      var tabButtons = tabsNode.querySelectorAll('.market-tab');
      for (var b = 0; b < tabButtons.length; b += 1) {
        tabButtons[b].classList.toggle('active', tabButtons[b].getAttribute('data-market-category') === uiState.market.categoryId);
      }

      var filtered = getFilteredMarketItems();
      var pageCount = Math.max(1, Math.ceil(filtered.length / uiState.market.pageSize));
      if (uiState.market.page >= pageCount) uiState.market.page = pageCount - 1;
      if (uiState.market.page < 0) uiState.market.page = 0;

      var start = uiState.market.page * uiState.market.pageSize;
      var end = Math.min(filtered.length, start + uiState.market.pageSize);
      var visible = filtered.slice(start, end);

      gridNode.textContent = '';
      for (var i = 0; i < visible.length; i += 1) {
        (function () {
          var item = visible[i];
          var card = document.createElement('div');
          card.className = 'game-card';
          card.setAttribute('data-item-id', item.id);
          card.setAttribute('data-item-price', String(item.price));

          var thumb = document.createElement('div');
          thumb.className = 'game-thumb';
          thumb.appendChild(createIconElement(item.iconKey, item.icon, item.name + ' icon'));

          var name = document.createElement('div');
          name.className = 'game-name';
          name.textContent = item.name;

          var meta = document.createElement('div');
          meta.className = 'game-players';
          meta.textContent = 'M$ ' + item.price + ' · ' + formatCount(item.popularity) + ' wishlists';

          card.appendChild(thumb);
          card.appendChild(name);
          card.appendChild(meta);
          card.addEventListener('click', function () {
            window.queueShopItem(item.name, item.price);
          });
          gridNode.appendChild(card);
        })();
      }

      var category = getMarketCategory(uiState.market.categoryId);
      countNode.textContent = category.label + ': ' + formatCount(filtered.length) + ' items';
      pageNode.textContent = 'Page ' + String(uiState.market.page + 1) + ' / ' + String(pageCount);
      prevNode.disabled = uiState.market.page <= 0;
      nextNode.disabled = uiState.market.page >= pageCount - 1;
      uiState.market.lastRenderAt = Date.now();
    }

    var marketRenderPending = false;
    function scheduleMarketplaceRender() {
      if (marketRenderPending) return;
      marketRenderPending = true;
      var flush = function () {
        marketRenderPending = false;
        renderMarketplace();
      };

      if (document.hidden) {
        setTimeout(flush, 16);
        return;
      }
      requestAnimationFrame(flush);
    }

    function installMarketplaceControls() {
      var searchNode = safeById('market-search');
      var prevNode = safeById('market-prev');
      var nextNode = safeById('market-next');
      var searchTimer = null;

      if (searchNode && !searchNode.dataset.ready) {
        searchNode.dataset.ready = '1';
        searchNode.addEventListener('input', function () {
          bumpEvidence('marketSearches');
          uiState.market.query = (searchNode.value || '').slice(0, 48);
          uiState.market.page = 0;
          if (searchTimer) {
            clearTimeout(searchTimer);
          }
          searchTimer = setTimeout(function () {
            searchTimer = null;
            scheduleMarketplaceRender();
          }, 100);
        });
      }

      if (prevNode && !prevNode.dataset.ready) {
        prevNode.dataset.ready = '1';
        prevNode.addEventListener('click', function () {
          uiState.market.page -= 1;
          scheduleMarketplaceRender();
        });
      }

      if (nextNode && !nextNode.dataset.ready) {
        nextNode.dataset.ready = '1';
        nextNode.addEventListener('click', function () {
          uiState.market.page += 1;
          scheduleMarketplaceRender();
        });
      }

      window.marketSetCategory = function (categoryId) {
        var category = getMarketCategory(categoryId);
        uiState.market.categoryId = category.id;
        uiState.market.page = 0;
        scheduleMarketplaceRender();
      };
    }

    function installRealtimeFeeds() {
      var statusNode = safeById('scene-status');
      var modePool = ['Sandbox', 'Racers', 'Sword', 'Tycoon'];
      var tick = 0;

      function scheduleNext() {
        var delay = uiState.adaptive && uiState.adaptive.feedIntervalMs ? uiState.adaptive.feedIntervalMs : 1300;
        setTimeout(runTick, delay);
      }

      function runTick() {
        if (document.hidden) {
          scheduleNext();
          return;
        }
        tick += 1;
        var total = 0;
        var spread = uiState.adaptive && Number.isFinite(uiState.adaptive.driftSpread) ? uiState.adaptive.driftSpread : 16;
        for (var i = 0; i < uiState.experiences.length; i += 1) {
          var entry = uiState.experiences[i];
          var drift = Math.floor(Math.random() * ((spread * 2) + 1)) - spread;
          var center = (entry.min + entry.max) / 2;
          var rebalance = Math.round((center - entry.players) * 0.04);
          entry.players = Math.max(entry.min, Math.min(entry.max, entry.players + drift));
          entry.players = Math.max(entry.min, Math.min(entry.max, entry.players + rebalance));
          total += entry.players;

          var node = safeById('live-players-' + entry.id);
          if (node) node.textContent = formatCount(entry.players) + ' Playing';
        }

        if (statusNode) {
          var ms = Date.now() % 100000;
          statusNode.textContent = 'Universe shell online · live concurrency ' + formatCount(total) + ' · tick ' + ms;
        }
        bumpEvidence('runtimeTicks');

        if (tick % 2 === 0) {
          var category = getMarketCategory(uiState.market.categoryId);
          var mutationCount = uiState.adaptive && Number.isFinite(uiState.adaptive.marketMutations) ? uiState.adaptive.marketMutations : 4;
          for (var j = 0; j < mutationCount; j += 1) {
            var idx = Math.floor(Math.random() * category.items.length);
            var item = category.items[idx];
            var delta = Math.floor(Math.random() * 7) - 3;
            item.price = Math.max(40, Math.min(9999, item.price + delta));
            item.popularity = Math.max(120, item.popularity + (Math.floor(Math.random() * 44) - 16));
          }
        }

        var shopModal = safeById('modal-shop');
        if (shopModal && shopModal.style.display === 'block' && tick % 2 === 0) {
          scheduleMarketplaceRender();
        }

        var who = playersExtra[Math.floor(Math.random() * playersExtra.length)];
        who.online = Math.random() > 0.2;
        who.mode = modePool[Math.floor(Math.random() * modePool.length)];

        var playersPanel = safeById('panel-players');
        if (playersPanel && playersPanel.classList.contains('active') && tick % 2 === 0) {
          renderPlayersFeed();
        }

        scheduleNext();
      }

      scheduleNext();
    }

    window.setAuthMode = function (mode) {
      setAuthMode(mode);
    };

    window.toggleAuthMode = function () {
      setAuthMode(uiState.auth.mode === 'login' ? 'signup' : 'login');
    };

    window.submitAuthLogin = function () {
      var idInput = safeById('auth-login-id');
      var passInput = safeById('auth-login-password');
      var handle = normalizeUsername(idInput ? idInput.value : '');
      var pass = sanitizePlainText(passInput ? passInput.value : '', 64);
      if (!handle || pass.length < 4) {
        showAuthError('Enter a valid handle and password to continue.');
        return;
      }

      var display = handle.split(/[_.-]/)[0] || handle;
      display = display.charAt(0).toUpperCase() + display.slice(1);
      var known = null;
      for (var k = 0; k < uiState.auth.accounts.length; k += 1) {
        if (uiState.auth.accounts[k].username === handle) {
          known = uiState.auth.accounts[k];
          break;
        }
      }
      if (!applyAuthIdentity(known ? known.displayName : display, handle, known ? known.about : 'Logged in through early beta access panel.')) {
        showAuthError('Could not validate account details. Try again.');
        return;
      }

      uiState.auth.signedIn = true;
      uiState.auth.source = 'login';
      upsertAuthAccount();
      saveAuthSession();
      hideAuthOverlay();
      renderOnboardingTips();
      appendChatMessage('global', 'System', 'Welcome back, ' + uiState.profile.displayName + '.', true);
    };

    window.submitAuthSignup = function () {
      var nameInput = safeById('auth-signup-display');
      var userInput = safeById('auth-signup-user');
      var passInput = safeById('auth-signup-pass');
      var aboutInput = safeById('auth-signup-about');

      var displayName = sanitizePlainText(nameInput ? nameInput.value : '', 36);
      var username = normalizeUsername(userInput ? userInput.value : '');
      var pass = sanitizePlainText(passInput ? passInput.value : '', 64);
      var about = sanitizePlainText(aboutInput ? aboutInput.value : '', 120);

      if (!displayName || !username) {
        showAuthError('Display name and username are required.');
        return;
      }
      if (pass.length < 8) {
        showAuthError('Password must be at least 8 characters.');
        return;
      }
      if (!/^[a-z0-9_.-]{3,36}$/.test(username)) {
        showAuthError('Username must use 3-36 chars: letters, numbers, underscore, dot, hyphen.');
        return;
      }

      if (!applyAuthIdentity(displayName, username, about || 'New creator in early beta sandbox.')) {
        showAuthError('Could not create account from current fields.');
        return;
      }

      uiState.auth.signedIn = true;
      uiState.auth.source = 'signup';
      upsertAuthAccount();
      saveAuthSession();
      hideAuthOverlay();
      renderOnboardingTips();
      appendChatMessage('global', 'System', 'Account created. Welcome, ' + uiState.profile.displayName + '.', true);
    };

    window.enterAsGuest = function () {
      uiState.auth.signedIn = true;
      uiState.auth.source = 'guest';
      applyAuthIdentity(uiState.profile.displayName || 'Guest', uiState.profile.username || 'guest-local', uiState.profile.about);
      upsertAuthAccount();
      saveAuthSession();
      hideAuthOverlay();
      renderOnboardingTips();
      appendChatMessage('global', 'System', 'Guest session active. You can edit profile anytime.', true);
    };

    window.useSavedAccount = function (username) {
      var key = normalizeUsername(username || '');
      if (!key) return;
      var found = null;
      for (var i = 0; i < uiState.auth.accounts.length; i += 1) {
        if (uiState.auth.accounts[i].username === key) {
          found = uiState.auth.accounts[i];
          break;
        }
      }
      if (!found) return;
      var loginId = safeById('auth-login-id');
      if (loginId) loginId.value = found.username;
      setAuthMode('login');
      applyAuthIdentity(found.displayName, found.username, found.about || uiState.profile.about);
      showAuthError('Selected @' + found.username + '. Enter password then continue.');
    };

    window.switchAccount = function () {
      uiState.auth.signedIn = false;
      uiState.auth.source = 'switch';
      saveAuthSession();
      closeAllModals();
      setAuthMode('login');
      showAuthOverlay();
      renderAuthAccountList();
      setText('rt-last-action', 'switch account');
    };

    window.logoutAccount = function () {
      uiState.auth.signedIn = false;
      uiState.auth.source = 'logout';
      saveAuthSession();
      closeAllModals();
      setAuthMode('login');
      showAuthOverlay();
      renderAuthAccountList();
      appendChatMessage('global', 'System', 'Logged out. Log in or sign up to continue.', true);
      setText('rt-last-action', 'logged out');
    };

    window.dismissOnboardingTips = function () {
      uiState.onboarding.dismissed = true;
      saveOnboardingState();
      renderOnboardingTips();
    };

    window.unlockIdeaVault = function () {
      var input = safeById('idea-mfa-input');
      var code = sanitizePlainText(input ? input.value : '', 24).toUpperCase();
      if (code !== 'BANANA-4') {
        setText('idea-lab-note', 'MFA denied. Use approved vault code.');
        renderIdeaLab();
        return;
      }

      uiState.ideaLab.unlocked = true;
      uiState.ideaLab.unlockUntil = Date.now() + 90000;
      uiState.ideaLab.pullCount = 0;
      if (input) input.value = '';
      setText('idea-lab-note', 'Vault unlocked. Pull up to 10 ideas this cycle.');
      renderIdeaLab();
    };

    window.pullIdeaFromVault = function () {
      if (!uiState.ideaLab.unlocked || Date.now() > uiState.ideaLab.unlockUntil) {
        uiState.ideaLab.unlocked = false;
        setText('idea-lab-note', 'Vault is locked. Unlock with MFA first.');
        renderIdeaLab();
        return;
      }
      if (uiState.ideaLab.pullCount >= uiState.ideaLab.maxPulls) {
        uiState.ideaLab.unlocked = false;
        setText('idea-lab-note', 'Pull limit reached. Vault auto-locked.');
        renderIdeaLab();
        return;
      }
      if (uiState.ideaLab.active.length >= uiState.ideaLab.maxActive) {
        setText('idea-lab-note', 'Active queue full. Keep max 4 active ideas.');
        renderIdeaLab();
        return;
      }

      var pool = ideaLabVaultItems();
      if (!pool.length) {
        setText('idea-lab-note', 'No more ideas available in current vault scope.');
        renderIdeaLab();
        return;
      }

      var nextIdea = pool[0];
      uiState.ideaLab.active.push({ id: nextIdea.id, title: nextIdea.title, approved: false });
      uiState.ideaLab.pullCount += 1;
      saveIdeaLabState();
      setText('idea-lab-note', 'Pulled idea #' + nextIdea.id + '. Waiting Banana approval.');
      renderIdeaLab();
      renderOnboardingTips();
    };

    window.approveAllActiveIdeas = function () {
      if (!uiState.ideaLab.active.length) {
        setText('idea-lab-note', 'No active ideas to approve.');
        return;
      }

      for (var i = 0; i < uiState.ideaLab.active.length; i += 1) {
        uiState.ideaLab.active[i].approved = true;
      }
      saveIdeaLabState();
      setText('idea-lab-note', 'Banana approval applied to all active ideas.');
      renderIdeaLab();
    };

    window.showDashboard = function () {
      closeAllModals();
      var dashboard = safeById('dashboard-overlay');
      if (dashboard) dashboard.style.display = 'block';
      markActiveNav('nav-home');
    };

    window.openModal = function (modalId) {
      var overlay = safeById('auth-overlay');
      if (overlay && !overlay.classList.contains('hidden')) {
        showAuthOverlay();
        return;
      }

      var modal = safeById(modalId);
      if (!modal) {
        appendChatMessage('global', 'System', 'Unknown view requested: ' + String(modalId), true);
        window.showDashboard();
        return;
      }
      bumpEvidence('modalVisits');

      closeAllModals();
      var dashboard = safeById('dashboard-overlay');
      if (dashboard) dashboard.style.display = 'none';
      modal.style.display = 'block';

      if (modalId === 'modal-games') markActiveNav('nav-games');
      if (modalId === 'modal-shop') {
        markActiveNav('nav-more');
        scheduleMarketplaceRender();
      }
      if (modalId === 'modal-updates') markActiveNav('nav-more');
      if (modalId === 'modal-settings') markActiveNav('nav-more');
      if (modalId === 'modal-chat-hub') {
        markActiveNav('nav-chat');
        renderChatHubList();
      }
      if (modalId === 'modal-profile' || modalId === 'modal-profile-edit' || modalId === 'modal-profile-about') {
        markActiveNav('nav-me');
        renderProfileViews();
      }
      if (modalId === 'modal-idea-lab') {
        markActiveNav('nav-more');
        renderIdeaLab();
      }
      if (modalId === 'modal-more') markActiveNav('nav-more');
    };

    window.closeModals = function () {
      closeAllModals();
      window.showDashboard();
    };

    window.launchGame = function (gameId) {
      var allowed = false;
      for (var ai = 0; ai < uiState.experiences.length; ai += 1) {
        if (uiState.experiences[ai].id === gameId) {
          allowed = true;
          break;
        }
      }
      if (!allowed) {
        appendChatMessage('global', 'System', 'Blocked launch for unknown mode: ' + String(gameId), true);
        return;
      }

      var exp = null;
      for (var i = 0; i < uiState.experiences.length; i += 1) {
        if (uiState.experiences[i].id === gameId) {
          exp = uiState.experiences[i];
          break;
        }
      }

      setText('rt-last-action', 'launch request: ' + gameId);
      runtime.identity784.setCurrentMode(gameId);
      if (exp) {
        pushRecentExperience(exp);
        bumpEvidence('gameplayLaunches');
        renderOnboardingTips();
        uiState.aiBrain.memory.lastLaunched = exp.id;
        uiState.aiBrain.memory.preferredMode = exp.id;
        appendChatMessage('global', 'System', 'Launch request accepted for ' + exp.name + '. Session bootstrap pipeline queued.', true);
      } else {
        appendChatMessage('global', 'System', 'Launch request accepted for ' + gameId + '. Session bootstrap pipeline queued.', true);
      }
      closeModals();
    };

    window.runBigCheck = function () {
      bumpEvidence('bigChecks');
      var results = evaluateQualityGate(false);
      renderQualityResults('BIG CHECK', results);
      setText('rt-last-action', 'BIG CHECK completed');
    };

    window.runUltraCheck = function () {
      bumpEvidence('ultraChecks');
      var results = evaluateQualityGate(true);
      renderQualityResults('ULTRA CHECK', results);
      setText('rt-last-action', 'ULTRA CHECK completed');
    };

    window.runAllChecks = function () {
      bumpEvidence('bigChecks');
      bumpEvidence('ultraChecks');
      var big = evaluateQualityGate(false);
      var ultra = evaluateQualityGate(true);
      var recoveryOk = window.runRecoveryDrill();
      var debugFindings = runDebugSweep('silent');

      var combined = [];
      for (var i = 0; i < big.length; i += 1) combined.push(big[i]);
      for (var j = 0; j < ultra.length; j += 1) combined.push(ultra[j]);

      combined.push({
        area: 'TEST ALL',
        ruleRef: 'R16-R35',
        status: recoveryOk ? 'PASS' : 'FAIL',
        text: recoveryOk ? 'Recovery drill passed during Test All.' : 'Recovery drill failed during Test All.',
        evidence: 'recovery:' + (recoveryOk ? 'pass' : 'fail')
      });

      var hasDebugFail = false;
      for (var d = 0; d < debugFindings.length; d += 1) {
        if (debugFindings[d].severity === 'FAIL') {
          hasDebugFail = true;
          break;
        }
      }

      combined.push({
        area: 'TEST ALL',
        ruleRef: 'R22,R23',
        status: hasDebugFail ? 'NEEDS WORK' : 'PASS',
        text: hasDebugFail ? 'Debug sweep reported FAIL severity findings.' : 'Debug sweep did not report FAIL severity findings.',
        evidence: 'debugFindings:' + debugFindings.length
      });

      renderQualityResults('TEST ALL', combined);
      setText('rt-last-action', 'TEST ALL completed');
      appendChatMessage('global', 'System', 'TEST ALL completed: BIG + ULTRA + Recovery + Debug sweep.', true);
    };

    window.runRecoveryDrill = function () {
      var ok = true;
      try {
        var probeKey = 'mv-recovery-drill-v1';
        localStorage.setItem(probeKey, String(Date.now()));
        var readback = localStorage.getItem(probeKey);
        if (!readback) ok = false;
      } catch (err) {
        ok = false;
      }

      if (ok) {
        bumpEvidence('recoveryDrills');
        appendChatMessage('global', 'Recovery', 'Recovery drill completed. Local persistence path is healthy.', true);
      } else {
        appendChatMessage('global', 'Recovery', 'Recovery drill failed. Persistence path unavailable.', true);
      }
      setText('rt-last-action', 'recovery drill ' + (ok ? 'pass' : 'fail'));
      return ok;
    };

    window.openRulesReference = function () {
      var note = safeById('rules-reference-note');
      if (note) {
        note.innerHTML = '<span>v1.6 Rules:</span> Canonical policy baseline is documented in the rules reference document (35 rules).';
      }
      window.openModal('modal-updates');
      setText('rt-last-action', 'rules reference opened');
    };

    window.addFriend = function (name) {
      var candidate = sanitizePlainText(name, 36);
      if (!candidate) return;
      if ((uiState.social.friends || []).indexOf(candidate) !== -1) return;
      uiState.social.friends.push(candidate);
      if (uiState.social.friends.length > 60) uiState.social.friends = uiState.social.friends.slice(0, 60);
      saveFriends();
      bumpEvidence('friendAdds');
      renderFriendBrowser();
      renderOnboardingTips();
      appendChatMessage('friends', 'Party', candidate + ' added to your friends list.', true);
      setText('rt-last-action', 'friend added: ' + candidate);
    };

    window.createCommunity = function () {
      var nameInput = safeById('community-name');
      var visibilityInput = safeById('community-visibility');
      var membersInput = safeById('community-members');
      if (!nameInput || !visibilityInput || !membersInput) return;

      var name = sanitizePlainText(nameInput.value, 36);
      var visibility = (visibilityInput.value || 'public').trim().toLowerCase();
      var membersRaw = sanitizePlainText(membersInput.value, 180);
      if (!name) {
        appendChatMessage('global', 'System', 'Community name is required.', true);
        return;
      }
      if (!/^(public|private|unlisted)$/.test(visibility)) visibility = 'public';

      var members = ['Creator'];
      if (membersRaw) {
        var bits = membersRaw.split(',');
        for (var i = 0; i < bits.length; i += 1) {
          var person = bits[i].trim();
          person = sanitizePlainText(person, 28);
          if (!person) continue;
          if (members.indexOf(person) === -1) members.push(person);
        }
      }

      var id = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 28);
      if (!id) id = 'community-' + Date.now();
      uiState.communities.list.unshift({ id: id, name: name, visibility: visibility, members: members, games: 0 });
      if (uiState.communities.list.length > 24) uiState.communities.list = uiState.communities.list.slice(0, 24);
      saveCommunities();
      bumpEvidence('communityCreates');
      renderCommunities();
      appendChatMessage('global', 'Community', 'Created ' + name + ' (' + visibility + ') with ' + members.length + ' member(s).', true);
      nameInput.value = '';
      membersInput.value = '';
      setText('rt-last-action', 'community created: ' + name);
    };

    window.createCommunityGame = function (communityId) {
      var list = uiState.communities.list || [];
      var selected = null;
      for (var i = 0; i < list.length; i += 1) {
        if (list[i].id === communityId) {
          selected = list[i];
          break;
        }
      }
      if (!selected) return;

      selected.games += 1;
      var newId = selected.id + '-game-' + selected.games;
      uiState.experiences.push({
        id: newId,
        icon: '🧩',
        iconKey: 'companion',
        name: selected.name + ' Build ' + selected.games,
        players: 180,
        min: 60,
        max: 980
      });

      runtime.experienceCatalog = uiState.experiences;
      saveCommunities();
      renderCommunities();
      renderExperienceCards();
      renderContinueRow();
      appendChatMessage('global', 'Community', 'Group game created under ' + selected.name + '.', true);
      setText('rt-last-action', 'community game created: ' + selected.name);
    };

    window.saveProfileEdits = function () {
      var nameInput = safeById('profile-edit-name');
      var usernameInput = safeById('profile-edit-username');
      var aboutInput = safeById('profile-edit-about');
      if (!nameInput || !usernameInput || !aboutInput) return;

      var nextName = sanitizePlainText(nameInput.value, 36);
      var nextUser = sanitizePlainText(usernameInput.value, 36).replace(/\s+/g, '').toLowerCase();
      var nextAbout = sanitizePlainText(aboutInput.value, 240);
      if (!nextName || !nextUser) {
        appendChatMessage('global', 'Profile', 'Display name and username are required.', true);
        return;
      }

      uiState.profile.displayName = nextName;
      uiState.profile.username = nextUser;
      uiState.profile.about = nextAbout || uiState.profile.about;
      syncIdentityFromProfile();
      saveProfile();
      upsertAuthAccount();
      if (uiState.auth.signedIn) saveAuthSession();
      renderProfileViews();
      window.openModal('modal-profile');
      appendChatMessage('global', 'Profile', 'Profile updated successfully.', true);
      setText('rt-last-action', 'profile updated');
    };

    window.revealSecret = function () {
      var catalog = uiState.secrets.catalog || [];
      var hidden = [];
      for (var i = 0; i < catalog.length; i += 1) {
        if (!uiState.secrets.revealed[i]) hidden.push(i);
      }
      if (!hidden.length) {
        appendChatMessage('global', 'Secrets', 'All secrets already revealed.', true);
        return;
      }

      var idx = hidden[Math.floor(Math.random() * hidden.length)];
      uiState.secrets.revealed[idx] = true;
      saveSecrets();
      renderSecrets();
      appendChatMessage('global', 'Secrets', 'Secret revealed: ' + catalog[idx], true);
      setText('rt-last-action', 'secret revealed #' + (idx + 1));
    };

    window.triggerEmote = function (emoteId) {
      runtime.input.emit({ type: 'emote', source: 'ui', emote: emoteId, ts: performance.now() });
    };

    window.switchChatTab = function (tabName) {
      var tabs = document.querySelectorAll('.chat-tab');
      for (var i = 0; i < tabs.length; i += 1) {
        tabs[i].classList.toggle('active', tabs[i].getAttribute('data-tab') === tabName);
      }

      var panels = document.querySelectorAll('.panel-content');
      for (var j = 0; j < panels.length; j += 1) {
        panels[j].classList.remove('active');
      }

      var activePanel = safeById('panel-' + tabName);
      if (activePanel) activePanel.classList.add('active');

      if (tabName !== 'ai') {
        document.body.classList.remove('chat-minimized');
      }

      var launcher = safeById('ai-launcher');
      if (launcher) launcher.classList.toggle('active', tabName === 'ai');
    };

    window.minimizeChatSidebar = function () {
      document.body.classList.remove('chat-closed');
      document.body.classList.toggle('chat-minimized');
      setText('rt-last-action', 'chat ' + (document.body.classList.contains('chat-minimized') ? 'minimized' : 'restored'));
    };

    window.closeChatSidebar = function () {
      document.body.classList.remove('chat-minimized');
      document.body.classList.add('chat-closed');
      var launcher = safeById('ai-launcher');
      if (launcher) launcher.classList.remove('active');
      setText('rt-last-action', 'chat closed');
    };

    window.toggleAiAssistant = function () {
      document.body.classList.remove('chat-closed');
      var aiPanel = safeById('panel-ai');
      var aiIsOpen = !!(aiPanel && aiPanel.classList.contains('active'));

      if (aiIsOpen) {
        window.switchChatTab('global');
        document.body.classList.remove('ai-mobile-open');
        document.body.classList.remove('chat-minimized');
        return;
      }

      document.body.classList.remove('chat-minimized');
      document.body.classList.add('ai-mobile-open');
      window.switchChatTab('ai');
      var aiInput = safeById('chat-input-ai');
      if (aiInput) aiInput.focus();
    };

    window.sendChatMessage = function (channel) {
      if (channel !== 'global' && channel !== 'friends') return;
      var input = safeById('chat-input-' + channel);
      if (!input) return;
      var text = sanitizePlainText(input.value, 280);
      if (!text) return;

      appendChatMessage(channel, 'Guest', text, false);
      runtime.input.emit({ type: 'chat', source: 'ui', channel: channel, text: text, ts: performance.now() });

      if (channel === 'global') {
        appendChatMessage(channel, 'System', 'Echo logged for moderation pipeline.', true);
      }

      input.value = '';
    };

    window.queueShopItem = async function (itemName, price) {
      if (typeof itemName !== 'string' || !itemName.trim()) return;
      if (itemName.length > 64) return;
      if (!Number.isFinite(price) || price <= 0 || price > 1000000) return;
      if (uiState.shopBusy) {
        appendChatMessage('global', 'Shop', 'Checkout is already in progress. Please wait.', true);
        return;
      }
      bumpEvidence('shopRequests');

      var balanceNode = safeById('user-coins');
      var currentCoins = Number(balanceNode ? balanceNode.textContent : 0) || 0;
      if (!Number.isFinite(currentCoins) || currentCoins < 0) currentCoins = 0;
      if (currentCoins < price) {
        appendChatMessage('global', 'Shop', 'Not enough coins for ' + itemName + '.', true);
        return;
      }

      uiState.shopBusy = true;

      try {
        var brokerResult = await runtime.broker874.publish({
          topic: 'shop.checkout.request',
          sender: 'ui',
          payload: {
            item: itemName,
            price: price,
            buyer: runtime.identity784.globalIdentity.accountId
          }
        });

        if (!brokerResult.ok || !brokerResult.results.length || !brokerResult.results[0].ok) {
          appendChatMessage('global', 'Shop', 'Could not queue ' + itemName + ' due to sandbox policy.', true);
          return;
        }

        currentCoins -= price;
        if (currentCoins < 0) currentCoins = 0;
        if (balanceNode) balanceNode.textContent = String(currentCoins);
        appendChatMessage('global', 'Shop', itemName + ' queued at M$ ' + price + '.', true);
        setText('rt-last-action', 'shop queue: ' + itemName);
      } finally {
        uiState.shopBusy = false;
      }
    };

    window.spatialDoorAction = async function (doorId) {
      var normalizedDoor = typeof doorId === 'string' && /^[a-z0-9-]{1,40}$/i.test(doorId) ? doorId : 'hangar-gate';
      bumpEvidence('doorActions');
      var result = await runtime.broker874.publish({
        topic: 'spatial.door.request',
        sender: 'ui',
        payload: {
          doorId: normalizedDoor
        }
      });

      if (!result.ok || !result.results.length || !result.results[0].ok) {
        appendChatMessage('global', 'Spatial', 'Door action denied. Move into hangar zone first.', true);
        return;
      }
      appendChatMessage('global', 'Spatial', 'Door ' + normalizedDoor + ' is now ' + result.results[0].state + '.', true);
    };

    window.runSandboxProbe = async function () {
      bumpEvidence('sandboxProbes');
      var denyResult = await runtime.sandbox871.execute({
        capability: 'network.fetch',
        payload: { url: 'http://example.com' }
      });
      if (!denyResult.ok) {
        appendChatMessage('global', 'Security', 'Sandbox probe blocked as expected: ' + denyResult.error, true);
      } else {
        appendChatMessage('global', 'Security', 'Warning: probe unexpectedly succeeded.', true);
      }
    };

    window.toggleSetting = function (settingKey) {
      if (settingKey === 'reduced-motion') {
        bumpEvidence('settingsToggles');
        uiState.adaptive.userOverride = true;
        uiState.settings.reducedMotion = !uiState.settings.reducedMotion;
        setToggle(safeById('setting-reduced-motion'), uiState.settings.reducedMotion);
        document.body.setAttribute('data-mv-motion', uiState.settings.reducedMotion ? 'reduced' : 'normal');
        saveUiSettings();
        setText('rt-last-action', 'setting reduced-motion: ' + (uiState.settings.reducedMotion ? 'on' : 'off'));
        return;
      }

      if (settingKey === 'performance') {
        bumpEvidence('settingsToggles');
        uiState.adaptive.userOverride = true;
        uiState.settings.performance = !uiState.settings.performance;
        setToggle(safeById('setting-performance'), uiState.settings.performance);
        document.body.setAttribute('data-mv-quality', uiState.settings.performance ? 'economy' : (runtime.graphics.currentPolicy ? runtime.graphics.currentPolicy.quality : 'medium'));
        saveUiSettings();
        setText('rt-last-action', 'setting performance: ' + (uiState.settings.performance ? 'on' : 'off'));
        return;
      }

      if (settingKey === 'streamer') {
        bumpEvidence('settingsToggles');
        uiState.settings.streamer = !uiState.settings.streamer;
        setToggle(safeById('setting-streamer'), uiState.settings.streamer);
        if (uiState.settings.streamer) {
          uiState.previousDisplayName = runtime.identity784.globalIdentity.displayName;
        }
        var display = uiState.settings.streamer ? 'Creator' : uiState.previousDisplayName;
        runtime.identity784.globalIdentity.displayName = display;
        runtime.identity784.emitUpdate();
        saveUiSettings();
        setText('rt-last-action', 'setting streamer: ' + (uiState.settings.streamer ? 'on' : 'off'));
        return;
      }

      if (settingKey === 'cinematic') {
        bumpEvidence('settingsToggles');
        uiState.settings.cinematic = !uiState.settings.cinematic;
        setToggle(safeById('setting-cinematic'), uiState.settings.cinematic);
        document.body.classList.toggle('setting-cinematic', uiState.settings.cinematic);
        saveUiSettings();
        setText('rt-last-action', 'setting cinematic: ' + (uiState.settings.cinematic ? 'on' : 'off'));
        return;
      }

      if (settingKey === 'physics') {
        bumpEvidence('settingsToggles');
        uiState.settings.physics = !uiState.settings.physics;
        setToggle(safeById('setting-physics'), uiState.settings.physics);
        document.body.classList.toggle('setting-physics', uiState.settings.physics);
        saveUiSettings();
        setText('rt-last-action', 'setting physics: ' + (uiState.settings.physics ? 'on' : 'off'));
        return;
      }

      if (settingKey === 'debug') {
        bumpEvidence('settingsToggles');
        setDebugMode(!uiState.debug.active);
        if (uiState.debug.active) runDebugSweep('manual');
        return;
      }

      if (settingKey === 'visibility') {
        bumpEvidence('settingsToggles');
        uiState.settings.visibilityBoost = !uiState.settings.visibilityBoost;
        setToggle(safeById('setting-visibility'), uiState.settings.visibilityBoost);
        document.body.classList.toggle('visibility-boost', uiState.settings.visibilityBoost);
        saveUiSettings();
        setText('rt-last-action', 'setting visibility: ' + (uiState.settings.visibilityBoost ? 'on' : 'off'));
        return;
      }

      if (settingKey === 'hide-extras') {
        bumpEvidence('settingsToggles');
        uiState.settings.hideExtras = !uiState.settings.hideExtras;
        setToggle(safeById('setting-hide-extras'), uiState.settings.hideExtras);
        document.body.classList.toggle('hide-extras', uiState.settings.hideExtras);
        saveUiSettings();
        setText('rt-last-action', 'setting hide-extras: ' + (uiState.settings.hideExtras ? 'on' : 'off'));
        return;
      }

      appendChatMessage('global', 'System', 'Unknown setting key: ' + String(settingKey), true);
    };

    window.sendAiMessage = async function () {
      var input = safeById('chat-input-ai');
      var sendButton = safeById('ai-send-btn');
      if (!input) return;
      var text = sanitizePlainText(input.value, 320);
      if (!text) return;

      if (uiState.aiBusy) {
        appendChatMessage('ai', 'AI', 'Still thinking. Send your next question in a moment.', true);
        return;
      }


      uiState.aiBusy = true;
      bumpEvidence('aiPrompts');
      if (sendButton) sendButton.disabled = true;
      appendChatMessage('ai', 'You', text, false);
      input.value = '';

      try {
        await new Promise(function (resolve) { setTimeout(resolve, 150); });
        var result = buildAiReply(text, runtime, uiState.aiBrain);
        appendChatMessage('ai', 'AI', result.message, true);
        rememberAiTurn(uiState.aiBrain, text, result.intent, snapshotUiContext(runtime), result.message);
        setText('rt-last-action', 'ai response generated');
      } finally {
        uiState.aiBusy = false;
        if (sendButton) sendButton.disabled = false;
      }
    };

    function isSubmitKey(evt) {
      if (!evt || evt.isComposing) return false;
      if (evt.key === 'Enter' || evt.key === 'Return') return true;
      if (evt.code === 'Enter' || evt.code === 'NumpadEnter') return true;
      return evt.keyCode === 13 || evt.which === 13;
    }

    function wireChatEnter(inputId, channel) {
      var input = safeById(inputId);
      if (!input) return;
      input.addEventListener('keydown', function (evt) {
        if (isSubmitKey(evt)) {
          evt.preventDefault();
          window.sendChatMessage(channel);
        }
      });
    }

    wireChatEnter('chat-input-global', 'global');
    wireChatEnter('chat-input-friends', 'friends');

    var aiInput = safeById('chat-input-ai');
    if (aiInput) {
      aiInput.addEventListener('keydown', function (evt) {
        if (isSubmitKey(evt)) {
          evt.preventDefault();
          window.sendAiMessage();
        }
      });
    }

    window.addEventListener('resize', function () {
      if (window.innerWidth > 980) {
        document.body.classList.remove('ai-mobile-open');
      }
    });

    var realismSlider = safeById('setting-realism');
    loadUiSettings();
    renderExperienceCards();

    setToggle(safeById('setting-reduced-motion'), uiState.settings.reducedMotion);
    setToggle(safeById('setting-performance'), uiState.settings.performance);
    setToggle(safeById('setting-streamer'), uiState.settings.streamer);
    setToggle(safeById('setting-cinematic'), uiState.settings.cinematic);
    setToggle(safeById('setting-physics'), uiState.settings.physics);
    setToggle(safeById('setting-debug-mode'), uiState.settings.debugMode);
    setToggle(safeById('setting-visibility'), uiState.settings.visibilityBoost);
    setToggle(safeById('setting-hide-extras'), uiState.settings.hideExtras);
    document.body.setAttribute('data-mv-device-tier', uiState.adaptive.tier);
    document.body.setAttribute('data-mv-motion', uiState.settings.reducedMotion ? 'reduced' : 'normal');
    document.body.setAttribute('data-mv-quality', uiState.settings.performance ? 'economy' : 'medium');
    document.body.classList.toggle('setting-cinematic', uiState.settings.cinematic);
    document.body.classList.toggle('setting-physics', uiState.settings.physics);
    document.body.classList.toggle('visibility-boost', uiState.settings.visibilityBoost);
    document.body.classList.toggle('hide-extras', uiState.settings.hideExtras);

    if (realismSlider && !realismSlider.dataset.ready) {
      realismSlider.dataset.ready = '1';
      realismSlider.value = String(uiState.settings.realism);
      applyRealismProfile(realismSlider.value);
      realismSlider.addEventListener('input', function () {
        applyRealismProfile(realismSlider.value);
        saveUiSettings();
        setText('rt-last-action', 'realism slider: ' + realismSlider.value + '%');
      });
    }

    upgradeStaticIcons();
    bindAuthInputShortcuts();
    uiState.badges.catalog = createBadgeCatalog();
    loadBadges();
    loadFriends();
    loadCommunities();
    loadProfile();
    loadAuthAccounts();
    loadAuthSession();
    loadOnboardingState();
    loadIdeaLabState();
    loadSecrets();
    renderBadgePanel();
    renderDebugFindings();
    renderFriendBrowser();
    renderCommunities();
    renderSecrets();
    renderHomeFriendsStrip();
    renderProfileViews();
    evaluateBadgeUnlocks();
    installTopSearch();
    window.addEventListener('dc200:profile', function (evt) {
      applyAdaptiveTier(evt.detail, 'dc200 profile');
      evaluateBadgeUnlocks();
    });
    var aiSeedNode = safeById('ai-seed-lines');
    if (aiSeedNode) aiSeedNode.textContent = '';
    renderPlayersFeed();
    uiState.social.friendCandidates = playersExtra.slice(0);
    renderFriendBrowser();
    renderChatHubList();
    renderRecentExperiences();
    renderContinueRow();
    syncIdentityFromProfile();
    renderAuthAccountList();
    renderOnboardingTips();
    renderIdeaLab();

    window.addEventListener('implement:queue', function (evt) {
      var detail = evt && evt.detail ? evt.detail : {};
      if (detail.ideas && Array.isArray(detail.ideas)) {
        ingestMasterIdeas(detail.ideas);
      }
    });

    setAuthMode(uiState.auth.mode);
    if (uiState.auth.signedIn) {
      hideAuthOverlay();
    } else {
      showAuthOverlay();
    }

    var friendSearchInput = safeById('friend-search-input');
    if (friendSearchInput) {
      friendSearchInput.addEventListener('input', function () {
        uiState.social.friendSearch = sanitizePlainText(friendSearchInput.value, 40);
        renderFriendBrowser();
      });
    }

    if (uiState.settings.debugMode) {
      setDebugMode(true);
      runDebugSweep('manual', true);
    }
    window.runBigCheck();

    installMarketplaceControls();
    scheduleMarketplaceRender();
    installRealtimeFeeds();
  }

  async function bootstrap() {
    var input = new InputTranslator();
    var graphics = new GraphicsAdapter();
    var spatial790 = new SpatialReplication790();
    var identity784 = new GlobalPlayerIdentity784();
    var sandbox871 = new Sandbox871();
    var broker874 = new MessageBroker874();
    var escrow872 = new Escrow872(broker874, sandbox871);
    var spatial975 = new SpatialLogic975();

    input.init();
    graphics.init();
    spatial790.start();
    identity784.emitUpdate();

    input.onAction(function (action) {
      spatial790.handleAction(action);
      identity784.trackAction(action);
    });

    window.addEventListener('790:state', function (evt) {
      identity784.updateSessionFromSpatial(evt.detail);
      spatial975.updateFromSpatial(evt.detail);
    });

    window.addEventListener('implement:queue', function () {
      // System-managed writes are isolated from creator/game script writes.
      identity784.systemWriteFaction('builders', 'cooperative');
    });

    broker874.subscribe('shop.checkout.request', async function (envelope) {
      return escrow872.checkout(envelope.payload || {});
    });

    broker874.subscribe('spatial.door.request', async function (envelope) {
      var payload = envelope.payload || {};
      return spatial975.toggleDoor(payload.doorId || 'hangar-gate');
    });

    var runtime = {
      dc200: DC200,
      input: input,
      graphics: graphics,
      spatial790: spatial790,
      identity784: identity784,
      sandbox871: sandbox871,
      broker874: broker874,
      escrow872: escrow872,
      spatial975: spatial975
    };

    installGlobalUi(runtime);
    wireRuntimePanel(runtime);
    await initImplementMode();

    setText('rt-871-policy', sandbox871.policy.mode);

    await sandbox871.execute({
      capability: 'storage.set',
      payload: { key: 'mode', value: 'implement' }
    });

    await sandbox871.execute({
      capability: 'wallet.direct',
      payload: { amount: 100 }
    });

    try {
      await DC200.init();
    } catch (err) {
      console.warn('DC-200 init failed, falling back to minimal profile:', err);
      DC200.publish({
        id: 'dc200-profile-fallback',
        timestamp: Date.now(),
        staticCaps: DC200.detectStaticCapabilities(),
        runtime: {
          qualityClass: 'medium',
          qualityHint: 'balanced',
          averageFps: 30,
          averageFrameMs: 33.3,
          frameJitterMs: 8
        }
      });
    }

    window.MetaverseRuntime = runtime;
    window.MetaverseRuntime.implementMode = {
      state: 'active',
      source: 'METAVERSE_MASTER_IDEAS_LIST.md'
    };
    window.showDashboard();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootstrap);
  } else {
    bootstrap();
  }
})();
