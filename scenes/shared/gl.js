// Drobné pomůcky pro WebGL2: překlad programů, textury a framebuffery.

export const FULLSCREEN_VS = `#version 300 es
// Jeden trojúhelník přes celou obrazovku, bez vrcholového bufferu.
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

// Ladění: ?prekladat v adrese obejde mezipaměť přeložených shaderů (jako po aktualizaci)
// a do konzole se vypíše, jak dlouho se který program překládal.
const fresh = typeof location !== 'undefined' && new URLSearchParams(location.search).has('prekladat');
const stamp = `
// ${Date.now()}-${Math.random()}
`;
export const compileTimes = [];

function linkProgram(gl, vertexSource, fragmentSource) {
  if (fresh) fragmentSource += stamp;
  const compile = (type, source) => {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    return shader;
  };
  const vs = compile(gl.VERTEX_SHADER, vertexSource);
  const fs = compile(gl.FRAGMENT_SHADER, fragmentSource);
  const program = gl.createProgram();
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  return { program, vs, fs };
}

function finishProgram(gl, { program, vs, fs }, label) {
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const log = [vs, fs].map((s) => gl.getShaderInfoLog(s)).filter(Boolean).join(' | ');
    throw new Error(`Shader ${label}: ${log || gl.getProgramInfoLog(program)}`);
  }
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  const u = {};
  const count = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < count; i++) {
    const info = gl.getActiveUniform(program, i);
    u[info.name.replace(/\[0\]$/, '')] = gl.getUniformLocation(program, info.name);
  }
  const attributes = {};
  const attributeCount = gl.getProgramParameter(program, gl.ACTIVE_ATTRIBUTES);
  for (let i = 0; i < attributeCount; i++) {
    const info = gl.getActiveAttrib(program, i);
    attributes[info.name] = gl.getAttribLocation(program, info.name);
  }
  return { program, u, attributes };
}

export function createProgram(gl, vertexSource, fragmentSource, label) {
  const t0 = performance.now();
  const result = finishProgram(gl, linkProgram(gl, vertexSource, fragmentSource), label);
  compileTimes.push([label, Math.round(performance.now() - t0), 'hned']);
  return result;
}

/**
 * Totéž na pozadí: velký shader se překládá v grafickém procesu a stránka mezitím
 * nezamrzne (KHR_parallel_shader_compile). Bez rozšíření se přeloží hned.
 */
export function createProgramAsync(gl, vertexSource, fragmentSource, label) {
  const ext = gl.getExtension('KHR_parallel_shader_compile');
  const t0 = performance.now();
  const linked = linkProgram(gl, vertexSource, fragmentSource);
  return new Promise((resolve, reject) => {
    const check = () => {
      if (ext && !gl.getProgramParameter(linked.program, ext.COMPLETION_STATUS_KHR)) {
        setTimeout(check, 40);
        return;
      }
      try {
        const result = finishProgram(gl, linked, label);
        compileTimes.push([label, Math.round(performance.now() - t0), 'na pozadí']);
        resolve(result);
      } catch (error) {
        reject(error);
      }
    };
    check();
  });
}

export function createTexture(gl, width, height, { internal, format, type, filter = gl.LINEAR }) {
  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texStorage2D(gl.TEXTURE_2D, 1, internal, width, height);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.bindTexture(gl.TEXTURE_2D, null);
  return texture;
}

/** Textura, do které jde kreslit. Vrací null, když ji ovladač neumí jako cíl. */
export function createTarget(gl, width, height, options) {
  const texture = createTexture(gl, width, height, options);
  const framebuffer = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
  const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  if (!ok) {
    gl.deleteFramebuffer(framebuffer);
    gl.deleteTexture(texture);
    return null;
  }
  return {
    texture, framebuffer, width, height,
    dispose() {
      gl.deleteFramebuffer(framebuffer);
      gl.deleteTexture(texture);
    },
  };
}

/** První formát ze seznamu, do kterého jde na tomto stroji kreslit. */
export function firstRenderable(gl, width, height, formats) {
  for (const format of formats) {
    const target = createTarget(gl, width, height, format);
    if (target) return { target, format };
  }
  return null;
}

/**
 * Jakou grafiku prohlížeč pro WebGL používá. software = true, když kreslí procesor
 * (Microsoft Basic Render Driver, SwiftShader, llvmpipe): pak je všechno mnohonásobně pomalejší.
 */
export function rendererInfo(gl) {
  const debug = gl.getExtension('WEBGL_debug_renderer_info');
  const name = debug ? String(gl.getParameter(debug.UNMASKED_RENDERER_WEBGL)) : String(gl.getParameter(gl.RENDERER));
  const software = /SwiftShader|Basic Render|llvmpipe|softpipe|Software/i.test(name);
  return { name, software };
}

/** Upozornění v náhledu, že prohlížeč nepoužívá grafickou kartu. Kliknutím zmizí. */
export function showSoftwareNotice(name) {
  const box = document.createElement('div');
  box.id = 'gpu-notice';
  box.setAttribute('role', 'status');
  box.innerHTML =
    `<strong>Prohlížeč kreslí bez grafické karty</strong> (${name.replace(/[<>&]/g, '')}), proto se scéna seká.<br>` +
    'V Chromu zapněte <em>Nastavení → Systém → Použít grafickou akceleraci, pokud je k dispozici</em> a prohlížeč restartujte. ' +
    'Na stránce <code>chrome://gpu</code> pak má u WebGL stát „Hardware accelerated“. ' +
    'Do té doby scéna běží v nižší kvalitě. <small>(kliknutím zavřete)</small>';
  Object.assign(box.style, {
    position: 'fixed', top: '16px', left: '16px', right: '16px', maxWidth: '72ch', padding: '12px 16px',
    borderRadius: '10px', background: 'rgba(70, 20, 20, 0.88)', color: '#fbe9e7',
    font: '14px/1.45 system-ui, "Segoe UI", sans-serif', zIndex: 10, cursor: 'pointer',
  });
  box.addEventListener('click', () => box.remove());
  document.body.append(box);
}
