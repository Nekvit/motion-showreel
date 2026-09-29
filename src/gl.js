// Minimal WebGL2 toolkit: programs, fullscreen passes, float FBOs, ping-pong
// buffers, instanced geometry and texture helpers. Everything a shot needs,
// nothing it doesn't.

export const FS_VERT = `#version 300 es
layout(location=0) in vec2 aPos;
out vec2 vUv;
void main(){ vUv = aPos*0.5+0.5; gl_Position = vec4(aPos,0.0,1.0); }`;

const HEADER = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
`;

// Prepends the #version/precision header if the source does not start with one.
export function withHeader(src) {
  return src.trimStart().startsWith('#version') ? src : HEADER + src;
}

function compile(gl, type, src, label) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh);
    const numbered = src.split('\n').map((l, i) => `${String(i + 1).padStart(4)}: ${l}`).join('\n');
    console.error(`[${label}] shader compile error:\n${log}\n${numbered}`);
    throw new Error(`[${label}] shader compile error: ${log}`);
  }
  return sh;
}

export class Program {
  constructor(gl, vert, frag, label = 'program') {
    this.gl = gl;
    this.label = label;
    const p = gl.createProgram();
    gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, withHeader(vert), label + ':vs'));
    gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, withHeader(frag), label + ':fs'));
    gl.bindAttribLocation(p, 0, 'aPos');
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      throw new Error(`[${label}] link error: ${gl.getProgramInfoLog(p)}`);
    }
    this.p = p;
    this.loc = new Map();
    this.types = new Map();
    const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) {
      const info = gl.getActiveUniform(p, i);
      const name = info.name.replace(/\[0\]$/, '');
      this.loc.set(name, gl.getUniformLocation(p, info.name));
      this.types.set(name, { type: info.type, size: info.size });
    }
  }

  use() { this.gl.useProgram(this.p); return this; }

  // Set uniforms from a plain object. Numbers, arrays (vec2/3/4, mat3/4, arrays
  // of floats/vecs), booleans and textures ({tex} objects, WebGLTexture, or
  // FBO/PingPong instances) are all accepted. Unknown names are ignored so a
  // shader can optimise away an unused uniform without breaking callers.
  set(uniforms) {
    const gl = this.gl;
    let unit = 0;
    for (const [name, v] of Object.entries(uniforms)) {
      const loc = this.loc.get(name);
      if (loc == null) continue;
      if (typeof v === 'function') throw new Error(`[${this.label}] uniform ${name}: got a function (call it, e.g. sys.NOTCH(ctx))`);
      const { type } = this.types.get(name);
      if (type === gl.SAMPLER_2D || type === gl.SAMPLER_3D || type === gl.SAMPLER_2D_ARRAY) {
        const tex = resolveTex(v);
        gl.activeTexture(gl.TEXTURE0 + unit);
        gl.bindTexture(type === gl.SAMPLER_3D ? gl.TEXTURE_3D : type === gl.SAMPLER_2D_ARRAY ? gl.TEXTURE_2D_ARRAY : gl.TEXTURE_2D, tex);
        gl.uniform1i(loc, unit++);
        continue;
      }
      const a = typeof v === 'boolean' ? [v ? 1 : 0] : typeof v === 'number' ? [v] : v;
      switch (type) {
        case gl.FLOAT: gl.uniform1fv(loc, a); break;
        case gl.FLOAT_VEC2: gl.uniform2fv(loc, a); break;
        case gl.FLOAT_VEC3: gl.uniform3fv(loc, a); break;
        case gl.FLOAT_VEC4: gl.uniform4fv(loc, a); break;
        case gl.INT: case gl.BOOL: gl.uniform1iv(loc, a.map(Math.round)); break;
        case gl.INT_VEC2: gl.uniform2iv(loc, a.map(Math.round)); break;
        case gl.INT_VEC3: gl.uniform3iv(loc, a.map(Math.round)); break;
        case gl.INT_VEC4: gl.uniform4iv(loc, a.map(Math.round)); break;
        case gl.FLOAT_MAT2: gl.uniformMatrix2fv(loc, false, a); break;
        case gl.FLOAT_MAT3: gl.uniformMatrix3fv(loc, false, a); break;
        case gl.FLOAT_MAT4: gl.uniformMatrix4fv(loc, false, a); break;
        default: throw new Error(`[${this.label}] unsupported uniform type for ${name}`);
      }
    }
    return this;
  }
}

function resolveTex(v) {
  if (!v) return null;
  if (v instanceof WebGLTexture) return v;
  if (v.read) return v.read.tex;   // PingPong -> current read side
  if (v.tex) return v.tex;         // FBO / Texture wrapper
  return null;
}

// A render target with one or more colour attachments (MRT) and optional depth.
export class FBO {
  constructor(gl, w, h, opts = {}) {
    this.gl = gl;
    this.w = w; this.h = h;
    const {
      internal = gl.RGBA16F, format = gl.RGBA, type = gl.HALF_FLOAT,
      filter = gl.LINEAR, wrap = gl.CLAMP_TO_EDGE, depth = false, count = 1,
    } = opts;
    this.fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fb);
    this.texs = [];
    for (let i = 0; i < count; i++) {
      const t = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texImage2D(gl.TEXTURE_2D, 0, internal, w, h, 0, format, type, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + i, gl.TEXTURE_2D, t, 0);
      this.texs.push(t);
    }
    this.tex = this.texs[0];
    if (count > 1) gl.drawBuffers(this.texs.map((_, i) => gl.COLOR_ATTACHMENT0 + i));
    if (depth) {
      this.depth = gl.createRenderbuffer();
      gl.bindRenderbuffer(gl.RENDERBUFFER, this.depth);
      gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, w, h);
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, this.depth);
    }
    const st = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    if (st !== gl.FRAMEBUFFER_COMPLETE) throw new Error('FBO incomplete: 0x' + st.toString(16));
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  bind() {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fb);
    gl.viewport(0, 0, this.w, this.h);
    return this;
  }

  clear(r = 0, g = 0, b = 0, a = 1) {
    const gl = this.gl;
    this.bind();
    gl.clearColor(r, g, b, a);
    gl.clear(gl.COLOR_BUFFER_BIT | (this.depth ? gl.DEPTH_BUFFER_BIT : 0));
    return this;
  }

  get size() { return [this.w, this.h]; }
}

// Two FBOs that swap roles every step: read from `read`, write to `write`, swap.
export class PingPong {
  constructor(gl, w, h, opts = {}) {
    this.a = new FBO(gl, w, h, opts);
    this.b = new FBO(gl, w, h, opts);
    this.read = this.a; this.write = this.b;
    this.w = w; this.h = h;
  }
  swap() { const t = this.read; this.read = this.write; this.write = t; }
  clear(...c) { this.a.clear(...c); this.b.clear(...c); }
  get tex() { return this.read.tex; }
  get size() { return [this.w, this.h]; }
}

// Shared fullscreen triangle VAO.
export function fullscreenVAO(gl) {
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  gl.bindVertexArray(null);
  return vao;
}

// Upload (or re-upload) a canvas/image into a texture.
export function textureFrom(gl, source, opts = {}) {
  const { tex = gl.createTexture(), filter = gl.LINEAR, wrap = gl.CLAMP_TO_EDGE, mipmap = false, flipY = true, premultiply = false } = opts;
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, flipY);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, premultiply);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, source);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, mipmap ? gl.LINEAR_MIPMAP_LINEAR : filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap);
  if (mipmap) gl.generateMipmap(gl.TEXTURE_2D);
  return tex;
}

// Float data texture (e.g. initial particle state). data: Float32Array of w*h*4.
export function dataTexture(gl, w, h, data, opts = {}) {
  const { filter = gl.NEAREST, wrap = gl.CLAMP_TO_EDGE } = opts;
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, w, h, 0, gl.RGBA, gl.FLOAT, data);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap);
  return tex;
}

// Build a VAO from attribute descriptions:
//   { attribs: [{ loc, data: Float32Array, size, divisor=0 }], indices?: Uint16Array|Uint32Array }
export function createVAO(gl, { attribs, indices }) {
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  for (const a of attribs) {
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, a.data, a.usage ?? gl.STATIC_DRAW);
    gl.enableVertexAttribArray(a.loc);
    gl.vertexAttribPointer(a.loc, a.size, gl.FLOAT, false, 0, 0);
    if (a.divisor) gl.vertexAttribDivisor(a.loc, a.divisor);
    a.buffer = buf;
  }
  let ibo = null;
  if (indices) {
    ibo = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW);
  }
  gl.bindVertexArray(null);
  return { vao, ibo, attribs, indexType: indices instanceof Uint32Array ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT, count: indices ? indices.length : 0 };
}

// Tiny column-major mat4 helpers for shots that rasterise real geometry.
export const mat4 = {
  identity() { return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]; },
  perspective(fovy, aspect, near, far) {
    const f = 1 / Math.tan(fovy / 2), nf = 1 / (near - far);
    return [f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) * nf, -1, 0, 0, 2 * far * near * nf, 0];
  },
  lookAt(eye, target, up = [0, 1, 0]) {
    let zx = eye[0] - target[0], zy = eye[1] - target[1], zz = eye[2] - target[2];
    let l = Math.hypot(zx, zy, zz); zx /= l; zy /= l; zz /= l;
    let xx = up[1] * zz - up[2] * zy, xy = up[2] * zx - up[0] * zz, xz = up[0] * zy - up[1] * zx;
    l = Math.hypot(xx, xy, xz); xx /= l; xy /= l; xz /= l;
    const yx = zy * xz - zz * xy, yy = zz * xx - zx * xz, yz = zx * xy - zy * xx;
    return [xx, yx, zx, 0, xy, yy, zy, 0, xz, yz, zz, 0,
      -(xx * eye[0] + xy * eye[1] + xz * eye[2]), -(yx * eye[0] + yy * eye[1] + yz * eye[2]), -(zx * eye[0] + zy * eye[1] + zz * eye[2]), 1];
  },
  multiply(a, b) {
    const o = new Array(16);
    for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
      o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
    }
    return o;
  },
  rotateY(a) { const c = Math.cos(a), s = Math.sin(a); return [c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, 0, 0, 1]; },
  rotateX(a) { const c = Math.cos(a), s = Math.sin(a); return [1, 0, 0, 0, 0, c, s, 0, 0, -s, c, 0, 0, 0, 0, 1]; },
  rotateZ(a) { const c = Math.cos(a), s = Math.sin(a); return [c, s, 0, 0, -s, c, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]; },
  translate(x, y, z) { return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1]; },
  scale(x, y = x, z = x) { return [x, 0, 0, 0, 0, y, 0, 0, 0, 0, z, 0, 0, 0, 0, 1]; },
};
