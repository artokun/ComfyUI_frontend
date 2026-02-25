import { detectOutputCount, detectPassCount } from '@/platform/glsl/glslUtils'

const VERTEX_SHADER_SOURCE = `#version 300 es
out vec2 v_texCoord;
void main() {
    vec2 verts[3] = vec2[](vec2(-1, -1), vec2(3, -1), vec2(-1, 3));
    v_texCoord = verts[gl_VertexID] * 0.5 + 0.5;
    gl_Position = vec4(verts[gl_VertexID], 0, 1);
}
`

const MAX_INPUTS = 5
const MAX_FLOAT_UNIFORMS = 5
const MAX_INT_UNIFORMS = 5
const MAX_PASSES = 32

interface CompileResult {
  success: boolean
  log: string
}

export class GLSLPreviewEngine {
  private canvas: OffscreenCanvas
  private gl: WebGL2RenderingContext
  private program: WebGLProgram | null = null
  private vertexShader: WebGLShader
  private fragmentShader: WebGLShader | null = null
  private pingPongFBOs: [WebGLFramebuffer, WebGLFramebuffer] | null = null
  private pingPongTextures: [WebGLTexture, WebGLTexture] | null = null
  private inputTextures: (WebGLTexture | null)[] = Array.from<null>({
    length: MAX_INPUTS
  }).fill(null)
  private uniformLocations = new Map<string, WebGLUniformLocation | null>()
  private outputCount = 1
  private passCount = 1
  private disposed = false

  constructor(width: number, height: number) {
    this.canvas = new OffscreenCanvas(width, height)
    const gl = this.canvas.getContext('webgl2', {
      alpha: true,
      premultipliedAlpha: false,
      preserveDrawingBuffer: true
    })
    if (!gl) throw new Error('WebGL2 not available')
    this.gl = gl

    this.vertexShader = this.compileShader(
      gl.VERTEX_SHADER,
      VERTEX_SHADER_SOURCE
    )
    this.initPingPongFBOs(width, height)
  }

  compileFragment(source: string): CompileResult {
    const { gl } = this
    if (this.disposed) return { success: false, log: 'Engine disposed' }

    this.outputCount = detectOutputCount(source)
    this.passCount = Math.min(detectPassCount(source), MAX_PASSES)

    if (this.fragmentShader) {
      gl.deleteShader(this.fragmentShader)
      this.fragmentShader = null
    }
    if (this.program) {
      gl.deleteProgram(this.program)
      this.program = null
    }
    this.uniformLocations.clear()

    try {
      this.fragmentShader = this.compileShader(gl.FRAGMENT_SHADER, source)
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      return { success: false, log: msg }
    }

    const program = gl.createProgram()
    if (!program) return { success: false, log: 'Failed to create program' }

    gl.attachShader(program, this.vertexShader)
    gl.attachShader(program, this.fragmentShader)
    gl.linkProgram(program)

    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      const log = gl.getProgramInfoLog(program) ?? 'Link failed'
      gl.deleteProgram(program)
      return { success: false, log }
    }

    this.program = program
    this.cacheUniformLocations()
    return { success: true, log: '' }
  }

  setResolution(width: number, height: number): void {
    if (this.disposed) return
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width
      this.canvas.height = height
      this.gl.viewport(0, 0, width, height)
      this.destroyPingPongFBOs()
      this.initPingPongFBOs(width, height)
    }
  }

  setFloatUniform(index: number, value: number): void {
    if (this.disposed || !this.program) return
    const loc = this.uniformLocations.get(`u_float${index}`)
    if (loc != null) {
      this.gl.useProgram(this.program)
      this.gl.uniform1f(loc, value)
    }
  }

  setIntUniform(index: number, value: number): void {
    if (this.disposed || !this.program) return
    const loc = this.uniformLocations.get(`u_int${index}`)
    if (loc != null) {
      this.gl.useProgram(this.program)
      this.gl.uniform1i(loc, value)
    }
  }

  bindInputImage(index: number, image: HTMLImageElement | ImageBitmap): void {
    if (this.disposed) return
    const { gl } = this

    if (this.inputTextures[index]) {
      gl.deleteTexture(this.inputTextures[index])
    }

    const texture = gl.createTexture()
    if (!texture) return

    gl.activeTexture(gl.TEXTURE0 + index)
    gl.bindTexture(gl.TEXTURE_2D, texture)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image)

    this.inputTextures[index] = texture
  }

  render(): void {
    if (this.disposed || !this.program || !this.pingPongFBOs) return
    const { gl } = this

    gl.useProgram(this.program)

    const resLoc = this.uniformLocations.get('u_resolution')
    if (resLoc != null) {
      gl.uniform2f(resLoc, this.canvas.width, this.canvas.height)
    }

    for (let i = 0; i < MAX_INPUTS; i++) {
      const loc = this.uniformLocations.get(`u_image${i}`)
      if (loc != null) {
        gl.activeTexture(gl.TEXTURE0 + i)
        gl.bindTexture(
          gl.TEXTURE_2D,
          this.inputTextures[i] ?? this.createEmptyTexture()
        )
        gl.uniform1i(loc, i)
      }
    }

    const prevPassUnit = MAX_INPUTS
    const prevPassLoc = this.uniformLocations.get('u_prevPass')

    for (let pass = 0; pass < this.passCount; pass++) {
      const passLoc = this.uniformLocations.get('u_pass')
      if (passLoc != null) gl.uniform1i(passLoc, pass)

      const isLastPass = pass === this.passCount - 1
      const writeIdx = pass % 2
      const readIdx = 1 - writeIdx

      if (isLastPass) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, null)
      } else {
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.pingPongFBOs[writeIdx])
      }

      if (pass > 0 && prevPassLoc != null) {
        gl.activeTexture(gl.TEXTURE0 + prevPassUnit)
        gl.bindTexture(gl.TEXTURE_2D, this.pingPongTextures![readIdx])
        gl.uniform1i(prevPassLoc, prevPassUnit)
      }

      if (this.outputCount > 1 && !isLastPass) {
        const buffers = Array.from(
          { length: this.outputCount },
          (_, i) => gl.COLOR_ATTACHMENT0 + i
        )
        gl.drawBuffers(buffers)
      } else {
        gl.drawBuffers([gl.BACK])
      }

      gl.drawArrays(gl.TRIANGLES, 0, 3)
    }
  }

  readPixels(): ImageData {
    const { gl } = this
    const w = this.canvas.width
    const h = this.canvas.height
    const pixels = new Uint8ClampedArray(w * h * 4)
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, pixels)

    flipVertically(pixels, w, h)
    return new ImageData(pixels, w, h)
  }

  async toBlob(): Promise<Blob> {
    return this.canvas.convertToBlob({ type: 'image/png' })
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true

    const { gl } = this

    for (const tex of this.inputTextures) {
      if (tex) gl.deleteTexture(tex)
    }
    this.inputTextures.fill(null)

    this.destroyPingPongFBOs()

    if (this.fragmentShader) {
      gl.deleteShader(this.fragmentShader)
      this.fragmentShader = null
    }
    gl.deleteShader(this.vertexShader)

    if (this.program) {
      gl.deleteProgram(this.program)
      this.program = null
    }

    this.uniformLocations.clear()

    const ext = gl.getExtension('WEBGL_lose_context')
    ext?.loseContext()
  }

  private compileShader(type: GLenum, source: string): WebGLShader {
    const { gl } = this
    const shader = gl.createShader(type)
    if (!shader) throw new Error('Failed to create shader')

    gl.shaderSource(shader, source)
    gl.compileShader(shader)

    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(shader) ?? 'Compilation failed'
      gl.deleteShader(shader)
      throw new Error(log)
    }
    return shader
  }

  private cacheUniformLocations(): void {
    if (!this.program) return
    const { gl } = this

    const names = [
      'u_resolution',
      'u_pass',
      'u_prevPass',
      ...Array.from({ length: MAX_INPUTS }, (_, i) => `u_image${i}`),
      ...Array.from({ length: MAX_FLOAT_UNIFORMS }, (_, i) => `u_float${i}`),
      ...Array.from({ length: MAX_INT_UNIFORMS }, (_, i) => `u_int${i}`)
    ]

    for (const name of names) {
      this.uniformLocations.set(name, gl.getUniformLocation(this.program, name))
    }
  }

  private initPingPongFBOs(width: number, height: number): void {
    const { gl } = this
    const fbos: WebGLFramebuffer[] = []
    const textures: WebGLTexture[] = []

    for (let i = 0; i < 2; i++) {
      const tex = gl.createTexture()!
      gl.bindTexture(gl.TEXTURE_2D, tex)
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA8,
        width,
        height,
        0,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        null
      )
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)

      const fbo = gl.createFramebuffer()!
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo)
      gl.framebufferTexture2D(
        gl.FRAMEBUFFER,
        gl.COLOR_ATTACHMENT0,
        gl.TEXTURE_2D,
        tex,
        0
      )

      fbos.push(fbo)
      textures.push(tex)
    }

    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    gl.bindTexture(gl.TEXTURE_2D, null)

    this.pingPongFBOs = fbos as [WebGLFramebuffer, WebGLFramebuffer]
    this.pingPongTextures = textures as [WebGLTexture, WebGLTexture]
  }

  private destroyPingPongFBOs(): void {
    const { gl } = this
    if (this.pingPongFBOs) {
      for (const fbo of this.pingPongFBOs) gl.deleteFramebuffer(fbo)
      this.pingPongFBOs = null
    }
    if (this.pingPongTextures) {
      for (const tex of this.pingPongTextures) gl.deleteTexture(tex)
      this.pingPongTextures = null
    }
  }

  private createEmptyTexture(): WebGLTexture {
    const { gl } = this
    const tex = gl.createTexture()!
    gl.bindTexture(gl.TEXTURE_2D, tex)
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA,
      1,
      1,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      new Uint8Array([0, 0, 0, 255])
    )
    return tex
  }
}

function flipVertically(
  pixels: Uint8ClampedArray,
  width: number,
  height: number
): void {
  const rowSize = width * 4
  const temp = new Uint8ClampedArray(rowSize)
  for (let y = 0; y < height / 2; y++) {
    const topOffset = y * rowSize
    const bottomOffset = (height - y - 1) * rowSize
    temp.set(pixels.subarray(topOffset, topOffset + rowSize))
    pixels.copyWithin(topOffset, bottomOffset, bottomOffset + rowSize)
    pixels.set(temp, bottomOffset)
  }
}
