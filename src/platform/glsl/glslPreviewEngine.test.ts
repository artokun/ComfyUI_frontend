import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { GLSLPreviewEngine } from '@/platform/glsl/glslPreviewEngine'

const PASSTHROUGH_SHADER = `#version 300 es
precision highp float;

uniform sampler2D u_image0;
uniform vec2 u_resolution;

in vec2 v_texCoord;
layout(location = 0) out vec4 fragColor0;

void main() {
    fragColor0 = texture(u_image0, v_texCoord);
}
`

const FLOAT_UNIFORM_SHADER = `#version 300 es
precision highp float;

uniform float u_float0;
uniform vec2 u_resolution;

in vec2 v_texCoord;
layout(location = 0) out vec4 fragColor0;

void main() {
    fragColor0 = vec4(u_float0, 0.0, 0.0, 1.0);
}
`

const MRT_SHADER = `#version 300 es
precision highp float;

uniform vec2 u_resolution;

in vec2 v_texCoord;
layout(location = 0) out vec4 fragColor0;
layout(location = 1) out vec4 fragColor1;

void main() {
    fragColor0 = vec4(1.0, 0.0, 0.0, 1.0);
    fragColor1 = vec4(0.0, 1.0, 0.0, 1.0);
}
`

const MULTIPASS_SHADER = `#version 300 es
precision highp float;
#pragma passes 3

uniform vec2 u_resolution;
uniform int u_pass;

in vec2 v_texCoord;
layout(location = 0) out vec4 fragColor0;

void main() {
    fragColor0 = vec4(float(u_pass) / 2.0, 0.0, 0.0, 1.0);
}
`

const INVALID_SHADER = `#version 300 es
precision highp float;
void main() {
    fragColor0 = undeclared_variable;
}
`

function isWebGL2Available(): boolean {
  try {
    const canvas = new OffscreenCanvas(1, 1)
    return canvas.getContext('webgl2') != null
  } catch {
    return false
  }
}

const describeWebGL = isWebGL2Available() ? describe : describe.skip

describeWebGL('GLSLPreviewEngine', () => {
  let engine: GLSLPreviewEngine

  beforeEach(() => {
    engine = new GLSLPreviewEngine(64, 64)
  })

  afterEach(() => {
    engine.dispose()
  })

  it('compiles a valid passthrough shader', () => {
    const result = engine.compileFragment(PASSTHROUGH_SHADER)
    expect(result.success).toBe(true)
    expect(result.log).toBe('')
  })

  it('reports error for invalid shader', () => {
    const result = engine.compileFragment(INVALID_SHADER)
    expect(result.success).toBe(false)
    expect(result.log.length).toBeGreaterThan(0)
  })

  it('compiles a shader with float uniforms', () => {
    const result = engine.compileFragment(FLOAT_UNIFORM_SHADER)
    expect(result.success).toBe(true)
  })

  it('compiles an MRT shader', () => {
    const result = engine.compileFragment(MRT_SHADER)
    expect(result.success).toBe(true)
  })

  it('compiles a multi-pass shader', () => {
    const result = engine.compileFragment(MULTIPASS_SHADER)
    expect(result.success).toBe(true)
  })

  it('renders without throwing after compilation', () => {
    engine.compileFragment(PASSTHROUGH_SHADER)
    expect(() => engine.render()).not.toThrow()
  })

  it('renders and reads pixels', () => {
    engine.compileFragment(PASSTHROUGH_SHADER)
    engine.render()
    const imageData = engine.readPixels()
    expect(imageData.width).toBe(64)
    expect(imageData.height).toBe(64)
    expect(imageData.data.length).toBe(64 * 64 * 4)
  })

  it('produces a blob via toBlob()', async () => {
    engine.compileFragment(PASSTHROUGH_SHADER)
    engine.render()
    const blob = await engine.toBlob()
    expect(blob).toBeInstanceOf(Blob)
    expect(blob.size).toBeGreaterThan(0)
    expect(blob.type).toBe('image/png')
  })

  it('sets float uniform values', () => {
    engine.compileFragment(FLOAT_UNIFORM_SHADER)
    expect(() => engine.setFloatUniform(0, 0.75)).not.toThrow()
  })

  it('sets int uniform values', () => {
    engine.compileFragment(PASSTHROUGH_SHADER)
    expect(() => engine.setIntUniform(0, 5)).not.toThrow()
  })

  it('handles resolution change', () => {
    engine.compileFragment(PASSTHROUGH_SHADER)
    engine.setResolution(128, 128)
    engine.render()
    const imageData = engine.readPixels()
    expect(imageData.width).toBe(128)
    expect(imageData.height).toBe(128)
  })

  it('no-ops after dispose', () => {
    engine.compileFragment(PASSTHROUGH_SHADER)
    engine.dispose()
    const result = engine.compileFragment(PASSTHROUGH_SHADER)
    expect(result.success).toBe(false)
    expect(result.log).toBe('Engine disposed')
  })

  it('recompiles when switching shaders', () => {
    const r1 = engine.compileFragment(PASSTHROUGH_SHADER)
    expect(r1.success).toBe(true)
    const r2 = engine.compileFragment(FLOAT_UNIFORM_SHADER)
    expect(r2.success).toBe(true)
  })

  it('renders float uniform shader and produces colored output', () => {
    engine.compileFragment(FLOAT_UNIFORM_SHADER)
    engine.setFloatUniform(0, 1.0)
    engine.render()
    const imageData = engine.readPixels()
    // First pixel should have red=255 from u_float0=1.0
    expect(imageData.data[0]).toBe(255)
    expect(imageData.data[1]).toBe(0)
    expect(imageData.data[2]).toBe(0)
    expect(imageData.data[3]).toBe(255)
  })

  it('calls dispose idempotently', () => {
    engine.dispose()
    expect(() => engine.dispose()).not.toThrow()
  })
})
